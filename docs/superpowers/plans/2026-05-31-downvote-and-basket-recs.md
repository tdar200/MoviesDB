# Downvote + Basket-Primary Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive recommendations from an explicit starred "basket" (basket-primary) and add a 👎 downvote that steers recommendations away from similar content, with watched history used only to hide already-seen titles.

**Architecture:** Build a positive profile from basket items and a negative profile from downvoted items (reusing the existing `buildTasteProfile`), combine them into one **net** profile via a new pure `combineProfiles()` (genres net/can-go-negative; keywords/people net-positive-only), then feed the existing `generateCandidates`/`scoreCandidate`/`rankCandidates` with the net profile and an expanded exclusion set (`watched ∪ downvoted ∪ basket`). The UI adds a `downvotedTitles` store mutually exclusive with stars, a 👎 button beside ★ on every card, a "Basket" tab (relabel) with a Basket|Downvoted toggle.

**Tech Stack:** Vanilla ES modules (browser), `node:test`, no build step. Served via `npx serve .` / `python3 -m http.server`.

---

## File structure

- **`recommendations.js`** (modify) — add `DOWNVOTE_PENALTY` + pure `combineProfiles()`; filter candidate-seed genres to positive; rework `_pipeline`/`getRecommendations`/`getRecommendationRows` to the new `{ basket, downvoted, watchedIds }` input with empty-basket cold-start; rewrite `signalSignature(basket, downvoted)`; remove the now-dead `mergeSignalItems`.
- **`recommendations.test.js`** (modify) — tests for `combineProfiles`, steer-away scoring via net genres, and exclusion.
- **`script.js`** (modify) — `downvotedTitles` store + `toggleDownvote`/`isDownvoted`/`getDownvotedList`; mutual exclusivity in `toggleStar`/`toggleDownvote`; `createDownvoteButton` on all cards + player; `buildSignalItems` new shape; cold-start checks; Basket|Downvoted toggle; live re-render on rec-card toggle.
- **`index.html`** (modify) — relabel the Favorites tab button text to "Basket".
- **`style.css`** (modify) — downvote button states + Basket|Downvoted toggle.

All hand-written app files; no codegen/orval output touched.

---

### Task 1: Add `DOWNVOTE_PENALTY` + pure `combineProfiles()`

**Files:**
- Modify: `recommendations.js` (add near the other tuning constants ~line 17-24, and add `combineProfiles` after `buildTasteProfile`, before `mergeSignalItems`)
- Test: `recommendations.test.js`

- [ ] **Step 1: Write failing tests** — append to `recommendations.test.js`:

```js
import { combineProfiles } from './recommendations.js';

const POS = {
  genres: { '878': 4, '18': 2 },                          // Sci-Fi 4, Drama 2
  keywords: { '9': { name: 'time travel', weight: 3 }, '7': { name: 'space', weight: 1 } },
  people: { '5': { name: 'Nolan', weight: 2 } },
  mediaTypeBias: { movie: 5, tv: 0 },
  topTitles: [{ id: 1, title: 'Inception', weight: 3, genreIds: [878], keywordIds: [9], peopleIds: [5], media_type: 'movie' }],
};
const NEG = {
  genres: { '18': 3, '27': 5 },                           // Drama 3, Horror 5
  keywords: { '9': { name: 'time travel', weight: 1 }, '99': { name: 'gore', weight: 4 } },
  people: { '5': { name: 'Nolan', weight: 1 } },
  mediaTypeBias: { movie: 1, tv: 0 },
  topTitles: [],
};

test('combineProfiles: genres net (pos - penalty*neg), keep negatives so scoring can penalize', () => {
  const c = combineProfiles(POS, NEG, { penalty: 1 });
  assert.equal(c.genres['878'], 4);    // sci-fi: only positive
  assert.equal(c.genres['18'], -1);    // drama: 2 - 3 = -1 (kept negative)
  assert.equal(c.genres['27'], -5);    // horror: 0 - 5 = -5 (downvoted-only genre, kept negative)
});

test('combineProfiles: keywords/people net, drop anything <= 0 so disliked themes never seed', () => {
  const c = combineProfiles(POS, NEG, { penalty: 1 });
  assert.equal(c.keywords['9'].weight, 2);     // time travel: 3 - 1 = 2 (still positive)
  assert.equal(c.keywords['7'].weight, 1);     // space: positive only
  assert.equal(c.keywords['99'], undefined);   // gore: downvoted-only -> dropped
  assert.equal(c.people['5'].weight, 1);       // Nolan: 2 - 1*1 = 1 (kept, positive)
});

test('combineProfiles: penalty scales the negative side', () => {
  const c = combineProfiles(POS, NEG, { penalty: 0.5 });
  assert.equal(c.genres['18'], 0.5);           // 2 - 0.5*3 = 0.5
  assert.equal(c.people['5'].weight, 1.5);     // 2 - 0.5*1 = 1.5 (kept, positive)
});

test('combineProfiles: positive profile passes through topTitles and mediaTypeBias', () => {
  const c = combineProfiles(POS, NEG, { penalty: 1 });
  assert.equal(c.topTitles[0].id, 1);
  assert.deepEqual(c.mediaTypeBias, { movie: 5, tv: 0 });
});

test('combineProfiles: no negative profile is a pass-through of positives', () => {
  const c = combineProfiles(POS, null, { penalty: 1 });
  assert.equal(c.genres['878'], 4);
  assert.equal(c.keywords['9'].weight, 3);
  assert.equal(c.people['5'].weight, 2);
});
```

