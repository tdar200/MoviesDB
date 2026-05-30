# Engagement Signals, Favorites & Collection-Wide Recommendations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weight recommendations by how much the user engages with a title (dwell time + episode depth), let the user star favorites as decay-proof taste anchors surfaced in a new Favorites tab, and make ranking + explanations reflect the user's whole collection.

**Architecture:** Pure scoring logic (engagement boost, weighting, coverage bonus, hybrid reasons, signal-merge) lives in `recommendations.js` and is unit-tested with Node's runner. Browser-only concerns — localStorage signal stores, dwell/episode capture (timers + visibility), the star toggle UI, and the Favorites tab — live in `script.js`/`index.html` and are verified manually. The engine entry point `getRecommendations` now consumes a unified, annotated input list (`watched ∪ starred`, each carrying `_engagement`/`_starred`), assembled by a pure `mergeSignalItems` helper.

**Tech Stack:** Vanilla JS (ES modules), TMDB API, localStorage/sessionStorage, Node `--test`. No new dependencies.

---

## Data shapes (referenced throughout)

**Engagement store** (`localStorage['titleEngagement']`):
```
{ [id]: { dwellMs: number, episodes: number, opens: number, lastAt: number, _eps?: string[] } }
```
(`_eps` is an internal de-dupe list of `"S:E"` keys; `episodes` is its length.)

**Starred store** (`localStorage['starredTitles']`):
```
{ [id]: { id, media_type, genre_ids, vote_average, title?, name?, poster_path?, release_date?, first_air_date?, starredAt } }
```

**Annotated signal item** (engine input, from `mergeSignalItems`):
```
{ ...movie, watchedAt?, _starred: boolean, _engagement: { dwellMs, episodes, opens } | null }
```

**Tunable constants** (defined in `recommendations.js`):
`ENGAGEMENT_MIN=0.4`, `ENGAGEMENT_MAX=2.5`, `QUICK_BAIL_MS=120000`, `FULL_ENGAGE_MS=5400000` (90 min), `EPISODE_SATURATION=20`, `STAR_BONUS=2.5`, `COVERAGE_WEIGHT=0.5`.

---

## Task 1: Pure `engagementBoost` + constants

**Files:**
- Modify: `recommendations.js`
- Modify: `recommendations.test.js`

- [ ] **Step 1: Write the failing test** — append to `recommendations.test.js`:

```js
import { engagementBoost } from './recommendations.js';

test('engagementBoost: quick bail trends to minimum', () => {
  assert.equal(engagementBoost(0, 0), 0.4);            // opened, closed instantly
  assert.ok(engagementBoost(60000, 0) > 0.4 && engagementBoost(60000, 0) < 1.0); // 1 min
});

test('engagementBoost: long dwell trends to max', () => {
  assert.equal(engagementBoost(5400000, 0), 2.5);      // 90 min
  assert.ok(engagementBoost(2700000, 0) > 1.5 && engagementBoost(2700000, 0) < 2.5); // 45 min
});

test('engagementBoost: episode depth is a strong signal', () => {
  assert.equal(engagementBoost(0, 20), 2.5);           // 20 episodes saturates
  assert.ok(engagementBoost(0, 5) > 1.0);              // some episodes => above neutral
});

test('engagementBoost: monotonic non-decreasing in dwell past the bail point', () => {
  assert.ok(engagementBoost(3000000, 0) >= engagementBoost(2000000, 0));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test recommendations.test.js`
Expected: FAIL — `engagementBoost is not exported`.

- [ ] **Step 3: Write minimal implementation** — in `recommendations.js`, add after the `HALF_LIFE_MS` constant (near the other pure helpers, before `recencyWeight`):

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test recommendations.test.js`
Expected: PASS — all prior tests plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: add engagementBoost weighting helper"
```

---

## Task 2: Engagement + star weighting in `buildTasteProfile`

**Files:**
- Modify: `recommendations.js` (the `buildTasteProfile` function body)
- Modify: `recommendations.test.js`

- [ ] **Step 1: Write the failing test** — append to `recommendations.test.js`:

```js
test('buildTasteProfile applies engagement and star multipliers', () => {
  const base = { id: 1, media_type: 'movie', title: 'A', genre_ids: [878], vote_average: 8, watchedAt: NOW };
  // Same item, three engagement states:
  const neutral = buildTasteProfile([{ ...base }], NOW).genres['878'];
  const bailed  = buildTasteProfile([{ ...base, _engagement: { dwellMs: 0, episodes: 0 } }], NOW).genres['878'];
  const engaged = buildTasteProfile([{ ...base, _engagement: { dwellMs: 5400000, episodes: 0 } }], NOW).genres['878'];
  assert.ok(bailed < neutral, 'a quick bail downweights below neutral');
  assert.ok(engaged > neutral, 'a long watch upweights above neutral');
});

test('buildTasteProfile: stars are decay-proof and boosted', () => {
  const old = { id: 2, media_type: 'movie', title: 'B', genre_ids: [28], vote_average: 8, watchedAt: NOW - 365 * DAY };
  const normal  = buildTasteProfile([{ ...old }], NOW).genres['28'];
  const starred = buildTasteProfile([{ ...old, _starred: true }], NOW).genres['28'];
  // Old item normally decays heavily; starred ignores decay AND gets the bonus.
  assert.ok(starred > normal * 5, 'starred old item vastly outweighs decayed normal');
});

test('buildTasteProfile: legacy items (no _engagement/_starred) unchanged', () => {
  const item = { id: 3, media_type: 'movie', title: 'C', genre_ids: [18], vote_average: 7, watchedAt: NOW };
  const w = buildTasteProfile([item], NOW).genres['18'];
  // recencyWeight(NOW,NOW)=1 * ratingNudge(7)=1.1 => 1.1
  assert.ok(Math.abs(w - 1.1) < 1e-9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test recommendations.test.js`
Expected: FAIL — `starred` equals `normal` (no star handling yet); engagement assertions fail.

- [ ] **Step 3: Write minimal implementation** — in `recommendations.js`, replace the weight line inside `buildTasteProfile`'s loop. Find:

```js
    const w = recencyWeight(item.watchedAt, now) * ratingNudge(item.vote_average);
```

Replace with:

```js
    const recency = item._starred ? 1 : recencyWeight(item.watchedAt, now);
    const eng = item._engagement
      ? engagementBoost(item._engagement.dwellMs, item._engagement.episodes)
      : 1;
    const star = item._starred ? STAR_BONUS : 1;
    const w = recency * ratingNudge(item.vote_average) * eng * star;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test recommendations.test.js`
Expected: PASS — new tests plus all prior tests (the original `buildTasteProfile` test uses no `_engagement`/`_starred`, so it is unaffected).

