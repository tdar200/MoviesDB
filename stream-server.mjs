// Local helper for the YTS (Torrent) source.
//
// Why this exists: a browser cannot stream a YTS torrent on its own. Browser
// WebTorrent only talks to WebRTC peers, but YTS swarms are classic BitTorrent
// (TCP/uTP) clients the browser can't reach. And the YTS API has no CORS
// headers, so the page can't even query it. This Node process bridges both:
//   - serves the static app (so the page + stream share one origin)
//   - GET /yts?imdb=tt..   -> proxies the YTS API and adds CORS
//   - GET /stream?hash=..  -> adds the magnet via the real BitTorrent client
//                             and pipes the video file with HTTP Range support
//   - GET /stream-stop?hash=.. -> tears the torrent down
//
// Deliberately NOT deployable to Vercel: it's a long-lived, stateful process
// holding peer sockets for the whole viewing session. Run it locally with
// `npm start`.

import http from 'node:http';
import { startTvProviderCompat } from './tv-provider-compat.mjs';
import { CONFIG } from './config.js';
import { parseByteRange } from './http-range.js';
import { HlsSessions } from './hls-session.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statfsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';
import { createYtsHandler } from './catalog-handlers.mjs';
import { fetchYtsMovie } from './yts-api.mjs';
import { isSubtitleFile, subtitleLabel, srtToVtt, decodeSubtitle, shiftVtt, cleanSubtitleVtt } from './subtitles.js';
import { fetchMovieSources, fetchTvSources, isRemuxableTvFile, isTranscodableTvFile, pickEpisodeFile, pickEpisodeVideoFile, pickMovieFileByIndex } from './tv-api.mjs';
import { createResolvingFetch, fetchViaPublicDns } from './dns-fetch.js';
import { pieceWindow } from './stream-window.mjs';
import { helperRequestAllowed } from './helper-auth.js';
import { clampReadyTimeout, deferFailedSources, rememberSourceFailure } from './tv-fallback.js';
import { lanBaseUrl } from './lan-info.mjs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createFixturesFeed } from './live-fixtures.mjs';
import { createSourceRegistry } from './live-sources.mjs';
import { createNuvioAdapter } from './live-source-nuvio.mjs';
import { selectTodayFixtures, joinFixtures, sortMatches } from './live-match.mjs';
import { createChannelFeed } from './live-channels.mjs';
import { verifyUpstream, isPublicHttpUrl, relayPath, rewritePlaylist, upstreamHeaders } from './live-relay.mjs';
import { measureTsHeight } from './live-measure.mjs';
import { createHighflyAdapter } from './live-source-highfly.mjs';
import { probeStream, createStreamHealth, BLOCKED_TARGET } from './live-health.mjs';
import {
  parseEmbeddedSubStreams, embeddedTrackLabel,
  fileTrackId, embeddedTrackId, externalTrackId, stremioTrackId, ytsSubtitleTrackId, parseTrackId,
} from './subtitle-tracks.js';
import { searchSubtitle, fetchSubtitleText, searchStremioSubtitle, fetchStremioSubtitleText, searchYtsSubtitle, fetchYtsSubtitleText } from './opensubtitles.mjs';

const PORT = process.env.PORT || 3000;
// Access key for the API endpoints. Empty = open (local npm start). Set it when
// the helper is published beyond your own machines (see helper-auth.js).
const HELPER_KEY = process.env.HELPER_KEY || '';

// External subtitles fill the gap when a torrent ships none. A configured
// OpenSubtitles.com key is preferred; the official Stremio OpenSubtitles add-on
// supplies a no-key fallback. Results and converted VTT are cached in memory.
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY || '';
const osSearchCache = new Map(); // "imdb|s|e" -> { fileId, release, lang } | null
const osVttCache = new Map();    // fileId -> converted WebVTT string
const stremioSearchCache = new Map();
const stremioSubtitleUrls = new Map();
const ytsSubtitleSearchCache = new Map();
const ytsSubtitleUrls = new Map();
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const READY_TIMEOUT_MS = 60_000;
const failedTvSources = new Map();

// Where torrent data and HLS segments live. The root filesystem is chronically
// ~full (Docker), so downloads there stall playback the moment it hits zero. Prefer
// the roomy /mnt/data partition; fall back to the OS temp dir. Override with
// MEDIA_CACHE_DIR. A disk guard (below) evicts torrents if this ever runs low.
const CACHE_ROOT = process.env.MEDIA_CACHE_DIR
  || (existsSync('/mnt/data') ? '/mnt/data/moviesdb-cache' : join(tmpdir(), 'moviesdb-cache'));
const TORRENT_DIR = join(CACHE_ROOT, 'webtorrent');
const HLS_DIR = join(CACHE_ROOT, 'hls');
try { mkdirSync(TORRENT_DIR, { recursive: true }); mkdirSync(HLS_DIR, { recursive: true }); } catch { /* fall back to defaults if unwritable */ }
const DISK_FLOOR_BYTES = Number(process.env.MEDIA_DISK_FLOOR_BYTES || 4 * 1024 * 1024 * 1024); // keep >=4 GB free
function freeBytes(path = CACHE_ROOT) {
  try { const s = statfsSync(path); return s.bavail * s.bsize; } catch { return Infinity; }
}
const handleYts = createYtsHandler(fetchYtsMovie);

// HEVC/x265 the browser can't decode is transcoded to H.264 on the fly. Default to software H.264 on this host: a CUDA/driver mismatch can make NVENC hang
// until the TV startup deadline. Set TRANSCODE_ENCODER=h264_nvenc after repairing CUDA.
const TRANSCODE_ENCODER = process.env.TRANSCODE_ENCODER || 'libx264';
const TRANSCODE_GPU_DECODE = TRANSCODE_ENCODER.includes('nvenc') && process.env.TRANSCODE_GPU_DECODE !== '0';

// Debrid stream URLs (Real-Debrid et al.) go through the same DNS-workaround the
// torrent indexes use: the index host is frequently ISP-poisoned, and the URL
// may 302 to the real file. resolveDebridInput follows redirects to the final,
// directly-fetchable URL so ffmpeg (which uses plain system DNS) can read it.
const resolvingFetch = createResolvingFetch();

