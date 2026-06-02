// Content-based recommendation engine for the Movies app.
// Pure functions (profile + scoring + reasons) are unit-tested; network/cache
// functions live lower in the file and are exercised manually in the browser.
import { MOVIE_GENRES, TV_GENRES, THEME_KEYWORDS } from './config.js';

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
const DOWNVOTE_SCORE_STRENGTH = 0.4;        // how hard disliked-vector overlap downweights a candidate
export const DOWNVOTE_SCORE_FLOOR = 0.5;    // a strongly-disliked candidate keeps >= half its score (never zeroed)

// --- Recommendation engine tuning (contract constants; declared once) ---
const W_COLLAB = 0.55;              // collaborative score weight in the hybrid
const W_CONTENT = 0.30;             // content (cosine) score weight in the hybrid
const W_PRIOR = 0.15;               // quality-prior weight: a cold-start floor so empty-profile pools sort by rating
const MMR_LAMBDA_TEASER = 0.8;      // home-teaser MMR relevance/diversity tradeoff
const MMR_LAMBDA_PAGE = 0.6;        // full rec-page MMR relevance/diversity tradeoff
const PER_SEED_CAP = 3;             // max candidates kept per producing seed in MMR
const MAX_SEEDS = 12;               // cap basket seeds expanded per pipeline run
const BAYES_PRIOR_COUNT = 150;      // m: pseudo-count for the bayesian rating prior (few-hundred-vote pool calibration)
const BAYES_GLOBAL_MEAN = 6.5;      // C: global mean rating prior
const REC_SOURCE_WEIGHT = 1.0;      // /recommendations candidate source weight
const SIMILAR_SOURCE_WEIGHT = 0.5;  // /similar weighted below rec
const NEAR_DUP_SIM = 0.9;           // itemSim above this collapses near-duplicates
const DOWNVOTE_GAMMA = 0.15;        // Rocchio negative-profile weight
const RECENCY_FULL_YEARS = 2;       // within 2 yrs => full recency multiplier 1.0
const RECENCY_FLOOR = 0.85;         // oldest titles recency multiplier floor
const COLD_START_FULL = 5;          // basketSize at which personalizedWeight === 1

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

// IMDb-style confidence-weighted rating: shrinks low-vote titles toward the
// global mean C, leaving heavily-voted titles near their raw average.
// WR = v/(v+m)*R + m/(v+m)*C. Returns C when there are votes-less but a prior;
// returns R when there is neither prior nor votes (m=0,v=0 edge).
export function bayesianRating(voteAverage, voteCount, m = BAYES_PRIOR_COUNT, C = BAYES_GLOBAL_MEAN) {
  const R = typeof voteAverage === 'number' && voteAverage > 0 ? voteAverage : 0;
  const v = typeof voteCount === 'number' && voteCount > 0 ? voteCount : 0;
  if (v + m === 0) return R;             // m=0,v=0 edge: no prior, no votes => R
  return (v / (v + m)) * R + (m / (v + m)) * C;
}

// Map the Bayesian rating (~0..10) to a gentle multiplier in ~[0.6,1.1].
export function qualityMultiplier(voteAverage, voteCount) {
  return 0.6 + 0.5 * (bayesianRating(voteAverage, voteCount) / 10);
}

const RECENCY_DECAY_YEARS = 20; // age (yrs) past which we sit at the floor

// Gentle release-date nudge. Full (1.0) within RECENCY_FULL_YEARS, then linearly
// decays to RECENCY_FLOOR by RECENCY_DECAY_YEARS; missing/unknown date => 1.0.
export function recencyMultiplier(releaseDate, now) {
  if (!releaseDate || typeof releaseDate !== 'string') return 1;
  const t = Date.parse(releaseDate);
  if (Number.isNaN(t)) return 1;
  const ageYears = Math.max(0, (now - t) / (365 * 24 * 60 * 60 * 1000));
  if (ageYears <= RECENCY_FULL_YEARS) return 1;
  const span = RECENCY_DECAY_YEARS - RECENCY_FULL_YEARS;
  const frac = Math.min(1, (ageYears - RECENCY_FULL_YEARS) / span);
  return 1 - (1 - RECENCY_FLOOR) * frac;
}

// Tag-vector for a candidate: genres always; keywords/people only when the item
// carries enrichment (_keywords/_people). Presence-weighted (1 per term).
export function buildTagVector(item) {
  const v = {};
  for (const g of item.genre_ids || []) v['g:' + g] = 1;
  for (const k of item._keywords || []) v['k:' + k.id] = 1;
  for (const p of item._people || []) v['p:' + p.id] = 1;
  return v;
}

// Tag-vector for the taste profile: genre/keyword/person weights -> g:/k:/p: keys.
// Non-positive genre weights (net-negative after Rocchio) are excluded so they
// never pull the content cosine upward.
export function profileVector(profile) {
  const v = {};
  for (const [g, w] of Object.entries(profile.genres || {})) {
    if (w > 0) v['g:' + g] = w;
  }
  for (const [k, o] of Object.entries(profile.keywords || {})) {
    if (o.weight > 0) v['k:' + k] = o.weight;
  }
  for (const [p, o] of Object.entries(profile.people || {})) {
    if (o.weight > 0) v['p:' + p] = o.weight;
  }
  return v;
}

// Inverse document frequency over a set of tag-vectors: idf = log(N/(1+df)).
// A term in every candidate (df=N) gets a small NEGATIVE idf, but that is harmless in
// cosineSim: profile and candidate share the same idf, so a shared term contributes
// profW*idf^2 (>=0) — content stays in [0,1] and ranking is preserved (see regression test).
export function computeIdf(tagVectors) {
  const N = tagVectors.length;
  const df = {};
  for (const v of tagVectors) {
    for (const term of Object.keys(v)) df[term] = (df[term] || 0) + 1;
  }
  const idf = {};
  for (const [term, d] of Object.entries(df)) idf[term] = Math.log(N / (1 + d));
  return idf;
}

// Scale a tag-vector by idf weights (terms missing from idf => 0).
export function applyIdf(tagVector, idf) {
  const out = {};
  for (const [term, w] of Object.entries(tagVector)) out[term] = w * (idf[term] || 0);
  return out;
}

