import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signUpstream } from './live-relay.mjs';

const exec = promisify(execFile);
const KEY = 'testkey';
const PORT = 18123;
const REF = 'https://ref.example/';
const ORG = 'https://ref.example';

// Origin server that mimics a sports CDN: 403 unless BOTH Referer and Origin match.
function originServer(dir) {
  return http.createServer(async (req, res) => {
    if (req.headers.referer !== REF || req.headers.origin !== ORG) { res.writeHead(403); return res.end('forbidden'); }
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    try {
      const body = await readFile(join(dir, name));
      res.writeHead(200, { 'content-type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'content-length': body.length });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
}

function startHelper() {
  return new Promise((resolve, reject) => {
    // LIVE_RELAY_ALLOW_PRIVATE lets the relay reach the 127.0.0.1 origin below; it is a test-only escape hatch.
    const child = spawn(process.execPath, ['stream-server.mjs'], { env: { ...process.env, PORT: String(PORT), HELPER_KEY: KEY, LIVE_RELAY_ALLOW_PRIVATE: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; if (out.includes('running')) resolve(child); });
    child.on('exit', code => reject(new Error(`helper exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error('helper did not start')), 20000).unref();
  });
}

test('relay: rewritten playlist plays through the helper with Referer+Origin added upstream', { skip: !process.env.CHECK_LIVE_RELAY }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-relay-'));
  const src = join(dir, 'src.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-y', src]);
  await exec('ffmpeg', ['-v', 'error', '-i', src, '-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', join(dir, 'index.m3u8')]);
  const origin = originServer(dir);
  await new Promise(r => origin.listen(0, '127.0.0.1', r));
  const originPort = origin.address().port;
  const child = await startHelper();
  try {
    const u = `http://127.0.0.1:${originPort}/index.m3u8`;
    // Direct fetch without headers must be refused by the origin (proves the test origin enforces).
    assert.equal((await fetch(u)).status, 403);
    const s = signUpstream({ u, ref: REF, org: ORG }, KEY);
    const q = new URLSearchParams({ u, s, ref: REF, org: ORG, key: KEY });
    const playlistRes = await fetch(`http://127.0.0.1:${PORT}/live/hls?${q}`);
    assert.equal(playlistRes.status, 200);
    assert.equal(playlistRes.headers.get('access-control-allow-origin'), '*');
    assert.match(playlistRes.headers.get('content-type'), /mpegurl/);
    const playlist = await playlistRes.text();
    const segLines = playlist.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(segLines.length >= 2);
    for (const l of segLines) assert.match(l, /^\/live\/seg\?u=.+&key=testkey/);
    const segRes = await fetch(`http://127.0.0.1:${PORT}${segLines[0]}`);
    assert.equal(segRes.status, 200);
    assert.match(segRes.headers.get('content-type'), /mp2t/);
    const bytes = Buffer.from(await segRes.arrayBuffer());
    assert.equal(bytes[0], 0x47, 'MPEG-TS sync byte');
    // Tampered signature and missing key are both refused.
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/live/hls?${new URLSearchParams({ u, s: s.replace(/^./, c => c === 'a' ? 'b' : 'a'), ref: REF, org: ORG, key: KEY })}`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/live/hls?${new URLSearchParams({ u, s, ref: REF, org: ORG })}`)).status, 401);
    // Preflight.
    const pre = await fetch(`http://127.0.0.1:${PORT}/live/seg?x=1`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  } finally {
    child.kill('SIGTERM');
    origin.close();
    await rm(dir, { recursive: true, force: true });
  }
});