// Live football (see docs/superpowers/specs/2026-09-27-live-football-design.md).
// The relay only accepts upstream URLs signed with this secret; with no HELPER_KEY
// (local npm start) a per-process random secret still prevents open-proxy use.
const LIVE_SECRET = HELPER_KEY || randomBytes(16).toString('hex');
const LIVE_ALLOW_PRIVATE = process.env.LIVE_RELAY_ALLOW_PRIVATE === '1'; // integration test only
// Live traffic uses plain fetch (system resolver), never resolvingFetch: the spec
// forbids routing around ISP blocks, so there is no public-DNS fallback here.
const liveFetch = (url, opts) => fetch(url, opts);
const liveFixtures = createFixturesFeed({ fetchImpl: liveFetch });
// Highfly first: it states true resolution and delivered 1080p for every live
// Nations League match on 27 Sep 2026; Nuvio covers more matches at lower quality.
const liveSources = createSourceRegistry([createHighflyAdapter({ fetchImpl: liveFetch }), createNuvioAdapter({ fetchImpl: liveFetch })]);
// Channels are probed down to a segment and measured, so the Channels row can
// list the sharpest first; 16 at a time keeps the first (cold) fetch near 20 s.
const liveChannels = createChannelFeed({
  fetchImpl: liveFetch,
  concurrency: 16,
  probe: url => probeStream({ url, referer: '', origin: '' }, {
    fetchUpstream: async (u, headers, signal) => {
      if (!LIVE_ALLOW_PRIVATE && !isPublicHttpUrl(u)) throw Object.assign(new Error('non-public target'), { name: BLOCKED_TARGET });
      return (await fetchUpstreamGuarded(u, { ...upstreamHeaders('', ''), ...headers }, signal)).upstream;
    },
    timeoutMs: 6000,
    measureHeight: bytes => measureTsHeight(bytes),
  }),
});
// Probe each stream once (2-min cache) so /live/streams drops broken ones and
// lists playable ones first; see live-health.mjs for the 2026-09-27 measurements.
const liveHealth = createStreamHealth({
  probe: s => probeStream(s, {
    // Every probe URL (the stream url from Nuvio, and variant/segment URLs from
    // untrusted playlist text) gets the same public-target check as liveRelayParams
    // before any request; fetchUpstreamGuarded itself only guards redirect hops.
    fetchUpstream: async (u, headers, signal) => {
      if (!LIVE_ALLOW_PRIVATE && !isPublicHttpUrl(u)) throw Object.assign(new Error('non-public target'), { name: BLOCKED_TARGET });
      return (await fetchUpstreamGuarded(u, { ...upstreamHeaders(s.referer, s.origin), ...headers }, signal)).upstream;
    },
    // Nuvio's playlist wrapper took 1.7-7.8 s at peak (27 Sep 2026); 5 s marked
    // working streams as timed out. 12 s covers the playlist plus first bytes.
    timeoutMs: 12000,
    // Read the real height from the segment (labels were wrong for most streams).
    measureHeight: bytes => measureTsHeight(bytes),
  }),
  // One wave for a typical match list, so the longer probe does not add waves.
  concurrency: 32,
});
const LIVE_JSON = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
const liveJson = (res, status, body) => { res.writeHead(status, LIVE_JSON); res.end(JSON.stringify(body)); };
// Feed modules call fetch with no signal and undici can wait ~300 s, so every feed
// call a route awaits gets a deadline here.
// A polling TV must never pile up hung requests.
const LIVE_FEED_DEADLINE_MS = 8000;
const LIVE_CHANNELS_DEADLINE_MS = 30000; // first fetch probes each listed channel (6 s + measure), 16 at a time
// Nuvio resolves streams on demand; measured 5-37 s per match at peak (27 Sep 2026).
const LIVE_STREAMS_DEADLINE_MS = 45000;
// Source catalogs: the Nuvio adapter gives up after 10 s and serves its last good
// list, so 12 s leaves it room while staying inside the TV's 15 s budget.
const LIVE_SOURCES_DEADLINE_MS = 12000;
function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'LIVE_TIMEOUT', label })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const isLiveTimeout = err => err && err.code === 'LIVE_TIMEOUT';
const localDate = (ms, dayOffset = 0) => { const d = new Date(ms + dayOffset * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Only https, only public hosts: `src` is fetched server-side, so block the
// obvious SSRF targets even though the endpoint already requires the access key.
function isSafeDebridUrl(raw) {
  return isPublicHttpUrl(raw, ['https:']);
}

async function resolveDebridInput(src, signal) {
  if (!isSafeDebridUrl(src)) throw new Error('unsafe or non-https debrid url');
  // A ranged GET both follows redirects to the final URL and confirms the file
  // is actually reachable; we read nothing (immediately cancel the body).
  const res = await resolvingFetch(src, {
    headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-1' },
    redirect: 'follow',
    signal,
  });
  try { await res.body?.cancel?.(); } catch { /* best effort */ }
  if (!res.ok && res.status !== 206) throw new Error(`debrid url returned HTTP ${res.status}`);
  const finalUrl = res.url && /^https?:\/\//i.test(res.url) ? res.url : src;
  if (!isSafeDebridUrl(finalUrl)) throw new Error('debrid url redirected to an unsafe host');
  return finalUrl;
}

// Seeding is unlimited by default, and it competes for the SAME uplink this
// helper uses to serve video to other devices. On this line that uplink is
// 16.2 Mbit total, so an unthrottled swarm can starve the stream it is feeding.
// Cap it well below the line and leave the rest for playback. Bytes per second;
// set TORRENT_UPLOAD_LIMIT=-1 to restore unlimited seeding.
const UPLOAD_LIMIT = Number.parseInt(process.env.TORRENT_UPLOAD_LIMIT ?? '262144', 10);

// Download is the bigger offender: an unthrottled swarm pulls at the full line
// rate (measured ~16 Mbit here), and on this box the same congested Wi-Fi carries
// both that download AND the HLS upload to the TV — so a flat-out download starves
// the stream it is feeding, which is exactly the "buffers forever" symptom. A
// stream only needs to stay a little ahead of the playhead: 1.5 MB/s is ~6x the
// average bitrate and comfortably above even high-bitrate peaks, while leaving the
// link airtime for playback. Bytes per second; TORRENT_DOWNLOAD_LIMIT=-1 restores
// unlimited (use that once this box is on wired ethernet, where there is headroom).
const DOWNLOAD_LIMIT = Number.parseInt(process.env.TORRENT_DOWNLOAD_LIMIT ?? '1572864', 10);

// maxConns: allow more simultaneous peers per torrent (default 55) so the
// sequential playhead can pull from many seeders at once.
const client = new WebTorrent({
  maxConns: 150,
  uploadLimit: Number.isFinite(UPLOAD_LIMIT) ? UPLOAD_LIMIT : 262144,
  downloadLimit: Number.isFinite(DOWNLOAD_LIMIT) ? DOWNLOAD_LIMIT : 1572864,
});
const hlsSessions = new HlsSessions({ tmpDir: HLS_DIR });
// The app can be served from a different origin than the stream helper (e.g. the UI
// hosted on Vercel while streams still come from this machine). The provider bridge
// must match the app's actual origin, so it is configurable and defaults to the
// helper's own origin for the classic same-origin setup.
const TV_APP_ORIGIN = process.env.TV_APP_ORIGIN || CONFIG.STREAM_HELPER_BASE;
const stopTvProviderCompat = process.env.TV_PROVIDER_BRIDGE === '0' ? () => {} : startTvProviderCompat({ device: process.env.TV_DEVICE || 'lgtv', appOrigin: TV_APP_ORIGIN });
const torrents = new Map(); // infoHash(lowercase) -> torrent

// Public BitTorrent trackers, folded into the magnet so the swarm is
// discoverable from just the infohash the YTS API returns. These are a
// current, known-alive set — dead trackers (coppersurfer, leechers-paradise,
// rarbg, gresille, glotorrents) just waste announce time and stall discovery.
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker2.dler.com:80/announce',
  'udp://tracker.bitsearch.to:1337/announce',
  'udp://pow7.com:80/announce',
  'udp://retracker.lanta-net.ru:2710/announce',
  'udp://explodie.org:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
];

function magnetFromHash(hash, name) {
  const tr = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name || hash)}${tr}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', // most browsers can't decode this; we prefer mp4 picks
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

const isVideoFile = (f) => /\.(mp4|m4v|mkv|webm|mov|avi)$/i.test(f.name);
// Containers a browser <video> can actually decode natively.
const isPlayableName = (name) => /\.(mp4|m4v|webm)$/i.test(name);

// Largest video file in a torrent, preferring a browser-playable container so
// a torrent that happens to bundle both .mp4 and .mkv picks the playable one.
function pickVideoFile(torrent) {
  const vids = torrent.files.filter(isVideoFile).sort((a, b) => b.length - a.length);
  return vids.find((f) => isPlayableName(f.name)) || vids[0] || null;
}

// Historic/rare packs can have live peers while DHT no longer returns their
// metadata. iTorrents caches the original bencoded metadata by infohash; using
// it as the torrent id skips that deadlock while peer data still flows P2P.
const VERIFIED_TORRENT_METADATA = new Map([
  ['fe1d4208f36e9a1f1c2e771ee5e4e4734d6cf305', 'https://itorrents.net/torrent/FE1D4208F36E9A1F1C2E771EE5E4E4734D6CF305.torrent'],
  ['74317662682c0f54cb076bd690cdc53e13512e6a', 'https://itorrents.net/torrent/74317662682C0F54CB076BD690CDC53E13512E6A.torrent'],
]);
function getTorrent(hash, name, readyTimeoutMs = READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const existing = torrents.get(hash);
    if (existing) {
      if (existing.ready) return resolve(existing);
      // A torrent already in the map but not yet ready is one an earlier request
      // added and that never found peers. Without the same timeout as a fresh
      // add, every retry of a dead hash waits forever — which is exactly what a
      // user sees as "Connecting to peers…" that never ends or fails.
      let done = false;
      const waitTimer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('timed out finding peers'));
      }, readyTimeoutMs);
      existing.once('ready', () => {
        if (done) return;
        done = true;
        clearTimeout(waitTimer);
        resolve(existing);
      });
      existing.once('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(waitTimer);
        reject(err);
      });
      return;
    }
    const torrentId = VERIFIED_TORRENT_METADATA.get(hash) || magnetFromHash(hash, name);
    const t = client.add(torrentId, { path: TORRENT_DIR });
    torrents.set(hash, t);
    // Stamp access on add: until the caller acquires a reader (after this promise
    // resolves, up to 60s later while finding peers), the torrent would otherwise
    // read as last=0 → infinitely idle → evicted mid-connect by the disk guard.
    torrentAccess.set(hash, Date.now());
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('timed out finding peers'));
    }, readyTimeoutMs);
    t.once('ready', () => {
      // Sequential streaming: turn OFF the default rarest-first whole-file
      // download. Otherwise all peer bandwidth is scattered across pieces far
      // from the playhead (measured: ~180 KB/s, 65s to first 2 MB). With the
      // background deselected, a created read stream pulls its bytes in order
      // and every peer feeds the playhead — far faster time-to-first-frame.
      try { t.deselect(0, t.pieces.length - 1); } catch { /* ignore */ }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(t);
    });
    t.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      torrents.delete(hash);
      reject(err);
    });
  });
}

