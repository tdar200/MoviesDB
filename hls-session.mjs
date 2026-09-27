import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function ffprobeJson(args) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', ...args, '-of', 'json'], { timeout: 30000 });
  return JSON.parse(stdout);
}

// With stream-copy HLS, an input seek begins on the preceding video keyframe.
// MPEG-TS then rebases that keyframe to a small positive timestamp (normally
// around 1.4s). The browser's media clock therefore maps to source time as:
//   source time = preceding keyframe + media time - first segment start time
// Return that source-time base so sidecar subtitles and saved progress use the
// same clock as the frames that actually reached the TV.
async function mediaStartForSubtitles({ inputUrl, startSec, directory, transcode }) {
  if (!(startSec > 0)) return 0;
  try {
    let sourceStart = startSec;
    if (!transcode) {
      const source = await ffprobeJson([
        '-read_intervals', `${startSec}%+#1`, '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time,flags', inputUrl,
      ]);
      const first = source.packets?.[0];
      if (!first || !String(first.flags || '').includes('K')) throw new Error('no seek keyframe');
      sourceStart = Number(first.pts_time);
    }
    const segment = await ffprobeJson([
      '-select_streams', 'v:0', '-show_entries', 'stream=start_time',
      join(directory, 'segment000000.ts'),
    ]);
    const segmentStart = Number(segment.streams?.[0]?.start_time);
    if (!Number.isFinite(sourceStart) || !Number.isFinite(segmentStart)) throw new Error('missing media timestamp');
    return Math.max(0, Math.round((sourceStart - segmentStart) * 1000) / 1000);
  } catch (error) {
    console.warn(`[hls] could not measure subtitle seek base: ${error.message}`);
    return startSec;
  }
}

// Each playback/seek gets an isolated segment directory. FFmpeg reads through
// the torrent's HTTP Range endpoint, so missing pieces WAIT rather than reading
// zeros from a partially downloaded file on disk.
export class HlsSessions {
  constructor({ startupMs = 90000, idleMs = 30 * 60000, maxSessions = 4, startupBufferSec, tmpDir } = {}) {
    this.sessions = new Map();
    this.startupMs = startupMs;
    this.idleMs = idleMs;
    this.maxSessions = maxSessions;
    // Segment scratch dir. Defaults to the OS temp dir, but the server points this at
    // the roomy cache partition so remuxing can't fill a near-full root filesystem.
    this.tmpDir = tmpDir || tmpdir();
    // Seconds of remuxed video to buffer before publishing the playlist. 60s was
    // was too long over the relay. LAN-direct playback now makes a 30-second reserve
    // practical, absorbing swarm and Wi-Fi dips before the TV starts.
    this.startupBufferSec = Number(startupBufferSec || process.env.HLS_STARTUP_BUFFER_SEC || 30);
    this.sweep = setInterval(() => {
      for (const [id, session] of this.sessions) if (Date.now() - session.accessed > idleMs) this.stop(id);
    }, 60000);
    this.sweep.unref();
  }
  async start({ inputUrl, hash, startSec = 0, signal, transcode = false, encoder = 'h264_nvenc', gpuDecode = true }) {
    // Over the cap, evict the least-recently-accessed session rather than refusing
    // the new play — refusing left the previous "Too many players" failures, and an
    // evicted idle session is almost always a stale one, not what's on screen.
    if (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.accessed - b.accessed)[0];
      if (oldest) await this.stop(oldest.id);
    }
    const id = randomUUID();
    const session = { id, hash, accessed: Date.now(), stopped: false, directory: null, child: null, error: null, ended: false };
    this.sessions.set(id, session);
    const abort = () => { void this.stop(id); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      session.directory = await mkdtemp(join(this.tmpDir, 'moviesdb-hls-'));
      if (signal?.aborted || session.stopped) throw new Error('Playback cancelled');
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
      // A torrent reader can legitimately pause while WebTorrent fetches the next
      // piece. FFmpeg's 30-second HTTP read timeout turned that pause into a cleanly
      // ended, truncated HLS playlist (for example, 10:04 of a 22:23 episode).
      // Playback health already stops stuck sessions, so let the local reader wait.
      if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(inputUrl)) {
        args.push('-rw_timeout', '30000000');
      }
      // HEVC the TV can't decode is transcoded to H.264 into the SAME HLS pipeline.
      // HLS (small segment files) is what streams cleanly through the Tailscale funnel
      // to the TV — a single long-lived /transcode response gets buffered by the funnel
      // and never reaches the player. GPU decode+encode keeps this near real time.
      if (transcode && gpuDecode) args.push('-hwaccel', 'cuda', '-c:v', 'hevc_cuvid');
      if (startSec > 0) args.push('-ss', String(startSec));
      // ~4 Mbit fits the throttled funnel with headroom (1080p on a TV still looks
      // fine); a higher target just invites buffering. Override with TRANSCODE_BITRATE.
      const vb = process.env.TRANSCODE_BITRATE || '4M';
      const vmax = process.env.TRANSCODE_MAXRATE || '6M';
      const preset = encoder.includes('nvenc') ? 'p4' : 'veryfast';
      const videoCodec = transcode
        ? ['-c:v', encoder, '-preset', preset, '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-b:v', vb, '-maxrate', vmax, '-bufsize', '8M']
        : ['-c:v', 'copy'];
      // Do not rely on MPEG-TS auto-detection: an MP4 whose first NAL is a
      // one-byte SEI starts with 00 00 00 01 and is mistaken for Annex B.
      // Explicit conversion preserves the H.264 headers and packet framing.
      args.push('-i', inputUrl, '-map', '0:v:0', '-map', '0:a:0?',
        ...videoCodec, '-bsf:v', 'h264_mp4toannexb', '-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-sn',
        '-avoid_negative_ts', 'make_zero', '-f', 'hls', '-hls_time', '8',
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
        if (!session.stopped && stderr.trim()) {
          console.warn(`[hls] ffmpeg exited ${code}: ${stderr.trim()}`);
        }
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
        if (bufferedSeconds >= this.startupBufferSec || (playlist.includes('#EXT-X-ENDLIST') && playlist.includes('#EXTINF:'))) {
          const mediaStartSec = await mediaStartForSubtitles({ inputUrl, startSec, directory: session.directory, transcode });
          session.requestedStartSec = startSec;
          session.mediaStartSec = mediaStartSec;
          return { id, startSec, mediaStartSec };
        }
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
  subtitleStart(hash, requestedStartSec) {
    if (!(requestedStartSec > 0)) return 0;
    const match = [...this.sessions.values()].find(session => session.hash === hash
      && session.requestedStartSec === requestedStartSec && Number.isFinite(session.mediaStartSec));
    return match ? match.mediaStartSec : requestedStartSec;
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
  // A torrent with a live session is still serving segments (already remuxed to
  // disk) even after ffmpeg stopped reading it — so it must not be swept.
  hasHash(hash) { for (const s of this.sessions.values()) if (s.hash === hash) return true; return false; }
  async close() { clearInterval(this.sweep); await Promise.all([...this.sessions.keys()].map(id => this.stop(id))); }
}
