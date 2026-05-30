// Content-based recommendation engine for the Movies app.
// Pure functions (profile + scoring + reasons) are unit-tested; network/cache
// functions live lower in the file and are exercised manually in the browser.
import { MOVIE_GENRES, TV_GENRES } from './config.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const GENRE_NAMES = new Map();
[...MOVIE_GENRES, ...TV_GENRES].forEach((g) => {
  if (g.id !== 0) GENRE_NAMES.set(g.id, g.name);
});

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30-day half-life

// --- Engagement & star tuning ---
const ENGAGEMENT_MIN = 0.4;
const ENGAGEMENT_MAX = 2.5;
const QUICK_BAIL_MS = 120000;       // < 2 min dwell = sampled-and-dropped
const FULL_ENGAGE_MS = 5400000;     // ~90 min dwell = fully engaged
const EPISODE_SATURATION = 20;      // episodes reached for max episode signal
const STAR_BONUS = 2.5;             // multiplier for starred items
const COVERAGE_WEIGHT = 0.5;        // strength of collection-breadth bonus

// Map a title's measured engagement to a weight multiplier in [0.4 .. 2.5].
// Callers pass a real engagement record; absence of a record is handled by the
// profile builder (neutral 1.0), not here.
export function engagementBoost(dwellMs, episodes) {
  const d = dwellMs || 0;
  const ep = episodes || 0;
  // Below the bail threshold with no episodes watched: downweight toward MIN.
  if (d < QUICK_BAIL_MS && ep === 0) {
    return ENGAGEMENT_MIN + (1 - ENGAGEMENT_MIN) * (d / QUICK_BAIL_MS);
  }
  // Otherwise interpolate 1.0 -> MAX by the stronger of dwell / episode signal.
  const engage = Math.max(
    Math.min(d / FULL_ENGAGE_MS, 1),
    Math.min(ep / EPISODE_SATURATION, 1)
  );
  return 1 + (ENGAGEMENT_MAX - 1) * engage;
}

// Newer watched items count more. Returns 1.0 at now, ~0.5 after 30 days.
export function recencyWeight(watchedAt, now) {
  if (!watchedAt) return 0.5;
  const age = Math.max(0, now - watchedAt);
  return Math.pow(0.5, age / HALF_LIFE_MS);
}

// Higher-rated watched titles nudge their signal up. 0-10 → 0.75..1.25.
export function ratingNudge(voteAverage) {
  if (typeof voteAverage !== 'number' || voteAverage <= 0) return 1;
  return 0.75 + (voteAverage / 10) * 0.5;
}

function topNumeric(obj, n) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
  );
}

function topWeighted(obj, n) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1].weight - a[1].weight).slice(0, n)
  );
}

