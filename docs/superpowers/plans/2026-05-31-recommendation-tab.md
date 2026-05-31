# Recommendation Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated "Recommended" tab (2nd in the nav) that presents movie recommendations as multiple Netflix-style themed rails, reusing the existing content-based engine.

**Architecture:** Extract the engine's orchestration into a shared `_pipeline()` that also returns the taste profile, add a pure `groupIntoRows()` that buckets ranked recs into themed rows, and add a `getRecommendationRows()` orchestrator. In the UI, factor the existing home-row rail markup into a shared `buildRecRail()` helper used by both the home teaser and a new full-page `renderRecommendationsPage()`, wired to a new tab via the established `switchToX()` convention.

**Tech Stack:** Vanilla ES modules (browser), `node:test` for unit tests, no build step. App served with `npx serve .`.

---

## File structure

- **`recommendations.js`** (modify) — extract `_pipeline()`, add pure `groupIntoRows()`, add `getRecommendationRows()`, broaden `clearRecommendationCache()`.
- **`recommendations.test.js`** (modify) — unit tests for `groupIntoRows()`.
- **`index.html`** (modify) — new `#tab-recommended` nav button.
- **`script.js`** (modify) — import, element ref, `buildRecRail()` extraction, `renderRecommendationsPage()`, `switchToRecommended()`, tab deactivation in other switchers, listener wiring.
- **`style.css`** (modify) — `.rec-page` stacked-rails layout + empty state.

All five are hand-written app files — none are codegen/orval output, so no pipeline-confirmation gate applies.

---

### Task 1: Extract shared `_pipeline()` in the engine (no behavior change)

**Files:**
- Modify: `recommendations.js:388-415` (the `getRecommendations` + `clearRecommendationCache` block)

- [ ] **Step 1: Run the existing tests to establish a green baseline**

Run: `npm test`
Expected: PASS (all existing recommendation tests pass before any change).

- [ ] **Step 2: Replace the `getRecommendations` orchestrator with a shared `_pipeline`**

In `recommendations.js`, replace the current `getRecommendations` function (the block starting `export async function getRecommendations(items, opts = {})` and ending at its closing `}`) with:

```js
// Shared pipeline: enrich → profile → candidates → rank. Returns the profile too
// (the dedicated Recommendation page groups by it). Cached per (signal signature, limit)
// so the home teaser (limit 20) and the page (limit 60) don't clobber each other.
async function _pipeline(items, opts = {}) {
  const { limit = 20, now = Date.now() } = opts;
  const sig = signalSignature(items);
  const cacheKey = `${RECS_CACHE_KEY}:${limit}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    if (cached && cached.sig === sig) return { profile: cached.profile, recs: cached.recs };
  } catch { /* ignore cache read errors */ }

  const enriched = await enrichWatchedTitles(items);
  const profile = buildTasteProfile(enriched, now);
  const candidates = await generateCandidates(profile);
  const excludeIds = new Set(items.map((m) => m.id));
  const recs = rankCandidates(candidates, profile, excludeIds, limit);

  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ sig, profile, recs }));
  } catch { /* ignore quota errors */ }
  return { profile, recs };
}

// Top-level orchestrator for the home teaser row. Returns [{ movie, score, reasons }].
export async function getRecommendations(items, opts = {}) {
  if (!items || items.length === 0) return [];
  return (await _pipeline(items, opts)).recs;
}
```

- [ ] **Step 3: Broaden `clearRecommendationCache` to clear all per-limit keys**

Replace the existing `clearRecommendationCache` function body with:

```js
// Clear every per-limit session results cache entry (call after a new title is watched).
export function clearRecommendationCache() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(RECS_CACHE_KEY)) sessionStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run tests to verify nothing broke**

Run: `npm test`
Expected: PASS (same set as Step 1 — this refactor is behavior-preserving for the pure functions; no test exercises the network path).

- [ ] **Step 5: Commit**

```bash
git add recommendations.js
git commit -m "refactor: extract shared _pipeline in rec engine"
```

---

### Task 2: Add pure `groupIntoRows()` (TDD)