- [ ] **Step 5: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: weight taste profile by engagement and stars"
```

---

## Task 3: Collection-coverage bonus in `scoreCandidate`

**Files:**
- Modify: `recommendations.js`
- Modify: `recommendations.test.js`

- [ ] **Step 1: Write the failing test** — append to `recommendations.test.js`:

```js
test('scoreCandidate rewards aligning with more distinct watched titles', () => {
  const profile = {
    genres: { '878': 2, '28': 2 },
    keywords: { '9': { name: 'time travel', weight: 2 }, '12': { name: 'heist', weight: 2 } },
    people: { '5': { name: 'Nolan', weight: 2 } },
    mediaTypeBias: { movie: 5, tv: 0 },
    topTitles: [
      { id: 1, title: 'A', weight: 2, genreIds: [878], keywordIds: [9], peopleIds: [5] },
      { id: 2, title: 'B', weight: 2, genreIds: [28], keywordIds: [12], peopleIds: [] },
      { id: 3, title: 'C', weight: 2, genreIds: [878], keywordIds: [], peopleIds: [5] },
    ],
  };
  // Broad candidate: seeds touch keyword 9 (title1), keyword 12 (title2), person 5 (titles1&3).
  const broad = { id: 100, genre_ids: [878, 28], popularity: 10, _seeds: [
    { type: 'keyword', id: 9, name: 'time travel', weight: 2 },
    { type: 'keyword', id: 12, name: 'heist', weight: 2 },
    { type: 'person', id: 5, name: 'Nolan', weight: 2 },
  ] };
  // Narrow candidate: single seed touching only title2, same raw seed weight total area.
  const narrow = { id: 200, genre_ids: [28], popularity: 10, _seeds: [
    { type: 'keyword', id: 12, name: 'heist', weight: 6 },
  ] };
  assert.ok(scoreCandidate(broad, profile) > scoreCandidate(narrow, profile),
    'a candidate spanning more of the collection should win even at equal seed weight');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test recommendations.test.js`
Expected: FAIL — without the coverage bonus, `narrow` (seed weight 6 + genre) may score ≥ `broad`.

- [ ] **Step 3: Write minimal implementation** — in `recommendations.js`, add this helper immediately above `scoreCandidate`:

```js
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
```

Then in `scoreCandidate`, replace the final `return score;` with:

```js
  const contributors = contributingTitleCount(candidate, profile);
  return score * (1 + COVERAGE_WEIGHT * Math.log2(1 + contributors));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test recommendations.test.js`
Expected: PASS — the new test plus all prior (the existing strong>weak ordering test still holds; both sides are scaled, and `strong` aligns with the fixture title while `weak` does not).

- [ ] **Step 5: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: reward collection-wide coverage in candidate scoring"
```

---

## Task 4: Hybrid `generateReasons`

**Files:**
- Modify: `recommendations.js` (rewrite `generateReasons`)
- Modify: `recommendations.test.js` (update the existing reasons test + add cases)

- [ ] **Step 1: Update/add tests** — in `recommendations.test.js`, find the existing test `generateReasons links to a watched title and falls back to genre` and REPLACE it entirely with:

```js
test('generateReasons leads with a taste theme and adds dominant title', () => {
  const cand = { id: 100, genre_ids: [878], popularity: 50,
    _seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 2 }] };
  const reasons = generateReasons(cand, PROFILE);
  assert.ok(reasons.length >= 1 && reasons.length <= 2);
  // Theme references the matched genre and/or person.
  assert.match(reasons[0], /Sci-Fi|Nolan|most-watched/);
  // Dominant contributing title (shares person 5 -> Inception) appears via "esp.".
  assert.ok(reasons.join(' ').includes('Inception'));
});

test('generateReasons falls back to genre-only theme without person/keyword', () => {
  const cand = { id: 101, genre_ids: [878], popularity: 5, _seeds: [] };
  const reasons = generateReasons(cand, PROFILE);
  assert.match(reasons[0], /Sci-Fi/);
});

test('generateReasons falls back to generic when nothing matches', () => {
  const cand = { id: 102, genre_ids: [99], popularity: 1, _seeds: [] };
  assert.deepEqual(generateReasons(cand, PROFILE), ['Picked for your taste']);
});
```

(The `PROFILE` fixture defined earlier in the file has `genres: { '878': 3, '28': 1 }`, `people: { '5': {name:'Nolan',weight:2} }`, and `topTitles: [{ id:1, title:'Inception', genreIds:[878], keywordIds:[9], peopleIds:[5] }]`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test recommendations.test.js`
Expected: FAIL — current `generateReasons` returns `"Because you watched Inception"` as `reasons[0]`, so the theme-format assertions fail.

- [ ] **Step 3: Rewrite implementation** — in `recommendations.js`, REPLACE the entire `generateReasons` function with:

```js
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
  if (themeParts.length >= 2) theme = `Matches your love of ${themeParts[0]} & ${themeParts[1]}`;
  else if (themeParts.length === 1) theme = `From your most-watched genre: ${themeParts[0]}`;
  else theme = 'Picked for your taste';

  const reasons = [theme];
  if (dominantTitle && theme !== 'Picked for your taste') reasons.push(`esp. ${dominantTitle}`);
  return reasons.slice(0, 2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test recommendations.test.js`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: collection-aware hybrid recommendation reasons"
```

---

## Task 5: Pure `mergeSignalItems` + `getRecommendations` unified input

**Files:**
- Modify: `recommendations.js`
- Modify: `recommendations.test.js`

- [ ] **Step 1: Write the failing test** — append to `recommendations.test.js`:

```js
import { mergeSignalItems } from './recommendations.js';

test('mergeSignalItems unions watched + starred and annotates each', () => {
  const watched = [
    { id: 1, media_type: 'movie', title: 'A', genre_ids: [878], vote_average: 8, watchedAt: 111 },
    { id: 2, media_type: 'tv', name: 'B', genre_ids: [18], vote_average: 7, watchedAt: 222 },
  ];
  const starred = {
    2: { id: 2, media_type: 'tv', name: 'B', genre_ids: [18], vote_average: 7, starredAt: 9 }, // also watched
    3: { id: 3, media_type: 'movie', title: 'C', genre_ids: [28], vote_average: 6, starredAt: 9 }, // star only
  };
  const engagement = { 1: { dwellMs: 5000, episodes: 0, opens: 1 } };
  const items = mergeSignalItems(watched, starred, engagement);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(items.length, 3);                 // 1,2,3 (2 merged, not duplicated)
  assert.equal(byId[1]._starred, false);
  assert.deepEqual(byId[1]._engagement, { dwellMs: 5000, episodes: 0, opens: 1 });
  assert.equal(byId[2]._starred, true);          // present in both
  assert.equal(byId[3]._starred, true);          // star-only still included
  assert.equal(byId[3]._engagement, null);       // no engagement record
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test recommendations.test.js`
Expected: FAIL — `mergeSignalItems is not exported`.

- [ ] **Step 3: Implement `mergeSignalItems`** — in `recommendations.js`, add near the top pure helpers (e.g. after `buildTasteProfile`):

```js
// Union watched history with starred titles and annotate each item with its
// engagement record and star flag. Pure: caller supplies the three raw stores.
export function mergeSignalItems(watched, starredMap, engagementMap) {
  const starred = starredMap || {};
  const engagement = engagementMap || {};
  const byId = new Map();
  for (const m of watched || []) byId.set(m.id, { ...m });
  for (const key of Object.keys(starred)) {
    const s = starred[key];
    byId.set(s.id, byId.has(s.id) ? { ...byId.get(s.id), ...s } : { ...s });
  }
  const items = [];
  for (const m of byId.values()) {
    const e = engagement[m.id];
    items.push({
      ...m,
      _starred: Object.prototype.hasOwnProperty.call(starred, m.id),
      _engagement: e ? { dwellMs: e.dwellMs || 0, episodes: e.episodes || 0, opens: e.opens || 0 } : null,
    });
  }
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test recommendations.test.js`
Expected: PASS.

- [ ] **Step 5: Update `getRecommendations` to consume the unified list** — in `recommendations.js`, update the orchestrator. Replace the `watchedSignature` function and the `getRecommendations` signature/body as follows.

Find `function watchedSignature(watched) { ... }` and replace with:

```js
// Stable signature of the signal set so we can cache results per session.
// Includes star + engagement so toggling a star or finishing a long watch busts it.
function signalSignature(items) {
  return items
    .map((m) => `${m.id}:${m.watchedAt || 0}:${m._starred ? 1 : 0}:${m._engagement?.dwellMs || 0}:${m._engagement?.episodes || 0}`)
    .join(',');
}
```

Find the `getRecommendations` function and replace its header + the lines that reference `watched`/`watchedSignature`/`watchedIds`:

```js
export async function getRecommendations(items, opts = {}) {
  const { limit = 20, now = Date.now() } = opts;
  if (!items || items.length === 0) return [];

  const sig = signalSignature(items);
  try {
    const cached = JSON.parse(sessionStorage.getItem(RECS_CACHE_KEY) || 'null');
    if (cached && cached.sig === sig) return cached.recs;
  } catch { /* ignore cache read errors */ }

  const enriched = await enrichWatchedTitles(items);
  const profile = buildTasteProfile(enriched, now);
  const candidates = await generateCandidates(profile);
  const excludeIds = new Set(items.map((m) => m.id));
  const recs = rankCandidates(candidates, profile, excludeIds, limit);

  try {
    sessionStorage.setItem(RECS_CACHE_KEY, JSON.stringify({ sig, recs }));
  } catch { /* ignore quota errors */ }
  return recs;
}
```

- [ ] **Step 6: Verify module imports + tests**

Run: `node -e "import('./recommendations.js').then(m => console.log(typeof m.getRecommendations, typeof m.mergeSignalItems, typeof m.engagementBoost))"`
Expected: `function function function`

Run: `node --test recommendations.test.js`
Expected: PASS — all tests.

- [ ] **Step 7: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: feed unified watched+starred signals into recommendations"
```

---

## Task 6: Signal stores + wire engine input + hybrid reason rendering

**Files:**
- Modify: `script.js`

- [ ] **Step 1: Add the signal storage helpers** — in `script.js`, add right after the `clearWatchedHistory` function (near the other localStorage helpers, ~line 231):

```js
// ---- Engagement + star signal stores ----
const TITLE_ENGAGEMENT_KEY = 'titleEngagement';
const STARRED_TITLES_KEY = 'starredTitles';
const SESSION_DWELL_CAP_MS = 10800000; // 3h per session
const TOTAL_DWELL_CAP_MS = 86400000;   // 24h lifetime per title

function getEngagementStore() {
  try { return JSON.parse(localStorage.getItem(TITLE_ENGAGEMENT_KEY) || '{}'); }
  catch { return {}; }
}
function saveEngagementStore(store) {
  try { localStorage.setItem(TITLE_ENGAGEMENT_KEY, JSON.stringify(store)); }
  catch (e) { console.error('engagement save failed:', e); }
}
function recordOpen(id) {
  const s = getEngagementStore();
  const e = s[id] || { dwellMs: 0, episodes: 0, opens: 0, _eps: [] };
  e.opens = (e.opens || 0) + 1;
  e.lastAt = Date.now();
  s[id] = e;
  saveEngagementStore(s);
}
function recordDwell(id, ms) {
  if (!id || !ms || ms <= 0) return;
  const capped = Math.min(ms, SESSION_DWELL_CAP_MS);
  const s = getEngagementStore();
  const e = s[id] || { dwellMs: 0, episodes: 0, opens: 0, _eps: [] };
  e.dwellMs = Math.min((e.dwellMs || 0) + capped, TOTAL_DWELL_CAP_MS);
  e.lastAt = Date.now();
  s[id] = e;
  saveEngagementStore(s);
}
function recordEpisode(id, season, episode) {
  const s = getEngagementStore();
  const e = s[id] || { dwellMs: 0, episodes: 0, opens: 0, _eps: [] };
  const key = `${season}:${episode}`;
  e._eps = e._eps || [];
  if (!e._eps.includes(key)) e._eps.push(key);
  e.episodes = e._eps.length;
  e.lastAt = Date.now();
  s[id] = e;
  saveEngagementStore(s);
}

function getStarredStore() {
  try { return JSON.parse(localStorage.getItem(STARRED_TITLES_KEY) || '{}'); }
  catch { return {}; }
}
function saveStarredStore(store) {
  try { localStorage.setItem(STARRED_TITLES_KEY, JSON.stringify(store)); }
  catch (e) { console.error('starred save failed:', e); }
}
function isStarred(id) {
  return Object.prototype.hasOwnProperty.call(getStarredStore(), id);
}
// Toggle star for a movie; returns the new starred state.
function toggleStar(movie) {
  const store = getStarredStore();
  if (Object.prototype.hasOwnProperty.call(store, movie.id)) {
    delete store[movie.id];
    saveStarredStore(store);
    clearRecommendationCache();
    return false;
  }
  store[movie.id] = {
    id: movie.id,
    media_type: movie.media_type || (movie.title ? 'movie' : 'tv'),
    genre_ids: movie.genre_ids || [],
    vote_average: movie.vote_average,
    title: movie.title,
    name: movie.name,
    poster_path: movie.poster_path,
    release_date: movie.release_date,
    first_air_date: movie.first_air_date,
    overview: movie.overview,
    starredAt: Date.now(),
  };
  saveStarredStore(store);
  clearRecommendationCache();
  return true;
}
function getStarredList() {
  const store = getStarredStore();
  return Object.values(store).sort((a, b) => (b.starredAt || 0) - (a.starredAt || 0));
}

// Assemble the unified, annotated input the engine consumes.
function buildSignalItems() {
  return mergeSignalItems(getWatchedHistory(), getStarredStore(), getEngagementStore());
}
```

- [ ] **Step 2: Import `mergeSignalItems`** — in `script.js` line 3, update the recommendations import to:

```js
import { getRecommendations, clearRecommendationCache, mergeSignalItems } from './recommendations.js';
```

- [ ] **Step 3: Feed the unified signals into the rail** — in `renderRecommendationsRow`, replace:

```js
  const watched = getWatchedHistory();
  if (!watched || watched.length === 0) return; // cold-start: show nothing

  let recs = [];
  try {
    recs = await getRecommendations(watched, { limit: 20 });
```

with:

```js
  const items = buildSignalItems();
  if (items.length === 0) return; // cold-start: show nothing

  let recs = [];
  try {
    recs = await getRecommendations(items, { limit: 20 });
```

- [ ] **Step 4: Render the hybrid reason** — in `createRecommendationCard`, replace the entire block that builds the `because` element (from `const because = document.createElement('p');` through `card.appendChild(because);`) with:

```js
  // The "why" — theme-led, with an optional dominant title.
  const because = document.createElement('p');
  because.className = 'rec-because';
  because.innerHTML =
    '<svg class="rec-spark" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 2l1.6 5.2L19 9l-5.4 1.8L12 16l-1.6-5.2L5 9l5.4-1.8z"/></svg>';
  const theme = rec.reasons[0] || 'Picked for your taste';
  because.appendChild(document.createTextNode(theme));
  const espMatch = (rec.reasons[1] || '').match(/^esp\. (.+)$/);
  if (espMatch) {
    because.appendChild(document.createTextNode(' · esp. '));
    const b = document.createElement('b');
    b.textContent = espMatch[1];
    because.appendChild(b);
  }
  card.appendChild(because);
```

- [ ] **Step 5: Verify**

Run: `node --check script.js`
Expected: exit 0.

Run: `node --test recommendations.test.js`
Expected: PASS (engine untouched).

- [ ] **Step 6: Commit**

```bash
git add script.js
git commit -m "feat: signal stores and unified engine input wiring"
```

---

## Task 7: Dwell + episode capture

**Files:**
- Modify: `script.js` (`openPlayer`, `closePlayer`, the episode-change function ~line 1006, plus module-scope state + a visibility/pagehide listener)

- [ ] **Step 1: Add capture state + flush helper** — in `script.js`, near `let currentPlayingMovie = null;` (~line 162), add:

```js
let playerOpenedAt = 0;
let playerHiddenMs = 0;
let playerHiddenSince = 0;
let dwellTitleId = null;

// Compute and persist this session's dwell, then reset. Idempotent.
function flushDwell() {
  if (!playerOpenedAt || !dwellTitleId) return;
  if (playerHiddenSince) { // tab still hidden at flush time
    playerHiddenMs += Date.now() - playerHiddenSince;
    playerHiddenSince = 0;
  }
  const dwell = Date.now() - playerOpenedAt - playerHiddenMs;
  recordDwell(dwellTitleId, dwell);
  if (dwell > 0) clearRecommendationCache();
  playerOpenedAt = 0;
  playerHiddenMs = 0;
  dwellTitleId = null;
}
```

- [ ] **Step 2: Start capture in `openPlayer`** — in `openPlayer`, immediately after `addToWatchedHistory(movie);` (line ~1077), add:

```js
  // Begin engagement capture for this title.
  flushDwell(); // flush any prior session that didn't close cleanly
  playerOpenedAt = Date.now();
  playerHiddenMs = 0;
  playerHiddenSince = 0;
  dwellTitleId = movie.id;
  recordOpen(movie.id);
```

- [ ] **Step 3: Stop capture in `closePlayer`** — in `closePlayer`, add as the FIRST statement inside the function body:

```js
  flushDwell();
```

- [ ] **Step 4: Record episode depth** — find the line `saveWatchProgress(currentPlayingMovie.id, season, episode);` (~line 1006) and add immediately after it:

```js
  recordEpisode(currentPlayingMovie.id, season, episode);
```

- [ ] **Step 5: Add global visibility + pagehide listeners** — in `script.js`, add near the other top-level `window.addEventListener` calls (e.g. after the scroll listener ~line 2301):

```js
// Pause dwell accumulation while the tab is hidden; flush on tab close.
document.addEventListener('visibilitychange', () => {
  if (!playerOpenedAt) return;
  if (document.hidden) {
    playerHiddenSince = Date.now();
  } else if (playerHiddenSince) {
    playerHiddenMs += Date.now() - playerHiddenSince;
    playerHiddenSince = 0;
  }
});
window.addEventListener('pagehide', flushDwell);
```

- [ ] **Step 6: Verify**

Run: `node --check script.js`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add script.js
git commit -m "feat: capture dwell time and episode depth as engagement"
```

---

## Task 8: Star toggle UI on cards and in the player

**Files:**
- Modify: `index.html` (player header)
- Modify: `script.js` (`createMovieCard`, `createRecommendationCard`, `openPlayer`)
- Modify: `style.css`

- [ ] **Step 1: Add a reusable star button factory** — in `script.js`, add above `createMovieCard` (~line 1670):

```js
const STAR_FILLED_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.3 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg>';
const STAR_OUTLINE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3.2l2.6 5.7 6.2.6-4.7 4.1 1.4 6.1L12 16.6 6.5 19.8l1.4-6.1L3.2 9.5l6.2-.6z"/></svg>';

// A star toggle bound to a movie. Stops click propagation so it never triggers play.
function createStarButton(movie) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'star-btn';
  const sync = () => {
    const on = isStarred(movie.id);
    btn.classList.toggle('starred', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    btn.title = on ? 'Remove from favorites' : 'Add to favorites';
    btn.innerHTML = on ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
  };
  sync();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStar(movie);
    sync();
    if (isFavoritesMode) loadFavorites(); // un-starring removes it from the favorites grid
  });
  return btn;
}
```

- [ ] **Step 2: Add the star to browse/watched/favorites cards** — in `createMovieCard`, immediately before `card.appendChild(imageDiv);` (~line 1837), add:

```js
  imageDiv.appendChild(createStarButton(movie));
```

- [ ] **Step 3: Add the star to recommendation cards** — in `createRecommendationCard`, immediately after `poster.appendChild(scrim);` (before `card.appendChild(poster);`), add:

```js
  poster.appendChild(createStarButton(movie));
```

- [ ] **Step 4: Add a star button to the player header** — in `index.html`, inside `<div class="player-header">`, change the title line so the star sits next to it. Replace:

```html
          <h2 id="player-title">Now Playing</h2>
```

with:

```html
          <div class="player-title-row">
            <h2 id="player-title">Now Playing</h2>
            <button id="player-star" type="button" class="star-btn player-star" aria-label="Add to favorites" title="Add to favorites"></button>
          </div>
```

- [ ] **Step 5: Wire the player star** — in `script.js`, add a module-scope element ref near the other player refs (~line 52, after `const playerIframe = ...`):

```js
const playerStarBtn = document.getElementById('player-star');
```

Then in `openPlayer`, after `currentPlayingMovie = movie;` (~line 1083), add:

```js
  // Sync the player-header star to this title.
  if (playerStarBtn) {
    const syncPlayerStar = () => {
      const on = isStarred(movie.id);
      playerStarBtn.classList.toggle('starred', on);
      playerStarBtn.setAttribute('aria-pressed', String(on));
      playerStarBtn.title = on ? 'Remove from favorites' : 'Add to favorites';
      playerStarBtn.innerHTML = on ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
    };
    syncPlayerStar();
    playerStarBtn.onclick = (e) => { e.stopPropagation(); toggleStar(movie); syncPlayerStar(); };
  }
```

- [ ] **Step 6: Style the star button** — append to `style.css`:

```css
/* Star toggle */
.star-btn {
  position: absolute;
  top: 0.45rem;
  left: 0.5rem;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  color: #fff;
  background: rgba(8, 9, 26, 0.55);
  backdrop-filter: blur(3px);
  opacity: 0;
  transform: scale(0.85);
  transition: opacity 0.2s ease, transform 0.2s ease, color 0.2s ease;
}
.movie:hover .star-btn,
.rec-card:hover .star-btn,
.star-btn:focus-visible,
.star-btn.starred {
  opacity: 1;
  transform: scale(1);
}
.star-btn.starred { color: #e9b955; background: rgba(8, 9, 26, 0.75); }
.star-btn:hover { color: #f3d089; }
/* The rec card already uses top-left for the rank; offset its star to top-right. */
.rec-card .star-btn { left: auto; right: 0.5rem; }
/* Player-header star sits inline, always visible. */
.player-title-row { display: flex; align-items: center; gap: 0.6rem; }
.player-star {
  position: static;
  opacity: 1;
  transform: none;
  width: 34px;
  height: 34px;
  background: rgba(255, 255, 255, 0.08);
}
```

- [ ] **Step 7: Verify**

Run: `node --check script.js`
Expected: exit 0.

Run: `node -e "const c=require('fs').readFileSync('style.css','utf8'); const o=(c.match(/{/g)||[]).length, cl=(c.match(/}/g)||[]).length; process.exit(o===cl?0:1)" && echo CSSOK`
Expected: `CSSOK`

- [ ] **Step 8: Commit**

```bash
git add index.html script.js style.css
git commit -m "feat: star toggle on cards and in the player"
```

---

## Task 9: Favorites tab

**Files:**
- Modify: `index.html` (tab bar)
- Modify: `script.js` (mode flag, switch/load, wiring, rail guard)

- [ ] **Step 1: Add the tab button** — in `index.html`, in the `.app-tabs` block, add after the Watched tab (line ~16):

```html
          <button id="tab-favorites" class="app-tab" data-tab="favorites">Favorites</button>
```

- [ ] **Step 2: Add a mode flag** — in `script.js`, near `let isWatchedMode = false;` (~line 2376), add:

```js
let isFavoritesMode = false;
```

- [ ] **Step 3: Suppress the rail in Favorites mode** — in `renderRecommendationsRow`, update the guard line:

```js
  if (isSearchMode || isTop250Mode || isWatchedMode) return;
```

to:

```js
  if (isSearchMode || isTop250Mode || isWatchedMode || isFavoritesMode) return;
```

- [ ] **Step 4: Clear the flag where other Movies-view modes reset** — in `switchToMovies`, after `isWatchedMode = false;` (~line 2380), add:

```js
  isFavoritesMode = false;
```

Also in `switchToWatched` and `switchToYouTube`, add `isFavoritesMode = false;` near where they set their own flags (so leaving Favorites for those tabs clears it).

- [ ] **Step 5: Add `switchToFavorites` + `loadFavorites`** — in `script.js`, add after `loadWatchedHistory` (~line 2404):

```js
function switchToFavorites() {
  currentApp = 'movies';
  isWatchedMode = false;
  isFavoritesMode = true;
  isSearchMode = false;
  isTop250Mode = false;

  document.getElementById('recommendations-row')?.remove();
  tabMovies.classList.remove('active');
  tabWatched.classList.remove('active');
  tabYouTube.classList.remove('active');
  tabFavorites.classList.add('active');
  top250Btn.classList.remove('active');

  movieFilters.style.display = 'none';
  youtubeFilters.style.display = 'none';
  movieSearchForm.style.display = 'none';
  youtubeSearchForm.style.display = 'none';
  top250Button.style.display = 'none';

  loadFavorites();
}

function loadFavorites() {
  setLoading(true);
  hideError();

  const favorites = getStarredList();
  if (favorites.length === 0) {
    main.innerHTML = '<p class="no-results">No favorites yet. Tap the ★ on any title to add it.</p>';
    setLoading(false);
    return;
  }

  allMovies = favorites;
  filteredMovies = favorites;
  displayedCount = 0;
  hasMorePages = false;

  main.innerHTML = '';
  const fragment = document.createDocumentFragment();
  favorites.forEach((movie, index) => fragment.appendChild(createMovieCard(movie, index)));
  main.appendChild(fragment);
  displayedCount = favorites.length;

  setLoading(false);
}
```

- [ ] **Step 6: Add the tab element ref + click wiring** — in `script.js`, near `const tabWatched = document.getElementById('tab-watched');` (~line 2314), add:

```js
const tabFavorites = document.getElementById('tab-favorites');
```

And near `tabWatched?.addEventListener('click', switchToWatched);` (~line 2461), add:

```js
tabFavorites?.addEventListener('click', switchToFavorites);
```

Also, in `switchToWatched` where it sets `tabFavorites` inactive is needed — confirm `switchToMovies`, `switchToWatched`, `switchToYouTube` each remove `active` from `tabFavorites`. Add `tabFavorites.classList.remove('active');` to each of those three functions alongside their existing `classList.remove('active')` calls.

- [ ] **Step 7: Verify**

Run: `node --check script.js`
Expected: exit 0.

Run: `node --test recommendations.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add index.html script.js
git commit -m "feat: add Favorites tab for starred titles"
```

---

## Task 10: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Serve and seed**

Run `npm start`, open the app. In DevTools, seed a varied `watchedHistory` (or play several titles). Confirm the Movies-home recommendations rail appears.

- [ ] **Step 2: Engagement weighting**

Open a title, leave the player open ~1 min, close it. Open another and close within a few seconds. In DevTools confirm `localStorage.titleEngagement` has `dwellMs`/`opens` per id. Reload Movies — confirm the rail recomputed (the long-dwell title's genres should pull recommendations toward its taste).

- [ ] **Step 3: Episode depth**

Open a TV show, advance through several episodes. Confirm `titleEngagement[id].episodes` increases with distinct episodes.

- [ ] **Step 4: Stars**

Hover a card → the ★ appears top-corner. Click it → fills gold, `localStorage.starredTitles` gains the id, and `sessionStorage.recResultsCache` is cleared. Star from the player header too.

- [ ] **Step 5: Favorites tab**

Click the **Favorites** tab → starred titles render as a grid; the recommendations rail is absent. Unstar one → it disappears from the grid. With no stars, the empty-state message shows.

- [ ] **Step 6: Collection-aware reasons**

On the rail, confirm reasons read as themes (e.g. "Matches your love of Sci-Fi & …", "From your most-watched genre: …") and append "esp. <Title>" when one title dominates — not the old single "Because you watched X" for every card.

- [ ] **Step 7: Cold-start + regression**

Clear `watchedHistory` and `starredTitles`; reload — no rail, normal browse intact. Confirm Search / Top 250 / Watched / YouTube tabs still work and the rail does not leak into them.

- [ ] **Step 8: Final commit (if verification fixes were needed)**

```bash
git add -A
git commit -m "fix: verification adjustments for engagement/favorites"
```

---

## Self-Review Notes

- **Spec coverage:** engagement stores + capture (Tasks 6–7) ✓; dwell cap + tab-hide pause (Task 7 `flushDwell`/visibility) ✓; episode depth (Task 7) ✓; `recency×rating×engagement×star` weighting (Tasks 1–2) ✓; decay-proof stars + bonus (Task 2) ✓; star ∪ watched union (Tasks 5–6) ✓; coverage bonus (Task 3) ✓; hybrid reasons (Task 4) + rendering (Task 6) ✓; star UI on cards + player (Task 8) ✓; Favorites tab (Task 9) ✓; engine entry-point unified input + cache sig incl. star/engagement (Task 5) ✓; legacy compatibility (Task 2 test) ✓; pure/network split + tests (Tasks 1–5) ✓.
- **Type consistency:** `_engagement` (`{dwellMs,episodes,opens}|null`) and `_starred` (bool) are produced by `mergeSignalItems` (Task 5) and consumed by `buildTasteProfile` (Task 2); `getRecommendations(items, …)` (Task 5) is called with `buildSignalItems()` (Task 6); store keys `titleEngagement`/`starredTitles` and helpers `isStarred`/`toggleStar`/`getStarredList`/`recordDwell`/`recordEpisode`/`recordOpen` are defined once (Task 6) and used in Tasks 7–9; `isFavoritesMode`, `tabFavorites`, `loadFavorites` defined in Task 9 and referenced by `createStarButton` (Task 8) — Task 8 precedes Task 9, but both are function-scoped references resolved at call time (hoisting/late binding), so order is safe.
- **Ordering note:** `createStarButton` (Task 8) references `isFavoritesMode`/`loadFavorites` defined in Task 9. Both are module-scope (`let`/function declaration); the reference only executes on a click, which can't happen until the app is fully loaded, so the forward reference is safe.