(Note: in the second test, with `penalty: 1`, Nolan = `2 - 1*1 = 1` > 0, so it is kept — the assertion `c.people['5'] === undefined` is WRONG. Use the corrected test below instead.)

Replace the `people['5']` assertion in the second test with:

```js
  assert.equal(c.people['5'].weight, 1);       // Nolan: 2 - 1*1 = 1 (kept, positive)
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL — `combineProfiles` is not exported.

- [ ] **Step 3: Implement.** In `recommendations.js`, add the penalty constant near the other tuning constants (after `const COVERAGE_WEIGHT = 0.5;`):

```js
const DOWNVOTE_PENALTY = 1.0;       // steer-away strength: a downvoted theme cancels an equal positive one
```

Then add this function immediately after `buildTasteProfile` (before `mergeSignalItems`):

```js
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: PASS (all new `combineProfiles` tests + existing suite).

- [ ] **Step 5: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: add combineProfiles for basket/downvote net profile"
```

---

### Task 2: Steer-away scoring + positive-only genre seeding

**Files:**
- Modify: `recommendations.js` (`generateCandidates` topGenres filter)
- Test: `recommendations.test.js`

`scoreCandidate` already adds `profile.genres[gid] * 0.5` for any non-zero weight, so a **negative** net genre weight already lowers a candidate's score — no change needed there. We add a test pinning that behavior, and we filter candidate-seed genres to positive so we never seed Discover with a disliked genre.

- [ ] **Step 1: Write failing test** — append to `recommendations.test.js`:

```js
test('scoreCandidate: a candidate in a net-negative genre scores below a neutral one', () => {
  const netProfile = {
    genres: { '878': 4, '27': -5 },                 // like Sci-Fi, dislike Horror
    keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const sciFi = { id: 10, genre_ids: [878], _seeds: [], popularity: 10 };
  const horror = { id: 11, genre_ids: [878, 27], _seeds: [], popularity: 10 };
  assert.ok(scoreCandidate(sciFi, netProfile) > scoreCandidate(horror, netProfile),
    'horror-tagged candidate must score lower due to the negative genre');
});
```

- [ ] **Step 2: Run test, verify pass already (scoring) — then verify the seeding filter is still needed**

Run: `npm test`
Expected: the new scoring test PASSES already (negative genre subtracts). Keep it as a regression guard.

- [ ] **Step 3: Filter candidate-seed genres to positive.** In `recommendations.js` `generateCandidates`, change the `topGenres` line:

```js
  const topGenres = Object.entries(profile.genres)
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);
```

to:

```js
  const topGenres = Object.entries(profile.genres)
    .filter(([, w]) => w > 0)                       // never seed Discover with a downvoted genre
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: PASS (full suite).

- [ ] **Step 5: Commit**

