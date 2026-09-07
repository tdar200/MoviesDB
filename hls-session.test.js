import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HlsSessions } from './hls-session.mjs';
import { helperRequestAllowed } from './helper-auth.js';
const exec = promisify(execFile);

test('HLS prepares decodable segments, authenticates their URLs, seeks, and cleans up', { timeout: 30000 }, async () => {
 const dir = await mkdtemp(join(tmpdir(), 'movies-hls-test-'));
 const sessions = new HlsSessions();
 try {
  const source = join(dir, 'test.mkv');
  await exec('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','80','-c:v','libx264','-preset','ultrafast','-g','50','-c:a','aac','-y',source]);
  const { id } = await sessions.start({ inputUrl: source, hash: 'test', startSec: 8 });
  const playlist = await sessions.read(id, 'index.m3u8', 'a&b');
  assert.match(playlist.body.toString(), /#EXTM3U/);
  const seconds=[...playlist.body.toString().matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum,m)=>sum+Number(m[1]),0);
  assert.ok(seconds>=60,'publish a full minute of playable segments before starting the TV');
  assert.match(playlist.body.toString(), /segment000000.ts\?key=a%26b/);
  const segment = await sessions.read(id, 'segment000000.ts');
  assert.ok(segment.body.length > 1000);
  const location = sessions.sessions.get(id).directory;
  const { stdout } = await exec('ffprobe', ['-v','error','-show_entries','stream=codec_name','-of','json',join(location,'segment000000.ts')]);
  const codecs = JSON.parse(stdout).streams.map(s => s.codec_name);
  assert.ok(codecs.includes('h264')); assert.ok(codecs.includes('aac'));
  assert.equal(await sessions.read(id, '../secret'), null);
  await sessions.stop(id);
  assert.equal(sessions.sessions.size, 0);
  await assert.rejects(stat(location), { code: 'ENOENT' });
 } finally { await sessions.close(); await rm(dir,{recursive:true,force:true}); }
});

test('HLS preparation can be cancelled without leaving a process or directory', async () => {
 const sessions = new HlsSessions();
 const controller = new AbortController(); controller.abort();
 try {
  await assert.rejects(sessions.start({ inputUrl:'/unused', hash:'cancel', signal:controller.signal }), /cancelled/);
  assert.equal(sessions.sessions.size, 0);
 } finally { await sessions.close(); }
});

test('playlist, segment, start, and stop endpoints require the helper key', () => {
 for (const path of ['/hls/start','/hls/stop','/hls/abc/index.m3u8','/hls/abc/segment000000.ts']) {
  assert.equal(helperRequestAllowed({pathname:path,searchParams:new URLSearchParams(),requiredKey:'secret'}),false);
  assert.equal(helperRequestAllowed({pathname:path,searchParams:new URLSearchParams('key=secret'),requiredKey:'secret'}),true);
 }
});
