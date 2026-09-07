import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Each playback/seek gets an isolated segment directory. FFmpeg reads through
// the torrent's HTTP Range endpoint, so missing pieces WAIT rather than reading
// zeros from a partially downloaded file on disk.
export class HlsSessions {
  constructor({ startupMs = 90000, idleMs = 15 * 60000, maxSessions = 4 } = {}) {
    this.sessions = new Map();
    this.startupMs = startupMs;
    this.idleMs = idleMs;
    this.maxSessions = maxSessions;
    this.sweep = setInterval(() => {
      for (const [id, session] of this.sessions) if (Date.now() - session.accessed > idleMs) this.stop(id);
    }, 60000);
    this.sweep.unref();
  }
  async start({ inputUrl, hash, startSec = 0, signal }) {
    if (this.sessions.size >= this.maxSessions) throw new Error('Too many active players. Close another player and retry.');
    const id = randomUUID();
    const session = { id, hash, accessed: Date.now(), stopped: false, directory: null, child: null, error: null, ended: false };
    this.sessions.set(id, session);
    const abort = () => { void this.stop(id); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      session.directory = await mkdtemp(join(tmpdir(), 'moviesdb-hls-'));
      if (signal?.aborted || session.stopped) throw new Error('Playback cancelled');
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '30000000'];
      if (startSec > 0) args.push('-ss', String(startSec));
      args.push('-i', inputUrl, '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-sn',
        '-avoid_negative_ts', 'make_zero', '-f', 'hls', '-hls_time', '4',
        '-hls_list_size', '0', '-hls_playlist_type', 'event',
        '-hls_flags', 'temp_file',
        '-hls_segment_filename', join(session.directory, 'segment%06d.ts'),
        join(session.directory, 'index.m3u8'));
      const child = session.child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', error => { session.error = error; });
      child.on('close', code => {
        session.ended = true;
        if (code && !session.stopped) session.error = new Error('The source stopped producing playable video.');
      });
      const deadline = Date.now() + this.startupMs;
      while (Date.now() < deadline) {
        if (signal?.aborted || session.stopped) throw new Error('Playback cancelled');
        if (session.error) throw session.error;
        let playlist = '';
        try { playlist = await readFile(join(session.directory, 'index.m3u8'), 'utf8'); } catch { /* first segment pending */ }
        // Give the native TV player a real buffer before publishing the playlist.
        const bufferedSeconds = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
        if (bufferedSeconds >= 60 || (playlist.includes('#EXT-X-ENDLIST') && playlist.includes('#EXTINF:'))) return { id, startSec };
        if (session.ended) throw new Error('The source contains no playable video.');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error('This source is too slow to prepare playback.');
    } catch (error) {
      await this.stop(id);
      // An abort may happen during mkdtemp, after stop observed directory=null.
      if (session.directory) await rm(session.directory, { recursive: true, force: true });
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async read(id, filename, key = '') {
    const session = this.sessions.get(id);
    if (!session || session.stopped) return null;
    if (filename !== 'index.m3u8' && !/^segment\d{6}\.ts$/.test(filename)) return null;
    session.accessed = Date.now();
    try {
      const body = await readFile(join(session.directory, filename));
      if (filename !== 'index.m3u8') return { body, type: 'video/mp2t' };
      // Authenticate EACH segment; a relative URL does not inherit query params.
      const text = body.toString().replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES').replace(/^(segment\d{6}\.ts)$/gm, name => `${name}?key=${encodeURIComponent(key)}`);
      return { body: Buffer.from(text), type: 'application/vnd.apple.mpegurl' };
    } catch { return null; }
  }
  async stop(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.stopped = true;
    if (session.child && session.child.exitCode === null) {
      const closed = new Promise(resolve => session.child.once('close', resolve));
      session.child.kill('SIGKILL');
      await closed;
    }
    if (session.directory) await rm(session.directory, { recursive: true, force: true });
  }
  async stopHash(hash) { await Promise.all([...this.sessions.values()].filter(s => s.hash === hash).map(s => this.stop(s.id))); }
  async close() { clearInterval(this.sweep); await Promise.all([...this.sessions.keys()].map(id => this.stop(id))); }
}
