# Recommendation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a content-based recommendation engine that suggests movies/TV shows from the user's watched history, surfaced as a "Recommended for you" row on the Movies home view with reason badges.

**Architecture:** A standalone ES module `recommendations.js` holds all engine logic, split into *pure* functions (taste profile + scoring + reasons — unit-tested with Node's built-in test runner) and *network* functions (per-title metadata fetch w/ permanent localStorage cache, TMDB Discover candidate generation). `script.js` only wires the engine in: it renders the returned row and triggers recompute on home-load and after a title is watched. `config.js` gains the keyword/discover endpoints. Candidates are *seeded* by the profile's top keywords/people/genres via Discover, so each candidate carries provenance (`_seeds`) — this gives keyword/cast matching without an extra fetch per candidate, and powers the reason badges.

**Tech Stack:** Vanilla JS (ES modules), TMDB API, localStorage/sessionStorage, Node `--test` for unit tests. No new runtime dependencies.

---

## Data shapes (referenced throughout)

**Enriched watched item** (a TMDB watched-history object with metadata attached):
```
{ id, media_type: 'movie'|'tv', title?, name?, genre_ids: number[],
  vote_average: number, watchedAt: number,
  _keywords: [{ id, name }], _people: [{ id, name }] }
```

**Taste profile** (returned by `buildTasteProfile`):
```
{ genres:   { [genreId: string]: weight: number },           // top 15
  keywords: { [keywordId: string]: { name, weight } },        // top 30
  people:   { [personId: string]: { name, weight } },         // top 20
  mediaTypeBias: { movie: number, tv: number },
  topTitles: [{ id, title, weight, genreIds: number[],
                keywordIds: number[], peopleIds: number[], media_type }] }  // sorted desc by weight
```

**Tagged candidate** (a Discover result with seed provenance):
```
{ ...tmdbMovie, genre_ids: number[], popularity: number,
  _seeds: [{ type: 'keyword'|'person'|'genre', id, name, weight }] }
```

**Recommendation** (returned by `rankCandidates` / `getRecommendations`):
```
{ movie: taggedCandidate, score: number, reasons: string[] }   // reasons: up to 2
```

---

## Task 1: Project test setup + config endpoints

**Files:**
- Modify: `package.json` (add `test` script)
- Modify: `config.js` (add endpoints to the `ENDPOINTS` object)

> NOTE: `config.js` is a hand-written source file, NOT generated codegen output. The global "confirm before editing codegen" rule does not apply here.

- [ ] **Step 1: Add a test script to package.json**

In `package.json`, change the `scripts` block to add a `test` entry:

```json
  "scripts": {
    "start": "npx serve .",
    "test": "node --test",
    "test-providers": "node provider-tester-cli.js"
  },
```

- [ ] **Step 2: Add the keyword + discover endpoints to config.js**

In `config.js`, inside the `export const ENDPOINTS = { ... }` object, add these entries just before the closing `};` (after the existing `discoverTv` entry — add a comma to the current last entry first):

```js
  // Keywords for a title. NOTE: /movie/{id}/keywords returns { keywords: [...] };
  // /tv/{id}/keywords returns { results: [...] }. Caller normalizes both.
  keywords: (type, id) => `${CONFIG.BASE_URL}/${type}/${id}/keywords?api_key=${CONFIG.API_KEY}`,
  // Recommendation candidate generation via Discover (type = 'movie' | 'tv').
  discoverByGenres: (type, genreIdsCsv, page = 1) => `${CONFIG.BASE_URL}/discover/${type}?api_key=${CONFIG.API_KEY}&sort_by=popularity.desc&page=${page}&vote_count.gte=50&with_genres=${genreIdsCsv}`,
  discoverByKeyword: (type, keywordId, page = 1) => `${CONFIG.BASE_URL}/discover/${type}?api_key=${CONFIG.API_KEY}&sort_by=popularity.desc&page=${page}&vote_count.gte=50&with_keywords=${keywordId}`,
  discoverByCast: (type, personId, page = 1) => `${CONFIG.BASE_URL}/discover/${type}?api_key=${CONFIG.API_KEY}&sort_by=popularity.desc&page=${page}&vote_count.gte=20&with_cast=${personId}`
```

- [ ] **Step 3: Verify config.js still parses**

Run: `node -e "import('./config.js').then(m => console.log(typeof m.ENDPOINTS.keywords, typeof m.ENDPOINTS.discoverByGenres))"`
Expected: `function function`

- [ ] **Step 4: Commit**

```bash
git add package.json config.js
git commit -m "feat: add test script and recommendation API endpoints"
```

---

## Task 2: Pure weighting helpers + buildTasteProfile

**Files:**
- Create: `recommendations.js`
- Test: `recommendations.test.js`

- [ ] **Step 1: Write the failing test**

Create `recommendations.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recencyWeight, ratingNudge, buildTasteProfile } from './recommendations.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed clock for deterministic tests

test('recencyWeight decays ~half over 30 days', () => {
  const fresh = recencyWeight(NOW, NOW);
  const month = recencyWeight(NOW - 30 * DAY, NOW);
  assert.equal(fresh, 1);
  assert.ok(month > 0.49 && month < 0.51, `expected ~0.5, got ${month}`);
});

test('recencyWeight defaults to 0.5 when watchedAt missing', () => {
  assert.equal(recencyWeight(undefined, NOW), 0.5);
});

test('ratingNudge maps 0-10 into 0.75..1.25, neutral when missing', () => {
  assert.equal(ratingNudge(0), 1);
  assert.equal(ratingNudge(undefined), 1);
  assert.equal(ratingNudge(10), 1.25);
  assert.equal(ratingNudge(5), 1.0);
});

test('buildTasteProfile aggregates weighted genres, keywords, people', () => {
  const watched = [
    { id: 1, media_type: 'movie', title: 'A', genre_ids: [878, 28], vote_average: 8,
      watchedAt: NOW, _keywords: [{ id: 9, name: 'time travel' }], _people: [{ id: 5, name: 'Nolan' }] },
    { id: 2, media_type: 'tv', name: 'B', genre_ids: [878], vote_average: 6,
      watchedAt: NOW - 60 * DAY, _keywords: [{ id: 9, name: 'time travel' }], _people: [] },
  ];
  const p = buildTasteProfile(watched, NOW);
  // genre 878 appears in both → higher than genre 28 (one, but recent+high rating)
  assert.ok(p.genres['878'] > p.genres['28']);
  assert.equal(p.keywords['9'].name, 'time travel');
  assert.equal(p.people['5'].name, 'Nolan');
  assert.ok(p.mediaTypeBias.movie > 0 && p.mediaTypeBias.tv > 0);
  // topTitles sorted by weight desc, fresh high-rated movie first
  assert.equal(p.topTitles[0].id, 1);
  assert.deepEqual(p.topTitles[0].keywordIds, [9]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test recommendations.test.js`
Expected: FAIL — `Cannot find module './recommendations.js'` (file does not exist yet)

- [ ] **Step 3: Write minimal implementation**

Create `recommendations.js`:

```js
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
    const w = recencyWeight(item.watchedAt, now) * ratingNudge(item.vote_average);

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test recommendations.test.js`
Expected: PASS — 4 tests passing

- [ ] **Step 5: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: add taste profile builder with recency/rating weighting"
```

---

## Task 3: Pure candidate scoring, merging & reasons

**Files:**
- Modify: `recommendations.js`
- Modify: `recommendations.test.js`

- [ ] **Step 1: Write the failing test**

Append to `recommendations.test.js`:

```js
import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates } from './recommendations.js';

