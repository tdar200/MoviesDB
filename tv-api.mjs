// tv-api.mjs — the TV torrent source: torrentio lookup -> a browser-playable episode.
//
// YTS is movies only (its API is literally list_movies.json), so shows had no
// torrent fallback at all. EZTV would have been the natural analogue but its own
// Cloudflare edge returns 451 to UK traffic across every domain and mirror, and
// apibay answers 200 while its search returns "No results returned" for every
// query. torrentio is what actually works from here: keyless, IMDb-keyed, one
// request per episode, ~50 sources, 0.6-2.8s (measured Aug 19, 2026).
//
// The hard part is not finding sources, it is that almost none of them play. Of
// 200 sampled sources only 24 were .mp4; the rest were .mkv, which Chrome cannot
// play at all, and x265 outnumbered x264 among those stating a codec. Every
// sampled episode still had 2-9 usable .mp4 sources, and one is all we need — so
// this module's real job is filtering, ranking, and finding the right episode
// inside a season pack.
//
// Deliberately no ffmpeg: remuxing or transcoding would widen coverage enormously
// but is a different feature with a real CPU cost. This ships the MP4-only path.

const TORRENTIO = 'https://torrentio.strem.fun';

export const TV_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// key `imdb:season:episode` -> { sources, at }
const cache = new Map();

export function clearTvCache() {
  cache.clear();
}

// Containers a browser can play. .mkv is excluded because Chrome cannot decode
// Matroska at all, not merely because of its codecs.
const PLAYABLE_CONTAINER = /\.(mp4|m4v)$/i;
// Codecs Chrome cannot be relied on to decode even inside a playable container.
// HEVC support is hardware-dependent and absent often enough to be unusable here.
const UNPLAYABLE_CODEC = /(^|[^a-z])(x265|h\.?265|hevc)([^a-z]|$)/i;

// `context` is the release title, which frequently carries codec information the
// filename omits. Real case: filename "...2160p.WEB-DL.DV.HDR[Ben The Men].mp4"
// looks fine, while its title says H265 - offered unfiltered, that plays as a
// black screen. The CONTAINER is judged only on the filename though: a title
// claiming "MP4" says nothing about the actual file.
export function isPlayableTvFile(name, context = '') {
  const n = String(name || '');
  if (!PLAYABLE_CONTAINER.test(n)) return false;
  return !UNPLAYABLE_CODEC.test(n) && !UNPLAYABLE_CODEC.test(String(context || ''));
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
    .map((s) => ({ ...s, quality: detectQuality(s.filename, s.title) }))
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
export function pickEpisodeFile(files, season, episode) {
  const playable = (Array.isArray(files) ? files : []).filter((f) => isPlayableTvFile(f.path || f.name));
  if (!playable.length) return null;

  const matched = playable.filter((f) => matchesEpisode(f.path || f.name, season, episode));
  if (matched.length) return matched.sort((a, b) => (b.length || 0) - (a.length || 0))[0];

  // No episode marker anywhere: a single playable video is unambiguous.
  if (playable.length === 1) return playable[0];
  return null;
}

// torrentio reports seeds inside the human-readable title, e.g. "👤 123".
function parseSeeds(title) {
  const m = String(title || '').match(/👤\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

// Look up playable sources for one episode. Returns a ranked (possibly empty)
// array; throws only when torrentio itself could not be reached.
export async function fetchTvSources(imdb, season, episode, {
  fetchImpl = fetch,
  timeoutMs = 15000,
  ttlMs = TV_CACHE_TTL_MS,
  retries = 1,
  retryDelayMs = 1200,
  now = () => Date.now(),
} = {}) {
  const key = `${imdb}:${season}:${episode}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < ttlMs) return hit.sources;

  const url = `${TORRENTIO}/stream/series/${encodeURIComponent(imdb)}:${season}:${episode}.json`;
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
      const sources = rankTvSources(
        (body?.streams || []).map((st) => ({
          hash: (st.infoHash || '').toLowerCase(),
          filename: st.behaviorHints?.filename || (st.title || '').split('\n')[0] || '',
          seeds: parseSeeds(st.title),
          title: (st.title || '').split('\n')[0] || '',
        })).filter((s) => /^[a-f0-9]{40}$/.test(s.hash))
      );
      cache.set(key, { sources, at: now() });
      return sources;
    } catch (err) {
      lastErr = err;
    }
  }

  const err = new Error(`torrentio lookup failed for ${key}: ${lastErr?.message || lastErr}`);
  err.cause = lastErr;
  throw err;
}
