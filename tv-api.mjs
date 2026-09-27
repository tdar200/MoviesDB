// tv-api.mjs — TV torrent indexes -> a browser-playable episode.
//
// YTS is movies only (its API is literally list_movies.json), so shows had no
// torrent fallback at all. EZTV would have been the natural analogue but its own
// Cloudflare edge returns 451 to UK traffic across every domain and mirror, and
// apibay answers 200 while its search returns "No results returned" for every
// query. The indexes below speak the Stremio stream API: keyless, IMDb-keyed,
// and one request per episode.
//
// Torrentio's public host became unreachable in Aug 2026 (AAAA-only and the
// published address times out from this network), so Comet is the primary and
// Torrentio remains a fallback for when it recovers. Override the list without
// changing code by setting TV_TORRENT_INDEXES to comma-separated base URLs.
//
// Native MP4 remains preferred. H.264 MKV is also accepted because the local
// helper remuxes it to fragmented MP4; video is copied, not re-encoded.

import { createResolvingFetch } from './dns-fetch.js';

// UK ISPs poison the DNS for torrent indexes; this retries by resolved IP.
const resolvingFetch = createResolvingFetch();

export const DEFAULT_TV_INDEXES = [
  { name: 'Comet', url: 'https://comet.feels.legal' },
  { name: 'Torrentio', url: 'https://torrentio.strem.fun' },
];

// ---- Optional debrid (Real-Debrid et al.) -----------------------------------
//
// Thinly-seeded content (niche/regional shows like Mirzapur) has no reachable
// P2P peers, so it never streams over plain torrents. A debrid service holds
// cached copies on fast servers and hands back a ready-to-stream HTTP URL, which
// the helper remuxes exactly like a torrent file. This is entirely OPT-IN: with
// no key set, behaviour is identical to before (torrent infohashes only).
//
// Enable by setting, in the helper's environment:
//   DEBRID_API_KEY=<your key>
//   DEBRID_SERVICE=realdebrid   (default; see DEBRID_SERVICES below)
//
// Implemented against Torrentio's config format (`<service>=<key>`), which is a
// stable key=value path segment. Comet keeps running WITHOUT debrid so it still
// contributes its public-tracker torrents alongside any debrid results.
const DEBRID_SERVICES = new Set([
  'realdebrid', 'alldebrid', 'premiumize', 'debridlink', 'offcloud', 'putio', 'torbox',
]);

export function debridSettings(env = process.env) {
  const key = String(env.DEBRID_API_KEY || '').trim();
  const service = String(env.DEBRID_SERVICE || 'realdebrid').trim().toLowerCase();
  if (!key || !DEBRID_SERVICES.has(service)) return null;
  return { service, key };
}

// The Torrentio config path segment that turns on debrid. Cached files come back
// as ready-to-stream `url`s; `sort=qualitysize` keeps the 1080p-first ordering.
export function torrentioDebridSegment(debrid) {
  if (!debrid) return '';
  return `sort=qualitysize|${debrid.service}=${encodeURIComponent(debrid.key)}`;
}

// Build the stream URL for one index, injecting the debrid config for Torrentio
// only (Comet's config is a version-fragile base64 blob we deliberately avoid).
export function indexStreamUrl(index, mediaType, item, debrid) {
  const base = String(index?.url || '').replace(/\/$/, '');
  const isTorrentio = /torrentio/i.test(base) || /torrentio/i.test(index?.name || '');
  const segment = isTorrentio ? torrentioDebridSegment(debrid) : '';
  const cfg = segment ? `/${segment}` : '';
  return `${base}${cfg}/stream/${mediaType}/${item}.json`;
}

export const TV_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// key `imdb:season:episode:year:country` -> { sources, at }
const cache = new Map();

export function clearTvCache() {
  cache.clear();
}

// Containers a browser can play without help.
const NATIVE_CONTAINER = /\.(mp4|m4v)$/i;
const REMUXABLE_CONTAINER = /\.mkv$/i;
// Codecs Chrome cannot be relied on to decode even inside a playable container.
// HEVC support is hardware-dependent and absent often enough to be unusable here.
const UNPLAYABLE_CODEC = /(^|[^a-z])(x265|h\.?265|hevc|av1)([^a-z0-9]|$)/i;
const H264_CODEC = /(^|[^a-z])(x264|h\.?264|avc)([^a-z]|$)/i;