// Per-torrent access tracking so idle torrents can be evicted. Torrents were only
// ever freed on an explicit /stream-stop; without this the webtorrent client grows
// unbounded over a session (measured at 6.5 GB), which starves the remux and turns
// playback into 504 timeouts. Both direct streams and the HLS remux (which reads
// through this same /stream endpoint) go through handleStream, so one refcount here
// covers every active reader.
const torrentReaders = new Map(); // hash -> active reader count
const torrentAccess = new Map();  // hash -> last-access timestamp
const TORRENT_IDLE_MS = 20 * 60000; // free a torrent idle this long with no reader/session
const TORRENT_MAX = 6;              // hard cap; evict least-recently-used idle torrents beyond it
const TORRENT_SWEEP_MS = 5 * 60000;
function acquireTorrent(hash) {
  torrentReaders.set(hash, (torrentReaders.get(hash) || 0) + 1);
  torrentAccess.set(hash, Date.now());
}
function releaseTorrent(hash) {
  const n = (torrentReaders.get(hash) || 1) - 1;
  if (n <= 0) torrentReaders.delete(hash); else torrentReaders.set(hash, n);
  torrentAccess.set(hash, Date.now());
}

function destroyTorrent(hash) {
  void hlsSessions.stopHash(hash);
  torrentReaders.delete(hash);
  torrentAccess.delete(hash);
  const t = torrents.get(hash);
  if (!t) return;
  torrents.delete(hash);
  for (const key of embeddedVttCache.keys()) if (key.startsWith(hash + ':')) embeddedVttCache.delete(key);
  try {
    t.destroy({ destroyStore: true });
  } catch {
    /* ignore */
  }
}

// A torrent is safe to free only when nothing is reading it (no live /stream or
// remux) AND no HLS session is still serving its already-remuxed segments.
function evictIdleTorrents() {
  const now = Date.now();
  // Disk guard: when the cache filesystem runs low, don't wait 20 minutes — free
  // every torrent nothing is actively reading right now. This is what stops a busy
  // session from filling the disk and freezing playback.
  const low = freeBytes() < DISK_FLOOR_BYTES;
  const idle = [];
  for (const hash of [...torrents.keys()]) {
    if ((torrentReaders.get(hash) || 0) > 0) continue;
    if (hlsSessions.hasHash(hash)) continue;
    const t = torrents.get(hash);
    // Never evict a torrent still connecting/finding peers — a reader is almost
    // certainly awaiting its metadata (getTorrent hasn't resolved yet).
    if (t && !t.ready) continue;
    const last = torrentAccess.get(hash) || 0;
    if (low || now - last >= TORRENT_IDLE_MS) { destroyTorrent(hash); continue; }
    idle.push([hash, last]);
  }
  // Hard cap: if still over the limit, drop the least-recently-used idle torrents.
  let over = torrents.size - TORRENT_MAX;
  if (over > 0) {
    idle.sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < idle.length && over > 0; i++, over--) destroyTorrent(idle[i][0]);
  }
  if (low) console.warn(`[disk] low space on ${CACHE_ROOT} (${(freeBytes() / 1e9).toFixed(1)} GB free); evicted idle torrents`);
}
setInterval(evictIdleTorrents, TORRENT_SWEEP_MS).unref();
// Check disk far more often than the 5-minute idle sweep so a fast download can't
// fill the disk between sweeps.
setInterval(() => { if (freeBytes() < DISK_FLOOR_BYTES) evictIdleTorrents(); }, 20000).unref();

// The file webtorrent is writing to on disk. Embedded-subtitle extraction and
// seek-by-timestamp both need a real seekable file, not the on-demand stream.
function diskPathOf(torrent, file) {
  return join(torrent.path, file.path);
}

// ffprobe the video: total duration (for the seek bar) and its embedded text
// subtitle streams. The header carries all of this and downloads first, so this
// answers quickly even mid-download.
function probeVideo(diskPath) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-show_streams', '-of', 'json', diskPath,
    ]);
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', () => resolve({ duration: 0, subStreams: [] }));
    p.on('close', () => {
      try {
        const j = JSON.parse(out || '{}');
        resolve({
          duration: Number(j.format?.duration) || 0,
          subStreams: parseEmbeddedSubStreams(j.streams),
        });
      } catch {
        resolve({ duration: 0, subStreams: [] });
      }
    });
  });
}

// Extract one embedded subtitle stream as WebVTT, cached by torrent+stream so the
// ffmpeg pass runs once. Works on a partially-downloaded file: it yields cues for
// whatever contiguous prefix is on disk, which grows as the episode downloads.
const embeddedVttCache = new Map(); // `${hash}:${streamIndex}` -> { vtt, downloaded, at }
const EMBEDDED_VTT_REFRESH_MS = 60000;
const EMBEDDED_VTT_REFRESH_BYTES = 8 * 1024 * 1024;
function extractEmbeddedVtt(diskPath, streamIndex, cacheKey, downloaded = 0) {
  const hit = embeddedVttCache.get(cacheKey);
  // Native webOS reloads <track> frequently. Re-extract only after both a minute
  // and meaningful file growth; the cached cues remain valid in between.
  if (hit && (hit.downloaded === downloaded
    || Date.now() - hit.at < EMBEDDED_VTT_REFRESH_MS
    || downloaded - hit.downloaded < EMBEDDED_VTT_REFRESH_BYTES)) return Promise.resolve(hit.vtt);
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', diskPath, '-map', `0:${streamIndex}`, '-f', 'webvtt', 'pipe:1']);
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    p.on('error', (e) => reject(e));
    p.on('close', () => {
      // ffmpeg logs "File ended prematurely" on a partial file but still emits
      // valid VTT for the downloaded prefix, so trust the output, not the code.
      if (out.includes('-->')) { embeddedVttCache.set(cacheKey, { vtt: out, downloaded, at: Date.now() }); resolve(out); }
      else reject(new Error(err || 'no cues extracted'));
    });
  });
}

// GET /tv-torrents?imdb=..&season=..&episode=..  -> streamable sources for one episode.
// YTS is movies-only, so shows use Stremio-compatible torrent indexes. Native MP4
// is returned directly; H.264 MKV is remuxed locally to fragmented MP4.
async function handleTvTorrents(res, url) {
  const imdb = (url.searchParams.get('imdb') || '').trim();
  const season = Number.parseInt(url.searchParams.get('season') || '', 10);
  const episode = Number.parseInt(url.searchParams.get('episode') || '', 10);
  const year = Number.parseInt(url.searchParams.get('year') || '', 10);
  const country = (url.searchParams.get('country') || '').trim();
  if (!/^tt\d+$/.test(imdb) || !Number.isFinite(season) || !Number.isFinite(episode)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'need imdb=tt.., season=, episode=' }));
  }
  try {
    const rankedSources = await fetchTvSources(imdb, season, episode, {
      year: Number.isFinite(year) ? year : undefined,
      country,
      title: url.searchParams.get('title'),
      originalTitle: url.searchParams.get('originalTitle'),
    });
    const sources = deferFailedSources(rankedSources, failedTvSources);
    const provider = sources[0]?.provider ? ` via ${sources[0].provider}` : '';
    console.log(`[tv] ${imdb} S${season}E${episode} -> ${sources.length} streamable source(s)${provider}`);
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ sources }));
  } catch (err) {
    console.error(`[tv] lookup failed for ${imdb} S${season}E${episode}: ${err.message}`);
    res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: 'tv_index_unreachable', detail: err.message }));
  }
}