const PROFILE = {
  genres: { '878': 3, '28': 1 },
  keywords: { '9': { name: 'time travel', weight: 2 } },
  people: { '5': { name: 'Nolan', weight: 2 } },
  mediaTypeBias: { movie: 5, tv: 1 },
  topTitles: [
    { id: 1, title: 'Inception', weight: 3, genreIds: [878], keywordIds: [9], peopleIds: [5], media_type: 'movie' },
  ],
};

test('mergeCandidates dedupes by id and accumulates seeds', () => {
  const merged = mergeCandidates([
    { id: 100, genre_ids: [878], _seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] },
    { id: 100, genre_ids: [878], _seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 2 }] },
    { id: 200, genre_ids: [28], _seeds: [{ type: 'genre', id: 28, name: 'Action', weight: 1 }] },
  ]);
  assert.equal(merged.length, 2);
  const c100 = merged.find((c) => c.id === 100);
  assert.equal(c100._seeds.length, 2);
});

test('scoreCandidate rewards seed weight, genre overlap, popularity', () => {
  const strong = { id: 100, genre_ids: [878], popularity: 100,
    _seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] };
  const weak = { id: 200, genre_ids: [28], popularity: 1,
    _seeds: [{ type: 'genre', id: 28, name: 'Action', weight: 1 }] };
  assert.ok(scoreCandidate(strong, PROFILE) > scoreCandidate(weak, PROFILE));
});