export function isRemuxableTvFile(name, context = '') {
  const n = String(name || '');
  const details = `${n} ${String(context || '')}`;
  return REMUXABLE_CONTAINER.test(n)
    && H264_CODEC.test(details)
    && !UNPLAYABLE_CODEC.test(details);
}

// `context` is the release title, which frequently carries codec information the
// filename omits. Real case: filename "...2160p.WEB-DL.DV.HDR[Ben The Men].mp4"
// looks fine, while its title says H265 - offered unfiltered, that plays as a
// black screen. The CONTAINER is judged only on the filename though: a title
// claiming "MP4" says nothing about the actual file.
export function isPlayableTvFile(name, context = '') {
  const n = String(name || '');
  const details = `${n} ${String(context || '')}`;
  if (NATIVE_CONTAINER.test(n)) return !UNPLAYABLE_CODEC.test(details);
  return isRemuxableTvFile(n, context);
}

// HEVC/x265 and AV1 are not reliable in the TV browser, but the helper can
// software-transcode them to H.264. Codec-less files remain excluded so an
// unknown MKV is never presented as a playable option.
const TRANSCODE_CONTAINER = /\.(mkv|mp4|m4v|ts|mov)$/i;
export function isTranscodableTvFile(name, context = '') {
  const n = String(name || '');
  const details = `${n} ${String(context || '')}`;
  return TRANSCODE_CONTAINER.test(n) && UNPLAYABLE_CODEC.test(details);
}

// Does this filename belong to the requested season and episode?
//
// The trap this exists to avoid: a loose numeric match reads S01E10 as episode 1
// and serves the wrong episode nine times out of ten. Every pattern below anchors
// the episode number so 1 never matches 10, 101, or a 1080p resolution tag.
export function matchesEpisode(name, season, episode) {
  const n = String(name || '');
  const s = Number(season);
  const e = Number(episode);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;

  // Digits may be zero-padded to any width, but the number must stand alone.
  const num = (v) => `0*${v}`;
  const patterns = [
    // S01E01 / s1 e1 / S01.E01
    new RegExp(`(^|[^0-9a-z])s${num(s)}[\\s._-]*e${num(e)}([^0-9]|$)`, 'i'),
    // 1x01
    new RegExp(`(^|[^0-9a-z])${num(s)}x${num(e)}([^0-9]|$)`, 'i'),
    // Season 1/Episode 1 directory layouts
    new RegExp(`season[\\s._-]*${num(s)}[\\s./_-]+episode[\\s._-]*${num(e)}([^0-9]|$)`, 'i'),
  ];
  return patterns.some((re) => re.test(n));
}

// Quality tag, used for ranking and display. Falls back to the release title:
// plenty of files are named bare ("Severance S01E01.mp4") while the title states
// the resolution, and reporting those as "unknown" makes the picker useless.
function detectQuality(name, context = '') {
  const find = (v) => (String(v || '').match(/(2160p|1080p|720p|480p)/i) || [])[1];
  const q = find(name) || find(context);
  return q ? q.toLowerCase() : 'unknown';
}

// Full HD is the default when a source can sustain it. File size, codec and live
// connection health still decide which 1080p release survives; 4K remains last
// because it is usually HEVC and too large for responsive torrent playback.
const QUALITY_RANK = { '1080p': 0, '720p': 1, '480p': 2, unknown: 3, '2160p': 4 };

// A directly-playable copy with a healthy swarm beats a transcode copy: transcoding
// adds GPU load and its own pipeline latency, so it should only be reached for when
// no well-seeded direct copy exists (the Mirzapur case, where the only H.264 copies
// were near-dead). Below this seed count a "direct" copy is too risky to bank on, so
// a healthy transcode copy is the better bet.
const HEALTHY_SEEDS = 8;
function playTier(s) {
  const healthy = s.debrid || (Number(s.seeds) || 0) >= HEALTHY_SEEDS;
  if (!s.transcode) return healthy ? 0 : 2; // direct play: first choice when seeded
  return healthy ? 1 : 3;                    // transcode: a fallback for when it is not
}