// GET /subtitles?hash=..  -> the subtitle tracks inside this torrent.
// YTS ships .srt sidecars (and often a Subs/ folder), so no external service or
// API key is involved: the files are already in the swarm we are downloading.
async function handleSubtitleList(res, url) {
  const hash = (url.searchParams.get('hash') || '').toLowerCase().trim();
  const name = url.searchParams.get('title') || '';
  if (!/^[a-f0-9]{40}$/.test(hash)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'invalid or missing hash' }));
  }
  // webtorrent selects every file the moment a torrent is added, so adding one
  // just to read its file list would start pulling the whole 2GB movie. If this
  // request is what introduced the torrent, deselect everything: listing needs
  // metadata only. An already-streaming torrent is left alone.
  // `streaming=1` means the caller is playing this torrent right now, so the video
  // file must stay selected. Without it, a subtitle request that beat the video's
  // own request to the server would deselect every file and the movie never
  // downloaded at all (observed Aug 19, 2026: the [subs] lines preceded [stream]).
  const streaming = url.searchParams.get('streaming') === '1';
  const isNewToUs = !torrents.has(hash) && !streaming;
  let torrent;
  try {
    torrent = await getTorrent(hash, name);
  } catch (err) {
    res.writeHead(504, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'torrent unavailable: ' + err.message }));
  }
  if (isNewToUs) torrent.files.forEach((f) => f.deselect());

  // Standalone subtitle files sitting in the torrent (YTS movies ship these).
  const tracks = torrent.files
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => isSubtitleFile(f.path || f.name))
    .map(({ f, index }) => ({ id: fileTrackId(index), ...subtitleLabel(f.path || f.name), bytes: f.length }));

  // Subtitles embedded INSIDE the .mkv (almost every TV release). Probe the exact
  // file that will be streamed for this episode, so a season pack does not offer
  // another episode's tracks. Also report the episode duration for the seek bar.
  let duration = 0;
  const s = Number.parseInt(url.searchParams.get('s') || '', 10);
  const e = Number.parseInt(url.searchParams.get('e') || '', 10);
  const requestedFileIndex = Number.parseInt(url.searchParams.get('file') || '', 10);
  const videoFile = (Number.isFinite(s) && Number.isFinite(e))
    ? pickEpisodeVideoFile(torrent.files, s, e)
    : Number.isInteger(requestedFileIndex)
      ? pickMovieFileByIndex(torrent.files, requestedFileIndex, '', true)
      : pickVideoFile(torrent);
  if (videoFile) {
    const vIndex = torrent.files.indexOf(videoFile);
    try {
      const info = await probeVideo(diskPathOf(torrent, videoFile));
      duration = info.duration;
      for (const st of info.subStreams) {
        tracks.push({ id: embeddedTrackId(vIndex, st.streamIndex), label: embeddedTrackLabel(st), embedded: true });
      }
    } catch { /* probe is best-effort; fall back to whatever files gave us */ }
  }

  // Nothing bundled and nothing embedded — reach out to OpenSubtitles. Cached
  // (including a null "searched, found nothing") so the app's retries and repeat
  // opens don't re-query. The actual subtitle text is fetched lazily by /subtitle.
  if (!tracks.length && OPENSUBTITLES_API_KEY) {
    const imdb = url.searchParams.get('imdb') || '';
    const cacheKey = `${imdb}|${Number.isFinite(s) ? s : ''}|${Number.isFinite(e) ? e : ''}`;
    try {
      let found = osSearchCache.get(cacheKey);
      if (!osSearchCache.has(cacheKey)) {
        found = await searchSubtitle({ apiKey: OPENSUBTITLES_API_KEY, imdbId: imdb, season: s, episode: e });
        osSearchCache.set(cacheKey, found || null);
      }
      if (found) {
        console.log(`[subs] opensubtitles match for ${imdb} -> file ${found.fileId} (${found.release})`);
        tracks.push({ id: externalTrackId(found.fileId), label: 'English (OpenSubtitles)', lang: found.lang || 'en', external: true });
      }
    } catch (err) { console.log('[subs] opensubtitles search failed:', err.message); }
  }

  // YTS Subs carries release-specific captions. Prefer its exact BluRay/WEBRip
  // match for YTS video files so captions do not drift between different cuts.
  if (!tracks.length && /\byts\b/i.test(videoFile?.name || '')) {
    const imdb = url.searchParams.get('imdb') || '';
    const cacheKey = `${imdb}|${videoFile?.name || ''}`;
    try {
      let found = ytsSubtitleSearchCache.get(cacheKey);
      if (!ytsSubtitleSearchCache.has(cacheKey)) {
        found = await searchYtsSubtitle({ imdbId: imdb, releaseName: videoFile?.name || '' }, resolvingFetch);
        ytsSubtitleSearchCache.set(cacheKey, found || null);
      }
      if (found) {
        ytsSubtitleUrls.set(found.fileId, found.url);
        console.log(`[subs] exact YTS match for ${imdb} -> ${found.fileId}`);
        tracks.push({ id: ytsSubtitleTrackId(found.fileId), label: 'English (release matched)', lang: 'en', external: true });
      }
    } catch (err) { console.log('[subs] YTS subtitle search failed:', err.message); }
  }

  // The official Stremio OpenSubtitles add-on exposes a public, no-key subtitle
  // resource. Use it after bundled/embedded tracks and the optional keyed API.
  if (!tracks.length) {
    const imdb = url.searchParams.get('imdb') || '';
    const cacheKey = `${imdb}|${Number.isFinite(s) ? s : ''}|${Number.isFinite(e) ? e : ''}`;
    try {
      let found = stremioSearchCache.get(cacheKey);
      if (!stremioSearchCache.has(cacheKey)) {
        found = await searchStremioSubtitle({ imdbId: imdb, season: s, episode: e, releaseName: videoFile?.name || '' }, resolvingFetch);
        stremioSearchCache.set(cacheKey, found || null);
      }
      if (found) {
        stremioSubtitleUrls.set(found.fileId, found.url);
        console.log(`[subs] no-key match for ${imdb} -> file ${found.fileId} (${found.release})`);
        tracks.push({ id: stremioTrackId(found.fileId), label: 'English', lang: found.lang || 'en', external: true });
      }
    } catch (err) { console.log('[subs] no-key search failed:', err.message); }
  }
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ tracks, duration }));
}

// GET /subtitle?hash=..&index=..  -> that file, converted to WebVTT.
// A <track> element accepts WebVTT only; served an .srt, Chrome reports no error
// and simply shows nothing, so the conversion has to happen here.
async function handleSubtitleFile(res, url) {
  const hash = (url.searchParams.get('hash') || '').toLowerCase().trim();
  // Prefer the stable track id (?id=f3 / e0:2); fall back to the legacy ?index=
  // for a file track so older clients keep working.
  const rawIndex = url.searchParams.get('index');
  const track = parseTrackId(url.searchParams.get('id') || (rawIndex != null ? fileTrackId(Number(rawIndex)) : ''));
  if (!/^[a-f0-9]{40}$/.test(hash) || !track) {
    res.writeHead(400);
    return res.end('invalid or missing hash/id');
  }
  // ?t=<seconds> shifts every cue earlier by that much, to match a stream that
  // was restarted at a timestamp (the seek): the <video> clock is then 0-based.
  const requestedSubShift = Math.max(0, Number(url.searchParams.get('t')) || 0);
  const subShift = hlsSessions.subtitleStart(hash, requestedSubShift);

  // An external (OpenSubtitles) track lives on a service, not in the torrent — no
  // torrent fetch needed. Download + convert once, then serve from the cache so a
  // seek (which re-requests with a new ?t=) doesn't spend another quota download.
  if (track.kind === 'external') {
    if (!OPENSUBTITLES_API_KEY) { res.writeHead(404); return res.end('external subtitles not configured'); }
    try {
      let vtt = osVttCache.get(track.fileId);
      if (vtt == null) {
        const srt = await fetchSubtitleText({ apiKey: OPENSUBTITLES_API_KEY, fileId: track.fileId });
        vtt = cleanSubtitleVtt(srtToVtt(srt));
        osVttCache.set(track.fileId, vtt);
      }
      console.log(`[subs] opensubtitles file ${track.fileId} -> ${vtt.length} bytes of VTT`);
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' });
      return res.end(subShift ? shiftVtt(vtt, subShift) : vtt);
    } catch (err) {
      res.writeHead(502);
      return res.end('opensubtitles: ' + err.message);
    }
  }
  if (track.kind === 'yts-subtitle') {
    const sourceUrl = ytsSubtitleUrls.get(track.fileId);
    if (!sourceUrl) { res.writeHead(404); return res.end('YTS subtitle URL expired; refresh the subtitle list'); }
    try {
      let vtt = osVttCache.get('yts:' + track.fileId);
      if (vtt == null) {
        const srt = await fetchYtsSubtitleText({ url: sourceUrl }, resolvingFetch);
        vtt = cleanSubtitleVtt(srtToVtt(srt));
        osVttCache.set('yts:' + track.fileId, vtt);
      }
      console.log(`[subs] exact YTS file ${track.fileId} -> ${vtt.length} bytes of VTT`);
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' });
      return res.end(subShift ? shiftVtt(vtt, subShift) : vtt);
    } catch (err) {
      res.writeHead(502);
      return res.end('YTS subtitles: ' + err.message);
    }
  }
  if (track.kind === 'stremio') {
    const sourceUrl = stremioSubtitleUrls.get(track.fileId);
    if (!sourceUrl) { res.writeHead(404); return res.end('no-key subtitle URL expired; refresh the subtitle list'); }
    try {
      let vtt = osVttCache.get('stremio:' + track.fileId);
      if (vtt == null) {
        const srt = await fetchStremioSubtitleText({ url: sourceUrl }, fetchViaPublicDns);
        vtt = cleanSubtitleVtt(srtToVtt(srt));
        osVttCache.set('stremio:' + track.fileId, vtt);
      }
      console.log(`[subs] no-key file ${track.fileId} -> ${vtt.length} bytes of VTT`);
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' });
      return res.end(subShift ? shiftVtt(vtt, subShift) : vtt);
    } catch (err) {
      res.writeHead(502);
      return res.end('no-key subtitles: ' + err.message);
    }
  }
  // `streaming=1` means the caller is playing this torrent right now, so the video
  // file must stay selected. Without it, a subtitle request that beat the video's
  // own request to the server would deselect every file and the movie never
  // downloaded at all (observed Aug 19, 2026: the [subs] lines preceded [stream]).
  const streaming = url.searchParams.get('streaming') === '1';
  const isNewToUs = !torrents.has(hash) && !streaming;
  let torrent;
  try {
    torrent = await getTorrent(hash, url.searchParams.get('title') || '');
  } catch (err) {
    res.writeHead(504);
    return res.end('torrent unavailable: ' + err.message);
  }
  // Same guard as the listing: fetching a subtitle must not drag the movie down
  // with it. Only ever deselect when we were the ones who added the torrent.
  if (isNewToUs) torrent.files.forEach((f) => f.deselect());

  // subShift (?t=<seconds>) is computed above; it shifts every cue earlier to match
  // a stream restarted at a timestamp (the <video> clock is then 0-based, but the
  // subtitle times are absolute — without the shift captions lead by the seek offset).
  const sendVtt = (vtt) => {
    res.writeHead(200, {
      'content-type': 'text/vtt; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': track.kind === 'embedded' ? 'public, max-age=45' : 'public, max-age=3600',
    });
    res.end(subShift ? shiftVtt(vtt, subShift) : vtt);
  };

  // A subtitle embedded inside the .mkv: extract the one stream as WebVTT.
  if (track.kind === 'embedded') {
    const file = torrent.files[track.fileIndex];
    if (!file) { res.writeHead(404); return res.end('no video file at that index'); }
    try { file.select(); } catch { /* keep it downloading so more cues become available */ }
    try {
      const vtt = cleanSubtitleVtt(await extractEmbeddedVtt(diskPathOf(torrent, file), track.streamIndex, `${hash}:${track.fileIndex}:${track.streamIndex}`, file.downloaded));
      console.log(`[subs] embedded ${file.name} stream ${track.streamIndex} -> ${vtt.length} bytes of VTT`);
      return sendVtt(vtt);
    } catch (err) {
      res.writeHead(504);
      return res.end('could not extract embedded subtitle: ' + err.message);
    }
  }

  // A standalone subtitle file in the torrent.
  const file = torrent.files[track.fileIndex];
  if (!file || !isSubtitleFile(file.path || file.name)) {
    res.writeHead(404);
    return res.end('no subtitle file at that index');
  }
  // Subtitle files are tiny but sit outside the sequential video window, so the
  // piece picker would otherwise leave them until last — captions then arrive 20-40s
  // after the picture (movies felt "captionless" because the .srt was starved behind
  // the streaming video; shows carry subs inside the downloading .mkv). Select it AND
  // mark its pieces critical so those few KB jump the queue and captions show at once.
  try { file.select(1); } catch { /* older webtorrent: select() takes no priority */ }
  try {
    if (typeof torrent.critical === 'function' && Number.isInteger(file._startPiece)) {
      torrent.critical(file._startPiece, file._endPiece);
    }
  } catch { /* internals vary by webtorrent version; select() above still applies */ }

  try {
    const raw = await file.arrayBuffer();
    const text = decodeSubtitle(Buffer.from(raw));
    const vtt = cleanSubtitleVtt(/\.vtt$/i.test(file.name) ? text : srtToVtt(text));
    console.log(`[subs] ${file.path} -> ${vtt.length} bytes of VTT`);
    sendVtt(vtt);
  } catch (err) {
    res.writeHead(504);
    res.end('could not read subtitle: ' + err.message);
  }
}

