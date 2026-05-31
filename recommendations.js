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
const DOWNVOTE_PENALTY = 1.0;       // steer-away strength: a downvoted theme cancels an equal positive one

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

// Net a positive profile (basket) against a negative profile (downvoted) into a single
// profile the candidate generator/scorer consume. Genres keep their net value (which may
// be negative, so scoring penalizes candidates in disliked genres). Keywords/people are
// netted but anything <= 0 is dropped, so disliked themes never seed candidate generation.
export function combineProfiles(pos, neg, opts = {}) {
  const { penalty = DOWNVOTE_PENALTY } = opts;
  const n = neg || { genres: {}, keywords: {}, people: {} };

  const genres = {};
  for (const [g, w] of Object.entries(pos.genres || {})) genres[g] = w;
  for (const [g, w] of Object.entries(n.genres || {})) genres[g] = (genres[g] || 0) - penalty * w;

  const netWeighted = (posMap, negMap) => {
    const out = {};
    for (const [id, v] of Object.entries(posMap || {})) out[id] = { name: v.name, weight: v.weight };
    for (const [id, v] of Object.entries(negMap || {})) {
      if (out[id]) out[id].weight -= penalty * v.weight; // purely-downvoted themes are never added
    }
    for (const id of Object.keys(out)) if (out[id].weight <= 0) delete out[id];
    return out;
  };

  return {
    genres,
    keywords: netWeighted(pos.keywords, n.keywords),
    people: netWeighted(pos.people, n.people),
    mediaTypeBias: pos.mediaTypeBias || { movie: 0, tv: 0 },
    topTitles: pos.topTitles || [],
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

// Up to 2 reasons, collection-aware. Leads with a taste theme (top matched
// genre and/or strongest matched person/keyword); appends "esp. <Title>" when a
// single watched/starred title dominates the match.
export function generateReasons(candidate, profile) {
  // Matched genres, strongest first by profile weight.
  const matchedGenres = (candidate.genre_ids || [])
    .map(Number)
    .filter((id) => profile.genres[String(id)])
    .sort((a, b) => profile.genres[String(b)] - profile.genres[String(a)])
    .map((id) => GENRE_NAMES.get(id))
    .filter(Boolean);

  // Strongest matched person/keyword seed.
  const seeds = [...(candidate._seeds || [])].sort((a, b) => b.weight - a.weight);
  const topSeed = seeds.find((s) => s.type === 'person' || s.type === 'keyword');

  // Dominant contributing title: a watched/starred title sharing the top seed.
  let dominantTitle = null;
  if (topSeed) {
    const shared = (profile.topTitles || []).find((t) =>
      topSeed.type === 'person'
        ? (t.peopleIds || []).includes(topSeed.id)
        : (t.keywordIds || []).includes(topSeed.id)
    );
    if (shared && shared.title) dominantTitle = shared.title;
  }

  // Build the theme.
  const themeParts = [];
  if (matchedGenres[0]) themeParts.push(matchedGenres[0]);
  if (topSeed) themeParts.push(topSeed.type === 'person' ? topSeed.name : capitalize(topSeed.name));
  else if (matchedGenres[1]) themeParts.push(matchedGenres[1]);

  let theme;
  if (themeParts.length >= 2) {
    theme = `Matches your love of ${themeParts[0]} & ${themeParts[1]}`;
  } else if (themeParts.length === 1) {
    // A single part is the matched genre only when no person/keyword was matched;
    // otherwise it's a person/keyword and must not be labelled a "genre".
    theme = matchedGenres[0]
      ? `From your most-watched genre: ${themeParts[0]}`
      : `Matches your taste for ${themeParts[0]}`;
  } else {
    theme = 'Picked for your taste';
  }

  const reasons = [theme];
  if (dominantTitle && theme !== 'Picked for your taste') reasons.push(`esp. ${dominantTitle}`);
  return reasons.slice(0, 2);
}

// Group a ranked rec list into themed rows for the dedicated Recommendation page.
// Pure: no network, no DOM. `ranked` = [{movie, score, reasons}] where each movie
// carries _seeds provenance and genre_ids; `profile` is a buildTasteProfile() result.
export function groupIntoRows(ranked, profile, opts = {}) {
  const {
    topCount = 20,
    titleRows = 3,
    genreRows = 3,
    personRows = 2,
    minItems = 4,
    maxRows = 10,
    itemsPerRow = 20,
  } = opts;

  const rows = [];

  // 1. Top picks — highest scored overall. Does not consume the themed-row claim.
  if (ranked.length && topCount > 0) {
    rows.push({ kind: 'top', title: 'Top picks for you', recs: ranked.slice(0, topCount) });
  }

  // A movie lands in at most one themed row; first themed row (by order below) wins.
  const claimed = new Set();
  const recId = (r) => String(r.movie.id);
  const take = (predicate) => ranked
    .filter((r) => !claimed.has(recId(r)) && predicate(r))
    .slice(0, itemsPerRow);
  const claim = (recs) => recs.forEach((r) => claimed.add(recId(r)));
  const hasSeed = (r, type, id) => (r.movie._seeds || []).some((s) => s.type === type && s.id === id);

  // 2. Because you watched X — strongest contributing titles by profile weight.
  // Note: these also claim person-seeded recs, so a "More from <Person>" row for a
  // person who is also in topTitles may be starved (and dropped by the minItems gate).
  for (const t of (profile.topTitles || []).slice(0, titleRows)) {
    const kw = new Set(t.keywordIds || []);
    const pp = new Set(t.peopleIds || []);
    const recs = take((r) => (r.movie._seeds || []).some((s) =>
      (s.type === 'keyword' && kw.has(Number(s.id))) || (s.type === 'person' && pp.has(Number(s.id)))));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'title', title: `Because you watched ${t.title}`, recs });
    }
  }

  // 3. More <Genre> — top profile genres by weight.
  const topGenres = Object.entries(profile.genres || {})
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, genreRows).map(([id]) => Number(id));
  for (const gid of topGenres) {
    const recs = take((r) => (r.movie.genre_ids || []).map(Number).includes(gid));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'genre', title: `More ${GENRE_NAMES.get(gid) || 'like this'}`, recs });
    }
  }

  // 4. More from <Person> — top profile people by weight.
  const topPeople = Object.entries(profile.people || {})
    .sort((a, b) => b[1].weight - a[1].weight).slice(0, personRows);
  for (const [pidStr, { name }] of topPeople) {
    const pid = Number(pidStr);
    const recs = take((r) => hasSeed(r, 'person', pid));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'person', title: `More from ${name}`, recs });
    }
  }

  return rows.slice(0, maxRows);
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
    .filter(([, w]) => w > 0)                       // never seed Discover with a downvoted genre
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