// "Heavy" = a bitrate a throttled connection can't sustain: an uncompressed BluRay
// REMUX, or simply a very large file. Preferring lighter WEB-DL rips of the same
// resolution is the single biggest anti-buffering lever short of more bandwidth.
const HEAVY_SIZE_BYTES = Number(process.env.TV_HEAVY_SIZE_BYTES || 1.5 * 1024 * 1024 * 1024);
function isHeavySource(s) {
  if (/\b(remux|bd[\s._-]?remux)\b/i.test(`${s.filename} ${s.title}`)) return true;
  const bytes = Number(s.sizeBytes) || parseSizeBytes(s.title);
  return bytes > HEAVY_SIZE_BYTES;
}

// A release explicitly tagged as a foreign-language dub should not beat an
// English/untagged copy merely because its tracker reports more seeds. MULTi is
// deliberately exempt because those releases normally include English audio.
const FOREIGN_ONLY = /\b(truefrench|french|vostfr|vfq|italian|ita|german|ger|spanish|latino|hindi|hungarian|hun|russian|rus|ukrainian|polish|dutch|turkish|arabic)\b/i;
function languagePenalty(s) {
  const details = `${s.filename || ''} ${s.title || ''}`;
  return /\bmulti\b/i.test(details) ? 0 : Number(FOREIGN_ONLY.test(details));
}

function sourceBytes(s) {
  return Number(s.sizeBytes) || parseSizeBytes(s.title) || 0;
}

// Filter to what can actually play, then order by usefulness.
export function rankTvSources(sources) {
  return (Array.isArray(sources) ? sources : [])
    // Keep directly-playable H.264 AND transcodable HEVC. HEVC is marked so the
    // helper knows to GPU-transcode it instead of remux-copying (which would play
    // as a black screen on a non-HEVC device).
    .map((s) => {
      const playable = isPlayableTvFile(s.filename, s.title);
      // Transcode HEVC. Also transcode a debrid file we can't directly play (e.g. a
      // bare-named .mkv with no codec tag): it's a cached instant source and the GPU
      // handles whatever codec it turns out to be, so it shouldn't be dropped.
      return { ...s, transcode: !playable && (isTranscodableTvFile(s.filename, s.title) || Boolean(s.debrid)) };
    })
    .filter((s) => s.transcode || isPlayableTvFile(s.filename, s.title))
    // A debrid source is a cached file with no swarm, so a 0 seed count is normal
    // and must NOT disqualify it; a plain torrent with 0 seeds never connects.
    .filter((s) => s.debrid || (Number(s.seeds) || 0) > 0)
    .map((s) => ({
      ...s,
      quality: detectQuality(s.filename, s.title),
      remux: isRemuxableTvFile(s.filename, s.title),
    }))
    .sort((a, b) => {
      // Debrid (cached, instant, no peers to find) always outranks a torrent.
      if (Boolean(a.debrid) !== Boolean(b.debrid)) return a.debrid ? -1 : 1;
      const q = (QUALITY_RANK[a.quality] ?? 3) - (QUALITY_RANK[b.quality] ?? 3);
      if (q !== 0) return q;
      const lang = languagePenalty(a) - languagePenalty(b);
      if (lang !== 0) return lang;
      // Bandwidth fit comes before codec preference. A compact HEVC episode that
      // the local GPU can transcode is safer than a multi-gigabyte H.264 file
      // whose bitrate exceeds the connection, even though H.264 is direct-play.
      const h = Number(isHeavySource(a)) - Number(isHeavySource(b));
      if (h !== 0) return h;
      // Within the same bandwidth tier, prefer healthy direct play, then healthy
      // transcode, followed by the poorly-seeded remainder.
      const t = playTier(a) - playTier(b);
      if (t !== 0) return t;
      // Seed counts from public indexes include unreachable private trackers.
      // Once two sources clear the healthy threshold, file size is the more useful
      // predictor of uninterrupted playback, so prefer the lighter episode.
      const aBytes = sourceBytes(a);
      const bBytes = sourceBytes(b);
      if (aBytes && bBytes && aBytes !== bBytes) return aBytes - bBytes;
      return (Number(b.seeds) || 0) - (Number(a.seeds) || 0);
    });
}