const priorityFileByTorrent = new WeakMap();
function prioritizeTorrentFile(torrent, file, start = 0) {
  try {
    const w = pieceWindow({ file, pieceLength: torrent.pieceLength || 1, start });
    // Reset selection only when playback changes to another file. FFmpeg opens
    // several concurrent ranges for MP4: header, moov-at-end and first media data.
    // Clearing the file on every request made those ranges erase each other's
    // priorities, causing a 90-second first frame despite >1 MB/s throughput.
    if (priorityFileByTorrent.get(torrent) !== file) {
      torrent.files.forEach((candidate) => candidate.deselect());
      priorityFileByTorrent.set(torrent, file);
    }
    // Add this request to the existing selection union. Keep both the requested
    // bytes and the MP4 tail critical because decoding needs both before frame 1.
    torrent.select(w.window.from, w.window.to, 1);
    torrent.select(w.tail.from, w.tail.to, 1);
    torrent.critical(w.critical.from, w.critical.to);
    torrent.critical(w.tail.from, w.tail.to);
  } catch { /* WebTorrent internals vary; the read stream still selects its range */ }
}

// Chrome cannot parse Matroska. Compatible TV releases are remuxed to a
// fragmented MP4 stream: H.264 video is copied unchanged and audio is converted
// to AAC, keeping CPU use low while producing a browser-native container.
function streamRemuxedMkv(req, res, file, { startSec = 0, diskPath = '' } = {}) {
  const headers = {
    'content-type': 'video/mp4',
    'accept-ranges': 'none',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }

  // A live-remuxed fragmented MP4 cannot be byte-range seeked, so seeking is done
  // by restarting ffmpeg at a timestamp. Fast input `-ss` needs a seekable file,
  // which means reading the on-disk file directly rather than the on-demand
  // webtorrent stream — fine because a backward seek is over already-downloaded
  // bytes. From the start (startSec 0) we keep streaming through the webtorrent
  // pipe so playback needs no full download.
  const seeking = startSec > 0 && diskPath;
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (seeking) args.push('-ss', String(startSec), '-i', diskPath);
  else args.push('-i', 'pipe:0');
  args.push(
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-sn',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    // Emit a fragment at least every second. Without this, ffmpeg only fragments
    // at video keyframes (~5-10s apart), and webOS's older video element loads
    // the first couple of big fragments then stalls (~21s) instead of continuing
    // to pull the chunked stream. Frequent small fragments keep it consuming.
    '-frag_duration', '1000000',
    '-f', 'mp4', 'pipe:1',
  );
  const ffmpeg = spawn('ffmpeg', args, { stdio: [seeking ? 'ignore' : 'pipe', 'pipe', 'pipe'] });

  let input = null;
  let stderr = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  if (!seeking) {
    ffmpeg.stdin.on('error', () => { /* browser disconnect / torrent teardown */ });
  }
  ffmpeg.stdout.on('error', () => { /* browser disconnect */ });

  ffmpeg.once('spawn', () => {
    if (res.destroyed) {
      ffmpeg.kill('SIGKILL');
      return;
    }
    res.writeHead(200, headers);
    ffmpeg.stdout.pipe(res);
    if (seeking) return;   // ffmpeg reads the file itself
    input = file.createReadStream();
    input.once('error', (err) => {
      ffmpeg.stdin.destroy(err);
      if (!res.destroyed) res.destroy(err);
    });
    input.pipe(ffmpeg.stdin);
  });

  ffmpeg.once('error', (err) => {
    console.error(`[remux] could not start ffmpeg: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ffmpeg is required to play this H.264 MKV torrent');
    } else if (!res.destroyed) {
      res.destroy(err);
    }
  });

  ffmpeg.once('close', (code) => {
    if (code && !res.destroyed) {
      console.error(`[remux] ffmpeg exited ${code}: ${stderr.trim() || 'no details'}`);
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  });

  res.once('close', () => {
    input?.destroy();
    if (!ffmpeg.killed && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
  });
}

async function handleStream(req, res, url) {
  const hash = (url.searchParams.get('hash') || '').toLowerCase().trim();
  const name = url.searchParams.get('title') || '';
  if (!/^[a-f0-9]{40}$/.test(hash)) {
    res.writeHead(400);
    return res.end('invalid or missing hash');
  }

  // ?ready= lets the TV path fail a peerless source fast and move to the next one
  // instead of holding the browser on a dead swarm for the full default.
  const readyMs = clampReadyTimeout(url.searchParams.get('ready'), READY_TIMEOUT_MS);
  let torrent;
  try {
    torrent = await getTorrent(hash, name, readyMs);
  } catch (err) {
    res.writeHead(504);
    return res.end('torrent unavailable: ' + err.message);
  }
  // Mark this torrent as actively read for as long as the response is open, so the
  // idle sweep never frees a torrent that a direct stream or the remux is using.
  acquireTorrent(hash);
  res.on('close', () => releaseTorrent(hash));

  // A TV request names an episode. Season packs hold every episode, so picking the
  // largest playable file (right for a movie) would serve a random one.
  const s = Number.parseInt(url.searchParams.get('s') || '', 10);
  const e = Number.parseInt(url.searchParams.get('e') || '', 10);
  const wantsEpisode = Number.isFinite(s) && Number.isFinite(e);
  // The release title carries the codec that a per-episode filename inside a
  // season pack usually omits. The app forwards it as ?ctx=; the torrent's own
  // name is the fallback when an older client does not send it.
  const releaseContext = `${url.searchParams.get('ctx') || ''} ${torrent.name || ''}`.trim();
  // ?anycodec=1 (the transcode path) picks the episode by container only, WITHOUT
  // the H.264 playability filter — the whole point is to hand an HEVC file to the
  // GPU transcoder, which pickEpisodeFile would otherwise reject as unplayable.
  const anyCodec = url.searchParams.get('anycodec') === '1';
  const requestedFileIndex = Number.parseInt(url.searchParams.get('file') || '', 10);
  const wantsIndexedMovie = !wantsEpisode && Number.isInteger(requestedFileIndex);
  const file = wantsEpisode
    ? (anyCodec ? pickEpisodeVideoFile(torrent.files, s, e) : pickEpisodeFile(torrent.files, s, e, releaseContext))
    : wantsIndexedMovie
      ? pickMovieFileByIndex(torrent.files, requestedFileIndex, releaseContext, anyCodec)
      : pickVideoFile(torrent);
  if (!file) {
    res.writeHead(404);
    return res.end(wantsEpisode
      ? `no playable file for S${s}E${e} in this torrent`
      : wantsIndexedMovie
        ? `no playable movie file at index ${requestedFileIndex} in torrent`
        : 'no playable video file in torrent');
  }
  console.log(`[stream] ${file.name} (${(file.length / 1e9).toFixed(2)} GB) peers=${torrent.numPeers} range=${req.headers.range || 'none'}`);

  if (isRemuxableTvFile(file.path || file.name, releaseContext) && url.searchParams.get('raw') !== '1') {
    // ?t=<seconds> restarts the remux at a timestamp (the player's seek). A
    // backward seek reads bytes already on disk; a forward seek needs them
    // downloaded, so keep prioritising this file either way.
    const startSec = Math.max(0, Number(url.searchParams.get('t')) || 0);
    if (req.method !== 'HEAD') prioritizeTorrentFile(torrent, file, 0);
    return streamRemuxedMkv(req, res, file, { startSec, diskPath: diskPathOf(torrent, file) });
  }

  const total = file.length;
  const type = VIDEO_MIME[extname(file.name).toLowerCase()] || 'video/mp4';
  const range = req.headers.range;

  let start = 0;
  let end = total - 1;
  if (range) {
    const parsed = parseByteRange(range, total);
    if (!parsed) {
      res.writeHead(416, { 'content-range': `bytes */${total}`, 'access-control-allow-origin': '*' });
      return res.end();
    }
    ({ start, end } = parsed);
    // CORS on the media responses too: the deployed page reaches this helper
    // cross-origin and its <video> is in CORS mode (crossorigin="anonymous") so
    // subtitle tracks load — without this header the video itself would fail.
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'content-type': type,
      'access-control-allow-origin': '*',
    });
  } else {
    res.writeHead(200, {
      'accept-ranges': 'bytes',
      'content-length': total,
      'content-type': type,
      'access-control-allow-origin': '*',
    });
  }

  if (req.method === 'HEAD') return res.end();

  // Prioritise a sequential run from the playhead plus the tail for MP4 files
  // whose moov index is not at the front.
  prioritizeTorrentFile(torrent, file, start);

  const stream = file.createReadStream({ start, end });
  stream.pipe(res);
  const cleanup = () => stream.destroy();
  stream.on('error', cleanup);
  res.on('close', cleanup);
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  // Block path traversal.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

// GET /debrid-proxy?src=<https url>  -> range-capable passthrough of a debrid
// file. Native-MP4 debrid results play straight through this (no transcode);
// MKV goes through /hls/start?src instead. The helper does the fetch so the TV
// never has to resolve the (often ISP-poisoned) debrid/index host itself.
async function handleDebridProxy(req, res, url) {
  const src = (url.searchParams.get('src') || '').trim();
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  let finalUrl;
  try {
    finalUrl = await resolveDebridInput(src, controller.signal);
  } catch (err) {
    res.writeHead(400, { 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ error: err.message }));
  }
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await resolvingFetch(finalUrl, { headers, redirect: 'follow', signal: controller.signal });
    // resolvingFetch's DNS-fallback path returns a buffered {ok,status,text,json}
    // object with no streamable body/headers — we can't proxy that as a stream, so
    // fail cleanly rather than crash on `upstream.headers.get`.
    if (!upstream.headers || typeof upstream.headers.get !== 'function' || !upstream.body) {
      if (!res.headersSent) { res.writeHead(502, { 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ error: 'debrid source not directly streamable' })); }
      return;
    }
    const passthrough = {
      'access-control-allow-origin': '*',
      'accept-ranges': 'bytes',
      'content-type': upstream.headers.get('content-type') || 'video/mp4',
    };
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) passthrough[h] = v;
    }
    res.writeHead(upstream.status, passthrough);
    if (req.method === 'HEAD') return res.end();
    const { Readable } = await import('node:stream');
    const body = Readable.fromWeb(upstream.body);
    // Without these, an aborted/broken upstream (the normal seek/close path) emits an
    // unhandled 'error' that crashes the whole Node process.
    body.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
    res.on('error', () => { try { body.destroy(); } catch { /* already gone */ } });
    body.pipe(res);
  } catch (err) {
    if (res.writableEnded || res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
    res.writeHead(502, { 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: 'debrid fetch failed: ' + err.message }));
  }
}

async function handleLiveFixtures(res, url) {
  const date = url.searchParams.get('date') || localDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return liveJson(res, 400, { error: 'date must be YYYY-MM-DD' });
  try { liveJson(res, 200, { fixtures: await withDeadline(liveFixtures.fetchFixtures(date), LIVE_FEED_DEADLINE_MS, `espn ${date}`) }); }
  catch (err) { liveJson(res, isLiveTimeout(err) ? 504 : 502, { error: String(err.message || err) }); }
}

async function handleLiveMatches(res) {
  const now = Date.now();
  const status = { fixtures: 'ok', sources: {} };
  const fixturesP = Promise.all([localDate(now), localDate(now, 1)].map(d => withDeadline(liveFixtures.fetchFixtures(d), LIVE_FEED_DEADLINE_MS, `espn ${d}`)))
    .then(lists => selectTodayFixtures(lists, now))
    .catch(err => { status.fixtures = 'error: ' + String(err.message || err); return []; });
  const sourcesP = Promise.all(liveSources.list().map(a => withDeadline(a.listMatches(), LIVE_SOURCES_DEADLINE_MS, a.name)
    .then(list => { status.sources[a.name] = 'ok'; return list.map(m => ({ ...m, adapter: a.name })); })
    .catch(err => { status.sources[a.name] = 'error: ' + String(err.message || err); return []; })))
    .then(r => r.flat());
  const [fixtures, sourceMatches] = await Promise.all([fixturesP, sourcesP]);
  const matches = sortMatches(joinFixtures(fixtures, sourceMatches, { now }));
  console.log(`[live] fixtures=${status.fixtures} ${Object.entries(status.sources).map(([k, v]) => `${k}=${v}`).join(' ')} matches=${matches.length} withStream=${matches.filter(m => m.hasStream).length}`);
  liveJson(res, 200, { matches, status, generatedAt: new Date(now).toISOString() });
}

async function handleLiveStreams(res, url) {
  const adapter = liveSources.get(url.searchParams.get('adapter') || '');
  const id = url.searchParams.get('id') || '';
  if (!adapter || !id) return liveJson(res, 404, { error: 'unknown adapter or id' });
  try {
    const streams = await withDeadline(adapter.streamsFor(id), LIVE_STREAMS_DEADLINE_MS, `${adapter.name} streams`);
    const ranked = await liveHealth.rank(streams);
    const counts = ranked.reduce((acc, s) => { acc[s.health] = (acc[s.health] || 0) + 1; return acc; }, {});
    console.log(`[live] streams ${adapter.name}:${id.slice(0, 40)} total=${streams.length} kept=${ranked.length} ${JSON.stringify(counts)}`);
    // The client never sees upstream URLs or headers; only signed relay paths.
    liveJson(res, 200, { streams: ranked.map(s => ({
      label: s.label, language: s.language, quality: s.height ? `${s.height}p` : s.quality, height: s.height || 0, rank: s.rank, health: s.health,
      play: relayPath('hls', { u: s.url, ref: s.referer, org: s.origin }, LIVE_SECRET),
    })) });
  } catch (err) { liveJson(res, isLiveTimeout(err) ? 504 : 502, { error: String(err.message || err) }); }
}

async function handleLiveChannels(res) {
  let feed;
  try { feed = await withDeadline(liveChannels.fetchChannels(), LIVE_CHANNELS_DEADLINE_MS, 'channels'); }
  catch (err) {
    console.log(`[live] channels ${isLiveTimeout(err) ? 'timeout' : 'error: ' + String(err.message || err)}`);
    return liveJson(res, 200, { channels: [], stale: true, fetchedAt: null, error: isLiveTimeout(err) ? 'timeout' : String(err.message || err) });
  }
  const { channels, stale, fetchedAt } = feed;
  console.log(`[live] channels=${channels.length} stale=${stale}`);
  liveJson(res, 200, { channels: channels.map(c => ({ id: c.id, name: c.name, logo: c.logo, height: c.height || 0, play: relayPath('hls', { u: c.url, ref: '', org: '' }, LIVE_SECRET) })), stale, fetchedAt });
}

function liveRelayParams(url) {
  const p = { u: url.searchParams.get('u') || '', ref: url.searchParams.get('ref') || '', org: url.searchParams.get('org') || '', s: url.searchParams.get('s') || '' };
  if (!verifyUpstream(p, LIVE_SECRET)) return { error: 'bad relay signature' };
  if (!LIVE_ALLOW_PRIVATE && !isPublicHttpUrl(p.u)) return { error: 'upstream not allowed' };
  return p;
}

// Redirect hops are checked separately from the signed start URL: a CDN we do not
// control could 302 a signed public URL to a LAN address. Public targets are always
// fine; with LIVE_RELAY_ALLOW_PRIVATE (integration test only) loopback 127/8 is also
// allowed, but RFC1918, link-local and CGNAT targets are refused even then.
function liveRedirectTargetAllowed(raw) {
  if (isPublicHttpUrl(raw)) return true;
  if (!LIVE_ALLOW_PRIVATE) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(u.hostname);
  } catch { return false; }
}

const LIVE_MAX_REDIRECTS = 5;
const liveRelayError = (status, message) => Object.assign(new Error(message), { status });

// Fetch an upstream with manual redirects, re-checking every hop against the guard.
// Resolves { upstream, finalUrl }; rejects with err.status 403 (disallowed hop) or
// 502 (too many hops, unusable redirect, network error).
async function fetchUpstreamGuarded(startUrl, headers, signal) {
  let current = startUrl;
  for (let hop = 0; ; hop++) {
    const upstream = await liveFetch(current, { headers, redirect: 'manual', signal });
    if (upstream.status < 300 || upstream.status >= 400) return { upstream, finalUrl: current };
    try { const c = upstream.body && upstream.body.cancel && upstream.body.cancel(); if (c && c.catch) c.catch(() => {}); } catch { /* already closed */ }
    const location = upstream.headers.get('location');
    if (!location) throw liveRelayError(502, `upstream ${upstream.status} without location`);
    if (hop >= LIVE_MAX_REDIRECTS) throw liveRelayError(502, 'too many redirects');
    let next;
    try { next = new URL(location, current).href; } catch { throw liveRelayError(502, 'bad redirect location'); }
    if (!liveRedirectTargetAllowed(next)) throw liveRelayError(403, 'redirect to disallowed target');
    current = next;
  }
}

async function handleLiveHls(req, res, url) {
  const p = liveRelayParams(url);
  if (p.error) { console.log(`[live] 403 ${p.error}`); return liveJson(res, 403, { error: p.error }); }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000); // bounds the redirect chain AND the body read (Nuvio's wrapper can take ~8 s)
  try {
    const { upstream, finalUrl } = await fetchUpstreamGuarded(p.u, upstreamHeaders(p.ref, p.org), ac.signal);
    if (!upstream.ok) { res.writeHead(upstream.status, LIVE_JSON); return res.end(JSON.stringify({ error: `upstream ${upstream.status}` })); }
    const text = await upstream.text();
    const body = rewritePlaylist(text, { playlistUrl: finalUrl, relayBase: '', ref: p.ref, org: p.org, secret: LIVE_SECRET, key: url.searchParams.get('key') || '' });
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    if (err.status === 403) console.log(`[live] 403 ${err.message}`);
    if (!res.headersSent) liveJson(res, err.status || 502, { error: String(err.message || err) });
  } finally {
    clearTimeout(t);
  }
}

const LIVE_SEG_HEADERS_DEADLINE_MS = 10000;
async function handleLiveSeg(req, res, url) {
  const p = liveRelayParams(url);
  if (p.error) return liveJson(res, 403, { error: p.error });
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  // A dead segment CDN must fail fast: upstream response headers (after every
  // redirect hop) must arrive within this deadline. The body stream itself stays
  // unbounded; a client disconnect already aborts it.
  let headersTimedOut = false;
  const headersTimer = setTimeout(() => { headersTimedOut = true; ac.abort(); }, LIVE_SEG_HEADERS_DEADLINE_MS);
  let upstream;
  try { ({ upstream } = await fetchUpstreamGuarded(p.u, upstreamHeaders(p.ref, p.org), ac.signal)); }
  catch (err) {
    if (err.status === 403) console.log(`[live] 403 ${err.message}`);
    if (!res.headersSent) {
      if (headersTimedOut) liveJson(res, 504, { error: 'upstream timeout' });
      else liveJson(res, err.status || 502, { error: String(err.message || err) });
    }
    return;
  } finally {
    clearTimeout(headersTimer);
  }
  if (!upstream.ok) { res.writeHead(upstream.status, LIVE_JSON); return res.end(); }
  const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-type': upstream.headers.get('content-type') || 'video/mp2t' };
  const len = upstream.headers.get('content-length');
  if (len) headers['content-length'] = len;
  res.writeHead(200, headers);
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res).catch(() => { try { res.destroy(); } catch { /* closed */ } });
  else res.end(); // a null-body success (e.g. 204) is relayed as an empty segment
}

// GET /transcode?hash=..&s=..&e=..  -> a live H.264 fragmented-MP4 stream of an
// HEVC source, GPU-transcoded. Progressive MP4 plays in plain <video> on both the
// TV and a desktop browser (unlike HLS, which desktop Chrome can't play natively).
// ffmpeg reads the episode through our own /stream endpoint, so webtorrent's
// sequential piece selection still applies.
async function handleTranscode(req, res, url) {
  const debridSrc = (url.searchParams.get('src') || '').trim();
  const hash = (url.searchParams.get('hash') || '').toLowerCase();
  if (!debridSrc && !/^[a-f0-9]{40}$/.test(hash)) { res.writeHead(400); return res.end('invalid hash'); }
  const startSec = Math.max(0, Math.min(86400, Number(url.searchParams.get('t')) || 0));
  // Input is either a debrid HTTP file (transcode it directly) or our own /stream
  // torrent endpoint (anycodec=1 so it serves the HEVC file rather than 404ing).
  let inputUrl;
  if (debridSrc) {
    try { inputUrl = await resolveDebridInput(debridSrc); }
    catch (err) { res.writeHead(400, { 'access-control-allow-origin': '*' }); return res.end(JSON.stringify({ error: err.message })); }
  } else {
    const input = new URL('/stream', `http://127.0.0.1:${server.address().port}`);
    input.search = url.search;
    input.searchParams.set('raw', '1');
    input.searchParams.set('anycodec', '1');
    input.searchParams.delete('t');
    inputUrl = input.href;
  }

  let child = null;
  let done = false;
  const cleanup = () => { done = true; try { child?.kill('SIGKILL'); } catch { /* already gone */ } };
  res.on('close', cleanup);

  // One attempt: GPU decode+encode first; on total failure, software decode +
  // (still GPU) encode. Resolve as soon as the first output byte arrives so a
  // stalled/erroring ffmpeg falls through to the fallback instead of hanging.
  const attempt = (gpuDecode, encoder = TRANSCODE_ENCODER) => new Promise((resolve) => {
    const pre = [];
    if (startSec > 0) pre.push('-ss', String(startSec));
    if (gpuDecode) pre.push('-hwaccel', 'cuda', '-c:v', 'hevc_cuvid');
    // Force High@4.1 so the browser MSE codec string is deterministic
    // (avc1.640029). fragmented MP4 (empty_moov init segment + moof/mdat frags)
    // is what the client feeds into MediaSource.
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '30000000',
      ...pre, '-i', inputUrl, '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', encoder, '-preset', encoder.includes('nvenc') ? 'p4' : 'veryfast', '-profile:v', 'high', '-level', '4.1',
      '-b:v', process.env.TRANSCODE_BITRATE || '4M', '-maxrate', process.env.TRANSCODE_MAXRATE || '6M', '-bufsize', '8M',
      '-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-sn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
    child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let firstByte = false;
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.stdout.once('data', (chunk) => {
      firstByte = true;
      if (done) { resolve({ ok: true }); return; } // res already closed; don't dangle the promise
      res.writeHead(200, { 'content-type': 'video/mp4', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.write(chunk);
      // An unhandled stdout/socket 'error' (broken pipe when the viewer closes) would
      // otherwise crash the whole process; tear the pair down instead.
      child.stdout.on('error', () => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
      res.on('error', () => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
      child.stdout.pipe(res);
      resolve({ ok: true });
    });
    child.on('close', () => { if (!firstByte) resolve({ ok: false, stderr }); });
    child.on('error', (e) => { if (!firstByte) resolve({ ok: false, stderr: String(e) }); });
  });

  console.log(`[transcode] ${hash || 'debrid'} enc=${TRANSCODE_ENCODER} gpuDecode=${TRANSCODE_GPU_DECODE}`);
  let r = await attempt(TRANSCODE_GPU_DECODE);
  if (!r.ok && !done && TRANSCODE_GPU_DECODE) r = await attempt(false); // software-decode fallback
  if (!r.ok && !done && TRANSCODE_ENCODER !== 'libx264') r = await attempt(false, 'libx264');
  if (!r.ok && !done) {
    console.error(`[transcode] failed ${hash}: ${(r.stderr || '').slice(-300)}`);
    if (!res.headersSent) { res.writeHead(502, { 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ error: 'transcode failed' })); }
    else res.end();
  }
}

function handleStreamStatus(res, url) {
  const hash = (url.searchParams.get('hash') || '').toLowerCase().trim();
  const t = torrents.get(hash);
  const body = { state: 'idle' };
  if (t) {
    const file = t.ready ? pickVideoFile(t) : null;
    body.state = t.ready ? 'ready' : 'connecting';
    body.peers = t.numPeers;
    body.progress = t.progress;
    body.downloadSpeed = t.downloadSpeed;
    if (file) {
      body.name = file.name;
      body.length = file.length;
      body.remux = isRemuxableTvFile(file.path || file.name);
      // HEVC counts as playable here because the helper can transcode it — without
      // this, the status poll would wrongly declare a transcode source "not playable"
      // and bail to the movie-fallback path.
      body.playable = isPlayableName(file.name) || body.remux || isTranscodableTvFile(file.name);
    }
  }
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/live/')) {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*', 'access-control-max-age': '600' });
    return res.end();
  }
  try {
    if (!helperRequestAllowed({ pathname: url.pathname, searchParams: url.searchParams, requiredKey: HELPER_KEY })) {
      // Log WHICH key was refused (prefix only). Rotating HELPER_KEY leaves the old
      // key in every browser's localStorage, and without this line a stale-key 401
      // is indistinguishable from a no-key one, which are different user fixes.
      const given = url.searchParams.get('key') || '';
      const shown = given ? `${given.slice(0, 4)}…(${given.length} chars)` : 'none';
      console.log(`[401] ${url.pathname} key=${shown} ua=${(req.headers['user-agent'] || '').slice(0, 60)}`);
      res.writeHead(401, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ error: 'access key required' }));
    }
    // Tell a same-network client (the TV) how to reach this helper directly over
    // the LAN, bypassing the throughput-capped Tailscale funnel. The browser only
    // adopts this if it can actually reach the address (it probes it first), so
    // returning it here is safe even when the client is remote.
    if (url.pathname === '/lan-info') {
      const base = lanBaseUrl(networkInterfaces(), server.address()?.port || currentPort);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ base }));
    }
    if (url.pathname === '/hls/start') {
      const debridSrc = (url.searchParams.get('src') || '').trim();
      const hash = (url.searchParams.get('hash') || '').toLowerCase();
      // Two input kinds: a torrent (infohash -> our own /stream endpoint) or a
      // debrid file (a ready HTTP url -> ffmpeg reads it directly). Everything
      // downstream (remux to HLS, session lifecycle) is identical.
      if (!debridSrc && !/^[a-f0-9]{40}$/.test(hash)) { res.writeHead(400); return res.end('invalid hash'); }
      const startSec = Math.max(0, Math.min(86400, Number(url.searchParams.get('t')) || 0));
      const transcode = url.searchParams.get('transcode') === '1';
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      let inputUrl;
      let sessionHash = hash;
      try {
        if (debridSrc) {
          inputUrl = await resolveDebridInput(debridSrc, controller.signal);
          sessionHash = 'debrid:' + createHash('sha1').update(debridSrc).digest('hex');
        } else {
          const input = new URL('/stream', `http://127.0.0.1:${server.address().port}`);
          input.search = url.search;
          input.searchParams.set('raw', '1');
          if (transcode) input.searchParams.set('anycodec', '1'); // serve the HEVC file to ffmpeg
          input.searchParams.delete('t');
          inputUrl = input.href;
        }
        if (transcode) console.log(`[hls-transcode] ${sessionHash} enc=${TRANSCODE_ENCODER}`);
        // Transcode HEVC->H.264 into HLS. Try the configured GPU path first,
        // then software decode, and finally full libx264 when NVENC itself is
        // unavailable (for example after a CUDA/driver mismatch).
        let session;
        let lastError;
        const attempts = transcode
          ? [
            { encoder: TRANSCODE_ENCODER, gpuDecode: TRANSCODE_GPU_DECODE },
            ...(TRANSCODE_GPU_DECODE ? [{ encoder: TRANSCODE_ENCODER, gpuDecode: false }] : []),
            ...(TRANSCODE_ENCODER !== 'libx264' ? [{ encoder: 'libx264', gpuDecode: false }] : []),
          ]
          : [{ encoder: TRANSCODE_ENCODER, gpuDecode: false }];
        for (const attempt of attempts) {
          try {
            session = await hlsSessions.start({ inputUrl, hash: sessionHash, startSec, signal: controller.signal, transcode, ...attempt });
            break;
          } catch (err) {
            lastError = err;
            if (controller.signal.aborted) throw err;
            if (attempt.encoder !== 'libx264') console.warn(`[hls-transcode] ${attempt.encoder} failed; retrying`);
          }
        }
        if (!session) throw lastError;
        if (res.destroyed) { await hlsSessions.stop(session.id); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify(session));
      } catch (error) {
        if (res.destroyed) return;
        if (hash) {
          rememberSourceFailure(failedTvSources, hash);
          console.log(`[tv] temporarily deferring failed source ${hash.slice(0, 8)}`);
        }
        res.writeHead(504, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ error: error.message }));
      }
    }
    if (url.pathname === '/hls/stop') {
      await hlsSessions.stop(url.searchParams.get('id'));
      res.writeHead(204, { 'access-control-allow-origin': '*' }); return res.end();
    }
    if (url.pathname.startsWith('/hls/')) {
      const match = /^\/hls\/([a-f0-9-]{36})\/(index\.m3u8|segment\d{6}\.ts)$/.exec(url.pathname);
      const asset = match && await hlsSessions.read(match[1], match[2], url.searchParams.get('key') || '');
      if (!asset) { res.writeHead(404); return res.end('segment unavailable'); }
      res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.body.length, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(req.method === 'HEAD' ? undefined : asset.body);
    }
    if (url.pathname === '/yts') return await handleYts(res, url);
    if (url.pathname === '/movie-torrents') {
      const imdb = url.searchParams.get('imdb') || '';
      if (!/^tt\d+$/.test(imdb)) { res.writeHead(400); return res.end('invalid IMDb ID'); }
      try {
        const sources = await fetchMovieSources(imdb, { year: Number(url.searchParams.get('year')) || undefined, title: url.searchParams.get('title') });
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ sources }));
      } catch {
        res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ error: 'Movie sources are unavailable right now.' }));
      }
    }
    if (url.pathname === '/tv-torrents') return await handleTvTorrents(res, url);
    if (url.pathname === '/subtitles') return await handleSubtitleList(res, url);
    if (url.pathname === '/subtitle') return await handleSubtitleFile(res, url);
    if (url.pathname === '/stream') return await handleStream(req, res, url);
    if (url.pathname === '/transcode') return await handleTranscode(req, res, url);
    if (url.pathname === '/debrid-proxy') return await handleDebridProxy(req, res, url);
    if (url.pathname === '/live/fixtures') return await handleLiveFixtures(res, url);
    if (url.pathname === '/live/matches') return await handleLiveMatches(res);
    if (url.pathname === '/live/streams') return await handleLiveStreams(res, url);
    if (url.pathname === '/live/channels') return await handleLiveChannels(res);
    if (url.pathname === '/live/hls') return await handleLiveHls(req, res, url);
    if (url.pathname === '/live/seg') return await handleLiveSeg(req, res, url);
    if (url.pathname === '/stream-status') return handleStreamStatus(res, url);
    if (url.pathname === '/stream-stop') {
      destroyTorrent((url.searchParams.get('hash') || '').toLowerCase().trim());
      res.writeHead(204);
      return res.end();
    }
    return await serveStatic(req, res, url);
  } catch (err) {
    res.writeHead(500);
    res.end('server error: ' + String(err));
  }
});