// Stable signature of the explicit signal set (basket + downvoted) for session caching.
// Toggling a star or a downvote changes this, busting the cache.
function signalSignature(basket, downvoted) {
  const ids = (arr) => (arr || []).map((m) => m.id).sort().join(',');
  return `b:${ids(basket)}|d:${ids(downvoted)}`;
}

// Shared pipeline: enrich basket + downvoted → positive/negative profiles → net profile
// → candidates → rank, excluding watched ∪ downvoted ∪ basket. `input` is
// { basket: [movie], downvoted: [movie], watchedIds: [id] }. Cached per (signature, limit).
async function _pipeline(input, opts = {}) {
  const { limit = 20, now = Date.now(), penalty = DOWNVOTE_PENALTY } = opts;
  const basket = input.basket || [];
  const downvoted = input.downvoted || [];
  const watchedIds = input.watchedIds || [];

  const sig = signalSignature(basket, downvoted);
  const cacheKey = `${RECS_CACHE_KEY}:${limit}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    if (cached && cached.sig === sig) return { profile: cached.profile, recs: cached.recs };
  } catch { /* ignore cache read errors */ }

  // Basket items are explicit seeds; mark them starred and drop engagement so the profile
  // weights them uniformly (basket-primary, not time/engagement-driven). Downvoted items
  // are profiled the same way so positive/negative weights are on a comparable scale.
  const annotate = (arr) => arr.map((m) => ({ ...m, _starred: true, _engagement: null }));
  const basketEnriched = annotate(await enrichWatchedTitles(basket));
  const downEnriched = annotate(await enrichWatchedTitles(downvoted));

  const posProfile = buildTasteProfile(basketEnriched, now);
  const negProfile = downEnriched.length ? buildTasteProfile(downEnriched, now) : null;
  const profile = combineProfiles(posProfile, negProfile, { penalty });

  const candidates = await generateCandidates(profile);
  const excludeIds = new Set(
    [...basket, ...downvoted].map((m) => m.id).concat(watchedIds)
  );
  const recs = rankCandidates(candidates, profile, excludeIds, limit);

  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ sig, profile, recs }));
  } catch { /* ignore quota errors */ }
  return { profile, recs };
}

// Home teaser orchestrator. Empty basket -> no recommendations (basket-primary cold-start).
export async function getRecommendations(input, opts = {}) {
  if (!input || !input.basket || input.basket.length === 0) return [];
  return (await _pipeline(input, opts)).recs;
}

// Recommendation page orchestrator. Empty basket -> no rows.
export async function getRecommendationRows(input, opts = {}) {
  if (!input || !input.basket || input.basket.length === 0) return { rows: [] };
  const { limit = 60, now = Date.now(), groupOpts = {}, penalty } = opts;
  const { profile, recs } = await _pipeline(input, { limit, now, penalty });
  return { rows: groupIntoRows(recs, profile, groupOpts) };
}

// Clear every per-limit session results cache entry (call after a new title is watched).
export function clearRecommendationCache() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(RECS_CACHE_KEY)) sessionStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}