```bash
git add recommendations.js recommendations.test.js
git commit -m "feat: steer-away genre scoring + positive-only genre seeding"
```

---

### Task 3: Rework `_pipeline` + orchestrators for basket/downvote input

**Files:**
- Modify: `recommendations.js` (`signalSignature`, `_pipeline`, `getRecommendations`, `getRecommendationRows`; remove `mergeSignalItems`)

- [ ] **Step 1: Rewrite `signalSignature`** to key on basket + downvoted ids. Replace the existing `signalSignature` function with:

```js
// Stable signature of the explicit signal set (basket + downvoted) for session caching.
// Toggling a star or a downvote changes this, busting the cache.
function signalSignature(basket, downvoted) {
  const ids = (arr) => (arr || []).map((m) => m.id).join(',');
  return `b:${ids(basket)}|d:${ids(downvoted)}`;
}
```

- [ ] **Step 2: Rewrite `_pipeline`** to the new input. Replace the `_pipeline` function with:

```js
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
```

- [ ] **Step 3: Update orchestrators** for the empty-basket cold-start. Replace `getRecommendations` and `getRecommendationRows` with:

```js
// Home teaser orchestrator. Empty basket -> no recommendations (basket-primary cold-start).
export async function getRecommendations(input, opts = {}) {
  if (!input || !input.basket || input.basket.length === 0) return [];
  return (await _pipeline(input, opts)).recs;
}

// Recommendation page orchestrator. Empty basket -> no rows.
export async function getRecommendationRows(input, opts = {}) {
  if (!input || !input.basket || input.basket.length === 0) return { rows: [] };
  const { limit = 60, now = Date.now(), groupOpts = {} } = opts;
  const { profile, recs } = await _pipeline(input, { limit, now });
  return { rows: groupIntoRows(recs, profile, groupOpts) };
}
```

- [ ] **Step 4: Remove the now-dead `mergeSignalItems`.** Delete the entire `export function mergeSignalItems(...) { ... }` block (the comment above it too). It is no longer used (Task 7 updates the only caller).

- [ ] **Step 5: Verify parse + tests**

Run: `node --check recommendations.js && npm test`
Expected: `node --check` clean; `npm test` PASS (pure-function suite unaffected; the network path is verified headlessly in Task 11).

- [ ] **Step 6: Commit**

```bash
git add recommendations.js
git commit -m "feat: basket/downvote pipeline with net profile and expanded exclusion"
```

---

### Task 4: `downvotedTitles` store + mutual exclusivity

**Files:**
- Modify: `script.js` (near the starred-store helpers, ~lines 256-367)

- [ ] **Step 1: Add the downvoted store key.** Next to `const STARRED_TITLES_KEY = 'starredTitles';` add:

```js
const DOWNVOTED_TITLES_KEY = 'downvotedTitles';
```

- [ ] **Step 2: Add store helpers.** After `getStarredList()` (~line 367) add:

```js
function getDownvotedStore() {
  try { return JSON.parse(localStorage.getItem(DOWNVOTED_TITLES_KEY) || '{}'); }
  catch { return {}; }
}
function saveDownvotedStore(store) {
  try { localStorage.setItem(DOWNVOTED_TITLES_KEY, JSON.stringify(store)); }
  catch (e) { console.error('downvoted save failed:', e); }
}
function isDownvoted(id) {
  return Object.prototype.hasOwnProperty.call(getDownvotedStore(), id);
}
// Snapshot of a title for a signal store (basket or downvoted). Mirrors the star payload.
function signalSnapshot(movie) {
  return {
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
  };
}
// Toggle downvote for a movie; returns the new downvoted state. Mutually exclusive with star.
function toggleDownvote(movie) {
  const store = getDownvotedStore();
  if (Object.prototype.hasOwnProperty.call(store, movie.id)) {
    delete store[movie.id];
    saveDownvotedStore(store);
    clearRecommendationCache();
    return false;
  }
  // Remove from basket if present — a title is in at most one of {basket, downvoted}.
  const starred = getStarredStore();
  if (Object.prototype.hasOwnProperty.call(starred, movie.id)) {
    delete starred[movie.id];
    saveStarredStore(starred);
  }
  store[movie.id] = { ...signalSnapshot(movie), downvotedAt: Date.now() };
  saveDownvotedStore(store);
  clearRecommendationCache();
  return true;
}
function getDownvotedList() {
  const store = getDownvotedStore();
  return Object.values(store).sort((a, b) => (b.downvotedAt || 0) - (a.downvotedAt || 0));
}
```

