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

test('queue preserves throw-on-!ok contract used by recommendations.js callers', async () => {
  const storage = fakeStorage();
  const fetchImpl = async () => jsonResponse({ status_message: 'Not Found' }, { ok: false, status: 404 });
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  await assert.rejects(
    () => q.fetchJson('https://api.themoviedb.org/3/movie/0'),
    (err) => err instanceof Error && /404/.test(err.message),
    'callers rely on a thrown Error carrying the HTTP status',
  );
});

test('429 with a non-numeric Retry-After falls back to exponential backoff (no NaN delay)', async () => {
  const storage = fakeStorage();
  const delays = [];
  const delayImpl = async (ms) => { delays.push(ms); };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (calls === 1) return jsonResponse({ error: 'rate' }, { ok: false, status: 429, headers: { 'retry-after': 'soon' } });
    return jsonResponse({ url });
  };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl, now: () => NOW });

  const out = await q.fetchJson('https://api/bad-retry-after');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000], 'non-numeric Retry-After uses exponential base, never NaN');
  assert.deepEqual(out, { url: 'https://api/bad-retry-after' });
});

// Wrap fakeStorage to count getItem(MEMO_KEY) reads.
function countingStorage() {
  const s = fakeStorage();
  let getItemCount = 0;
  return {
    getItem: (k) => { getItemCount++; return s.getItem(k); },
    setItem: (k, v) => s.setItem(k, v),
    removeItem: (k) => s.removeItem(k),
    _map: s._map,
    _getItemCount: () => getItemCount,
  };
}

test('memo mirror: storage.getItem is read once at creation, not per fetch', async () => {
  const storage = countingStorage();
  const fetchImpl = async (url) => jsonResponse({ url });
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });
  assert.equal(storage._getItemCount(), 1, 'mirror seeded by exactly one getItem at creation');
  await q.fetchJson('https://api/m/1');
  await q.fetchJson('https://api/m/2');
  await q.fetchJson('https://api/m/1'); // memo hit
  await flush();
  assert.equal(storage._getItemCount(), 1, 'no further getItem reads per fetch (served from mirror)');
});

test('memo mirror: writes flush through to storage and de-dupe/persist across a new queue', async () => {
  const storage = fakeStorage();
  let calls = 0;
  const fetchImpl = async (url) => { calls++; return jsonResponse({ url }); };
  const q1 = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });
  await q1.fetchJson('https://api/persist');
  await flush();
  assert.equal(calls, 1);
  assert.ok(storage.getItem('recFetchMemo'), 'memo flushed to storage');
  const q2 = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });
  const out = await q2.fetchJson('https://api/persist');
  assert.deepEqual(out, { url: 'https://api/persist' });
  assert.equal(calls, 1, 'new queue serves the persisted entry from its mirror, no refetch');
});