// Cosine similarity in [0,1] over sparse tag-vectors (assumes non-negative weights).
export function cosineSim(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const w of Object.values(a)) na += w * w;
  for (const w of Object.values(b)) nb += w * w;
  if (na === 0 || nb === 0) return 0;
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  for (const [term, w] of Object.entries(small)) {
    if (term in large) dot += w * large[term];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Co-recommendation tally: how strongly the basket's seeds surfaced this candidate
// via /recommendations and /similar, weighted by source (rec > similar) and seed
// weight, discounted by the seed-list rank. Non-collaborative seeds contribute 0.
export function collabScore(candidate) {
  let s = 0;
  for (const seed of candidate._seeds || []) {
    let sw;
    if (seed.source === 'rec') sw = REC_SOURCE_WEIGHT;
    else if (seed.source === 'similar') sw = SIMILAR_SOURCE_WEIGHT;
    else continue;
    const rank = typeof seed.rank === 'number' ? seed.rank : 0;
    const weight = typeof seed.weight === 'number' ? seed.weight : 1;
    s += (sw * weight) / (1 + rank);
  }
  return s;
}

// Fraction of a candidate's own tag-vector terms that the disliked tag-vector also contains, in
// [0,1]. 'g:'/'k:'/'p:' keys. Drives the bounded multiplicative downvote penalty in scorePool.
function dislikeOverlapVec(candVec, dislikeVector) {
  if (!dislikeVector) return 0;
  const terms = Object.keys(candVec || {});
  if (terms.length === 0) return 0;
  let hit = 0;
  for (const t of terms) if (dislikeVector[t] > 0) hit += 1;
  return hit / terms.length;
}

// Hybrid pool scorer (pure, zero network). Builds idf over the pool's tag-vectors, idf-weights
// both the profile vector and each candidate vector, then:
//   collabN  = min-max of collabScore across the pool
//   contentN = cosine(idf(profileVector), idf(candidateVector))   [0,1]
//   qualityN = min-max of bayesianRating across the pool — an ADDITIVE cold-start floor so an
//              empty-profile pool (collab 0, content 0) still sorts by rating instead of all-zero
//   score    = (Wc*collabN + Wt*contentN + Wp*qualityN) * recencyMultiplier
// A non-empty `dislikeVector` applies a bounded multiplicative penalty (factor >= DOWNVOTE_SCORE_FLOOR);
// when absent it has no effect. Returns Scored[] sorted descending, each with parts + reasons.
// (qualityMultiplier is still computed for parts.quality back-compat reads, but no longer scales score.)
export function scorePool(candidates, { profile, now = Date.now(), weights = { collab: W_COLLAB, content: W_CONTENT, prior: W_PRIOR }, dislikeVector } = {}) {
  const wCollab = typeof weights.collab === 'number' ? weights.collab : W_COLLAB;
  const wContent = typeof weights.content === 'number' ? weights.content : W_CONTENT;
  const wPrior = typeof weights.prior === 'number' ? weights.prior : W_PRIOR;
  const tagVectors = candidates.map(buildTagVector);
  const idf = computeIdf(tagVectors);
  const rawProfVec = profileVector(profile);
  const profVec = applyIdf(rawProfVec, idf);
  // idf = log(N/(1+df)) collapses to 0 for any term whose df = N-1, which is the
  // common case in tiny pools (e.g. each genre appearing in exactly one of two
  // candidates). When idf zeroes the entire profile signal, fall back to the raw
  // presence/weight vectors so genuine profile overlap still drives content.
  const idfDegenerate = Object.values(profVec).every((w) => w === 0);

  const collabRaw = candidates.map(collabScore);
  const { min: cMin, max: cMax } = minMax(collabRaw);
  const cRange = cMax - cMin;

  // Pooled quality min-max drives the additive cold-start floor (qualityN below).
  const qualityRaw = candidates.map((c) => bayesianRating(c.vote_average, c.vote_count));
  const { min: qMin, max: qMax } = minMax(qualityRaw);
  const qRange = qMax - qMin;

  const scored = candidates.map((c, i) => {
    const collabN = cRange > 0 ? (collabRaw[i] - cMin) / cRange : 0;
    const contentN = idfDegenerate
      ? cosineSim(rawProfVec, tagVectors[i])
      : cosineSim(profVec, applyIdf(tagVectors[i], idf));
    const qualityN = qRange > 0 ? (qualityRaw[i] - qMin) / qRange : 0;
    const quality = qualityMultiplier(c.vote_average, c.vote_count); // parts back-compat only
    const recency = recencyMultiplier(c.release_date || c.first_air_date, now);
    let score = (wCollab * collabN + wContent * contentN + wPrior * qualityN) * recency;
    const overlap = dislikeOverlapVec(tagVectors[i], dislikeVector);
    if (overlap > 0) {
      score *= Math.max(DOWNVOTE_SCORE_FLOOR, 1 - DOWNVOTE_SCORE_STRENGTH * overlap);
    }
    return {
      movie: c,
      score,
      parts: { collab: collabN, content: contentN, quality, qualityN, recency },
      reasons: generateReasons(c, profile),
    };
  });
  return scored.sort((a, b) => b.score - a.score);
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

// ROCCHIO: net a positive profile (basket) against a negative profile (downvoted) into a single
// profile the candidate generator/scorer consume:  profile = pos - gamma*neg.
// Genres keep their net value (which may go negative, so scoring penalizes disliked genres).
// Keywords/people are netted but anything <= 0 is dropped, so disliked themes never seed
// candidate generation. gamma is small (DOWNVOTE_GAMMA) so a single downvote softens but does
// NOT erase a strongly-basketed shared theme.
export function combineProfiles(pos, neg, opts = {}) {
  const { gamma = DOWNVOTE_GAMMA } = opts;
  const n = neg || { genres: {}, keywords: {}, people: {} };

  const genres = {};
  for (const [g, w] of Object.entries(pos.genres || {})) genres[g] = w;
  for (const [g, w] of Object.entries(n.genres || {})) genres[g] = (genres[g] || 0) - gamma * w;

  const netWeighted = (posMap, negMap) => {
    const out = {};
    for (const [id, v] of Object.entries(posMap || {})) out[id] = { name: v.name, weight: v.weight };
    for (const [id, v] of Object.entries(negMap || {})) {
      if (out[id]) out[id].weight -= gamma * v.weight; // purely-downvoted themes are never added
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


// Single-pass min/max over a numeric array. Avoids Math.min(...arr)/Math.max(...arr),
// which both spread the whole array onto the call stack (a RangeError cliff at N in the
// tens of thousands) and walk it twice. Empty array => {min:0,max:0}.
export function minMax(arr) {
  if (!arr || arr.length === 0) return { min: 0, max: 0 };
  let min = arr[0];
  let max = arr[0];
  for (let i = 1; i < arr.length; i += 1) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

// Jaccard of two id collections; empty∪empty => 0 (never NaN).
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// The basket-seed-title ids that produced a candidate (rec/similar provenance only),
// used for the provenance-overlap term of itemSim and the per-seed cap in mmrRerank.
// Discover/trending/toprated seeds carry facet/title ids under non-title sources and are
// intentionally excluded so they never collapse against unrelated rec/similar provenance.
function seedTitleIds(candidate) {
  const ids = new Set();
  for (const s of candidate._seeds || []) {
    if (s.source === 'rec' || s.source === 'similar') {
      ids.add(Number(s.seedId != null ? s.seedId : s.id));
    }
  }
  return ids;
}

// Pairwise similarity for the diversity re-rank: 0.6*genreJaccard + 0.4*provenanceJaccard.
// Identical composite identity => 1 (the same title can't add diversity). Uses candidateKey so a
// movie and a tv show sharing a numeric id aren't falsely treated as the same near-duplicate.
export function itemSim(a, b) {
  if (candidateKey(a) === candidateKey(b)) return 1;
  const ga = a._genreSet || new Set((a.genre_ids || []).map(Number));
  const gb = b._genreSet || new Set((b.genre_ids || []).map(Number));
  const genreJ = jaccard(ga, gb);
  const sa = a._seedSet || seedTitleIds(a);
  const sb = b._seedSet || seedTitleIds(b);
  const provJ = jaccard(sa, sb);
  return 0.6 * genreJ + 0.4 * provJ;
}

// Diversity re-rank. Three stages, all pure:
//   (1) near-duplicate / franchise collapse: drop any item whose simFn vs an already-kept,
//       higher-scored item exceeds NEAR_DUP_SIM (best representative survives).
//   (2) greedy Maximal Marginal Relevance: pick argmax(lambda*rel - (1-lambda)*maxSim-to-chosen).
//   (3) per-seed cap: never let more than perSeedCap chosen items share a single rec/similar seedId.
// `scored` is a Scored[] (scorePool, added earlier in this phase, sorts it desc by score). `rel`
// is read from `score`, min-max normalized to [0,1] across the collapsed survivors so the lambda
// trade-off is scale-independent. Items with no rec/similar provenance (discover/cold-start) are
// not seed-capped (empty seedTitleIds).
export function mmrRerank(scored, { lambda, perSeedCap = PER_SEED_CAP, limit, simFn = itemSim } = {}) {
  // Fail loud: an undefined/out-of-range lambda makes the greedy objective NaN, which would
  // silently return [] (NaN > -Infinity is false). lambda is a required caller-tuned knob.
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
    throw new RangeError(`mmrRerank: lambda must be a finite number in [0,1], got ${lambda}`);
  }
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  // Bound the O(N^2) re-rank: keep only the top (6*limit) by score before collapsing.
  // `sorted` is already score-desc, so a prefix slice is the top band. No-op when unbounded.
  const bound = Number.isFinite(limit) ? Math.min(sorted.length, 6 * limit) : sorted.length;
  const work = sorted.slice(0, bound);
  // Memoize each movie's genre Set + rec/similar seedId Set once so itemSim reads caches
  // instead of rebuilding Sets on every pairwise comparison.
  for (const s of work) {
    if (!s.movie._genreSet) s.movie._genreSet = new Set((s.movie.genre_ids || []).map(Number));
    if (!s.movie._seedSet) s.movie._seedSet = seedTitleIds(s.movie);
  }

  // (1) Near-duplicate collapse against already-kept (higher-scored) survivors.
  const survivors = [];
  for (const cand of work) {
    const dup = survivors.some((k) => simFn(cand.movie, k.movie) > NEAR_DUP_SIM);
    if (!dup) survivors.push(cand);
  }
  if (survivors.length === 0) return [];

  // Normalize relevance to [0,1] across survivors (min-max; flat pool => all 1).
  const { min: lo, max: hi } = minMax(survivors.map((s) => s.score));
  const span = hi - lo;
  const rel = (s) => (span === 0 ? 1 : (s.score - lo) / span);

  const cap = Number.isFinite(limit) ? Math.min(limit, survivors.length) : survivors.length;
  const seedCount = new Map();
  const seedsOf = (s) => seedTitleIds(s.movie);
  const underCap = (s) => {
    const ids = seedsOf(s);
    if (ids.size === 0) return true; // no rec/similar provenance => uncapped (discover/cold-start)
    for (const id of ids) if ((seedCount.get(id) || 0) >= perSeedCap) return false;
    return true;
  };
  const bumpSeeds = (s) => {
    for (const id of seedsOf(s)) seedCount.set(id, (seedCount.get(id) || 0) + 1);
  };

  // (2)+(3) Greedy MMR with the per-seed cap enforced at selection time.
  const chosen = [];
  const pool = [...survivors];
  while (chosen.length < cap && pool.length) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      if (!underCap(pool[i])) continue;
      let maxSim = 0;
      for (const c of chosen) {
        const sim = simFn(pool[i].movie, c.movie);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * rel(pool[i]) - (1 - lambda) * maxSim;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    if (best === -1) break; // remaining items all blocked by the seed cap
    const [picked] = pool.splice(best, 1);
    bumpSeeds(picked);
    chosen.push(picked);
  }
  return chosen;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Map one appendDetail response's recommendations (source:'rec') and similar
// (source:'similar') lists into tagged Candidates. Each candidate keeps its REAL
// media_type from the response (mixed movie+tv), all quality/date fields, and a
// SeedTag recording which basket seed produced it, its 0-based list rank, and the
// source weight (rec > similar). Pure: no network, no clock.
export function extractSeedCandidates(seedItem, appendDetailJson) {
  if (!seedItem || !appendDetailJson) return [];
  const seedId = seedItem.id;
  const seedTitle = seedItem.title || seedItem.name;
  const seedMediaType = seedItem.media_type === 'tv' ? 'tv' : 'movie';

  const fromList = (list, source, weight) =>
    (list || []).map((cand, rank) => ({
      ...cand,
      media_type: cand.media_type === 'tv' || cand.media_type === 'movie'
        ? cand.media_type
        : seedMediaType,
      // type:'title' tags carry no facet of their own, so `id` mirrors `seedId` (the
      // producing seed title); person/keyword-seed predicates downstream skip type:'title'.
      _seeds: [{ source, type: 'title', id: seedId, seedId, seedTitle, rank, weight }],
    }));

  return [
    ...fromList(appendDetailJson.recommendations?.results, 'rec', REC_SOURCE_WEIGHT),
    ...fromList(appendDetailJson.similar?.results, 'similar', SIMILAR_SOURCE_WEIGHT),
  ];
}

// Composite identity for a candidate: TMDB ids are unique only WITHIN a media_type, so a movie
// and a tv show can share a numeric id. Keying by `${media_type}:${id}` keeps them distinct
// through merge, the pipeline exclude set, and row placement. Missing media_type => 'movie'.
export function candidateKey(item) {
  const mt = item.media_type === 'tv' ? 'tv' : 'movie';
  return `${mt}:${item.id}`;
}

// Merge Discover result lists, deduping by id and accumulating seed provenance.
export function mergeCandidates(taggedCandidates) {
  const byId = new Map();
  for (const c of taggedCandidates) {
    const key = candidateKey(c);
    if (byId.has(key)) {
      byId.get(key)._seeds.push(...(c._seeds || []));
    } else {
      byId.set(key, { ...c, _seeds: [...(c._seeds || [])] });
    }
  }
  return [...byId.values()];
}

// Blend personalized candidates with cold-start filler. personalizedWeight rises with basket
// size: min(1, basketSize / COLD_START_FULL). Empty basket => filler only; a full basket =>
// personalized only. Deterministic order: personalized first, then filler to fill the
// (1 - personalizedWeight) share of the pool. Both sides deduped by id.
export function coldStartBlend(personalCandidates, fillerCandidates, basketSize) {
  const personal = personalCandidates || [];
  const filler = fillerCandidates || [];
  const p = Math.min(1, (basketSize || 0) / COLD_START_FULL);

  // Empty/zero-weight basket: filler-only (deduped).
  if (p <= 0) {
    const out = [];
    const seen = new Set();
    for (const c of filler) {
      if (seen.has(candidateKey(c))) continue;
      seen.add(candidateKey(c));
      out.push(c);
    }
    return out;
  }

  // Keep all personalized (deduped); they represent the personalizedWeight share.
  const out = [];
  const seen = new Set();
  for (const c of personal) {
    if (seen.has(candidateKey(c))) continue;
    seen.add(candidateKey(c));
    out.push(c);
  }
  if (p >= 1) return out; // full basket: personalized only.

  // If no personalized candidates were produced (e.g. all collab/discover calls failed),
  // fall back to filler-only so a fractional basket never yields a blank screen.
  if (out.length === 0) {
    for (const c of filler) {
      if (seen.has(candidateKey(c))) continue;
      seen.add(candidateKey(c));
      out.push(c);
    }
    return out;
  }

  // Size the pool so filler makes up the (1 - p) share.
  const poolSize = Math.round(out.length / p);
  const fillerSlots = Math.max(0, poolSize - out.length);
  let added = 0;
  for (const c of filler) {
    if (added >= fillerSlots) break;
    if (seen.has(candidateKey(c))) continue;
    seen.add(candidateKey(c));
    out.push(c);
    added += 1;
  }
  return out;
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

  // Collaborative provenance leads when present: TMDB rec/similar carry the producing
  // basket seed's title. Strongest such seed (by weight, then lowest rank) wins.
  const collabSeed = seeds
    .filter((s) => (s.source === 'rec' || s.source === 'similar') && s.seedTitle)
    .sort((a, b) => (b.weight - a.weight) || ((a.rank ?? 0) - (b.rank ?? 0)))[0];

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
  if (collabSeed) theme = `Because you liked ${collabSeed.seedTitle}`;
  else if (themeParts.length >= 2) {
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

// Normalized basket genre distribution. Each item splits its genre mass to sum 1,
// distributions are averaged over items, then renormalized. Keys are String ids.
export function genreHistogram(items) {
  const acc = {};
  let counted = 0;
  for (const it of items || []) {
    const gids = (it.genre_ids || []).map(Number).filter((n) => Number.isFinite(n));
    if (!gids.length) continue;
    counted += 1;
    const share = 1 / gids.length;
    for (const g of gids) {
      const key = String(g);
      acc[key] = (acc[key] || 0) + share;
    }
  }
  if (!counted) return {};
  let total = 0;
  for (const k of Object.keys(acc)) { acc[k] /= counted; total += acc[k]; }
  if (total > 0) for (const k of Object.keys(acc)) acc[k] /= total;
  return acc;
}

// Steck (2018) calibrated re-ranking. Greedily picks items maximizing
//   (1-lambda)*relevance  -  lambda*KL(target || shownDistribution-with-this-item)
// where the shown distribution is genre-smoothed by alpha against the target so the
// log is finite. Pure, deterministic; relevance is the existing `score`. lambda is the
// KL weight (lambda=0 => pure relevance). Keeps gems alive (no hard relevance cutoff).
export function calibrate(scored, targetDist, { lambda = 0.5, limit, alpha = 0.01 } = {}) {
  const pool = [...scored];
  const n = limit == null ? pool.length : Math.min(limit, pool.length);
  if (n <= 0) return [];

  const targetKeys = Object.keys(targetDist || {});
  // Per-item normalized genre distribution (sums to 1; genreless => empty).
  const itemDist = (it) => {
    const gids = (it.movie.genre_ids || []).map(Number).filter(Number.isFinite);
    if (!gids.length) return {};
    const share = 1 / gids.length;
    const d = {};
    for (const g of gids) d[String(g)] = (d[String(g)] || 0) + share;
    return d;
  };
  const dists = new Map(pool.map((s) => [s, itemDist(s)]));

  // KL(target || q) with alpha-smoothing of q toward target so log is finite.
  const kl = (aggGenre, count) => {
    if (!count) return 0;
    let div = 0;
    for (const g of targetKeys) {
      const p = targetDist[g];
      if (p <= 0) continue;
      const qRaw = (aggGenre[g] || 0) / count; // mean genre mass over selected
      const q = (1 - alpha) * qRaw + alpha * p; // smoothing
      div += p * Math.log(p / q);
    }
    return div;
  };

  const selected = [];
  const agg = {};        // summed genre mass over selected items
  const used = new Set();
  for (let pos = 0; pos < n; pos++) {
    let best = null;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const s = pool[i];
      const d = dists.get(s);
      // Trial-add this item's genre mass and score the marginal objective.
      const trial = { ...agg };
      for (const g of Object.keys(d)) trial[g] = (trial[g] || 0) + d[g];
      const div = kl(trial, selected.length + 1);
      const val = (1 - lambda) * s.score - lambda * div;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    if (best == null) break;
    used.add(best);
    const chosen = pool[best];
    const d = dists.get(chosen);
    for (const g of Object.keys(d)) agg[g] = (agg[g] || 0) + d[g];
    selected.push(chosen);
  }
  return selected;
}

// App-config ids that are actually TMDB *keyword* ids despite living in the genre/theme
// lists with type:'keyword' (e.g. Dystopia 4565, Time Travel 4379). Built once. Any id in
// this set must go to with_keywords/without_keywords, never with_genres/without_genres.
const KEYWORD_TYPED_IDS = new Set(
  [...MOVIE_GENRES, ...THEME_KEYWORDS]
    .filter((e) => e.type === 'keyword')
    .map((e) => Number(e.id))
);

// Split a flat list of app-config ids into { genres, keywords } using KEYWORD_TYPED_IDS.
// Coerces to Number, preserves input order within each bucket. Item genre_ids from TMDB
// responses are always real genre ids, so this is only for config-sourced ids.
export function splitGenreKeywordIds(ids) {
  const genres = [];
  const keywords = [];
  for (const raw of ids || []) {
    const id = Number(raw);
    if (KEYWORD_TYPED_IDS.has(id)) keywords.push(id);
    else genres.push(id);
  }
  return { genres, keywords };
}

// Build the shared opts (quality gates + date window + negative steering) applied to every
// Discover request. Pure: sources floors from CONFIG and the negative profile only.
// MIN_RATING is gated only when > 0 (0 means "no rating floor"). without_* are assembled from
// the negative profile's genres (real TMDB genre ids) and keywords (keyword ids) — this is the
// intentional HARD upstream filter (vs the soft Rocchio + scorePool penalty downstream).
// buildDiscoverRequests then strips any positively-steered facet from these, so a theme that is
// both liked and disliked is never self-excluded.
function discoverGates(negProfile) {
  const opts = {
    voteCountGte: CONFIG.MIN_VOTE_COUNT,
    dateGte: `${CONFIG.MIN_YEAR}-01-01`,
  };
  if (CONFIG.MIN_RATING > 0) opts.voteAverageGte = CONFIG.MIN_RATING;
  if (negProfile) {
    const negGenreIds = Object.keys(negProfile.genres || {}).map(Number);
    const negKeywordIds = Object.keys(negProfile.keywords || {}).map(Number);
    if (negGenreIds.length) opts.withoutGenres = negGenreIds.join('|');
    if (negKeywordIds.length) opts.withoutKeywords = negKeywordIds.join('|');
  }
  return opts;
}

// Pure: produce the list of { url, seed } Discover requests for the candidate pool.
// - top genres OR-combined into one with_genres facet (keyword-typed config ids split out)
// - top keywords and people each their own facet
// - run for BOTH media types, ordered by mediaTypeBias (heavier type first)
// - pages 1..opts.pages (default 2), gated by CONFIG floors + negative without_*
// Seeds conform to SeedTag: source 'discover-genre'|'discover-keyword'|'discover-person',
//   type 'genre'|'keyword'|'person', id = the producing facet id, name + weight.
// opts: { pages = 2, maxGenres = 4, maxKeywords = 6, maxPeople = 6 }
export function buildDiscoverRequests(profile, negProfile, opts = {}) {
  const { pages = 2, maxGenres = 4, maxKeywords = 6, maxPeople = 6 } = opts;
  let gates = discoverGates(negProfile);

  // mediaTypeBias-ordered types: heavier type first, both always present (mixed media).
  const bias = profile.mediaTypeBias || { movie: 0, tv: 0 };
  const types = bias.tv > bias.movie ? ['tv', 'movie'] : ['movie', 'tv'];

  const topGenreIds = Object.entries(profile.genres || {})
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxGenres)
    .map(([id]) => Number(id));
  // profile.genres may carry config-sourced keyword-typed ids; route them out of with_genres.
  const { genres: genreIds, keywords: genreKeywordIds } = splitGenreKeywordIds(topGenreIds);

  const topKeywords = Object.entries(profile.keywords || {})
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, maxKeywords)
    .map(([id, { name, weight }]) => ({ id: Number(id), name, weight }));
  const topPeople = Object.entries(profile.people || {})
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, maxPeople)
    .map(([id, { name, weight }]) => ({ id: Number(id), name, weight }));

  // Keyword facets = real theme keywords + any keyword-typed ids misfiled under genres,
  // then capped to maxKeywords AFTER concatenation so genre-derived keyword ids don't
  // inflate the facet count past the cap.
  const keywordFacets = [
    ...topKeywords,
    ...genreKeywordIds.map((id) => ({ id, name: GENRE_NAMES.get(id) || 'keyword', weight: 1 })),
  ].slice(0, maxKeywords);

  // Never list a positively-steered facet in without_*: a genre/keyword that the user both
  // liked (net-positive after Rocchio) and downvoted would otherwise produce a self-
  // contradictory `with_genres=X&without_genres=X` query, which TMDB answers with [] (silent).
  const stripConflicts = (without, positiveIds) => {
    if (!without) return without;
    const pos = new Set(positiveIds.map(String));
    const kept = without.split('|').filter((id) => !pos.has(id));
    return kept.length ? kept.join('|') : undefined;
  };
  gates = {
    ...gates,
    withoutGenres: stripConflicts(gates.withoutGenres, genreIds),
    withoutKeywords: stripConflicts(gates.withoutKeywords, keywordFacets.map((k) => k.id)),
  };

  const requests = [];
  for (const type of types) {
    for (let page = 1; page <= pages; page++) {
      if (genreIds.length) {
        const csv = genreIds.join('|'); // pipe-OR
        requests.push({
          url: ENDPOINTS.discoverByGenres(type, csv, page, gates),
          seed: {
            source: 'discover-genre', type: 'genre', id: genreIds[0],
            name: GENRE_NAMES.get(genreIds[0]) || 'genre',
            weight: profile.genres[String(genreIds[0])] || 1,
          },
        });
      }
      for (const k of keywordFacets) {
        requests.push({
          url: ENDPOINTS.discoverByKeyword(type, k.id, page, gates),
          seed: { source: 'discover-keyword', type: 'keyword', id: k.id, name: k.name, weight: k.weight },
        });
      }
      for (const p of topPeople) {
        requests.push({
          url: ENDPOINTS.discoverByCast(type, p.id, page, gates),
          seed: { source: 'discover-person', type: 'person', id: p.id, name: p.name, weight: p.weight },
        });
      }
    }
  }
  return requests;
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
    genreDist = null,       // basket genreHistogram for calibration + budget
    exploreCount = 8,
    exploreMinVote = 6.5,   // vote_average floor for a "gem"
    exploreMaxCount = 2000, // vote_count ceiling for a "gem"
  } = opts;

  const rows = [];

  // One global placed-Set: a title appears in at most one row.
  const placed = new Set();
  const recId = (r) => candidateKey(r.movie);
  const num = (v) => Number(v);                       // consistent coercion everywhere
  const seedHas = (r, type, id) =>
    (r.movie._seeds || []).some((s) => s.type === type && num(s.id) === num(id));

  // 'trending' archetype: cold-start filler items whose provenance is the trending source.
  // Reserve + claim them up-front (like the explore gems) so the personalized rows below
  // cannot absorb them; the row itself is pushed at its display position (below the
  // personalized rows, above explore). One deterministic row, capped like other rows. Reuses
  // the same recId()-keyed placed-Set the function maintains — no new dedupe mechanism.
  const trendingPicked = ranked
    .filter((r) => (r.movie._seeds || []).some((s) => s.source === 'trending'))
    .slice(0, itemsPerRow);
  trendingPicked.forEach((r) => placed.add(recId(r)));

  // 1. Top picks — global best-N, genre-calibrated to the basket, and CLAIMS its items.
  // Trending-reserved items are excluded (already in placed) so they cannot be double-claimed.
  if (ranked.length && topCount > 0) {
    const pool = ranked.filter((r) => !placed.has(recId(r)));
    let recs;
    if (genreDist && Object.keys(genreDist).length) {
      recs = calibrate(pool, genreDist, { lambda: 0.5, limit: topCount });
    } else {
      recs = pool.slice(0, topCount);
    }
    recs.forEach((r) => placed.add(recId(r)));
    rows.push({ kind: 'top', title: 'Top picks for you', recs });
  }

  const take = (predicate) => ranked
    .filter((r) => !placed.has(recId(r)) && predicate(r))
    .slice(0, itemsPerRow);
  const claim = (recs) => recs.forEach((r) => placed.add(recId(r)));

  // Determine the basket genre order once: histogram mass when present, else profile weight.
  const genreOrder = genreDist && Object.keys(genreDist).length
    ? Object.entries(genreDist).sort((a, b) => b[1] - a[1]).map(([id]) => num(id))
    : Object.entries(profile.genres || {})
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1]).map(([id]) => num(id));

  // Reserve the explore gems FIRST (high-rating, low-vote-count titles in the top basket
  // genre) so the broader genre row below cannot claim them; the row is pushed last for
  // display order. Deterministic selection: rarest first, then highest rating, then id.
  const topGenre = genreOrder[0];
  let exploreGems = [];
  if (topGenre != null) {
    exploreGems = ranked
      .filter((r) => !placed.has(recId(r))
        && (r.movie.genre_ids || []).map(num).includes(topGenre)
        && num(r.movie.vote_average) >= exploreMinVote
        && num(r.movie.vote_count) > 0
        && num(r.movie.vote_count) < exploreMaxCount)
      .sort((a, b) =>
        (num(a.movie.vote_count) - num(b.movie.vote_count))
        || (num(b.movie.vote_average) - num(a.movie.vote_average))
        || (num(a.movie.id) - num(b.movie.id)))
      .slice(0, exploreCount);
    if (exploreGems.length >= minItems) claim(exploreGems);
    else exploreGems = [];
  }

  // 2. Because you watched X — strongest contributing titles by profile weight (kind 'title').
  for (const t of (profile.topTitles || []).slice(0, titleRows)) {
    const kw = new Set((t.keywordIds || []).map(num));
    const pp = new Set((t.peopleIds || []).map(num));
    const recs = take((r) => (r.movie._seeds || []).some((s) =>
      (s.type === 'keyword' && kw.has(num(s.id))) || (s.type === 'person' && pp.has(num(s.id)))));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'title', title: `Because you watched ${t.title}`, recs });
    }
  }

  // 3. More <Genre> — budget allocated by the basket genre histogram when present.
  for (const gid of genreOrder.slice(0, genreRows)) {
    // Budget proportional to histogram mass (min the row floor), capped at itemsPerRow.
    const budget = genreDist
      ? Math.max(minItems, Math.round((genreDist[String(gid)] || 0) * itemsPerRow))
      : itemsPerRow;
    const recs = ranked
      .filter((r) => !placed.has(recId(r)) && (r.movie.genre_ids || []).map(num).includes(gid))
      .slice(0, Math.min(budget, itemsPerRow));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'genre', title: `More ${GENRE_NAMES.get(gid) || 'like this'}`, recs });
    }
  }

  // 4. More from <Person> — top profile people by weight. Contract Row.kind has no
  // 'person' archetype, so these are 'title' rows (a person is a "because you liked" facet).
  const topPeople = Object.entries(profile.people || {})
    .sort((a, b) => b[1].weight - a[1].weight).slice(0, personRows);
  for (const [pidStr, { name }] of topPeople) {
    const pid = num(pidStr);
    const recs = take((r) => seedHas(r, 'person', pid));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'title', title: `More from ${name}`, recs });
    }
  }

  // The reserved trending row, pushed at its display position (below the personalized rows,
  // above explore). Its items were claimed up-front so no personalized row could absorb them.
  if (trendingPicked.length) {
    rows.push({ kind: 'trending', title: 'Trending this week', recs: trendingPicked });
  }

  // 5. Exactly one DETERMINISTIC explore row, pushed last for display order. Its gems were
  // reserved + claimed above so the genre row could not absorb them.
  if (exploreGems.length >= minItems) {
    rows.push({
      kind: 'explore',
      title: `Hidden gems in ${GENRE_NAMES.get(topGenre) || 'your taste'}`,
      recs: exploreGems,
    });
  }

  return rows.slice(0, maxRows);
}

