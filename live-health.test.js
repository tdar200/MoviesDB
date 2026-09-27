import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySegmentBytes, firstMediaUri, probeStream, createStreamHealth, BLOCKED_TARGET } from './live-health.mjs';

const bytes = (...xs) => Uint8Array.from(xs);
const ascii = s => Uint8Array.from(Buffer.from(s, 'latin1'));

test('classifySegmentBytes recognises TS, fMP4, ID3, playlists and wrapped containers', () => {
  assert.equal(classifySegmentBytes(bytes(0x47, 0x40, 0x11, 0x10)), 'ts');
  assert.equal(classifySegmentBytes(ascii('\x00\x00\x00\x18ftypiso6')), 'fmp4');
  assert.equal(classifySegmentBytes(ascii('\x00\x00\x00\x18stypmsdh')), 'fmp4');
  assert.equal(classifySegmentBytes(ascii('\x00\x00\x02\x00moof....')), 'fmp4');
  assert.equal(classifySegmentBytes(ascii('ID3\x04\x00\x00')), 'id3');
  assert.equal(classifySegmentBytes(ascii('#EXTM3U\n')), 'playlist');
  assert.equal(classifySegmentBytes(ascii('RIFF\x10\x00\x00\x00WEBP')), 'wrapped');
  assert.equal(classifySegmentBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), 'wrapped');
  assert.equal(classifySegmentBytes(bytes(0xff, 0xd8, 0xff, 0xe0)), 'wrapped'); // JPEG
  assert.equal(classifySegmentBytes(ascii('GIF89a')), 'wrapped');
  assert.equal(classifySegmentBytes(ascii('<html>')), 'unknown');
  assert.equal(classifySegmentBytes(bytes()), 'unknown');
});

test('firstMediaUri returns the first URI and flags variants', () => {
  assert.deepEqual(firstMediaUri('#EXTM3U\n#EXTINF:5,\nseg1.ts\n#EXTINF:5,\nseg2.ts\n'), { uri: 'seg1.ts', isVariant: false });
  assert.deepEqual(firstMediaUri('#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=1\r\nhi/index?t=1\r\n'), { uri: 'hi/index?t=1', isVariant: true });
  assert.equal(firstMediaUri('#EXTM3U\n#EXT-X-ENDLIST\n'), null);
  assert.equal(firstMediaUri(''), null);
});

