// live-measure.mjs — true video height of a live stream from a sample of its
// first segment. Stream labels and even master-playlist RESOLUTION attributes
// were wrong for most streams measured on 27 Sep 2026; the H.264 SPS is not.
import { spawn } from 'node:child_process';

export function measureTsHeight(bytes, { spawnImpl = spawn, timeoutMs = 4000 } = {}) {
  return new Promise(resolve => {
    let out = '';
    let settled = false;
    const done = h => { if (!settled) { settled = true; clearTimeout(timer); resolve(h); } };
    let p;
    try {
      p = spawnImpl('ffprobe', ['-v', 'error', '-f', 'mpegts', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', '-i', 'pipe:0'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { resolve(0); return; }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } done(0); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => done(0));
    p.on('close', () => { const h = parseInt(String(out).trim().split(/\s+/)[0], 10); done(Number.isFinite(h) && h > 0 ? h : 0); });
    p.stdin.on('error', () => { /* ffprobe may close early */ });
    p.stdin.end(Buffer.from(bytes));
  });
}
