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

// --- Recommendation engine tuning (contract constants; declared once) ---
const W_COLLAB = 0.6;               // collaborative score weight in the hybrid
const W_CONTENT = 0.4;              // content (cosine) score weight in the hybrid
const MMR_LAMBDA_TEASER = 0.8;      // home-teaser MMR relevance/diversity tradeoff
const MMR_LAMBDA_PAGE = 0.6;        // full rec-page MMR relevance/diversity tradeoff
const PER_SEED_CAP = 3;             // max candidates kept per producing seed in MMR
const MAX_SEEDS = 12;               // cap basket seeds expanded per pipeline run
const BAYES_PRIOR_COUNT = 500;      // m: pseudo-count for the bayesian rating prior
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

// Hybrid pool scorer (pure, zero network). Builds idf over the pool's tag-vectors,
// idf-weights both the profile vector and each candidate vector, then:
//   collabN  = min-max of collabScore across the pool
//   contentN = cosine(idf(profileVector), idf(candidateVector))   [0,1]
//   score    = (Wc*collabN + Wt*contentN) * qualityMultiplier * recencyMultiplier
// `dislikeVector` is part of the signature for the downvote-penalty step (added
// later); when absent it has no effect. Returns Scored[] sorted descending,
// each with parts + reasons.
export function scorePool(candidates, { profile, now = Date.now(), weights = { collab: W_COLLAB, content: W_CONTENT }, dislikeVector } = {}) {
  void dislikeVector; // reserved: downvote-penalty step folds a bounded term in here
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
  const cMin = collabRaw.length ? Math.min(...collabRaw) : 0;
  const cMax = collabRaw.length ? Math.max(...collabRaw) : 0;
  const cRange = cMax - cMin;

  const scored = candidates.map((c, i) => {
    const collabN = cRange > 0 ? (collabRaw[i] - cMin) / cRange : 0;
    const contentN = idfDegenerate
      ? cosineSim(rawProfVec, tagVectors[i])
      : cosineSim(profVec, applyIdf(tagVectors[i], idf));
    const quality = qualityMultiplier(c.vote_average, c.vote_count);
    const recency = recencyMultiplier(c.release_date || c.first_air_date, now);
    const score = (weights.collab * collabN + weights.content * contentN) * quality * recency;
    return {
      movie: c,
      score,
      parts: { collab: collabN, content: contentN, quality, recency },
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
// Identical id => 1 (the same title can't add diversity).
export function itemSim(a, b) {
  if (a.id === b.id) return 1;
  const ga = new Set((a.genre_ids || []).map(Number));
  const gb = new Set((b.genre_ids || []).map(Number));
  const genreJ = jaccard(ga, gb);
  const provJ = jaccard(seedTitleIds(a), seedTitleIds(b));
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
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  // (1) Near-duplicate collapse against already-kept (higher-scored) survivors.
  const survivors = [];
  for (const cand of sorted) {
    const dup = survivors.some((k) => simFn(cand.movie, k.movie) > NEAR_DUP_SIM);
    if (!dup) survivors.push(cand);
  }
  if (survivors.length === 0) return [];

  // Normalize relevance to [0,1] across survivors (min-max; flat pool => all 1).
  const scores = survivors.map((s) => s.score);
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
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
import { createFetchQueue } from './fetch-queue.js';

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

// One module-level queue: concurrency cap + 429 backoff + URL-keyed session memo.
const _recFetchQueue = createFetchQueue({
  fetchImpl: (url) => fetch(url),
  maxInflight: 6,
  storage: (typeof sessionStorage !== 'undefined') ? sessionStorage : undefined,
});

function fetchJson(url) {
  return _recFetchQueue.fetchJson(url);
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

// Per-seed collaborative candidate generation (OWNER). For each (capped) basket seed,
// one appendDetail call yields its recommendations + similar (→ tagged candidates via
// extractSeedCandidates) AND its keywords/credits (→ attached to the seed in place for
// the content profile). Returns the merged, deduped collaborative candidate pool.
// Discover (discoverCandidates) and cold-start filler (fillerCandidates) are merged into
// the _pipeline candidate set by their own sections via targeted edits, not here.
async function generateCandidates(basketEnriched) {
  const seeds = topSeeds(basketEnriched);
  const tagged = [];
  const BATCH = 6;
  for (let i = 0; i < seeds.length; i += BATCH) {
    const slice = seeds.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((seed) => {
        const type = seed.media_type === 'tv' ? 'tv' : 'movie';
        return fetchJson(ENDPOINTS.appendDetail(type, seed.id))
          .then((json) => ({ seed, json }))
          .catch(() => null);
      })
    );
    for (const r of results) {
      if (!r) continue;
      const { keywords, people } = enrichmentFromAppend(r.json);
      // Pass enrichment on a shallow COPY — never mutate the shared basketEnriched object
      // (buildTasteProfile already consumed it; in-place writes would be an invisible
      // ordering dependency). extractSeedCandidates reads only id/title/media_type.
      const enrichedSeed = { ...r.seed, _keywords: keywords, _people: people };
      tagged.push(...extractSeedCandidates(enrichedSeed, r.json));
    }
    if (i + BATCH < seeds.length) await delay(300);
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

  const candidates = await generateCandidates(basketEnriched);
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
