import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureTsHeight } from './live-measure.mjs';

const exec = promisify(execFile);

test('measureTsHeight reads the true height from the first bytes of a TS segment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-measure-'));
  try {
    const file = join(dir, 'seg.ts');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-f', 'mpegts', '-y', file]);
    const bytes = new Uint8Array(await readFile(file)).subarray(0, 64 * 1024);
    assert.equal(await measureTsHeight(bytes), 360);
    assert.equal(await measureTsHeight(new Uint8Array(1000)), 0, 'garbage -> 0, not a throw');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('measureTsHeight gives up after its timeout', async () => {
  const hang = () => ({ stdin: { on() {}, end() {} }, stdout: { on() {} }, on() {}, kill() {} });
  const t0 = Date.now();
  assert.equal(await measureTsHeight(new Uint8Array(10), { spawnImpl: hang, timeoutMs: 50 }), 0);
  assert.ok(Date.now() - t0 < 1000);
});
