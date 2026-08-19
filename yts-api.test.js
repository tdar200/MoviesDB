// yts-api.test.js — the YTS metadata lookup: host racing, retry, cache.
//
// Injects a fake fetch, so these run offline and deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchYtsMovie, clearYtsCache, YTS_HOSTS } from './yts-api.mjs';

const IMDB = 'tt1375666';
const movie = (title) => ({ title, torrents: [{ hash: 'a'.repeat(40), quality: '1080p', seeds: 9 }] });
const okBody = (title) => ({ status: 'ok', data: { movies: [movie(title)] } });
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// A fake fetch driven by a per-host script: { hostSubstring: handler(url) }
function fakeFetch(routes, log = []) {
  return async (url, opts) => {
    log.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const handler = key ? routes[key] : () => { throw new Error('no route: ' + url); };
    return handler(url, opts);
  };
}
const hang = () => new Promise((_r, reject) => { /* never settles until aborted */
  // emulate an AbortSignal timeout rejection the way fetch does
  setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 50);
});

test('returns the movie from whichever host answers', async () => {
  clearYtsCache();
  const f = fakeFetch({
    'accel.li': async () => jsonRes(okBody('Inception')),
    'yts.bz': async () => jsonRes({}, 503),
    'yts.mx': async () => { throw new Error('ENOTFOUND'); },
  });
  const m = await fetchYtsMovie(IMDB, { fetchImpl: f, timeoutMs: 200 });
  assert.equal(m.title, 'Inception');
});

test('a hanging first host does not block a healthy later host', async () => {
  clearYtsCache();
  // The old implementation tried hosts in series with a 12s timeout each, so a
  // hanging first host cost the user 12s before the second was even attempted.
  const f = fakeFetch({
    'accel.li': hang,          // blocked / hanging
    'yts.bz': async () => jsonRes(okBody('Inception')),
    'yts.mx': async () => { throw new Error('ENOTFOUND'); },
  });
  const t0 = Date.now();
  const m = await fetchYtsMovie(IMDB, { fetchImpl: f, timeoutMs: 5000 });
  const ms = Date.now() - t0;
  assert.equal(m.title, 'Inception');
  assert.ok(ms < 100, `should not wait on the hanging host (took ${ms}ms)`);
});

test('prefers a host that actually has the movie over one that answers empty', async () => {
  clearYtsCache();
  const f = fakeFetch({
    'accel.li': async () => jsonRes({ status: 'ok', data: { movies: [] } }), // fast but empty
    'yts.bz': async () => { await new Promise((r) => setTimeout(r, 20)); return jsonRes(okBody('Inception')); },
    'yts.mx': async () => { throw new Error('ENOTFOUND'); },
  });
  const m = await fetchYtsMovie(IMDB, { fetchImpl: f, timeoutMs: 500 });
  assert.equal(m?.title, 'Inception', 'a movie-bearing answer must beat an empty one');
});

test('genuinely not on YTS resolves to null, not an error', async () => {
  clearYtsCache();
  const f = fakeFetch({
    'accel.li': async () => jsonRes({ status: 'ok', data: { movies: [] } }),
    'yts.bz': async () => jsonRes({ status: 'ok', data: { movies: [] } }),
    'yts.mx': async () => jsonRes({ status: 'ok', data: { movies: [] } }),
  });
  assert.equal(await fetchYtsMovie(IMDB, { fetchImpl: f, timeoutMs: 200 }), null);
});

test('retries once when every host fails, and succeeds on the retry', async () => {
  clearYtsCache();
  let round = 0;
  const f = async (url) => {
    if (url.includes('accel.li')) {
      round++;
      if (round === 1) throw new Error('EAI_AGAIN'); // transient ISP/DNS blip
      return jsonRes(okBody('Inception'));
    }
    throw new Error('ENOTFOUND');
  };
  const m = await fetchYtsMovie(IMDB, { fetchImpl: f, timeoutMs: 200, retryDelayMs: 1 });
  assert.equal(m.title, 'Inception');
});

test('throws a diagnosable error when all hosts fail every attempt', async () => {
  clearYtsCache();
  const f = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(
    () => fetchYtsMovie(IMDB, { fetchImpl: f, timeoutMs: 100, retryDelayMs: 1 }),
    (err) => {
      assert.match(err.message, /yts/i);
      assert.ok(Array.isArray(err.hostErrors) && err.hostErrors.length, 'should report per-host failures');
      return true;
    }
  );
});

test('a cached hit costs no network calls', async () => {
  clearYtsCache();
  const log = [];
  const f = fakeFetch({ 'accel.li': async () => jsonRes(okBody('Inception')), 'yts.': async () => jsonRes({}, 503) }, log);
  await fetchYtsMovie(IMDB, { fetchImpl: f, timeoutMs: 200 });
  const after = log.length;
  const m = await fetchYtsMovie(IMDB, { fetchImpl: f, timeoutMs: 200 });
  assert.equal(m.title, 'Inception');
  assert.equal(log.length, after, 'second lookup must be served from cache');
});

test('falls back to a stale cache entry when the hosts go down', async () => {
  clearYtsCache();
  const good = fakeFetch({ 'accel.li': async () => jsonRes(okBody('Inception')), 'yts.': async () => jsonRes({}, 503) });
  await fetchYtsMovie(IMDB, { fetchImpl: good, timeoutMs: 200 });

  // Same title later, with every host now blocked and the entry expired: a stale
  // answer beats an error message the user can do nothing about.
  const dead = async () => { throw new Error('ENOTFOUND'); };
  const m = await fetchYtsMovie(IMDB, { fetchImpl: dead, timeoutMs: 100, retryDelayMs: 1, ttlMs: -1 });
  assert.equal(m.title, 'Inception');
});

test('host list still includes the known-good API host first', () => {
  assert.ok(YTS_HOSTS[0].includes('accel.li'));
  assert.equal(YTS_HOSTS.length, 3);
});