test('generateReasons links to a watched title and falls back to genre', () => {
  const cand = { id: 100, genre_ids: [878], popularity: 50,
    _seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 2 }] };
  const reasons = generateReasons(cand, PROFILE);
  assert.ok(reasons.length >= 1 && reasons.length <= 2);
  assert.ok(reasons[0].includes('Inception')); // shares person 5 with watched title
});

test('rankCandidates drops already-watched and sorts by score', () => {
  const cands = [
    { id: 1, genre_ids: [878], popularity: 100, _seeds: [{ type: 'keyword', id: 9, name: 'tt', weight: 2 }] }, // watched
    { id: 100, genre_ids: [878], popularity: 100, _seeds: [{ type: 'keyword', id: 9, name: 'tt', weight: 2 }] },
    { id: 200, genre_ids: [28], popularity: 1, _seeds: [{ type: 'genre', id: 28, name: 'Action', weight: 1 }] },
  ];
  const recs = rankCandidates(cands, PROFILE, new Set([1]), 10);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].movie.id, 100);
  assert.ok(recs[0].score >= recs[1].score);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test recommendations.test.js`
Expected: FAIL — `mergeCandidates is not exported` / `is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `recommendations.js` (after `buildTasteProfile`):

```js
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
  return score;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test recommendations.test.js`
Expected: PASS — all 8 tests passing

- [ ] **Step 5: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: add candidate scoring, merging, and reason generation"
```

---

## Task 4: Network layer — metadata cache, candidate generation, orchestrator

**Files:**
- Modify: `recommendations.js`

> These functions touch `fetch`, `localStorage`, and `sessionStorage`, so they run only in the browser and are verified manually in Task 7 (not unit-tested).

- [ ] **Step 1: Append the network layer to recommendations.js**

Add at the end of `recommendations.js`:

```js
// ---------------------------------------------------------------------------
// Network + cache layer (browser only)
// ---------------------------------------------------------------------------
import { CONFIG, ENDPOINTS } from './config.js';

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