// Start listening, auto-advancing to the next port if one is already in use
// (port 3000 is commonly taken by another dev server). Without this, EADDRINUSE
// crashes the process with a raw stack trace and YTS silently can't reach /yts.
// Set PORT to pin a specific port and disable the auto-advance.
const REQUESTED_PORT = Number(PORT);
let currentPort = REQUESTED_PORT;
let portTriesLeft = 10;

server.on('listening', () => {
  const p = server.address().port;
  console.log(`\n  Discovery App + YTS stream helper running.`);
  console.log(`  Open the app here:  http://localhost:${p}\n`);
  if (p !== REQUESTED_PORT) {
    console.log(`  (port ${REQUESTED_PORT} was taken — using ${p} instead)\n`);
  }
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  if (process.env.PORT || portTriesLeft <= 0) {
    console.error(`\n  Port ${currentPort} is already in use. Free it, or run: PORT=<free port> npm start\n`);
    process.exit(1);
  }
  console.warn(`  Port ${currentPort} is in use, trying ${currentPort + 1}…`);
  portTriesLeft -= 1;
  currentPort += 1;
  server.listen(currentPort);
});

server.listen(currentPort);

// Tidy up peer connections on exit.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopTvProviderCompat();
    hlsSessions.close().finally(() => client.destroy(() => process.exit(0)));
    setTimeout(() => process.exit(0), 2000);
  });
}