// Choose the file to stream out of a torrent's file list.
// A season pack holds every episode, so picking the largest playable file (which
// is what the movie path does) would serve a random episode. Match first; only
// fall back to "the one playable video" for single-episode torrents, which are
// sometimes named without any SxxExx marker.
export function pickEpisodeFile(files, season, episode, context = '') {
  // `context` is the release title. Codec information usually lives there and not
  // in the per-episode filename inside a season pack, and judging the file
  // without it rejects torrents the source-level filter has already vouched for.
  const playable = (Array.isArray(files) ? files : []).filter((f) => isPlayableTvFile(f.path || f.name, context));
  if (!playable.length) return null;

  const matched = playable.filter((f) => matchesEpisode(f.path || f.name, season, episode));
  if (matched.length) return matched.sort((a, b) => (b.length || 0) - (a.length || 0))[0];

  // No episode marker anywhere: a single playable video is unambiguous.
  if (playable.length === 1 && !/s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3}/i.test(playable[0].path || playable[0].name)) return playable[0];
  return null;
}

// The episode's video file for PROBING (duration, embedded subtitles), chosen
// without the codec/remux filter pickEpisodeFile applies. Probing only reads
// metadata, so an x265 pack that could not be played back should still have its
// duration and subtitle tracks read. Matches the episode by name among video
// containers; falls back to the single video in a one-episode torrent.
const VIDEO_CONTAINER = /\.(mkv|mp4|m4v|webm|avi|mov|ts)$/i;
export function pickEpisodeVideoFile(files, season, episode) {
  const vids = (Array.isArray(files) ? files : []).filter((f) => VIDEO_CONTAINER.test(f.path || f.name));
  if (!vids.length) return null;
  const matched = vids.filter((f) => matchesEpisode(f.path || f.name, season, episode));
  if (matched.length) return matched.sort((a, b) => (b.length || 0) - (a.length || 0))[0];
  if (vids.length === 1) return vids[0];
  return vids.sort((a, b) => (b.length || 0) - (a.length || 0))[0];
}

// Movie indexes can point at one file inside a multi-film torrent. Honour that
// index exactly: falling back to the largest file in the pack silently plays the
// wrong movie. Invalid or unplayable indexed files fail closed so source fallback
// can move on to another release.
export function pickMovieFileByIndex(files, fileIndex, context = '', anyCodec = false) {
  if (!Number.isInteger(fileIndex) || fileIndex < 0) return null;
  const file = (Array.isArray(files) ? files : [])[fileIndex];
  if (!file || !VIDEO_CONTAINER.test(file.path || file.name)) return null;
  return anyCodec || isPlayableTvFile(file.path || file.name, context) ? file : null;
}

// Stremio torrent indexes report seeds inside human-readable text, e.g. "👤 123".
function parseSeeds(text) {
  const m = String(text || '').match(/👤\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

// Stremio indexes print the file size as "💾 1.8 GB". Bytes proxy the bitrate, which
// is what decides whether a source streams smoothly over a throttled connection.
const SIZE_UNITS = { tb: 1024 ** 4, gb: 1024 ** 3, mb: 1024 ** 2, kb: 1024 };
function parseSizeBytes(text) {
  const m = String(text || '').match(/💾\s*([\d.]+)\s*(TB|GB|MB|KB)/i);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (SIZE_UNITS[m[2].toLowerCase()] || 0));
}

function configuredIndexes() {
  const raw = String(process.env.TV_TORRENT_INDEXES || '').trim();
  if (!raw) return DEFAULT_TV_INDEXES;
  return raw.split(',').map((url) => url.trim()).filter(Boolean).map((url) => {
    let name = url;
    try { name = new URL(url).hostname; } catch { /* the fetch error will explain an invalid URL */ }
    return { name, url };
  });
}

function normalizeIndexes(indexes) {
  return (Array.isArray(indexes) ? indexes : []).map((index) => {
    if (typeof index === 'string') {
      let name = index;
      try { name = new URL(index).hostname; } catch { /* handled by fetch */ }
      return { name, url: index };
    }
    return { name: index?.name || index?.url || 'torrent index', url: index?.url || '' };
  }).filter((index) => index.url);
}

function normalizeStream(st, provider) {
  const description = [st?.title, st?.description, st?.name].filter(Boolean).join('\n');
  const filename = st?.behaviorHints?.filename
    || String(st?.description || st?.title || st?.name || '').split('\n')[0]
    || '';
  // Debrid results carry a ready-to-stream `url` and NO infoHash. A plain torrent
  // is the reverse. `debrid` marks the former so ranking can float it to the top
  // (cached = instant, no swarm to find) and the helper knows to remux the URL.
  const streamUrl = String(st?.url || '').trim();
  const hash = String(st?.infoHash || '').toLowerCase();
  return {
    hash,
    url: /^https?:\/\//i.test(streamUrl) ? streamUrl : '',
    debrid: !hash && /^https?:\/\//i.test(streamUrl),
    filename,
    seeds: parseSeeds(description),
    sizeBytes: parseSizeBytes(description),
    title: description,
    provider,
    fileIndex: Number.isInteger(st?.fileIdx) ? st.fileIdx : null,
  };
}

const COUNTRY_MARKERS = {
  AU: ['AU', 'AUS', 'AUSTRALIA'],
  US: ['US', 'USA'],
  UK: ['UK'],
};

function normalizeCountry(country) {
  const c = String(country || '').trim().toUpperCase();
  return c === 'GB' ? 'UK' : c;
}

// A broad index can return a spin-off under the parent show's IMDb lookup.
// Compare the release's series prefix, not just its S/E marker (e.g. reject
// "Rick and Morty: The Anime" when the selected series is "Rick and Morty").
export function matchesSeriesTitle(source, titles = []) {
  const normalize = text => String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|and)\b/g, ' ').trim().replace(/\s+/g, ' ');
  const wanted = titles.map(normalize).filter(Boolean);
  if (!wanted.length) return true;
  const name = String(source.filename || source.title || '').split('\n')[0].replace(/\[[^\]]*\]/g, '');
  const marker = /(?:^|[ ._-])(?:s\d{1,2}(?:e\d{1,3})?|\d{1,2}x\d{1,3}|season[ ._-]*\d)/i.exec(name);
  if (!marker) return true; // index identity is the only usable information
  const prefix = normalize(name.slice(0, marker.index));
  if (!prefix) return true;
  return wanted.some(title => {
    if (prefix === title) return true;
    if (!prefix.startsWith(title + ' ')) return false;
    const suffix = prefix.slice(title.length).trim();
    return /^(?:(?:19|20)\d{2}|us|usa|uk|au|complete)(?: (?:(?:19|20)\d{2}|us|usa|uk|au|complete))*$/.test(suffix);
  });
}