- [ ] **Step 3: Make `toggleStar` clear any downvote.** In `toggleStar`, in the branch that ADDS a star (after the `if (already starred) { delete; return false }` block, before `store[movie.id] = {...}`), add:

```js
  // Remove from downvoted if present — mutually exclusive with the basket.
  const downvoted = getDownvotedStore();
  if (Object.prototype.hasOwnProperty.call(downvoted, movie.id)) {
    delete downvoted[movie.id];
    saveDownvotedStore(downvoted);
  }
```

- [ ] **Step 4: Verify parse**

Run: `node --check script.js`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add script.js
git commit -m "feat: downvotedTitles store with star/downvote mutual exclusivity"
```

---

### Task 5: `createDownvoteButton` + place beside ★ on all cards and player

**Files:**
- Modify: `script.js` (`createStarButton` neighbor; `createMovieCard`, `createRecommendationCard`, `openPlayer` player-header)

- [ ] **Step 1: Add the button factory + SVGs.** After `createStarButton` add:

```js
const DOWN_OUTLINE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 14V3H4v11h3zm0 0l4 7c1.1 0 2-.9 2-2v-4h5.5c.8 0 1.4-.7 1.3-1.5l-1-6A1.5 1.5 0 0 0 17.3 9H13V5"/></svg>';
const DOWN_FILLED_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M22 4h-3v11h3V4zM2 14.5C2 15.3 2.7 16 3.5 16H10l-1 4.5c-.2.9.5 1.5 1.3 1.5.5 0 1-.3 1.3-.8L16 14V4H4.2c-.7 0-1.3.5-1.5 1.2l-2 8.3c0 .3 0 .7.3 1z"/></svg>';

// A downvote toggle bound to a movie. Mutually exclusive with the star; stops click
// propagation so it never triggers play. Re-syncs the sibling star button after toggling.
function createDownvoteButton(movie) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'down-btn';
  const sync = () => {
    const on = isDownvoted(movie.id);
    btn.classList.toggle('downvoted', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Remove downvote' : 'Not interested (downvote)');
    btn.title = on ? 'Remove downvote' : 'Not interested';
    btn.innerHTML = on ? DOWN_FILLED_SVG : DOWN_OUTLINE_SVG;
  };
  sync();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDownvote(movie);
    sync();
    // Re-sync the sibling star button (mutual exclusivity may have un-starred it).
    const star = btn.parentElement?.querySelector('.star-btn');
    if (star) star.dispatchEvent(new CustomEvent('resync'));
    onSignalChanged();
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  });
  return btn;
}
```

- [ ] **Step 2: Make the star button re-syncable + notify on change.** In `createStarButton`, after `sync();` (the initial call) add a listener, and in its click handler call `onSignalChanged()`. Concretely, inside `createStarButton`, change the end of the function from:

```js
  sync();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStar(movie);
    sync();
    if (isFavoritesMode) loadFavorites(); // un-starring removes it from the favorites grid
  });
```

to:

```js
  sync();
  btn.addEventListener('resync', sync); // re-render when a sibling downvote toggles state
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStar(movie);
    sync();
    // Re-sync the sibling downvote button (mutual exclusivity may have cleared it).
    const down = btn.parentElement?.querySelector('.down-btn');
    if (down) down.dispatchEvent(new CustomEvent('resync'));
    if (isFavoritesMode) loadFavorites();
    onSignalChanged();
  });
```

And in `createDownvoteButton`, the `down-btn` also needs a `resync` listener — add after its `sync();`:

```js
  btn.addEventListener('resync', sync);