**Files:**
- Modify: `recommendations.js` (add `groupIntoRows` in the pure-helpers section, right after `generateReasons`, before `rankCandidates`)
- Test: `recommendations.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `recommendations.test.js`:

```js
import { groupIntoRows } from './recommendations.js';

// Helper to build a ranked rec quickly.
function gr(id, { seeds = [], genres = [], score = 1 } = {}) {
  return { movie: { id, genre_ids: genres, _seeds: seeds }, score, reasons: ['r'] };
}

const GROUP_PROFILE = {
  genres: { '878': 5, '28': 3, '18': 1 },                 // 878=Sci-Fi, 28=Action, 18=Drama
  keywords: { '9': { name: 'time travel', weight: 2 } },
  people: { '5': { name: 'Nolan', weight: 4 }, '7': { name: 'Villeneuve', weight: 2 } },
  mediaTypeBias: { movie: 5, tv: 0 },
  topTitles: [
    { id: 1, title: 'Inception', weight: 3, genreIds: [878], keywordIds: [9], peopleIds: [5], media_type: 'movie' },
  ],
};

test('groupIntoRows: top picks row is first and capped', () => {
  const ranked = Array.from({ length: 30 }, (_, i) => gr(1000 + i, { genres: [878] }));
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { topCount: 20 });
  assert.equal(rows[0].kind, 'top');
  assert.equal(rows[0].title, 'Top picks for you');
  assert.equal(rows[0].recs.length, 20);
});

test('groupIntoRows: "Because you watched" groups by shared keyword/person seed', () => {
  const ranked = [
    gr(10, { seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] }),
    gr(11, { seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 4 }] }),
    gr(12, { seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] }),
    gr(13, { seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 4 }] }),
    gr(14, { seeds: [{ type: 'genre', id: 99, name: 'Doc', weight: 1 }] }), // unrelated
  ];
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { topCount: 0, minItems: 4 });
  const titleRow = rows.find((r) => r.kind === 'title');
  assert.equal(titleRow.title, 'Because you watched Inception');
  assert.equal(titleRow.recs.length, 4); // ids 10,11,12,13 — not the unrelated 14
});

test('groupIntoRows: drops rows with fewer than minItems', () => {
  const ranked = [
    gr(10, { seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] }),
    gr(11, { seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] }),
  ]; // only 2 match the title — below minItems 4
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { topCount: 0, minItems: 4 });
  assert.equal(rows.find((r) => r.kind === 'title'), undefined);
});

test('groupIntoRows: genre row labelled from config and deduped against earlier rows', () => {
  // 4 sci-fi recs share the Nolan person seed (claimed by the title row first),
  // plus 4 fresh sci-fi recs with no person seed for the genre row.
  const ranked = [
    ...[20, 21, 22, 23].map((id) => gr(id, { genres: [878], seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 4 }] })),
    ...[30, 31, 32, 33].map((id) => gr(id, { genres: [878] })),
  ];
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { topCount: 0, minItems: 4 });
  const genreRow = rows.find((r) => r.kind === 'genre');
  assert.equal(genreRow.title, 'More Sci-Fi');
  // 20-23 were claimed by the "Because you watched" row; only 30-33 remain.
  assert.deepEqual(genreRow.recs.map((r) => r.movie.id), [30, 31, 32, 33]);
});

test('groupIntoRows: "More from <Person>" groups by person seed', () => {
  const ranked = [10, 11, 12, 13].map((id) =>
    gr(id, { seeds: [{ type: 'person', id: 7, name: 'Villeneuve', weight: 2 }] }));
  // No topTitles person 7 and no genre match, so these land in the person row.
  const profile = { ...GROUP_PROFILE, topTitles: [], genres: {} };
  const rows = groupIntoRows(ranked, profile, { topCount: 0, minItems: 4 });
  const personRow = rows.find((r) => r.kind === 'person');
  assert.equal(personRow.title, 'More from Villeneuve');
  assert.equal(personRow.recs.length, 4);
});