// Build a weighted taste profile from enriched watched items. `now` is injected
// for deterministic testing.
export function buildTasteProfile(enrichedWatched, now) {
  const genres = {};
  const keywords = {};
  const people = {};
  const mediaTypeBias = { movie: 0, tv: 0 };
  const topTitles = [];

  for (const item of enrichedWatched) {
    const recency = item._starred ? 1 : recencyWeight(item.watchedAt, now);
    const eng = item._engagement
      ? engagementBoost(item._engagement.dwellMs, item._engagement.episodes)
      : 1;
    const star = item._starred ? STAR_BONUS : 1;
    const w = recency * ratingNudge(item.vote_average) * eng * star;

    (item.genre_ids || []).forEach((id) => {
      genres[id] = (genres[id] || 0) + w;
    });
    (item._keywords || []).forEach((k) => {
      if (!keywords[k.id]) keywords[k.id] = { name: k.name, weight: 0 };
      keywords[k.id].weight += w;
    });
    (item._people || []).forEach((p) => {
      if (!people[p.id]) people[p.id] = { name: p.name, weight: 0 };
      people[p.id].weight += w;
    });

    const mt = item.media_type === 'tv' ? 'tv' : 'movie';
    mediaTypeBias[mt] += w;
    topTitles.push({
      id: item.id,
      title: item.title || item.name || '',
      weight: w,
      genreIds: item.genre_ids || [],
      keywordIds: (item._keywords || []).map((k) => k.id),
      peopleIds: (item._people || []).map((p) => p.id),
      media_type: mt,
    });
  }

  return {
    genres: topNumeric(genres, 15),
    keywords: topWeighted(keywords, 30),
    people: topWeighted(people, 20),
    mediaTypeBias,
    topTitles: topTitles.sort((a, b) => b.weight - a.weight),
  };
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Merge Discover result lists, deduping by id and accumulating seed provenance.
export function mergeCandidates(taggedCandidates) {
  const byId = new Map();
  for (const c of taggedCandidates) {
    const key = String(c.id);
    if (byId.has(key)) {
      byId.get(key)._seeds.push(...(c._seeds || []));
    } else {
      byId.set(key, { ...c, _seeds: [...(c._seeds || [])] });
    }
  }
  return [...byId.values()];
}

// Count how many distinct watched/starred titles a candidate aligns with, via
// its seed provenance (shared keyword/person) and shared genres.
function contributingTitleCount(candidate, profile) {
  const seedKw = new Set();
  const seedPp = new Set();
  for (const s of candidate._seeds || []) {
    if (s.type === 'keyword') seedKw.add(s.id);
    else if (s.type === 'person') seedPp.add(s.id);
  }
  const candGenres = new Set((candidate.genre_ids || []).map(Number));
  const ids = new Set();
  for (const t of profile.topTitles || []) {
    const kwHit = (t.keywordIds || []).some((k) => seedKw.has(k));
    const ppHit = (t.peopleIds || []).some((p) => seedPp.has(p));
    const gnHit = (t.genreIds || []).some((g) => candGenres.has(Number(g)));
    if (kwHit || ppHit || gnHit) ids.add(t.id);
  }
  return ids.size;
}

// Score a candidate: seed provenance + profile genre overlap + light popularity prior.
export function scoreCandidate(candidate, profile) {
  let score = 0;
  for (const seed of candidate._seeds || []) score += seed.weight;
  for (const gid of candidate.genre_ids || []) {
    const gw = profile.genres[String(gid)];
    if (gw) score += gw * 0.5;
  }
  const pop = candidate.popularity || 0;
  score += Math.log10(pop + 1) * 0.1;
  const contributors = contributingTitleCount(candidate, profile);
  return score * (1 + COVERAGE_WEIGHT * Math.log2(1 + contributors));
}

// Up to 2 human-readable reasons. Prefers "Because you watched <title>" when the
// candidate's strongest seed (person/keyword) is shared with a watched title.
export function generateReasons(candidate, profile) {
  const reasons = [];
  const seeds = [...(candidate._seeds || [])].sort((a, b) => b.weight - a.weight);
  const topSeed = seeds.find((s) => s.type === 'person' || s.type === 'keyword');

  if (topSeed) {
    const shared = profile.topTitles.find((t) =>
      topSeed.type === 'person'
        ? t.peopleIds.includes(topSeed.id)
        : t.keywordIds.includes(topSeed.id)
    );
    if (shared && shared.title) reasons.push(`Because you watched ${shared.title}`);
    else if (topSeed.type === 'person') reasons.push(`Features ${topSeed.name}`);
    else reasons.push(capitalize(topSeed.name));
  }

  if (reasons.length < 2) {
    const matchedGenres = (candidate.genre_ids || [])
      .filter((id) => profile.genres[String(id)])
      .map((id) => GENRE_NAMES.get(id))
      .filter(Boolean);
    if (matchedGenres.length) reasons.push(matchedGenres.slice(0, 2).join(' · '));
  }

  return reasons.slice(0, 2);
}

// Score, drop already-watched, sort desc, take top `limit`.
export function rankCandidates(candidates, profile, watchedIds, limit = 20) {
  const watched = new Set([...watchedIds].map(String));
  return candidates
    .filter((c) => !watched.has(String(c.id)))
    .map((c) => ({ movie: c, score: scoreCandidate(c, profile), reasons: generateReasons(c, profile) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Network + cache layer (browser only)
// ---------------------------------------------------------------------------
import { ENDPOINTS } from './config.js';

const META_CACHE_KEY = 'recMetaCache';     // permanent per-title keywords/credits
const RECS_CACHE_KEY = 'recResultsCache';  // session recommendations cache

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMetaCache() {
  try {
    return JSON.parse(localStorage.getItem(META_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeMetaEntry(cacheKey, meta) {
  const cache = readMetaCache();
  cache[cacheKey] = meta;
  try {
    localStorage.setItem(META_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.error('recMetaCache write failed:', e);
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${url}`);
  return res.json();
}

// Fetch keywords + top cast/director for one title, caching permanently.
async function fetchTitleMeta(type, id) {
  const cache = readMetaCache();
  const cacheKey = `${type}:${id}`;
  if (cache[cacheKey]) return cache[cacheKey];

  const meta = { keywords: [], people: [] };
  try {
    const kw = await fetchJson(ENDPOINTS.keywords(type, id));
    const list = kw.keywords || kw.results || []; // movie vs tv shape
    meta.keywords = list.slice(0, 12).map((k) => ({ id: k.id, name: k.name }));
  } catch (e) {
    console.warn(`keywords fetch failed for ${cacheKey}:`, e.message);
  }
  try {
    const credits = await fetchJson(ENDPOINTS.credits(type, id));
    const cast = (credits.cast || []).slice(0, 5).map((c) => ({ id: c.id, name: c.name }));
    const director = (credits.crew || []).find((c) => c.job === 'Director');
    meta.people = director ? [...cast, { id: director.id, name: director.name }] : cast;
  } catch (e) {
    console.warn(`credits fetch failed for ${cacheKey}:`, e.message);
  }

  writeMetaEntry(cacheKey, meta);
  return meta;
}

// Attach _keywords/_people to each watched item. Batched to respect rate limits.
async function enrichWatchedTitles(watched) {
  const BATCH = 8;
  const enriched = [];
  for (let i = 0; i < watched.length; i += BATCH) {
    const slice = watched.slice(i, i + BATCH);
    const metas = await Promise.all(
      slice.map((m) => fetchTitleMeta(m.media_type === 'tv' ? 'tv' : 'movie', m.id))
    );
    slice.forEach((m, j) => {
      enriched.push({ ...m, _keywords: metas[j].keywords, _people: metas[j].people });
    });
    if (i + BATCH < watched.length) await delay(300);
  }
  return enriched;
}

// Pull Discover candidates seeded by the profile's top keywords/people/genres.
async function generateCandidates(profile) {
  const preferTv = profile.mediaTypeBias.tv > profile.mediaTypeBias.movie;
  const types = preferTv ? ['tv', 'movie'] : ['movie', 'tv'];
  const primaryType = types[0];

  const topKeywords = Object.entries(profile.keywords)
    .sort((a, b) => b[1].weight - a[1].weight).slice(0, 6);
  const topPeople = Object.entries(profile.people)
    .sort((a, b) => b[1].weight - a[1].weight).slice(0, 6);
  const topGenres = Object.entries(profile.genres)
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);

  const requests = [];
  for (const [id, { name, weight }] of topKeywords) {
    requests.push({ url: ENDPOINTS.discoverByKeyword(primaryType, id), seed: { type: 'keyword', id: Number(id), name, weight } });
  }
  for (const [id, { name, weight }] of topPeople) {
    requests.push({ url: ENDPOINTS.discoverByCast(primaryType, id), seed: { type: 'person', id: Number(id), name, weight } });
  }
  if (topGenres.length) {
    const csv = topGenres.join('|'); // OR
    requests.push({ url: ENDPOINTS.discoverByGenres(primaryType, csv), seed: { type: 'genre', id: Number(topGenres[0]), name: GENRE_NAMES.get(Number(topGenres[0])) || 'genre', weight: profile.genres[topGenres[0]] } });
  }

  const tagged = [];
  const BATCH = 6;
  for (let i = 0; i < requests.length; i += BATCH) {
    const slice = requests.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((r) => fetchJson(r.url).then((d) => ({ d, seed: r.seed })).catch(() => null))
    );
    for (const r of results) {
      if (!r) continue;
      for (const movie of (r.d.results || []).slice(0, 10)) {
        tagged.push({ ...movie, media_type: primaryType, _seeds: [r.seed] });
      }
    }
    if (i + BATCH < requests.length) await delay(300);
  }
  return mergeCandidates(tagged);
}

// Stable signature of the watched set so we can cache results per session.
function watchedSignature(watched) {
  return watched.map((m) => `${m.id}:${m.watchedAt || 0}`).join(',');
}

// Top-level orchestrator. Returns [{ movie, score, reasons }]. `now` injectable for tests.
export async function getRecommendations(watched, opts = {}) {
  const { limit = 20, now = Date.now() } = opts;
  if (!watched || watched.length === 0) return [];

  const sig = watchedSignature(watched);
  try {
    const cached = JSON.parse(sessionStorage.getItem(RECS_CACHE_KEY) || 'null');
    if (cached && cached.sig === sig) return cached.recs;
  } catch { /* ignore cache read errors */ }

  const enriched = await enrichWatchedTitles(watched);
  const profile = buildTasteProfile(enriched, now);
  const candidates = await generateCandidates(profile);
  const watchedIds = new Set(watched.map((m) => m.id));
  const recs = rankCandidates(candidates, profile, watchedIds, limit);

  try {
    sessionStorage.setItem(RECS_CACHE_KEY, JSON.stringify({ sig, recs }));
  } catch { /* ignore quota errors */ }
  return recs;
}

// Clear the session results cache (call after a new title is watched).
export function clearRecommendationCache() {
  try {
    sessionStorage.removeItem(RECS_CACHE_KEY);
  } catch { /* ignore */ }
}
