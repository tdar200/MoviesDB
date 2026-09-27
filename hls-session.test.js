import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HlsSessions } from './hls-session.mjs';
import { helperRequestAllowed } from './helper-auth.js';
const exec = promisify(execFile);

test('HLS prepares decodable segments, authenticates their URLs, seeks, and cleans up', { timeout: 60000 }, async () => {
 const dir = await mkdtemp(join(tmpdir(), 'movies-hls-test-'));
 const sessions = new HlsSessions();
 try {
  const source = join(dir, 'test.mkv');
  await exec('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','80','-c:v','libx264','-preset','ultrafast','-g','50','-c:a','aac','-y',source]);
  const { id, mediaStartSec } = await sessions.start({ inputUrl: source, hash: 'test', startSec: 8 });
  assert.ok(mediaStartSec < 8, 'subtitle clock accounts for the preceding keyframe and TS timestamp base');
  assert.ok(mediaStartSec > 4, 'measured subtitle clock remains near the requested seek');
  assert.equal(sessions.subtitleStart('test', 8), mediaStartSec);
  assert.equal(sessions.subtitleStart('other', 8), 8, 'unrelated sessions retain the requested shift');
  const playlist = await sessions.read(id, 'index.m3u8', 'a&b');
  assert.match(playlist.body.toString(), /#EXTM3U/);
  const seconds=[...playlist.body.toString().matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum,m)=>sum+Number(m[1]),0);
  // Publish a 30-second reserve before starting the TV so short swarm or Wi-Fi dips
  // do not drain the native player's buffer.
  assert.ok(seconds>=30,'publish a 30-second reserve of playable segments before starting the TV');
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

// A one-byte initial SEI NAL has the AVCC length prefix 00 00 00 01.
// FFmpeg's automatic filter detection mistakes that for an Annex B start code
// and copies the remaining length-prefixed packets into invalid MPEG-TS video.
test('HLS converts MP4 video when its first NAL length resembles an Annex B start code', { timeout: 60000 }, async () => {
 const dir = await mkdtemp(join(tmpdir(), 'movies-hls-avcc-test-'));
 const sessions = new HlsSessions({ startupBufferSec: 8 });
 try {
  const source = join(dir, 'test.mp4');
  await exec('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','12','-c:v','libx264','-preset','ultrafast','-g','50','-c:a','aac','-y',source]);
  const { stdout } = await exec('ffprobe', ['-v','error','-select_streams','v:0','-read_intervals','%+#1','-show_entries','packet=pos','-of','json',source]);
  const offset = Number(JSON.parse(stdout).packets[0].pos);
  const bytes = await readFile(source);
  const nalLength = bytes.readUInt32BE(offset);
  assert.equal(bytes[offset + 4] & 31, 6, 'fixture starts with an SEI NAL');
  assert.ok(nalLength > 6);
  // Replace the encoder's optional SEI with an empty SEI and a filler NAL of
  // equal total size, preserving every MP4 sample size and chunk offset.
  bytes.writeUInt32BE(1, offset);
  bytes.writeUInt32BE(nalLength - 5, offset + 5);
  bytes[offset + 9] = 12;
  bytes.fill(255, offset + 10, offset + 4 + nalLength);
  bytes[offset + 3 + nalLength] = 128;
  await writeFile(source, bytes);
  await exec('ffmpeg', ['-v','error','-xerror','-i',source,'-frames:v','1','-f','null','-']);

  const { id } = await sessions.start({ inputUrl: source, hash: 'avcc-prefix' });
  const segment = join(sessions.sessions.get(id).directory, 'segment000000.ts');
  // A codec label alone passes for the broken stream; actually decode a frame.
  await exec('ffmpeg', ['-v','error','-xerror','-i',segment,'-frames:v','1','-f','null','-']);
  const probe = await exec('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',segment]);
  assert.equal(JSON.parse(probe.stdout).streams[0].width, 320);
  assert.equal(JSON.parse(probe.stdout).streams[0].height, 180);
 } finally { await sessions.close(); await rm(dir,{recursive:true,force:true}); }
});
