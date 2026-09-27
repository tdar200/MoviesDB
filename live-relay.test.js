import test from 'node:test';
import assert from 'node:assert/strict';
import { signUpstream, verifyUpstream, isPublicHttpUrl, relayPath, rewritePlaylist, upstreamHeaders } from './live-relay.mjs';

const S = 'secret-1';
const P = { u: 'https://cdn.example/hls/a.m3u8?s=x&e=1', ref: 'https://ref.example/', org: 'https://ref.example' };

test('signatures verify only for the exact url/referer/origin triple and secret', () => {
  const s = signUpstream(P, S);
  assert.match(s, /^[0-9a-f]{32}$/);
  assert.equal(verifyUpstream({ ...P, s }, S), true);
  assert.equal(verifyUpstream({ ...P, s }, 'other'), false);
  assert.equal(verifyUpstream({ ...P, u: P.u + '&x=1', s }, S), false);
  assert.equal(verifyUpstream({ ...P, ref: '', s }, S), false);
  assert.equal(verifyUpstream({ ...P, s: '' }, S), false);
  assert.equal(verifyUpstream({ ...P, s: s.slice(0, 31) }, S), false);
});

test('signUpstream throws when secret is empty/undefined/null, verifyUpstream returns false', () => {
  assert.throws(() => signUpstream(P, ''), /relay secret required/);
  assert.throws(() => signUpstream(P, undefined), /relay secret required/);
  assert.throws(() => signUpstream(P, null), /relay secret required/);
  assert.equal(verifyUpstream({ ...P, s: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, ''), false);
  assert.equal(verifyUpstream({ ...P, s: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, undefined), false);
});

test('isPublicHttpUrl refuses private, loopback, link-local and non-http targets', () => {
  assert.equal(isPublicHttpUrl('https://cdn.example/a.m3u8'), true);
  assert.equal(isPublicHttpUrl('http://89.1.2.3:8080/x.m3u8'), true);
  assert.equal(isPublicHttpUrl('http://100.63.255.255/x'), true, 'just before CGNAT');
  assert.equal(isPublicHttpUrl('http://100.128.0.1/x'), true, 'just after CGNAT');
  assert.equal(isPublicHttpUrl('http://223.255.255.255/x'), true, 'just before multicast');
  assert.equal(isPublicHttpUrl('http://89.1.2.3:8080/x.m3u8', ['https:']), false);
  for (const bad of ['http://127.0.0.1/x', 'http://localhost/x', 'http://localhost./x', 'http://10.0.0.5/x', 'http://192.168.0.189:8123/x', 'http://172.16.0.1/x', 'http://169.254.1.1/x', 'http://[::1]/x', 'http://[fe80::1]/x', 'http://[fe90::1]/x', 'http://[febf::1]/x', 'http://[fd00::1]/x', 'http://[::ffff:127.0.0.1]/x', 'http://[::7f00:1]/x', 'http://[::ffff:0:127.0.0.1]/x', 'http://[64:ff9b::7f00:1]/x', 'http://100.64.0.1/x', 'http://100.100.100.100/x', 'http://224.0.0.1/x', 'http://239.255.255.250/x', 'http://255.255.255.255/x', 'ftp://cdn.example/x', 'not a url', '']) {
    assert.equal(isPublicHttpUrl(bad), false, bad);
  }
});

test('relayPath encodes the triple, signs it, and appends the key only when given', () => {
  const p = relayPath('hls', P, S);
  const url = new URL('http://h' + p);
  assert.equal(url.pathname, '/live/hls');
  assert.equal(url.searchParams.get('u'), P.u);
  assert.equal(url.searchParams.get('ref'), P.ref);
  assert.equal(url.searchParams.get('org'), P.org);
  assert.equal(url.searchParams.get('s'), signUpstream(P, S));
  assert.equal(url.searchParams.get('key'), null);
  assert.equal(new URL('http://h' + relayPath('seg', P, S, 'k1')).searchParams.get('key'), 'k1');
  assert.equal(new URL('http://h' + relayPath('seg', P, S)).pathname, '/live/seg');
});

const seg = (p, u) => { const q = new URL('http://h' + p); return { path: q.pathname, u: q.searchParams.get('u'), ok: verifyUpstream({ u: q.searchParams.get('u'), ref: q.searchParams.get('ref'), org: q.searchParams.get('org'), s: q.searchParams.get('s') }, S), key: q.searchParams.get('key') }; };

test('rewritePlaylist routes segments to /live/seg, resolving relative URLs, keeping tags and adding the key', () => {
  const text = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:117', '#EXTINF:5.000,', 'seg117.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:5.000,', '/abs/seg118.ts?t=1', '#EXTINF:5.000,', 'https://other.example/seg119.ts', ''].join('\n');
  const out = rewritePlaylist(text, { playlistUrl: 'https://cdn.example/hls/live/index.m3u8?s=x', ref: P.ref, org: P.org, secret: S, key: 'k1' }).split('\n');
  assert.equal(out[0], '#EXTM3U');
  assert.equal(out[3], '#EXT-X-MEDIA-SEQUENCE:117');
  assert.equal(out[6], '#EXT-X-DISCONTINUITY');
  const a = seg(out[5]); assert.equal(a.path, '/live/seg'); assert.equal(a.u, 'https://cdn.example/hls/live/seg117.ts'); assert.equal(a.ok, true); assert.equal(a.key, 'k1');
  assert.equal(seg(out[8]).u, 'https://cdn.example/abs/seg118.ts?t=1');
  assert.equal(seg(out[10]).u, 'https://other.example/seg119.ts');
  assert.equal(out[out.length - 1], '');
});

test('rewritePlaylist sends master-playlist variants and .m3u8 lines to /live/hls', () => {
  const text = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720', 'high/mono.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'https://cdn.example/low/index.m3u8?e=1', 'chunklist.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=500000', 'live/abc?token=1'].join('\n');
  const out = rewritePlaylist(text, { playlistUrl: 'https://cdn.example/hls/master.m3u8', ref: P.ref, org: P.org, secret: S, key: '' }).split('\n');
  assert.equal(out[1], '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720');
  const v = seg(out[2]); assert.equal(v.path, '/live/hls'); assert.equal(v.u, 'https://cdn.example/hls/high/mono.m3u8'); assert.equal(v.key, null);
  assert.equal(seg(out[4]).u, 'https://cdn.example/low/index.m3u8?e=1');
  assert.equal(seg(out[5]).path, '/live/hls');
  const noExt = seg(out[7]); assert.equal(noExt.path, '/live/hls', 'variant without extension goes to /live/hls'); assert.equal(noExt.u, 'https://cdn.example/hls/live/abc?token=1');
});

test('rewritePlaylist rewrites URI= in KEY/MAP (segments) and MEDIA/I-FRAME (playlists), leaving other attributes alone', () => {
  const text = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="keys/k1.key",IV=0x0123', '#EXT-X-MAP:URI="init.mp4"', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"', '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframes.m3u8"', '#EXTINF:4,', 'f1.m4s'].join('\n');
  const out = rewritePlaylist(text, { playlistUrl: 'https://cdn.example/p/index.m3u8', ref: '', org: '', secret: S, key: 'k' }).split('\n');
  const uri = line => /URI="([^"]+)"/.exec(line)[1];
  assert.match(out[1], /^#EXT-X-KEY:METHOD=AES-128,URI=".+",IV=0x0123$/);
  assert.equal(seg(uri(out[1])).path, '/live/seg'); assert.equal(seg(uri(out[1])).u, 'https://cdn.example/p/keys/k1.key');
  assert.equal(seg(uri(out[2])).u, 'https://cdn.example/p/init.mp4');
  assert.equal(seg(uri(out[3])).path, '/live/hls'); assert.equal(seg(uri(out[3])).u, 'https://cdn.example/p/audio/en.m3u8');
  assert.equal(seg(uri(out[4])).path, '/live/hls');
  assert.equal(seg(out[6]).u, 'https://cdn.example/p/f1.m4s');
});