// Back-compat thin wrapper over the scoring/diversity funnel:
//   scorePool -> exclude watched -> mmrRerank(page lambda) -> slice(limit).
// `now` is injectable for deterministic tests; defaults to the wall clock for browser use.
// mmrRerank already slices to `limit`, so no trailing .slice is needed.
export function rankCandidates(candidates, profile, watchedIds, limit = 20, now = Date.now()) {
  const watched = new Set([...watchedIds].map(String));
  const scored = scorePool(candidates, { profile, now })
    .filter((s) => !watched.has(String(s.movie.id)));
  return mmrRerank(scored, { lambda: MMR_LAMBDA_PAGE, limit, simFn: itemSim });
}

// ---------------------------------------------------------------------------
// Network + cache layer (browser only)
// ---------------------------------------------------------------------------
import { CONFIG, ENDPOINTS } from './config.js';
import { createFetchQueue } from './fetch-queue.js';

const META_CACHE_KEY = 'recMetaCache';     // permanent per-title keywords/credits
const META_CACHE_VERSION = 2;                      // bump to discard stale-schema entries
const META_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7-day TTL on per-title enrichment
const META_CACHE_MAX_ENTRIES = 500;                // size bound (LRU-by-savedAt)
const RECS_CACHE_KEY = 'recResultsCache';  // session recommendations cache

