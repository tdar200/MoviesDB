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
const UNPLAYABLE_CODEC = /(^|[^a-z])(x265|h\.?265|hevc)([^a-z]|$)/i;
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

// 1080p first, then 720p, then anything unlabelled, and 2160p last: 4K sources
// dominated the sample, are nearly all x265, and are a poor fit for a domestic
// uplink even when they are playable.
const QUALITY_RANK = { '1080p': 0, '720p': 1, '480p': 2, unknown: 3, '2160p': 4 };

// Filter to what can actually play, then order by usefulness.
export function rankTvSources(sources) {
  return (Array.isArray(sources) ? sources : [])
    .filter((s) => isPlayableTvFile(s.filename, s.title))
    .filter((s) => (Number(s.seeds) || 0) > 0)
    .map((s) => ({
      ...s,
      quality: detectQuality(s.filename, s.title),
      remux: isRemuxableTvFile(s.filename, s.title),
    }))
    .sort((a, b) => {
      const q = (QUALITY_RANK[a.quality] ?? 3) - (QUALITY_RANK[b.quality] ?? 3);
      return q !== 0 ? q : (Number(b.seeds) || 0) - (Number(a.seeds) || 0);
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

// Stremio torrent indexes report seeds inside human-readable text, e.g. "👤 123".
function parseSeeds(text) {
  const m = String(text || '').match(/👤\s*(\d+)/);
  return m ? Number(m[1]) : 0;
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
  return {
    hash: String(st?.infoHash || '').toLowerCase(),
    filename,
    seeds: parseSeeds(description),
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
  year,
  country,
  title,
  originalTitle,
  mediaType = 'series',
} = {}) {
  const key = `${mediaType}:${imdb}:${season}:${episode}:${year || ''}:${normalizeCountry(country)}:${title || ''}:${originalTitle || ''}`;
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
    const url = `${index.url.replace(/\/$/, '')}/stream/${mediaType}/${item}.json`;
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
            .filter((source) => /^[a-f0-9]{40}$/.test(source.hash))
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
    const sources = rankTvSources(collected).filter((s) => !seen.has(s.hash) && seen.add(s.hash));
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

export function fetchTvSources(imdb, season, episode, options = {}) {
  return fetchIndexedSources(imdb, season, episode, options);
}
export function fetchMovieSources(imdb, options = {}) {
  return fetchIndexedSources(imdb, 0, 0, { ...options, mediaType: 'movie' });
}