test('rewritePlaylist: variantNext resets after each non-tag line, routing segments without extensions correctly', () => {
  const text = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2000', 'live/abc?token=1', '#EXTINF:5,', 'chunk?n=5'].join('\n');
  const out = rewritePlaylist(text, { playlistUrl: 'https://cdn.example/p.m3u8', ref: '', org: '', secret: S, key: '' }).split('\n');
  const v = seg(out[2]); assert.equal(v.path, '/live/hls', 'variant after STREAM-INF goes to /live/hls');
  const c = seg(out[4]); assert.equal(c.path, '/live/seg', 'segment after EXTINF goes to /live/seg');
});

test('rewritePlaylist honours relayBase for absolute relay URLs', () => {
  const out = rewritePlaylist('#EXTM3U\n#EXTINF:4,\na.ts', { playlistUrl: 'https://cdn.example/x/i.m3u8', relayBase: 'http://192.168.0.189:8123', ref: '', org: '', secret: S, key: '' }).split('\n');
  assert.match(out[2], /^http:\/\/192\.168\.0\.189:8123\/live\/seg\?u=/);
});

test('upstreamHeaders sends Referer and Origin only when given, always a Chrome UA', () => {
  assert.deepEqual(upstreamHeaders('https://r/', 'https://r'), { Referer: 'https://r/', Origin: 'https://r', 'User-Agent': upstreamHeaders('', '')['User-Agent'], Accept: '*/*' });
  const h = upstreamHeaders('', '');
  assert.equal('Referer' in h, false);
  assert.equal('Origin' in h, false);
  assert.match(h['User-Agent'], /Chrome/);
});
