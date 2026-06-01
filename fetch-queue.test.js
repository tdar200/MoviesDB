import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchQueue } from './fetch-queue.js';

const NOW = 1_700_000_000_000; // fixed clock for deterministic tests

// Map-backed sessionStorage stand-in (getItem/setItem/removeItem, string values).
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

// Builds a Response-like object. body is returned from .json().
function jsonResponse(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    json: async () => body,
  };
}

// Resolve a promise after letting the microtask queue drain `ticks` times.
async function flush(ticks = 5) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

test('memoizes successful GET json by url: second call hits storage, not fetchImpl', async () => {
  const storage = fakeStorage();
  let calls = 0;
  const fetchImpl = async (url) => { calls++; return jsonResponse({ url, page: 1 }); };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  const first = await q.fetchJson('https://api/x?page=1');
  const second = await q.fetchJson('https://api/x?page=1');

  assert.deepEqual(first, { url: 'https://api/x?page=1', page: 1 });
  assert.deepEqual(second, first);
  assert.equal(calls, 1, 'second call must come from storage memo');
});

test('de-dupes identical in-flight URLs into a single fetch', async () => {
  const storage = fakeStorage();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (url) => { calls++; await gate; return jsonResponse({ url }); };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  const a = q.fetchJson('https://api/dup');
  const b = q.fetchJson('https://api/dup');
  await flush();
  assert.equal(calls, 1, 'identical in-flight URL must share one fetch');

  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, { url: 'https://api/dup' });
  assert.deepEqual(rb, ra);
});

test('caps concurrency at maxInflight', async () => {
  const storage = fakeStorage();
  let inflight = 0;
  let maxObserved = 0;
  const releasers = [];
  const fetchImpl = async (url) => {
    inflight++;
    maxObserved = Math.max(maxObserved, inflight);
    await new Promise((r) => releasers.push(() => { inflight--; r(jsonResponse({ url })); }));
    return jsonResponse({ url });
  };
  const q = createFetchQueue({ fetchImpl, storage, maxInflight: 2, delayImpl: async () => {}, now: () => NOW });

  const ps = [];
  for (let i = 0; i < 5; i++) ps.push(q.fetchJson(`https://api/c/${i}`));
  await flush();
  assert.equal(maxObserved, 2, 'never more than maxInflight concurrent fetches');

  while (releasers.length) releasers.shift()();
  await flush();
  while (releasers.length) releasers.shift()();
  await flush();
  while (releasers.length) releasers.shift()();
  await Promise.all(ps);
  assert.equal(maxObserved, 2);
});

test('on 429 with Retry-After, backs off via delayImpl then retries and succeeds', async () => {
  const storage = fakeStorage();
  const delays = [];
  const delayImpl = async (ms) => { delays.push(ms); };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (calls === 1) return jsonResponse({ error: 'rate' }, { ok: false, status: 429, headers: { 'retry-after': '3' } });
    return jsonResponse({ url, ok: true });
  };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl, now: () => NOW });

  const out = await q.fetchJson('https://api/429');
  assert.equal(calls, 2, 'must retry once after backoff');
  assert.deepEqual(delays, [3000], 'Retry-After seconds honored as ms');
  assert.deepEqual(out, { url: 'https://api/429', ok: true });
});

test('429 without Retry-After uses exponential backoff', async () => {
  const storage = fakeStorage();
  const delays = [];
  const delayImpl = async (ms) => { delays.push(ms); };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (calls < 3) return jsonResponse({ error: 'rate' }, { ok: false, status: 429 });
    return jsonResponse({ url });
  };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl, now: () => NOW });

  const out = await q.fetchJson('https://api/expo');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000], 'exponential: base 1000, then doubled');
  assert.deepEqual(out, { url: 'https://api/expo' });
});

test('throws on non-ok non-429 and does not memoize', async () => {
  const storage = fakeStorage();
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse({ error: 'nope' }, { ok: false, status: 500 }); };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  await assert.rejects(() => q.fetchJson('https://api/err'), /500/);
  assert.equal(calls, 1, 'no retry on 500');
  await assert.rejects(() => q.fetchJson('https://api/err'), /500/);
  assert.equal(calls, 2, 'error responses are never memoized');
});

test('clearMemo drops the stored entries so the next call refetches', async () => {
  const storage = fakeStorage();
  let calls = 0;
  const fetchImpl = async (url) => { calls++; return jsonResponse({ url }); };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  await q.fetchJson('https://api/clear');
  assert.equal(calls, 1);
  q.clearMemo();
  await q.fetchJson('https://api/clear');
  assert.equal(calls, 2, 'after clearMemo the memo is empty, so refetch');
});
