import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveCheck } from './check-live.mjs';

test('runLiveCheck reports per-source status from injected fetch', async () => {
  const fetchImpl = async url => {
    if (url.includes('/catalog/tv/')) return { ok: true, status: 200, json: async () => ({ metas: [{ id: 'm1', name: 'A vs B', cast: ['A', 'B'] }] }) };
    if (url.includes('/stream/tv/m1')) return { ok: true, status: 200, json: async () => ({ streams: [{ title: 'X', url: 'https://cdn.example/a.m3u8' }] }) };
    if (url.endsWith('sports.m3u')) return { ok: true, status: 200, text: async () => '#EXTM3U\r\n#EXTINF:-1 tvg-id="beINSPORTSXTRA.us@SD",beIN Sports 1\r\nhttps://cdn.example/b.m3u8\r\n' };
    if (url === 'https://cdn.example/b.m3u8') return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }), text: async () => '#EXTM3U' };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const lines = [];
  const r = await runLiveCheck({ fetchImpl, log: l => lines.push(l) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sources.nuvio, { ok: true, matches: 1, streams: 1, error: null });
  assert.deepEqual(r.channels, { ok: true, count: 1, error: null });
  assert.ok(lines.some(l => /nuvio/.test(l) && /ok/.test(l)));
});

test('runLiveCheck flags a dead primary adapter', async () => {
  const r = await runLiveCheck({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.sources.nuvio.ok, false);
  assert.match(r.sources.nuvio.error, /fetch failed/);
  assert.equal(r.channels.ok, false);
});

test('live check against the real internet', { skip: !process.env.CHECK_LIVE }, async () => {
  const r = await runLiveCheck({});
  assert.equal(r.sources.nuvio.ok, true, JSON.stringify(r));
});

test('runLiveCheck reports Highfly too and stays ok while any match source works', async () => {
  const fetchImpl = async url => {
    if (url.includes('highfly')) throw new TypeError('fetch failed');
    if (url.includes('/catalog/tv/')) return { ok: true, status: 200, json: async () => ({ metas: [{ id: 'm1', name: 'A vs B', cast: ['A', 'B'] }] }) };
    if (url.includes('/stream/tv/m1')) return { ok: true, status: 200, json: async () => ({ streams: [{ title: 'X', url: 'https://cdn.example/a.m3u8' }] }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const r = await runLiveCheck({ fetchImpl, log: () => {} });
  assert.equal(r.sources.highfly.ok, false);
  assert.equal(r.sources.nuvio.ok, true);
  assert.equal(r.ok, true);
});