```

- [ ] **Step 3: Add the `onSignalChanged` hook** (re-render the current rec view so toggles apply live). Add this function near `renderRecommendationsPage`:

```js
// Called after any basket/downvote toggle. The stores already busted the rec cache;
// re-render whichever recommendation surface is currently showing so the change applies.
function onSignalChanged() {
  if (tabRecommended.classList.contains('active')) {
    renderRecommendationsPage();
  } else if (currentApp === 'movies' && !isWatchedMode && !isFavoritesMode && !isSearchMode && !isTop250Mode) {
    renderRecommendationsRow();
  }
}
```

- [ ] **Step 4: Place the downvote button next to the star on the recommendation card.** In `createRecommendationCard`, find `poster.appendChild(createStarButton(movie));` and change it to:

```js
  poster.appendChild(createStarButton(movie));
  poster.appendChild(createDownvoteButton(movie));
```

- [ ] **Step 5: Place it on browse cards.** In `createMovieCard`, find `imageDiv.appendChild(createStarButton(movie));` and change it to:

```js
  imageDiv.appendChild(createStarButton(movie));
  imageDiv.appendChild(createDownvoteButton(movie));
```

- [ ] **Step 6: Add the player-header downvote button to the markup.** In `index.html`, find (line ~273):

```html
            <button id="player-star" type="button" class="star-btn player-star" aria-label="Add to favorites" title="Add to favorites"></button>
```

and add directly after it:

```html
            <button id="player-down" type="button" class="down-btn player-down" aria-label="Not interested (downvote)" title="Not interested"></button>
```

- [ ] **Step 7: Reference and wire the player downvote button.** In `script.js`, after `const playerStarBtn = document.getElementById('player-star');` (~line 55) add:

```js
const playerDownBtn = document.getElementById('player-down');
```

Then in `openPlayer`, the block that wires `playerStarBtn` (the `if (playerStarBtn) { const syncPlayerStar = () => {...}; syncPlayerStar(); playerStarBtn.onclick = ...; }`) — replace that whole block with one that wires BOTH buttons and keeps them mutually exclusive:

```js
  // Sync the player-header star + downvote to this title, kept mutually exclusive.
  if (playerStarBtn) {
    const syncPlayerStar = () => {
      const on = isStarred(movie.id);
      playerStarBtn.classList.toggle('starred', on);
      playerStarBtn.setAttribute('aria-pressed', String(on));
      playerStarBtn.title = on ? 'Remove from favorites' : 'Add to favorites';
      playerStarBtn.innerHTML = on ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
    };
    const syncPlayerDown = () => {
      if (!playerDownBtn) return;
      const on = isDownvoted(movie.id);
      playerDownBtn.classList.toggle('downvoted', on);
      playerDownBtn.setAttribute('aria-pressed', String(on));
      playerDownBtn.title = on ? 'Remove downvote' : 'Not interested';
      playerDownBtn.innerHTML = on ? DOWN_FILLED_SVG : DOWN_OUTLINE_SVG;
    };
    syncPlayerStar();
    syncPlayerDown();
    playerStarBtn.onclick = (e) => { e.stopPropagation(); toggleStar(movie); syncPlayerStar(); syncPlayerDown(); onSignalChanged(); };
    playerStarBtn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); };
    if (playerDownBtn) {
      playerDownBtn.onclick = (e) => { e.stopPropagation(); toggleDownvote(movie); syncPlayerStar(); syncPlayerDown(); onSignalChanged(); };
      playerDownBtn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); };
    }
  }
```

- [ ] **Step 8: Verify parse**

Run: `node --check script.js`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add script.js index.html
git commit -m "feat: downvote button beside star on cards + player + live rec refresh"
```

---

### Task 6: New `buildSignalItems` shape + cold-start checks

**Files:**
- Modify: `script.js` (`buildSignalItems`, import line, `renderRecommendationsRow`, `renderRecommendationsPage`)

- [ ] **Step 1: Drop the dead import.** Change line 3 from:

```js
import { getRecommendations, getRecommendationRows, clearRecommendationCache, mergeSignalItems } from './recommendations.js';
```

to:

```js
import { getRecommendations, getRecommendationRows, clearRecommendationCache } from './recommendations.js';
```

- [ ] **Step 2: Rewrite `buildSignalItems`** to the engine's new input shape:

```js
// Assemble the explicit signal input the engine consumes: the starred basket (positive),
// the downvoted set (negative steer), and watched ids (exclude-only).
function buildSignalItems() {
  return {
    basket: getStarredList(),
    downvoted: getDownvotedList(),
    watchedIds: getWatchedHistory().map((m) => m.id),
  };
}
```

- [ ] **Step 3: Update the home-row cold-start check.** In `renderRecommendationsRow`, change:

```js
  const items = buildSignalItems();
  if (items.length === 0) return; // cold-start: show nothing
```

to:

```js
  const items = buildSignalItems();
  if (items.basket.length === 0) return; // basket-primary cold-start: nothing to recommend
```

- [ ] **Step 4: Update the page cold-start check + empty-state copy.** In `renderRecommendationsPage`, change:

```js
  const items = buildSignalItems();
  if (items.length === 0) {
    setLoading(false);
    main.innerHTML = '<p class="no-results rec-empty">Watch or ★ a few titles to build your recommendations.</p>';
    return;
  }
```

to:

```js
  const items = buildSignalItems();
  if (items.basket.length === 0) {
    setLoading(false);
    main.innerHTML = '<p class="no-results rec-empty">Add titles to your basket with ★ to build your recommendations.</p>';
    return;
  }
```

- [ ] **Step 5: Verify parse + tests**

Run: `node --check script.js && npm test`
Expected: clean; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add script.js
git commit -m "feat: basket/downvote signal assembly + basket cold-start"
```

---

### Task 7: Rename Favorites → Basket + Basket|Downvoted toggle

**Files:**
- Modify: `index.html` (tab label), `script.js` (`loadFavorites` → render basket or downvoted via a sub-toggle)

- [ ] **Step 1: Relabel the tab.** In `index.html`, change:

```html
          <button id="tab-favorites" class="app-tab" data-tab="favorites">Favorites</button>
```

to:

```html
          <button id="tab-favorites" class="app-tab" data-tab="favorites">Basket</button>
```

- [ ] **Step 2: Add a basket sub-view state.** Near the top-level state vars in `script.js` (e.g. by `let isFavoritesMode = false;`) add:

```js
let basketView = 'basket'; // 'basket' | 'downvoted' — which list the Basket tab shows
```

- [ ] **Step 3: Rewrite `loadFavorites`** to render the chosen list with a segmented toggle header. Replace the `loadFavorites` function body with:

```js
function loadFavorites() {
  setLoading(true);
  hideError();

  const basket = getStarredList();
  const downvoted = getDownvotedList();
  const list = basketView === 'downvoted' ? downvoted : basket;

  main.innerHTML = '';

  // Segmented toggle: Basket | Downvoted (N)
  const seg = document.createElement('div');
  seg.className = 'basket-toggle';
  const mkBtn = (key, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'basket-seg' + (basketView === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { basketView = key; loadFavorites(); });
    return b;
  };
  seg.appendChild(mkBtn('basket', `Basket (${basket.length})`));
  seg.appendChild(mkBtn('downvoted', `Downvoted (${downvoted.length})`));
  main.appendChild(seg);

  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'no-results';
    empty.textContent = basketView === 'downvoted'
      ? 'No downvoted titles. Tap 👎 on any title to steer recommendations away from it.'
      : 'Your basket is empty. Tap ★ on any title to seed recommendations.';
    main.appendChild(empty);
    allMovies = []; filteredMovies = []; displayedCount = 0; hasMorePages = false;
    setLoading(false);
    return;
  }

  allMovies = list;
  filteredMovies = list;
  displayedCount = 0;
  hasMorePages = false;

  const fragment = document.createDocumentFragment();
  list.forEach((movie, index) => fragment.appendChild(createMovieCard(movie, index)));
  main.appendChild(fragment);
  displayedCount = list.length;

  setLoading(false);
}
```

- [ ] **Step 4: Verify parse**

Run: `node --check script.js`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add index.html script.js
git commit -m "feat: Basket tab label + Basket|Downvoted toggle"
```

---

### Task 8: Styles for downvote button + Basket toggle

**Files:**
- Modify: `style.css` (after the `.star-btn` rules)

- [ ] **Step 1: Add styles.** Append after the `.player-star { ... }` block (end of the star-toggle section):