function writeMetaCache(cache) {
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

  cache[cacheKey] = meta;
  writeMetaCache(cache);
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
```

- [ ] **Step 2: Verify the module still imports cleanly in Node**

Run: `node -e "import('./recommendations.js').then(m => console.log(typeof m.getRecommendations, typeof m.clearRecommendationCache))"`
Expected: `function function` (Node lacks `fetch`-of-TMDB calls here, but top-level import must not throw)

- [ ] **Step 3: Re-run pure tests to confirm no regressions**

Run: `node --test recommendations.test.js`
Expected: PASS — all 8 tests still passing

- [ ] **Step 4: Commit**

```bash
git add recommendations.js
git commit -m "feat: add metadata cache, candidate generation, and orchestrator"
```

---

## Task 5: Wire the "Recommended for you" row into script.js

**Files:**
- Modify: `script.js` (import at top ~line 2; render function; hook into Movies-home load; hook into `addToWatchedHistory` at line 201)

- [ ] **Step 1: Import the engine**

In `script.js`, after line 2 (`import { initYouTube, activateYouTube } from './youtube.js';`), add:

```js
import { getRecommendations, clearRecommendationCache } from './recommendations.js';
```

- [ ] **Step 2: Add the render function**

Add this function near the other render helpers in `script.js` (e.g. just above `function createMovieCard` around line 1617). It reuses `createMovieCard` and `getWatchedHistory`:

```js
// Render the "Recommended for you" row at the top of the Movies home view.
async function renderRecommendationsRow() {
  // Remove any existing row first (avoids duplicates on re-render).
  document.getElementById('recommendations-row')?.remove();

  // Only show on the Movies home/browse view — not search, Top 250, or Watched.
  if (isSearchMode || isTop250Mode || isWatchedMode) return;

  const watched = getWatchedHistory();
  if (!watched || watched.length === 0) return; // cold-start: show nothing

  let recs = [];
  try {
    recs = await getRecommendations(watched, { limit: 20 });
  } catch (e) {
    console.warn('Recommendations failed:', e);
    return;
  }
  if (recs.length === 0) return;

  const section = document.createElement('section');
  section.id = 'recommendations-row';
  section.className = 'recommendations-row';

  const heading = document.createElement('h2');
  heading.className = 'recommendations-heading';
  heading.textContent = 'Recommended for you';
  section.appendChild(heading);

  const scroller = document.createElement('div');
  scroller.className = 'recommendations-scroller';

  recs.forEach((rec, index) => {
    const card = createMovieCard(rec.movie, index);
    card.classList.add('recommendation-card');
    if (rec.reasons.length) {
      const badge = document.createElement('div');
      badge.className = 'recommendation-reason';
      badge.textContent = rec.reasons.join(' · ');
      card.appendChild(badge);
    }
    scroller.appendChild(card);
  });

  section.appendChild(scroller);
  // Insert above the main grid.
  main.parentNode.insertBefore(section, main);
}
```

- [ ] **Step 3: Trigger it from `loadTrending` (covers initial load + browse + filters)**

The Movies home/browse view always renders through `async function loadTrending()` (line ~1910) — it is the single funnel called by `initFromUrl` (initial page load, line ~2296), by `switchToMovies` (line ~2336), and by every filter handler. Add a single call at the very END of the `loadTrending` function body (just before its closing `}`):

```js
  // Refresh the personalized row whenever the browse view (re)renders.
  renderRecommendationsRow();
```

Because `renderRecommendationsRow` first removes any existing row and then returns early in search/Top 250/Watched modes (Step 2's guard), this both shows the row on the home/browse view and clears it when filters put us into a non-home mode.

`switchToWatched` (line ~2354) and `switchToYouTube` (line ~2339) do NOT call `loadTrending`, so the row would otherwise persist when leaving Movies. Add this line near the top of EACH of those two functions:

```js
  document.getElementById('recommendations-row')?.remove();
```

- [ ] **Step 4: Invalidate the cache when a new title is watched**

In `addToWatchedHistory` (line 201), add a cache-clear after the `localStorage.setItem(...)` line (line 212), inside the `try`:

```js
    clearRecommendationCache();