test('groupIntoRows: total rows never exceed maxRows', () => {
  const ranked = Array.from({ length: 40 }, (_, i) => gr(2000 + i, { genres: [878] }));
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { maxRows: 2 });
  assert.ok(rows.length <= 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `groupIntoRows is not a function` / import error.

- [ ] **Step 3: Implement `groupIntoRows`**

In `recommendations.js`, add this function immediately after `generateReasons` (before `rankCandidates`):

```js
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
  for (const t of (profile.topTitles || []).slice(0, titleRows)) {
    const kw = new Set(t.keywordIds || []);
    const pp = new Set(t.peopleIds || []);
    const recs = take((r) => (r.movie._seeds || []).some((s) =>
      (s.type === 'keyword' && kw.has(s.id)) || (s.type === 'person' && pp.has(s.id))));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'title', title: `Because you watched ${t.title}`, recs });
    }
  }

  // 3. More <Genre> — top profile genres by weight.
  const topGenres = Object.entries(profile.genres || {})
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all new `groupIntoRows` tests plus the existing suite).

- [ ] **Step 5: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: add groupIntoRows for themed recommendation rows"
```

---

### Task 3: Add `getRecommendationRows()` orchestrator

**Files:**
- Modify: `recommendations.js` (add after `getRecommendations`)

- [ ] **Step 1: Add the orchestrator**

In `recommendations.js`, immediately after the `getRecommendations` function, add:

```js
// Orchestrator for the dedicated Recommendation page. Ranks a larger candidate set
// (the engine already over-fetches, so this adds no network cost) and groups it.
// Returns { rows: [{ kind, title, recs }] }. `now` and `groupOpts` injectable for tests.
export async function getRecommendationRows(items, opts = {}) {
  if (!items || items.length === 0) return { rows: [] };
  const { limit = 60, now = Date.now(), groupOpts = {} } = opts;
  const { profile, recs } = await _pipeline(items, { limit, now });
  return { rows: groupIntoRows(recs, profile, groupOpts) };
}
```

- [ ] **Step 2: Run tests to confirm the module still loads and passes**

Run: `npm test`
Expected: PASS (unchanged set; this is a network-path export exercised manually in the browser, consistent with the existing engine split).

- [ ] **Step 3: Commit**

```bash
git add recommendations.js
git commit -m "feat: add getRecommendationRows orchestrator"
```

---

### Task 4: Add the "Recommended" nav button

**Files:**
- Modify: `index.html:15` (inside `.app-tabs`, after the Movies button)

- [ ] **Step 1: Insert the tab button**

In `index.html`, change:

```html
          <button id="tab-movies" class="app-tab active" data-tab="movies">Movies</button>
          <button id="tab-watched" class="app-tab" data-tab="watched">Watched</button>
```

to:

```html
          <button id="tab-movies" class="app-tab active" data-tab="movies">Movies</button>
          <button id="tab-recommended" class="app-tab" data-tab="recommended">Recommended</button>
          <button id="tab-watched" class="app-tab" data-tab="watched">Watched</button>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add Recommended nav tab button"
```

---

### Task 5: Wire the tab — view, page renderer, and switcher

**Files:**
- Modify: `script.js:3` (import), `script.js:2654` (element ref), `script.js:1872-1904` (extract `buildRecRail`), add page renderer + switcher, `script.js:2664-2806` (deactivate tab in other switchers + listener)

- [ ] **Step 1: Import the new orchestrator**

In `script.js`, change line 3:

```js
import { getRecommendations, clearRecommendationCache, mergeSignalItems } from './recommendations.js';
```

to:

```js
import { getRecommendations, getRecommendationRows, clearRecommendationCache, mergeSignalItems } from './recommendations.js';
```

- [ ] **Step 2: Add the tab element reference**

In `script.js`, after line 2654 (`const tabYouTube = document.getElementById('tab-youtube');`) add:

```js
const tabRecommended = document.getElementById('tab-recommended');
```

- [ ] **Step 3: Extract the shared `buildRecRail` helper**

In `script.js`, add this function immediately before `renderRecommendationsRow` (currently at line 1853, `async function renderRecommendationsRow()`):

```js
// Build one labelled recommendation rail (editorial header + edge-faded scroller of
// rec cards). Shared by the Movies-home teaser row and the dedicated Recommendation page.
function buildRecRail(recs, { kicker, heading, subline }) {
  const section = document.createElement('section');
  section.className = 'rec-rail-section';

  const header = document.createElement('div');
  header.className = 'rec-header';
  if (kicker) {
    const k = document.createElement('span');
    k.className = 'rec-kicker';
    k.textContent = kicker;
    header.appendChild(k);
  }
  const h = document.createElement('h2');
  h.className = 'rec-heading';
  h.textContent = heading;
  header.appendChild(h);
  if (subline) {
    const s = document.createElement('span');
    s.className = 'rec-subline';
    s.textContent = subline;
    header.appendChild(s);
  }
  section.appendChild(header);

  const rail = document.createElement('div');
  rail.className = 'rec-rail';
  const scroller = document.createElement('div');
  scroller.className = 'rec-scroller';
  recs.forEach((rec, index) => scroller.appendChild(createRecommendationCard(rec, index)));
  rail.appendChild(scroller);
  section.appendChild(rail);
  return section;
}
```

- [ ] **Step 4: Make the home row use `buildRecRail`**

In `script.js`, replace the body of `renderRecommendationsRow` from the line `const section = document.createElement('section');` through the final `main.parentNode.insertBefore(section, main);` (the block that builds the section, header, kicker, heading, subline, rail, scroller, and inserts it) with:

```js
  const section = buildRecRail(recs, {
    kicker: 'Curated for you',
    heading: 'Recommended',
    subline: `Tuned to your taste · ${recs.length} picks`,
  });
  section.id = 'recommendations-row';
  section.classList.add('recommendations-row');

  // Insert above the main grid (remove again to close any async double-render race).
  document.getElementById('recommendations-row')?.remove();
  main.parentNode.insertBefore(section, main);
```

(Leave the earlier part of `renderRecommendationsRow` — the `document.getElementById('recommendations-row')?.remove();`, the mode guard, `buildSignalItems()`, the `getRecommendations` call, and the empty/early-returns — unchanged.)

- [ ] **Step 5: Add `renderRecommendationsPage`**

In `script.js`, add immediately after `renderRecommendationsRow`:

```js
// Render the full themed Recommendation page (stacked rails) into #main.
async function renderRecommendationsPage() {
  document.getElementById('recommendations-row')?.remove();
  main.innerHTML = '';
  setLoading(true);
  hideError();

  const items = buildSignalItems();
  if (items.length === 0) {
    setLoading(false);
    main.innerHTML = '<p class="no-results rec-empty">Watch or ★ a few titles to build your recommendations.</p>';
    return;
  }

  let rows = [];
  try {
    ({ rows } = await getRecommendationRows(items, { limit: 60 }));
  } catch (e) {
    console.warn('Recommendation page failed:', e);
    setLoading(false);
    main.innerHTML = '<p class="no-results rec-empty">Couldn’t load recommendations right now. Try again shortly.</p>';
    return;
  }

  setLoading(false);
  if (rows.length === 0) {
    main.innerHTML = '<p class="no-results rec-empty">No recommendations yet — keep watching to tune your taste.</p>';
    return;
  }

  const page = document.createElement('div');
  page.className = 'rec-page';
  rows.forEach((row) => page.appendChild(buildRecRail(row.recs, { heading: row.title })));
  main.innerHTML = '';
  main.appendChild(page);
}
```

- [ ] **Step 6: Add `switchToRecommended` and deactivate the new tab elsewhere**

In `script.js`, add this function next to the other `switchToX` functions (e.g. right before `function switchToMovies()` at line 2664):

```js
function switchToRecommended() {
  currentApp = 'movies';
  isWatchedMode = false;
  isFavoritesMode = false;
  isSearchMode = false;
  isTop250Mode = false;

  document.getElementById('recommendations-row')?.remove();
  tabMovies.classList.remove('active');
  tabRecommended.classList.add('active');
  tabWatched.classList.remove('active');
  tabFavorites.classList.remove('active');
  tabYouTube.classList.remove('active');
  top250Btn.classList.remove('active');

  movieFilters.style.display = 'none';
  youtubeFilters.style.display = 'none';
  movieSearchForm.style.display = 'none';
  youtubeSearchForm.style.display = 'none';
  top250Button.style.display = 'none';

  renderRecommendationsPage();
}
```

Then add `tabRecommended.classList.remove('active');` to each of the four existing switchers, alongside their other `tab*.classList.remove('active')` lines: `switchToMovies`, `switchToYouTube`, `switchToWatched`, `switchToFavorites`.

- [ ] **Step 7: Wire the click listener**

In `script.js`, after line 2805 (`tabYouTube?.addEventListener('click', switchToYouTube);`) add:

```js
tabRecommended?.addEventListener('click', switchToRecommended);
```

- [ ] **Step 8: Sanity-check the module parses (no syntax errors)**

Run: `node --check script.js`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add script.js
git commit -m "feat: wire Recommended tab to themed rec page"
```

---

### Task 6: Style the recommendation page

**Files:**
- Modify: `style.css` (append after the existing `.rec-card` / recommendation block, near line 1234)

- [ ] **Step 1: Add page layout styles**

Append to `style.css` (after the `.rec-scroller::-webkit-scrollbar-thumb` rule, before the `.rec-card` block or anywhere after the recommendation block — placement is cosmetic):

```css
/* ---- Dedicated Recommendation page (stacked rails) ---- */
.rec-page {
  /* Re-declare the gold accent vars the rails/cards reference; on the home row
     these come from .recommendations-row, which the page intentionally omits. */
  --rec-gold: #e9b955;
  --rec-gold-soft: #f3d089;
  --rec-ink: #0f1130;
  max-width: 1500px;
  margin: 1.25rem auto 3rem;
  display: flex;
  flex-direction: column;
  gap: 2.25rem;
}
.rec-rail-section { position: relative; }
.rec-page .rec-header { margin-bottom: 0.85rem; }
.rec-page .rec-heading { font-size: 1.5rem; }
.rec-empty { margin: 3rem auto; text-align: center; color: #b9bce0; }
```

- [ ] **Step 2: Commit**

```bash
git add style.css
git commit -m "style: layout for dedicated recommendation page"
```

---

### Task 7: Manual browser verification

**Files:** none (manual)

- [ ] **Step 1: Serve the app**

Run: `npm start`
Expected: a local server URL (e.g. `http://localhost:3000`).

- [ ] **Step 2: Verify cold-start**

In a fresh profile (no watched/starred history), open the app, click the **Recommended** tab (2nd in nav).
Expected: the empty state text "Watch or ★ a few titles to build your recommendations." and the tab shows active.

- [ ] **Step 3: Verify populated state**

Watch a couple of titles and/or ★ a few, then return to the **Recommended** tab.
Expected: a "Top picks for you" rail first, followed by one or more themed rails ("Because you watched …", "More \<Genre\>", and/or "More from \<Person\>"), each with ≥ 4 cards. Each card shows poster, rank, type tag, a reason line, and a working star toggle; clicking a card opens the player.

- [ ] **Step 4: Verify no regression to the home teaser**

Click the **Movies** tab.
Expected: the existing single "Recommended" teaser row still renders at the top of the Movies home (unchanged behavior), and the `Recommended` tab is no longer active.

- [ ] **Step 5: Verify tab switching cleans up**

Switch among Recommended → Watched → Favorites → YouTube → Movies.
Expected: only one tab is active at a time; the page content swaps correctly; no leftover rec page or duplicate teaser row.

---

## Notes for the implementer

- **Run tests with `npm test`** (`node --test`). The pure functions are the only unit-tested surface; network/orchestration paths (`getRecommendationRows`, `_pipeline`) are verified manually in the browser (Task 7), matching the engine's existing split.
- **`GENRE_NAMES`** is a module-private `Map` already defined at the top of `recommendations.js`; `groupIntoRows` uses it directly for genre-row labels.
- **Cache keys** are now per-limit (`recResultsCache:20`, `recResultsCache:60`). `clearRecommendationCache` clears all of them — keep that invariant if you add more limits.
- **No codegen/orval files** are touched; all five files are hand-written app code.