// Pure: normalize + prune a versioned meta cache. Discards a wrong/legacy version wholesale,
// drops entries older than ttlMs, and caps to the newest maxEntries by savedAt. Injected now.
export function pruneMetaCache(cache, now, opts = {}) {
  const version = opts.version ?? META_CACHE_VERSION;
  const ttlMs = opts.ttlMs ?? META_CACHE_TTL_MS;
  const maxEntries = opts.maxEntries ?? META_CACHE_MAX_ENTRIES;

  if (!cache || typeof cache !== 'object' || cache.version !== version || !cache.entries) {
    return { version, entries: {} };
  }

  const cutoff = now - ttlMs;
  let kept = Object.entries(cache.entries).filter(
    ([, e]) => e && typeof e.savedAt === 'number' && e.savedAt >= cutoff
  );

  if (kept.length > maxEntries) {
    kept = kept
      .sort((a, b) => b[1].savedAt - a[1].savedAt) // newest first
      .slice(0, maxEntries);
  }

  const entries = {};
  for (const [k, e] of kept) entries[k] = e;
  return { version, entries };
}

function readMetaCache(now = Date.now()) {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(META_CACHE_KEY) || 'null');
  } catch {
    raw = null;
  }
  return pruneMetaCache(raw, now); // always a { version, entries } envelope
}

