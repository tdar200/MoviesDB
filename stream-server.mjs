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
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';
import { fetchYtsMovie } from './yts-api.mjs';
import { isSubtitleFile, subtitleLabel, srtToVtt, decodeSubtitle } from './subtitles.js';
import { fetchTvSources, isRemuxableTvFile, pickEpisodeFile } from './tv-api.mjs';
import { pieceWindow } from './stream-window.mjs';
import { helperRequestAllowed } from './helper-auth.js';
import { clampReadyTimeout } from './tv-fallback.js';

const PORT = process.env.PORT || 3000;
// Access key for the API endpoints. Empty = open (local npm start). Set it when
// the helper is published beyond your own machines (see helper-auth.js).
const HELPER_KEY = process.env.HELPER_KEY || '';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const READY_TIMEOUT_MS = 60_000;

// Seeding is unlimited by default, and it competes for the SAME uplink this
// helper uses to serve video to other devices. On this line that uplink is
// 16.2 Mbit total, so an unthrottled swarm can starve the stream it is feeding.
// Cap it well below the line and leave the rest for playback. Bytes per second;
// set TORRENT_UPLOAD_LIMIT=-1 to restore unlimited seeding.
const UPLOAD_LIMIT = Number.parseInt(process.env.TORRENT_UPLOAD_LIMIT ?? '262144', 10);

// maxConns: allow more simultaneous peers per torrent (default 55) so the
// sequential playhead can pull from many seeders at once.
const client = new WebTorrent({
  maxConns: 150,
  uploadLimit: Number.isFinite(UPLOAD_LIMIT) ? UPLOAD_LIMIT : 262144,
});
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
    const t = client.add(magnetFromHash(hash, name));
    torrents.set(hash, t);
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

function destroyTorrent(hash) {
  const t = torrents.get(hash);
  if (!t) return;
  torrents.delete(hash);
  try {
    t.destroy({ destroyStore: true });
  } catch {
    /* ignore */
  }
}

async function handleYts(res, url) {
  const imdb = url.searchParams.get('imdb');
  if (!imdb) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing imdb param' }));
  }
  try {
    const movie = await fetchYtsMovie(imdb);
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
    });
    res.end(
      JSON.stringify({
        title: movie?.title || null,
        year: movie?.year || null,
        torrents: movie?.torrents || [],
      })
    );
  } catch (err) {
    // Every YTS host was unreachable. Say so precisely: the helper is plainly
    // running (it is answering this request), so the app must not blame itself.
    console.error(`[yts] lookup failed for ${imdb}: ${(err.hostErrors || [String(err)]).join(' | ')}`);
    res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: 'yts_unreachable', detail: err.hostErrors || [String(err)] }));
  }
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
    const sources = await fetchTvSources(imdb, season, episode, {
      year: Number.isFinite(year) ? year : undefined,
      country,
    });
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

  const tracks = torrent.files
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => isSubtitleFile(f.path || f.name))
    .map(({ f, index }) => ({ index, ...subtitleLabel(f.path || f.name), bytes: f.length }));

  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ tracks }));
}

