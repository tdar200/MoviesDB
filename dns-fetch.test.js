// dns-fetch.test.js — getting past an ISP DNS block on a torrent index.
//
// Sky (this line) hijacks torrentio.strem.fun: the system resolver answers
// 2a02:c79:8ff:69::1 (an ISP sinkhole) while 1.1.1.1/8.8.8.8 return the real
// Cloudflare addresses 104.21.10.254 / 172.67.164.220. The helper therefore lost
// its only public-tracker index and fell back to Comet alone, whose sources are
// private-tracker swarms with no reachable peers — which the user saw as a
// permanent "Connecting to peers…". Connecting to the real IP with the hostname
// preserved (Host header + TLS SNI) works, so only address resolution is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResolvingFetch, isNetworkError } from './dns-fetch.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('a working host goes straight through the normal fetch', async () => {
  let viaIpCalls = 0;
  const f = createResolvingFetch({
    baseFetch: async () => ok({ streams: [1] }),
    viaIpFetch: async () => { viaIpCalls++; return ok({}); },
  });
  const res = await f('https://index.example/x.json');
  assert.deepEqual(await res.json(), { streams: [1] });
  assert.equal(viaIpCalls, 0, 'must not pay the DNS-override cost when DNS is fine');
});

test('a DNS-blocked host falls back to connecting by resolved IP', async () => {
  const f = createResolvingFetch({
    baseFetch: async () => { throw new TypeError('fetch failed'); },
    viaIpFetch: async () => ok({ streams: ['from-ip'] }),
  });
  const res = await f('https://blocked.example/x.json');
  assert.deepEqual(await res.json(), { streams: ['from-ip'] });
});

test('an HTTP error is NOT retried by IP — the host answered, it just said no', async () => {
  let viaIpCalls = 0;
  const f = createResolvingFetch({
    baseFetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    viaIpFetch: async () => { viaIpCalls++; return ok({}); },
  });
  assert.equal((await f('https://index.example/x.json')).status, 503);
  assert.equal(viaIpCalls, 0);
});

test('when the IP path also fails, the original error surfaces', async () => {
  const f = createResolvingFetch({
    baseFetch: async () => { throw new TypeError('fetch failed'); },
    viaIpFetch: async () => { throw new Error('no route'); },
  });
  await assert.rejects(() => f('https://blocked.example/x.json'), /fetch failed|no route/);
});

test('isNetworkError separates a dead connection from an HTTP status', () => {
  assert.equal(isNetworkError(new TypeError('fetch failed')), true);
  assert.equal(isNetworkError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), true);
  assert.equal(isNetworkError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isNetworkError(new Error('HTTP 503')), false);
});

test('an abort is never retried — the caller gave up on purpose', () => {
  assert.equal(isNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' })), false);
});

// The blocked host costs a full connect timeout (~10s) on the doomed direct
// attempt, every single lookup, which pushed the real request past the caller's
// 15s budget and silently lost the index. Once a host is known blocked, skip it.
test('after one blocked host is learned, later calls skip the doomed direct attempt', async () => {
  let baseCalls = 0;
  const f = createResolvingFetch({
    baseFetch: async () => { baseCalls++; throw new TypeError('fetch failed'); },
    viaIpFetch: async () => ok({ streams: [] }),
  });
  await f('https://blocked.example/a.json');
  await f('https://blocked.example/b.json');
  await f('https://blocked.example/c.json');
  assert.equal(baseCalls, 1, 'only the first call pays the connect timeout');
});

test('learning is per-host: a healthy host is unaffected', async () => {
  let baseCalls = 0;
  const f = createResolvingFetch({
    baseFetch: async (url) => {
      baseCalls++;
      if (url.includes('blocked')) throw new TypeError('fetch failed');
      return ok({ streams: ['direct'] });
    },
    viaIpFetch: async () => ok({ streams: ['via-ip'] }),
  });
  await f('https://blocked.example/a.json');
  const res = await f('https://healthy.example/a.json');
  assert.deepEqual(await res.json(), { streams: ['direct'] });
  assert.equal(baseCalls, 2);
});