// A fake upstream: map of url -> { status, body (string | Uint8Array) } or 'hang'.
function fakeUpstream(map, calls = []) {
  return async (url, headers, signal) => {
    calls.push({ url, headers });
    const r = map[url];
    if (r === 'hang') return new Promise((_, reject) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
    if (!r) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    const body = typeof r.body === 'string' ? Buffer.from(r.body, 'latin1') : Buffer.from(r.body || []);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => body.toString('latin1'), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
}
const S = { url: 'https://nuviosports.xyz/api/manifest?url=x', referer: 'https://ref.example/', origin: 'https://ref.example' };

test('probeStream: media playlist with a TS segment is ok, and headers are sent on every request', async () => {
  const calls = [];
  const fetchUpstream = fakeUpstream({
    [S.url]: { status: 200, body: '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/a/1.ts\n' },
    'https://cdn.example/a/1.ts': { status: 200, body: [0x47, 0x40, 0x00] },
  }, calls);
  assert.deepEqual(await probeStream(S, { fetchUpstream }), { status: 'ok', detail: 'ts' });
  assert.equal(calls.length, 2);
  for (const c of calls) { assert.equal(c.headers.Referer, S.referer); assert.equal(c.headers.Origin, S.origin); }
});

test('probeStream: follows one master -> variant hop and resolves relative URIs', async () => {
  const fetchUpstream = fakeUpstream({
    [S.url]: { status: 200, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://cdn.example/v/index?t=1\n' },
    'https://cdn.example/v/index?t=1': { status: 200, body: '#EXTM3U\n#EXTINF:4,\nseg/7.ts\n' },
    'https://cdn.example/v/seg/7.ts': { status: 200, body: [0x47] },
  });
  assert.deepEqual(await probeStream(S, { fetchUpstream }), { status: 'ok', detail: 'ts' });
});

test('probeStream: an fMP4 stream with #EXT-X-MAP is ok without fetching a segment', async () => {
  const calls = [];
  const fetchUpstream = fakeUpstream({ [S.url]: { status: 200, body: '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\n1.m4s\n' } }, calls);
  assert.deepEqual(await probeStream(S, { fetchUpstream }), { status: 'ok', detail: 'fmp4-map' });
  assert.equal(calls.length, 1);
});

test('probeStream: wrapped segments, HTTP errors, empty playlists, non-playlists and timeouts', async () => {
  const wrapped = fakeUpstream({ [S.url]: { status: 200, body: '#EXTM3U\n#EXTINF:4,\nhttps://img.example/x.png#.ts\n' }, 'https://img.example/x.png#.ts': { status: 200, body: 'RIFF\x00\x00\x00\x00WEBP' } });
  assert.deepEqual(await probeStream(S, { fetchUpstream: wrapped }), { status: 'wrapped', detail: 'wrapped' });
  const forbidden = fakeUpstream({ [S.url]: { status: 403, body: '' } });
  assert.deepEqual(await probeStream(S, { fetchUpstream: forbidden }), { status: 'http-error', detail: 'playlist 403' });
  const segForbidden = fakeUpstream({ [S.url]: { status: 200, body: '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/1.ts\n' }, 'https://cdn.example/1.ts': { status: 403, body: '' } });
  assert.deepEqual(await probeStream(S, { fetchUpstream: segForbidden }), { status: 'http-error', detail: 'segment 403' });
  const empty = fakeUpstream({ [S.url]: { status: 200, body: '#EXTM3U\n#EXT-X-ENDLIST\n' } });
  assert.deepEqual(await probeStream(S, { fetchUpstream: empty }), { status: 'bad-playlist', detail: 'no media uri' });
  const html = fakeUpstream({ [S.url]: { status: 200, body: '<html>parked</html>' } });
  assert.deepEqual(await probeStream(S, { fetchUpstream: html }), { status: 'bad-playlist', detail: 'not a playlist' });
  const hang = fakeUpstream({ [S.url]: { status: 200, body: '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/1.ts\n' }, 'https://cdn.example/1.ts': 'hang' });
  const t0 = Date.now();
  assert.deepEqual(await probeStream(S, { fetchUpstream: hang, timeoutMs: 60 }), { status: 'timeout', detail: 'timeout' });
  assert.ok(Date.now() - t0 < 1000, 'one shared deadline bounds the whole probe');
  const boom = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await probeStream(S, { fetchUpstream: boom }), { status: 'error', detail: 'fetch failed' });
});

test('createStreamHealth ranks ok first, keeps timeouts last, drops broken streams, caches per url', async () => {
  let clock = 0;
  const results = { a: 'ok', b: 'timeout', c: 'wrapped', d: 'ok', e: 'http-error', f: 'error', g: 'bad-playlist' };
  const probed = [];
  const probe = async s => { probed.push(s.url); return { status: results[s.url], detail: results[s.url] }; };
  const health = createStreamHealth({ probe, now: () => clock });
  const streams = [
    { url: 'b', rank: 99 }, { url: 'a', rank: 10 }, { url: 'c', rank: 50 }, { url: 'd', rank: 30 },
    { url: 'e', rank: 70 }, { url: 'f', rank: 5 }, { url: 'g', rank: 1 },
  ];
  const out = await health.rank(streams);
  assert.deepEqual(out.map(s => [s.url, s.health]), [['d', 'ok'], ['a', 'ok'], ['b', 'timeout'], ['f', 'error']]);
  assert.equal(probed.length, 7);
  clock = 60_000;
  await health.rank(streams);
  assert.equal(probed.length, 7, 'cached within the TTL');
  clock = 130_000;
  await health.rank(streams);
  assert.equal(probed.length, 14, 're-probed after the TTL');
  assert.deepEqual(await health.rank([{ url: 'c', rank: 1 }]), []);
  assert.deepEqual(await health.rank([]), []);
});

test('createStreamHealth never runs more than `concurrency` probes at once', async () => {
  let active = 0, peak = 0;
  const probe = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return { status: 'ok', detail: 'ts' }; };
  const health = createStreamHealth({ probe, concurrency: 3 });
  const out = await health.rank(Array.from({ length: 10 }, (_, i) => ({ url: 'u' + i, rank: i })));
  assert.equal(out.length, 10);
  assert.equal(peak, 3);
});

test('createStreamHealth treats a throwing probe as error, not a crash', async () => {
  const health = createStreamHealth({ probe: async () => { throw new Error('boom'); } });
  assert.deepEqual((await health.rank([{ url: 'x', rank: 1 }])).map(s => s.health), ['error']);
});

// Fix round 1: the probe must not reach non-public targets. The helper's
// fetchUpstream throws an error named BLOCKED_TARGET for those; the probe maps it
// to 'blocked' and the ranker drops the stream.
function blockingUpstream(map) {
  const inner = fakeUpstream(map);
  return async (url, headers, signal) => {
    if (url.startsWith('http://192.168.')) { const e = new Error('non-public target'); e.name = BLOCKED_TARGET; throw e; }
    return inner(url, headers, signal);
  };
}

test('probeStream: a segment on a non-public target is blocked', async () => {
  const fetchUpstream = blockingUpstream({ [S.url]: { status: 200, body: '#EXTM3U\n#EXTINF:4,\nhttp://192.168.0.1/seg.ts\n' } });
  assert.deepEqual(await probeStream(S, { fetchUpstream }), { status: 'blocked', detail: 'non-public target' });
});

test('probeStream: a non-public start url is blocked', async () => {
  const fetchUpstream = blockingUpstream({});
  assert.deepEqual(await probeStream({ ...S, url: 'http://192.168.0.1/index.m3u8' }, { fetchUpstream }), { status: 'blocked', detail: 'non-public target' });
});

test('createStreamHealth drops a stream whose probe is blocked', async () => {
  const health = createStreamHealth({ probe: async s => ({ status: s.url === 'lan' ? 'blocked' : 'ok', detail: '' }) });
  assert.deepEqual((await health.rank([{ url: 'lan', rank: 9 }, { url: 'pub', rank: 1 }])).map(s => s.url), ['pub']);
});

test('probeStream cancels the body of a non-ok response', async () => {
  let cancelled = 0;
  const body = { cancel: async () => { cancelled++; } };
  const fetchUpstream = async url => url === S.url
    ? { ok: true, status: 200, text: async () => '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/1.ts\n' }
    : { ok: false, status: 403, body, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  assert.deepEqual(await probeStream(S, { fetchUpstream }), { status: 'http-error', detail: 'segment 403' });
  const pl403 = async () => ({ ok: false, status: 404, body, text: async () => '' });
  assert.deepEqual(await probeStream(S, { fetchUpstream: pl403 }), { status: 'http-error', detail: 'playlist 404' });
  assert.equal(cancelled, 2);
});

test('probeStream reports the best variant height of a master playlist', async () => {
  const fetchUpstream = fakeUpstream({
    [S.url]: { status: 200, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=960x540\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080\nhigh.m3u8\n' },
    'https://nuviosports.xyz/api/high.m3u8': { status: 200, body: '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/1.ts\n' },
    'https://cdn.example/1.ts': { status: 200, body: [0x47] },
  });
  assert.deepEqual(await probeStream(S, { fetchUpstream }), { status: 'ok', detail: 'ts', height: 1080 });
});

test('createStreamHealth ranks working streams by height, then rank; probe height beats a lower label', async () => {
  const probeResults = { a: { status: 'ok', height: 0 }, b: { status: 'ok', height: 1080 }, c: { status: 'ok', height: 0 }, d: { status: 'timeout' }, e: { status: 'ok', height: 0 } };
  const health = createStreamHealth({ probe: async s => ({ ...probeResults[s.url], detail: 'x' }) });
  const out = await health.rank([
    { url: 'a', rank: 99, height: 480 },   // fast but SD
    { url: 'b', rank: 10, height: 720 },   // labelled HD, master says 1080
    { url: 'c', rank: 50, height: 720 },
    { url: 'd', rank: 100, height: 1080 }, // best label but dead: stays after working ones
    { url: 'e', rank: 60, height: 720 },
  ]);
  assert.deepEqual(out.map(s => [s.url, s.height, s.health]), [['b', 1080, 'ok'], ['e', 720, 'ok'], ['c', 720, 'ok'], ['a', 480, 'ok'], ['d', 1080, 'timeout']]);
});

// A segment hidden behind a fake image header: 42 bytes of RIFF/WEBP, then TS packets.
function wrappedTs(prefix = 'RIFF\x22\x00\x00\x00WEBPVP8 ', packets = 4) {
  const head = Buffer.from(prefix.padEnd(42, '\x00'), 'latin1');
  const ts = Buffer.alloc(188 * packets, 0xff);
  for (let i = 0; i < packets; i++) ts[i * 188] = 0x47;
  return [...head, ...ts];
}

test('tsSyncOffset finds MPEG-TS packets after a fake image header', async () => {
  const { tsSyncOffset } = await import('./live-health.mjs');
  assert.equal(tsSyncOffset(Uint8Array.from(wrappedTs())), 42);
  const plain = Buffer.alloc(188 * 3, 0xff); plain[0] = plain[188] = plain[376] = 0x47;
  assert.equal(tsSyncOffset(plain), 0);
  assert.equal(tsSyncOffset(Uint8Array.from(Buffer.from('RIFF....WEBP' + 'x'.repeat(2000), 'latin1'))), -1, 'a real image has no TS packets');
});

test('probeStream plays image-wrapped TS (hls.js skips the header) and measures the true height', async () => {
  const measured = [];
  const fetchUpstream = fakeUpstream({
    [S.url]: { status: 200, body: '#EXTM3U\n#EXTINF:5,\nhttps://img.example/1.png#.ts\n' },
    'https://img.example/1.png#.ts': { status: 200, body: wrappedTs() },
  });
  const measureHeight = async bytes => { measured.push(bytes[0]); return 1080; };
  assert.deepEqual(await probeStream(S, { fetchUpstream, measureHeight }), { status: 'ok', detail: 'ts-wrapped', height: 1080 });
  assert.deepEqual(measured, [0x47], 'measure gets the bytes from the first TS packet on');
});

test('probeStream: a measured height overrides the master playlist, and a real image is still dropped', async () => {
  const fetchUpstream = fakeUpstream({
    [S.url]: { status: 200, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080\nhi.m3u8\n' },
    'https://nuviosports.xyz/api/hi.m3u8': { status: 200, body: '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/1.ts\n' },
    'https://cdn.example/1.ts': { status: 200, body: [0x47, 0x40, 0x11] },
  });
  assert.deepEqual(await probeStream(S, { fetchUpstream, measureHeight: async () => 720 }), { status: 'ok', detail: 'ts', height: 720 });
  assert.deepEqual(await probeStream(S, { fetchUpstream, measureHeight: async () => 0 }), { status: 'ok', detail: 'ts', height: 1080 }, 'unmeasurable -> keep the advertised height');
  assert.deepEqual(await probeStream(S, { fetchUpstream, measureHeight: async () => { throw new Error('ffprobe missing'); } }), { status: 'ok', detail: 'ts', height: 1080 });
  const image = fakeUpstream({ [S.url]: { status: 200, body: '#EXTM3U\n#EXTINF:4,\nhttps://img.example/x.png\n' }, 'https://img.example/x.png': { status: 200, body: 'RIFF\x00\x00\x00\x00WEBP' + 'z'.repeat(500) } });
  assert.deepEqual(await probeStream(S, { fetchUpstream: image }), { status: 'wrapped', detail: 'wrapped' });
});

test('probeStream follows the highest variant of a master playlist, not the first', async () => {
  const calls = [];
  const fetchUpstream = fakeUpstream({
    [S.url]: { status: 200, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nmid.m3u8\n' },
    'https://nuviosports.xyz/api/high.m3u8': { status: 200, body: '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/h.ts\n' },
    'https://cdn.example/h.ts': { status: 200, body: [0x47] },
  }, calls);
  assert.deepEqual(await probeStream(S, { fetchUpstream, measureHeight: async () => 1080 }), { status: 'ok', detail: 'ts', height: 1080 });
  assert.ok(calls.some(c => c.url.endsWith('/high.m3u8')) && !calls.some(c => c.url.endsWith('/low.m3u8')));
});

test('bestVariantUri picks by resolution, then bandwidth, and falls back to the first', async () => {
  const { bestVariantUri } = await import('./live-health.mjs');
  assert.equal(bestVariantUri('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9\nb.m3u8\n'), 'b.m3u8');
  assert.equal(bestVariantUri('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9,RESOLUTION=640x360\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nb.m3u8\n'), 'b.m3u8');
  assert.equal(bestVariantUri('#EXTM3U\n#EXTINF:4,\nseg.ts\n'), null);
});