```css
/* Downvote toggle — sits beside the star on cards. */
.down-btn {
  position: absolute;
  top: 0.45rem;
  left: 2.7rem;            /* to the right of the star (which is at left: 0.5rem) */
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
.movie:hover .down-btn,
.rec-card:hover .down-btn,
.down-btn:focus-visible,
.down-btn.downvoted {
  opacity: 1;
  transform: scale(1);
}
.down-btn.downvoted { color: #ff6b6b; background: rgba(8, 9, 26, 0.75); }
.down-btn:hover { color: #ff9b9b; }
/* On the rec card the star is at top-right; offset the downvote to its left. */
.rec-card .down-btn { left: auto; right: 2.7rem; }
/* Player-header downvote sits inline beside the title star, always visible. */
.player-down {
  position: static;
  opacity: 1;
  transform: none;
  width: 34px;
  height: 34px;
  background: rgba(255, 255, 255, 0.08);
}

/* Basket | Downvoted segmented toggle. */
.basket-toggle {
  display: flex;
  gap: 0.4rem;
  margin: 0 auto 1.25rem;
  max-width: 1500px;
  padding: 0 0.4rem;
}
.basket-seg {
  padding: 0.45rem 0.9rem;
  border-radius: 99px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
  color: #b9bce0;
  font-size: 0.82rem;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.basket-seg.active { background: #e9b955; color: #1a1a2e; border-color: transparent; font-weight: 600; }
```

- [ ] **Step 2: Commit**

```bash
git add style.css
git commit -m "style: downvote button + Basket/Downvoted toggle"
```

---

### Task 9: Headless end-to-end verification

**Files:** none (manual / throwaway harness)

- [ ] **Step 1: Serve the app**

Run: `python3 -m http.server 8137` (background) and confirm `curl -s -o /dev/null -w "%{http_code}" http://localhost:8137/index.html` prints `200`.

- [ ] **Step 2: Write a puppeteer harness** `smoke-basket.mjs` that, using `executablePath: '/usr/bin/google-chrome'`, headless, `--no-sandbox`, verifies:
  1. Fresh profile, open Recommended tab → empty state mentions "basket".
  2. On the Movies grid, click a card's ★ (`.movie .star-btn`) → it enters the basket; open Recommended tab → rails render (basket-primary recs appear). Read `localStorage.starredTitles` has 1 entry.
  3. Click that same card's 👎 (`.movie .down-btn`) → `localStorage.starredTitles` now empty AND `localStorage.downvotedTitles` has 1 entry (mutual exclusivity).
  4. Open the Basket tab, click the "Downvoted (1)" segment → the downvoted title shows.

Example assertions to include:

```js
const starred = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('starredTitles') || '{}')).length);
const downv  = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('downvotedTitles') || '{}')).length);
```

- [ ] **Step 3: Run it**

Run: `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node smoke-basket.mjs`
Expected: all checks PASS (mutual exclusivity holds, basket-primary recs render, empty-basket shows the basket prompt).

- [ ] **Step 4: Clean up the harness and stop the server**

```bash
rm -f smoke-basket.mjs
```
Stop the background `http.server`.

- [ ] **Step 5: Commit (if anything changed during verification)** — otherwise nothing to commit.

---

## Notes for the implementer

- **Run tests with `npm test`** (`node --test`, globs `*.test.js`). Pure functions (`combineProfiles`, `scoreCandidate`, etc.) are the unit-tested surface; the network/orchestration path and all DOM wiring are verified headlessly (Task 9).
- **Negative steering is genre-level + theme-suppression.** TMDB Discover candidates carry `genre_ids` but not keywords/people, so a downvoted *genre* actively penalizes candidates (net-negative weight in scoring), while downvoted *keywords/people* are removed from the positive seed set (so disliked themes never pull in content). Exact downvoted titles are always excluded. This is the faithful "steer away" given the available candidate data.
- **Mutual exclusivity** lives in `toggleStar`/`toggleDownvote` (each clears the other store) and is reflected live by the sibling-button `resync` CustomEvent.
- **Basket-primary cold-start:** an empty `starredTitles` store yields no recommendations on both surfaces.
- **No codegen/orval files** are touched; all changes are hand-written app code.