// Some broad indexes search a title as well as its IMDb id. Reject an explicitly
// conflicting year/country while retaining releases that simply omit those tags.
function matchesSeriesHints(source, { year, country } = {}) {
  const text = `${source.filename} ${source.title}`.toUpperCase();
  const expectedYear = Number(year);
  if (Number.isInteger(expectedYear)) {
    const years = [...text.matchAll(/(^|[^0-9])((?:19|20)\d{2})([^0-9]|$)/g)].map((m) => Number(m[2]));
    if (years.length && !years.includes(expectedYear)) return false;
  }

  const expectedCountry = normalizeCountry(country);
  if (COUNTRY_MARKERS[expectedCountry]) {
    const tokens = new Set(text.split(/[^A-Z0-9]+/).filter(Boolean));
    const detected = Object.entries(COUNTRY_MARKERS)
      .filter(([, markers]) => markers.some((marker) => tokens.has(marker)))
      .map(([code]) => code);
    if (detected.length && !detected.includes(expectedCountry)) return false;
  }
  return true;
}

// Look up playable sources for one episode. Returns a ranked (possibly empty)
// array; throws only when every configured index could not be reached.
async function fetchIndexedSources(imdb, season, episode, {
  fetchImpl = resolvingFetch,
  timeoutMs = 15000,
  ttlMs = TV_CACHE_TTL_MS,
  retries = 1,
  retryDelayMs = 1200,
  now = () => Date.now(),
  indexUrls = configuredIndexes(),
  debrid = debridSettings(),
  year,
  country,
  title,
  originalTitle,
  mediaType = 'series',
} = {}) {
  const key = `${mediaType}:${imdb}:${season}:${episode}:${year || ''}:${normalizeCountry(country)}:${title || ''}:${originalTitle || ''}:${debrid ? debrid.service : ''}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < ttlMs) return hit.sources;

  const errors = [];
  let anyIndexResponded = false;
  // Every index that answers contributes. Returning the first non-empty one meant
  // Comet (which answers fastest) hid Torrentio's public-tracker torrents, and
  // those are the ones with reachable peers.
  const collected = [];

  for (const index of normalizeIndexes(indexUrls)) {
    const item = mediaType === 'movie' ? encodeURIComponent(imdb) : `${encodeURIComponent(imdb)}:${season}:${episode}`;
    const url = indexStreamUrl(index, mediaType, item, debrid);
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      try {
        const res = await fetchImpl(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        anyIndexResponded = true;
        collected.push(
          ...(body?.streams || [])
            .map((st) => normalizeStream(st, index.name))
            // Keep plain torrents (valid infohash) AND debrid results (a ready
            // HTTP url, no infohash). Everything else is unstreamable here.
            .filter((source) => /^[a-f0-9]{40}$/.test(source.hash) || source.debrid)
            .filter((source) => matchesSeriesHints(source, { year, country }))
            .filter((source) => matchesSeriesTitle(source, [title, originalTitle]))
            .filter((source) => mediaType === 'movie' || !/s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3}/i.test(source.filename) || matchesEpisode(source.filename, season, episode))
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) errors.push(`${index.name}: ${lastErr?.message || lastErr}`);
  }

  if (collected.length) {
    // Rank BEFORE dedupe. Indexes describe the same infohash with different
    // quality: one may omit the codec (reads as unplayable) or the seed count
    // (reads as dead) while another describes it correctly. Filtering first and
    // then keeping the best-ranked copy of each hash means a torrent is only
    // dropped when NO index could vouch for it.
    const seen = new Set();
    const sources = rankTvSources(collected).filter((s) => {
      const id = s.hash || s.url; // debrid sources have no hash; key them by url
      return id && !seen.has(id) && seen.add(id);
    });
    cache.set(key, { sources, at: now() });
    return sources;
  }

  if (anyIndexResponded) {
    const sources = [];
    cache.set(key, { sources, at: now() });
    return sources;
  }

  const err = new Error(`TV torrent indexes failed for ${imdb}:${season}:${episode}: ${errors.join(' | ') || 'no indexes configured'}`);
  err.hostErrors = errors;
  throw err;
}


// Verified season packs that the IMDb-only indexes omit. Keep this list narrow:
// each entry has been checked against its torrent file list so the quality picker
// can expose real alternatives without admitting title-search false positives.
const WINDSORS_S1_AV1_MB = [0, 469.86, 453.88, 460.78, 443.58, 458.51, 463.07];
const WINDSORS_S1_H264_GB = [0, 1.67, 1.62, 1.63, 1.57, 1.62, 1.63];
export function supplementalTvSources(imdb, season, episode) {
  const e = Number(episode);
  if (imdb !== 'tt5692740' || Number(season) !== 1 || !Number.isInteger(e) || e < 1 || e > 6) return [];
  const ep = String(e).padStart(2, '0');
  const av1Name = `The Windsors.S01.E${ep}.1080p.AV1.PlamenNik.mkv`;
  const h264Name = `The.Windsors.S01E${ep}.1080p.AMZN.WEB-DL.DD2.0.H.264-Cinefeel.mkv`;
  return [
    {
      hash: 'fe1d4208f36e9a1f1c2e771ee5e4e4734d6cf305', url: '', debrid: false,
      filename: av1Name, seeds: 4,
      sizeBytes: Math.round(WINDSORS_S1_AV1_MB[e] * 1024 * 1024),
      title: `The Windsors S01 1080p AV1 PlamenNik\n${av1Name}\n👤 4`,
      provider: 'Verified DHT', fileIndex: null,
    },
    {
      hash: '74317662682c0f54cb076bd690cdc53e13512e6a', url: '', debrid: false,
      filename: h264Name, seeds: 2,
      sizeBytes: Math.round(WINDSORS_S1_H264_GB[e] * 1024 * 1024 * 1024),
      title: `The Windsors S01 1080p AMZN WEB-DL x264 Cinefeel\n${h264Name}\n👤 2`,
      provider: 'Verified DHT', fileIndex: null,
    },
  ];
}
export async function fetchTvSources(imdb, season, episode, options = {}) {
  const indexed = await fetchIndexedSources(imdb, season, episode, options);
  const seen = new Set();
  return rankTvSources([...supplementalTvSources(imdb, season, episode), ...indexed])
    .filter((source) => {
      const id = source.hash || source.url;
      return id && !seen.has(id) && seen.add(id);
    });
}
export function fetchMovieSources(imdb, options = {}) {
  return fetchIndexedSources(imdb, 0, 0, { ...options, mediaType: "movie" })
    .then((sources) => sources.filter((source) => !/\bfan[\s._-]*made\b/i.test(`${source.filename || ""} ${source.title || ""}`)));
}