// GET /subtitle?hash=..&index=..  -> that file, converted to WebVTT.
// A <track> element accepts WebVTT only; served an .srt, Chrome reports no error
// and simply shows nothing, so the conversion has to happen here.
async function handleSubtitleFile(res, url) {
  const hash = (url.searchParams.get('hash') || '').toLowerCase().trim();
  const index = Number.parseInt(url.searchParams.get('index') || '', 10);
  if (!/^[a-f0-9]{40}$/.test(hash) || Number.isNaN(index)) {
    res.writeHead(400);
    return res.end('invalid or missing hash/index');
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
  // Same guard as the listing: fetching a 40KB subtitle must not drag the movie
  // down with it. Only ever deselect when we were the ones who added the torrent.
  if (isNewToUs) torrent.files.forEach((f) => f.deselect());
  const file = torrent.files[index];
  if (!file || !isSubtitleFile(file.path || file.name)) {
    res.writeHead(404);
    return res.end('no subtitle file at that index');
  }

  // Subtitle files are tiny but sit outside the sequential video window, so the
  // piece picker would otherwise leave them until last. Select explicitly, or
  // subtitles arrive minutes after the picture.
  try { file.select(1); } catch { /* older webtorrent: select() takes no priority */ }

  try {
    const raw = await file.arrayBuffer();
    const text = decodeSubtitle(Buffer.from(raw));
    const vtt = /\.vtt$/i.test(file.name) ? text : srtToVtt(text);
    console.log(`[subs] ${file.path} -> ${vtt.length} bytes of VTT`);
    res.writeHead(200, {
      'content-type': 'text/vtt; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
    });
    res.end(vtt);
  } catch (err) {
    res.writeHead(504);
    res.end('could not read subtitle: ' + err.message);
  }
}

function prioritizeTorrentFile(torrent, file, start = 0) {
  torrent.files.forEach((f) => (f === file ? f.select() : f.deselect()));
  try {
    const w = pieceWindow({ file, pieceLength: torrent.pieceLength || 1, start });
    torrent.deselect(w.fileStart, w.fileEnd);
    torrent.select(w.window.from, w.window.to, 1);
    torrent.select(w.tail.from, w.tail.to, 1);
    torrent.critical(w.critical.from, w.critical.to);
  } catch { /* ignore */ }
}

// Chrome cannot parse Matroska. Compatible TV releases are remuxed to a
// fragmented MP4 stream: H.264 video is copied unchanged and audio is converted
// to AAC, keeping CPU use low while producing a browser-native container.
function streamRemuxedMkv(req, res, file) {
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

  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-sn',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let input = null;
  let stderr = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  ffmpeg.stdin.on('error', () => { /* browser disconnect / torrent teardown */ });
  ffmpeg.stdout.on('error', () => { /* browser disconnect */ });

  ffmpeg.once('spawn', () => {
    if (res.destroyed) {
      ffmpeg.kill('SIGKILL');
      return;
    }
    res.writeHead(200, headers);
    input = file.createReadStream();
    input.once('error', (err) => {
      ffmpeg.stdin.destroy(err);
      if (!res.destroyed) res.destroy(err);
    });
    ffmpeg.stdout.pipe(res);
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

  // A TV request names an episode. Season packs hold every episode, so picking the
  // largest playable file (right for a movie) would serve a random one.
  const s = Number.parseInt(url.searchParams.get('s') || '', 10);
  const e = Number.parseInt(url.searchParams.get('e') || '', 10);
  const wantsEpisode = Number.isFinite(s) && Number.isFinite(e);
  // The release title carries the codec that a per-episode filename inside a
  // season pack usually omits. The app forwards it as ?ctx=; the torrent's own
  // name is the fallback when an older client does not send it.
  const releaseContext = `${url.searchParams.get('ctx') || ''} ${torrent.name || ''}`.trim();
  const file = wantsEpisode ? pickEpisodeFile(torrent.files, s, e, releaseContext) : pickVideoFile(torrent);
  if (!file) {
    res.writeHead(404);
    return res.end(wantsEpisode
      ? `no playable file for S${s}E${e} in this torrent`
      : 'no playable video file in torrent');
  }
  console.log(`[stream] ${file.name} (${(file.length / 1e9).toFixed(2)} GB) peers=${torrent.numPeers} range=${req.headers.range || 'none'}`);

  if (isRemuxableTvFile(file.path || file.name, releaseContext)) {
    if (req.method !== 'HEAD') prioritizeTorrentFile(torrent, file);
    return streamRemuxedMkv(req, res, file);
  }

  const total = file.length;
  const type = VIDEO_MIME[extname(file.name).toLowerCase()] || 'video/mp4';
  const range = req.headers.range;

  let start = 0;
  let end = total - 1;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
      res.writeHead(416, { 'content-range': `bytes */${total}`, 'access-control-allow-origin': '*' });
      return res.end();
    }
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
  req.on('close', cleanup);
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
      body.playable = isPlayableName(file.name) || body.remux;
    }
  }
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
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
    if (url.pathname === '/yts') return await handleYts(res, url);
    if (url.pathname === '/tv-torrents') return await handleTvTorrents(res, url);
    if (url.pathname === '/subtitles') return await handleSubtitleList(res, url);
    if (url.pathname === '/subtitle') return await handleSubtitleFile(res, url);
    if (url.pathname === '/stream') return await handleStream(req, res, url);
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
    client.destroy(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