```

- [ ] **Step 5: Manually verify wiring loads without errors**

Run: `npm start` then open the served URL. Open DevTools console.
Expected: No import/reference errors. (Full behavior verified in Task 7.)

- [ ] **Step 6: Commit**

```bash
git add script.js
git commit -m "feat: wire recommendations row into Movies home view"
```

---

## Task 6: Style the row and reason badges

**Files:**
- Modify: `style.css`

- [ ] **Step 1: Add styles**

Append to `style.css`:

```css
/* Recommendations row */
.recommendations-row {
  margin: 1rem auto;
  max-width: 1400px;
  padding: 0 1rem;
}
.recommendations-heading {
  margin: 0 0 0.75rem;
  font-size: 1.25rem;
  font-weight: 600;
}
.recommendations-scroller {
  display: flex;
  gap: 1rem;
  overflow-x: auto;
  padding-bottom: 0.5rem;
  scroll-snap-type: x proximity;
}
.recommendations-scroller .recommendation-card {
  flex: 0 0 220px;
  scroll-snap-align: start;
  position: relative;
}
.recommendation-reason {
  margin-top: 0.4rem;
  padding: 0.2rem 0.5rem;
  font-size: 0.72rem;
  line-height: 1.2;
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  display: inline-block;
}
```

- [ ] **Step 2: Visually verify**

Run: `npm start`, open the app, confirm the row scrolls horizontally and reason badges render under each card. (Adjust card width/colors to match the app's existing palette if needed — check the existing `.movie-card` rules in `style.css` and align.)

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "feat: style recommendations row and reason badges"
```

---

## Task 7: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Seed watched history**

Run `npm start`, open the app, and watch/play 3-5 varied titles (or, in DevTools console, populate `localStorage.watchedHistory` with several TMDB objects that include `id`, `media_type`, `genre_ids`, `vote_average`, and `watchedAt`).

- [ ] **Step 2: Verify the row appears**

Reload / switch to the Movies home view. Expected: a "Recommended for you" row appears above the main grid with ranked cards, none of which are titles already in watched history.

- [ ] **Step 3: Verify reasons**

Expected: each card shows a reason badge like `Because you watched <title>`, `Features <actor>`, a keyword, or a genre pair.

- [ ] **Step 4: Verify caching**

In DevTools, confirm `localStorage.recMetaCache` is populated and `sessionStorage.recResultsCache` exists. Switch away and back to Movies — the row should reappear quickly without re-fetching (network tab shows no new Discover calls).

- [ ] **Step 5: Verify cold-start**

Run `localStorage.removeItem('watchedHistory')` in console, reload. Expected: no recommendations row, normal trending view unaffected.

- [ ] **Step 6: Verify cache invalidation**

Watch a new title. Expected: `sessionStorage.recResultsCache` is cleared, and the next Movies-home render recomputes recommendations.

- [ ] **Step 7: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "fix: verification adjustments for recommendations row"
```

---

## Self-Review Notes

- **Spec coverage:** content-based engine (Tasks 2-4) ✓; genres+keywords+cast/crew profile (Task 2/4 `fetchTitleMeta`) ✓; permanent per-title cache `recMetaCache` (Task 4) ✓; Discover-seeded candidates (Task 4) ✓; drop already-watched (Task 3 `rankCandidates`) ✓; reason badges (Task 3 + Task 5/6) ✓; row on Movies home only (Task 5) ✓; cold-start shows nothing (Task 5 guard) ✓; session results cache + invalidate on watch (Task 4/5) ✓; rate-limit-friendly batching (Task 4) ✓; unit tests for scoring math (Tasks 2-3) ✓; profile caps 15/30/20 + top 20 (Task 2/4) ✓.
- **Design refinement vs spec:** the spec said candidates are "scored as weighted overlap of genres/keywords/cast." Because Discover results don't include keywords/cast, the plan captures keyword/cast matching via *candidate seeding* (provenance in `_seeds`) plus genre overlap from `genre_ids`, rather than re-fetching metadata per candidate. Same intent, far fewer API calls. This is the one intentional deviation.
- **Type consistency:** profile shape (`genres`/`keywords`/`people`/`mediaTypeBias`/`topTitles`), candidate `_seeds`, and rec `{movie,score,reasons}` are used identically across Tasks 2-5.