function writeMetaEntry(cacheKey, meta, now = Date.now()) {
  const cache = readMetaCache(now);
  cache.entries[cacheKey] = { meta, savedAt: now };
  const pruned = pruneMetaCache(cache, now); // re-bound after insert
  try {
    localStorage.setItem(META_CACHE_KEY, JSON.stringify(pruned));
  } catch (e) {
    console.error('recMetaCache write failed:', e);
  }
}

// One module-level queue: concurrency cap + 429 backoff + URL-keyed session memo.
const _recFetchQueue = createFetchQueue({
  fetchImpl: (url) => fetch(url),
  maxInflight: 12,
  storage: (typeof sessionStorage !== 'undefined') ? sessionStorage : undefined,
});

function fetchJson(url) {
  return _recFetchQueue.fetchJson(url);
}

// Fetch keywords + top cast/director for one title, caching permanently.
async function fetchTitleMeta(type, id) {
  const cacheKey = `${type}:${id}`;
  const cache = readMetaCache();
  if (cache.entries[cacheKey]) return cache.entries[cacheKey].meta;

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

// Attach _keywords/_people to each watched item. Concurrency is bounded by the
// module fetch queue (maxInflight); manual batching/delay is omitted — it only
// starved queue throughput without adding real rate-limiting.
async function enrichWatchedTitles(watched) {
  const metas = await Promise.all(
    watched.map((m) => fetchTitleMeta(m.media_type === 'tv' ? 'tv' : 'movie', m.id))
  );
  return watched.map((m, j) => ({ ...m, _keywords: metas[j].keywords, _people: metas[j].people }));
}

// Cap the basket to the strongest MAX_SEEDS by weight to bound fan-out.
function topSeeds(basketEnriched) {
  // _seedWeight is a forward hook (set by a later weighting task); until then this falls
  // back to insertion order — earlier basket items rank higher.
  return [...basketEnriched]
    .map((m, i) => ({ m, w: typeof m._seedWeight === 'number' ? m._seedWeight : (basketEnriched.length - i) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, MAX_SEEDS)
    .map((x) => x.m);
}

// Normalize the keywords/credits sub-responses of an appendDetail payload into the
// { id, name } shapes buildTagVector/buildTasteProfile expect (movie keywords live under
// .keywords.keywords; tv under .keywords.results; credits.cast + the Director).
function enrichmentFromAppend(json) {
  const kwList = json?.keywords?.keywords || json?.keywords?.results || [];
  const keywords = kwList.slice(0, 12).map((k) => ({ id: k.id, name: k.name }));
  const cast = (json?.credits?.cast || []).slice(0, 5).map((c) => ({ id: c.id, name: c.name }));
  const director = (json?.credits?.crew || []).find((c) => c.job === 'Director');
  const people = director ? [...cast, { id: director.id, name: director.name }] : cast;
  return { keywords, people };
}

// Standing Trending source: one /trending/all/week call (mixed media_type). Always fetched
// and merged into the pool so "Trending this week" is a row on every basket. Each candidate
// gets a provenance SeedTag (source:'trending', id = title id, 0-based rank).
async function trendingCandidates() {
  const tagged = [];
  await fetchJson(ENDPOINTS.trending(1))
    .then((d) => (d.results || []).forEach((m, rank) => {
      const mediaType = m.media_type === 'tv' ? 'tv' : m.media_type === 'movie' ? 'movie' : null;
      if (!mediaType) return;
      tagged.push({ ...m, media_type: mediaType,
        _seeds: [{ source: 'trending', type: 'title', id: m.id, rank, weight: 1 }] });
    }))
    .catch(() => {});
  return mergeCandidates(tagged);
}

// Cold-start-only filler: two /top_rated calls (movie + tv). Fetched ONLY for thin baskets
// (the generateCandidates caller gates on basketSize), so a full basket never pays for it.
async function topRatedFiller() {
  const tagged = [];
  await Promise.all(['movie', 'tv'].map((type) =>
    fetchJson(ENDPOINTS.topRated(type, 1))
      .then((d) => (d.results || []).forEach((m, rank) => {
        tagged.push({ ...m, media_type: type,
          _seeds: [{ source: 'toprated', type: 'title', id: m.id, rank, weight: 1 }] });
      }))
      .catch(() => {})));
  return mergeCandidates(tagged);
}

// Enrich the basket seeds AND expand them in ONE appendDetail call per (capped) seed.
// appendDetail returns keywords+credits (→ _keywords/_people for buildTasteProfile) AND
// recommendations+similar (→ extractSeedCandidates collab pool) — both read from the SAME
// payload, so a seed is never fetched twice. Returns { enrichedBasket, collabCandidates }.
//
// We fetch+expand only the top MAX_SEEDS seeds (bounds network + collab fan-out), but the
// taste profile must see the WHOLE basket: every starred item already carries
// genre_ids/vote_average/media_type (no fetch needed), so seeds beyond the cap — and any whose
// appendDetail fails — are still included with empty _keywords/_people. This keeps the profile's
// genre/rating/media signal faithful to the full basket while only fetching keyword/people
// enrichment for the strongest seeds. fetchImpl is injectable for tests.
export async function enrichAndExpandBasket(basket, { fetchImpl = fetchJson } = {}) {
  const seeds = topSeeds(basket);
  const seedIds = new Set(seeds.map((s) => s.id));
  const results = await Promise.all(
    seeds.map((seed) => {
      const type = seed.media_type === 'tv' ? 'tv' : 'movie';
      return fetchImpl(ENDPOINTS.appendDetail(type, seed.id))
        .then((json) => ({ seed, json }))
        .catch(() => ({ seed, json: null }));
    })
  );
  const enrichedBasket = [];
  const tagged = [];
  for (const { seed, json } of results) {
    const { keywords, people } = json ? enrichmentFromAppend(json) : { keywords: [], people: [] };
    const enrichedSeed = { ...seed, _keywords: keywords, _people: people };
    enrichedBasket.push(enrichedSeed);
    if (json) tagged.push(...extractSeedCandidates(enrichedSeed, json));
  }
  // Basket items beyond the top-MAX_SEEDS cap: profile-only (genre/rating/media), not fetched.
  for (const m of (basket || [])) {
    if (!seedIds.has(m.id)) enrichedBasket.push({ ...m, _keywords: [], _people: [] });
  }
  return { enrichedBasket, collabCandidates: mergeCandidates(tagged) };
}

// Combine the pre-expanded collaborative pool with Discover candidates, then blend
// cold-start filler by basket size. Seed expansion now happens once in
// enrichAndExpandBasket (called by _pipeline before buildTasteProfile), so this no
// longer fetches appendDetail per seed.
async function generateCandidates(collabCandidates, basketSize, profile, negProfile = null) {
  const collab = collabCandidates || [];
  const [discover, trending] = await Promise.all([
    discoverCandidates(profile, negProfile),
    trendingCandidates(),
  ]);
  const personalPool = mergeCandidates([...collab, ...discover]);
  // Top-rated filler only for cold/thin baskets; a full basket never fetches it.
  const blended = basketSize < COLD_START_FULL
    ? coldStartBlend(personalPool, await topRatedFiller(), basketSize)
    : personalPool;
  // Trending is a STANDING row on EVERY basket — merged AFTER the cold-start blend so it
  // survives even an empty basket (coldStartBlend(p=0) returns filler-only and would
  // otherwise drop a pre-merged trending pool).
  return mergeCandidates([...blended, ...trending]);
}

// Pull Discover candidates seeded by the profile's top genres/keywords/people.
// Deeper (pages 1-2), pipe-OR multi-facet, both media types, gated + negatively steered.
// Returns merged Candidate[] (de-duped + seed-union via mergeCandidates).
async function discoverCandidates(profile, negProfile = null) {
  const requests = buildDiscoverRequests(profile, negProfile, { pages: 1, maxKeywords: 4, maxPeople: 3 });

  const results = await Promise.all(
    requests.map((r) =>
      fetchJson(r.url).then((d) => ({ d, seed: r.seed, url: r.url })).catch(() => null))
  );
  const tagged = [];
  for (const r of results) {
    if (!r) continue;
    const reqType = r.url.includes('/discover/tv?') ? 'tv' : 'movie';
    for (const movie of (r.d.results || [])) {
      tagged.push({ ...movie, media_type: movie.media_type || reqType, _seeds: [r.seed] });
    }
  }
  return mergeCandidates(tagged);
}

// Order-independent FNV-1a hash of a sorted numeric id list. Deterministic, no clock.
function hashIds(ids) {
  const sorted = (ids || []).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  let h = 0x811c9dc5;
  const s = sorted.join(',');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Stable signature of the full signal set (basket + downvoted + watchedIds) for session
// caching. Toggling a star/downvote OR watching a new title changes this, busting the cache.
export function signalSignature(basket, downvoted, watchedIds) {
  const ids = (arr) => (arr || []).map((m) => m.id).sort().join(',');
  return `b:${ids(basket)}|d:${ids(downvoted)}|w:${hashIds(watchedIds)}`;
}

// Shared pipeline: enrich basket + downvoted → positive/negative profiles → net profile
// → candidates → rank, excluding watched ∪ downvoted ∪ basket. `input` is
// { basket: [movie], downvoted: [movie], watchedIds: [id] }. Cached per (signature, limit).
async function _pipeline(input, opts = {}) {
  const { limit = 20, now = Date.now(), gamma = DOWNVOTE_GAMMA, lambda = MMR_LAMBDA_PAGE, onRow, genreDist } = opts;
  const basket = input.basket || [];
  const downvoted = input.downvoted || [];
  const watchedIds = input.watchedIds || [];
  // Built once, up front (only needs basket/downvoted/watchedIds): used both by the provisional
  // streaming emission below and the final pool filter, so we don't rebuild it later.
  // Composite-key the exclude set so a basketed/watched movie can't suppress a tv show of the
  // same numeric id (and vice versa). watchedIds are numeric (legacy) -> exclude BOTH types.
  const excludeIds = new Set();
  for (const m of [...basket, ...downvoted]) excludeIds.add(candidateKey(m));
  for (const w of watchedIds) {
    if (w && typeof w === 'object') excludeIds.add(candidateKey(w));
    else { excludeIds.add(`movie:${w}`); excludeIds.add(`tv:${w}`); }
  }

  const sig = signalSignature(basket, downvoted, watchedIds);
  // lambda is part of the key: the teaser (0.8) and page (0.6) must not share a cache entry.
  const cacheKey = `${RECS_CACHE_KEY}:${limit}:${lambda}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    if (cached && cached.sig === sig && !cached.stale) {
      return { profile: cached.profile, recs: cached.recs };
    }
  } catch { /* ignore cache read errors */ }

  // Basket items are explicit positive seeds: STAR_BONUS-weighted, engagement dropped
  // (basket-primary, uniform). Downvoted items form a SMALL negative centroid — NOT starred,
  // no engagement — so one downvote can't out-shout the basket; it softly steers via Rocchio
  // (combineProfiles gamma), the bounded scorePool penalty, and Discover without_*.
  const annotatePos = (arr) => arr.map((m) => ({ ...m, _starred: true, _engagement: null }));
  const annotateNeg = (arr) => arr.map((m) => ({ ...m, _starred: false, _engagement: null }));
  const { enrichedBasket, collabCandidates } = await enrichAndExpandBasket(basket);
  const basketEnriched = annotatePos(enrichedBasket);
  const downEnriched = annotateNeg(await enrichWatchedTitles(downvoted));

  const posProfile = buildTasteProfile(basketEnriched, now);
  const negProfile = downEnriched.length ? buildTasteProfile(downEnriched, now) : null;
  const profile = combineProfiles(posProfile, negProfile, { gamma });

  // negProfile drives Discover without_genres/without_keywords and the bounded re-rank penalty
  // (scorePool dislikeVector). It is the negative-centroid tag-vector built by the scorer.
  const dislikeVector = negProfile ? profileVector(negProfile) : undefined;

  // Progressive streaming: the collaborative pool is already resolved (enrichAndExpandBasket),
  // so score+rank+group it NOW and emit the "Because you liked X" (title) rows before Discover/
  // trending land. These are stable (title rows draw only from rec/similar provenance, which is
  // entirely in the collab pool); the renderer reconciles them in place by key when the final
  // rows arrive. Only fires on a cache MISS (a hit returns instantly above — no streaming needed).
  if (typeof onRow === 'function') {
    const collabPool = collabCandidates.filter((c) => !excludeIds.has(candidateKey(c)));
    const provisionalRecs = mmrRerank(scorePool(collabPool, { profile, now, dislikeVector }), { lambda, limit });
    const provisionalRows = groupIntoRows(provisionalRecs, profile, { genreDist });
    for (const row of provisionalRows) {
      if (row.kind === 'title') onRow({ ...row, provisional: true });
    }
  }

  const candidates = await generateCandidates(collabCandidates, basket.length, profile, negProfile);
  const pool = candidates.filter((c) => !excludeIds.has(candidateKey(c)));
  const scored = scorePool(pool, { profile, now, dislikeVector });
  const recs = mmrRerank(scored, { lambda, limit });

  try {
    // Strip the transient itemSim memo Sets (_genreSet/_seedSet) before persisting: JSON would
    // turn them into {} and a rehydrated {} would silently break jaccard if a cached rec ever
    // re-entered itemSim. _seeds/_keywords/_people are kept (groupIntoRows reads them).
    const recsToCache = recs.map((r) => {
      const { _genreSet, _seedSet, ...movie } = r.movie;
      return { ...r, movie };
    });
    sessionStorage.setItem(cacheKey, JSON.stringify({ sig, profile, recs: recsToCache }));
  } catch { /* ignore quota errors */ }
  return { profile, recs };
}

// Home teaser orchestrator. Empty basket -> trending-only cold-start path (never []).
export async function getRecommendations(input, opts = {}) {
  const safe = input || {};
  const sig = { basket: safe.basket || [], downvoted: safe.downvoted || [], watchedIds: safe.watchedIds || [] };
  // Home teaser: a single scarce row -> favor relevance (higher MMR lambda) over diversity.
  return (await _pipeline(sig, { lambda: MMR_LAMBDA_TEASER, ...opts })).recs;
}

// Recommendation page orchestrator. Empty basket -> trending-only cold-start rows (never empty).
export async function getRecommendationRows(input, opts = {}) {
  const safe = input || {};
  const sig = { basket: safe.basket || [], downvoted: safe.downvoted || [], watchedIds: safe.watchedIds || [] };
  const { limit = 60, now = Date.now(), groupOpts = {}, gamma, onRow } = opts;
  // Calibrate Top Picks + budget genre rows to the basket's own genre mix (Steck calibration).
  // Derived from the raw basket (its items carry genre_ids). Threaded into _pipeline so the
  // provisional streaming rows use the same calibration as the final rows.
  const genreDist = genreHistogram(sig.basket);
  const { profile, recs } = await _pipeline(sig, { limit, now, gamma, onRow, genreDist });
  const rows = groupIntoRows(recs, profile, { genreDist, ...groupOpts });
  // Final, authoritative rows. When streaming, announce them (provisional:false) so the renderer
  // reconciles the early provisional title rows in place and fills the held hero/genre/trending.
  if (typeof onRow === 'function') {
    for (const row of rows) onRow({ ...row, provisional: false });
  }
  return { rows };
}

// Mark every per-limit session results cache entry STALE (keep the payload) so the next render
// can show the old rows immediately while recomputing (stale-while-revalidate). A successful
// recompute writes a fresh entry with no stale flag, clearing staleness.
export function clearRecommendationCache() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(RECS_CACHE_KEY)) {
        try {
          const v = JSON.parse(sessionStorage.getItem(k) || 'null');
          if (v) { v.stale = true; sessionStorage.setItem(k, JSON.stringify(v)); }
        } catch { sessionStorage.removeItem(k); }
      }
    }
  } catch { /* ignore */ }
}
