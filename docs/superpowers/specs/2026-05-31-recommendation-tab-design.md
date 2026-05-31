# Recommendation Tab — Design

**Date:** 2026-05-31
**Status:** Approved

## Goal

Promote movie recommendations from the single "Recommended for you" teaser row on
the Movies home into a **dedicated `Recommended` tab** — a full, Netflix-style page
of themed horizontal rails. The existing home-row teaser stays. YouTube
recommendations are explicitly **out of scope** here; the data source for YouTube
is undecided and will be tackled separately. This design keeps the engine
source-agnostic enough that a YouTube section can be added later, but builds only
the movies experience now.

## Decisions (from brainstorming)

- **Scope:** Movies only, full page. (YouTube added later, separate effort.)
- **Approach:** Reuse the tested content-based engine; add a thin pure grouping
  layer plus a view. No new TMDB endpoints, no extra network cost.
- **Layout:** Multiple themed horizontal rails (Netflix-style).
- **Home row:** Keep both — Movies home keeps its teaser row; the tab is the full view.
- **Row themes:** Top picks overall, "Because you watched X", "More \<Genre\>",
  "More from \<Person\>".
- **Nav order:** `Movies | Recommended | Watched | Favorites | YouTube | Test`
  (2nd, after Movies).

## Architecture & file boundaries

Four files touched, each staying in its existing lane:

- **`recommendations.js`** — extract the current orchestration in
  `getRecommendations()` into an internal `_pipeline(items, opts)` →
  `{ profile, recs }` so the (already-computed) taste profile becomes reusable.
  `getRecommendations()` keeps its **exact current signature and behavior** layered
  on top. Add one new **pure** function `groupIntoRows(ranked, profile, opts)` and a
  new orchestrator `getRecommendationRows(items, opts)` → `{ rows }`.
- **`script.js`** — add `switchToRecommended()` (mirrors `switchToFavorites`), wire
  the new tab button + element ref + listener, factor the home row's rail markup
  into a shared `buildRecRail(recs, headerOpts)` helper used by **both** the home
  teaser and the new page, and add `renderRecommendationsPage()`.
- **`index.html`** — one new nav button (`#tab-recommended`, `data-tab="recommended"`)
  inserted after `#tab-movies`.
- **`style.css`** — `.rec-page` stacked-rails layout, per-rail section headers, and
  an empty state, reusing the existing `.rec-*`, `.rec-rail`, `.rec-scroller`,
  `.rec-card` classes.

### Public interface (recommendations.js)

```js
// unchanged — home teaser row still calls this
export async function getRecommendations(items, opts) // → [{ movie, score, reasons }]

// new — dedicated tab
export async function getRecommendationRows(items, opts) // → { rows: [Row] }
export function groupIntoRows(ranked, profile, opts)     // pure → [Row]
```

`Row` shape:

```js
{ kind: 'top' | 'title' | 'genre' | 'person',
  title: 'Because you watched Inception',
  recs: [{ movie, score, reasons }] }
```

## Data flow

```
buildSignalItems()  → getRecommendationRows(items, { limit: 60 })
   → _pipeline()    → { profile, recs }       // enrich → profile → candidates → rank 60
   → groupIntoRows(recs, profile)             // pure grouping into themed rows
   → renderRecommendationsPage()              // stacked rec-rails into #main
```

The engine already over-fetches (~130 raw candidates per run) and discards most, so
ranking 60 instead of 20 adds **zero** extra network calls. `_pipeline` reuses the
existing per-title `recMetaCache` (permanent) and session results cache.

## groupIntoRows — grouping logic (the one new piece of logic)

Pure function. Input: `ranked` = `[{ movie, score, reasons }]` (each `movie` carries
`_seeds` provenance and `genre_ids`), `profile` (with `genres`, `people`,
`topTitles`), and `opts` (caps below). Output: ordered `Row[]`.

Rows are produced in this order:

1. **Top picks for you** (`kind: 'top'`) — the top ~20 recs by score. Always first.
2. **Because you watched X** (`kind: 'title'`) — up to **3** rows, one per strongest
   contributing watched/starred title (ranked by `profile.topTitles` weight). A rec
   joins title T's row when its `_seeds` share a keyword or person id with T — the
   same provenance test `contributingTitleCount` already implements.
3. **More \<Genre\>** (`kind: 'genre'`) — up to **3** rows for the top profile genres.
   A rec joins by its single strongest matched profile genre.
4. **More from \<Person\>** (`kind: 'person'`) — up to **2** rows for top
   cast/directors. A rec joins when a person `_seed` matches.

**Dedup rule:** a movie may appear in *Top picks* **and** in *at most one* themed row.
Among themed rows, the first row (by the order above) to claim a movie wins; later
themed rows skip it. This keeps rows distinct while letting Top picks mirror the best
of everything.

**Min-items rule:** any row with fewer than **4** recs is dropped (no thin rows).

**Overall cap:** at most **10** rows total. All caps live in `opts` with the defaults
above so they're easy to tune and to drive from tests.

## UI integration

- New `Recommended` tab, 2nd in the nav. `switchToRecommended()` follows the
  `switchToFavorites` pattern: sets active classes, hides movie/YouTube filter bars
  and search forms and the Top-250 button, removes the home `#recommendations-row`,
  then calls `renderRecommendationsPage()`.
- `renderRecommendationsPage()` builds signal items, calls `getRecommendationRows`,
  and renders each `Row` as a labelled rail via the shared `buildRecRail` helper
  (reusing `createRecommendationCard`). Cards keep their existing behavior: poster,
  rank, type tag, reason "because" line, star toggle, click → `openPlayer`.
- The other `switchToX()` functions must reset/hide the page when navigating away
  (the page renders into `#main`, so the normal content load already replaces it; no
  special teardown beyond the existing `#recommendations-row` removal).

## Cold-start, loading, refresh

- **Empty signals** (no watched/starred history) → the page shows an explanatory
  empty state: "Watch or ★ a few titles to build your recommendations." This differs
  from the home row, which silently hides — the user navigated to this tab on purpose,
  so an empty page needs an explanation.
- **Loading** → reuse `setLoading()` while enrichment/candidate fetches resolve.
- **Refresh** → recomputed on each tab activation; the engine's existing
  signature-keyed session cache makes re-entry instant unless signals changed. No
  explicit refresh button (YAGNI).

## Caching

Reuses the engine's two existing caches unchanged: `recMetaCache` (per-title
keywords/credits, permanent) and the session results cache. Because the page ranks
to a larger `limit` (60) than the home row (20), the session cache key must include
the limit (or mode) so the two surfaces don't collide. `_pipeline` owns this.

## Testing

Add `groupIntoRows` unit tests to `recommendations.test.js` with fixture
ranked-lists + profiles (no network):

- Top-picks row is first and capped at ~20.
- "Because you watched X" rows group by shared keyword/person seed; capped at 3.
- "More \<Genre\>" rows group by strongest matched genre; capped at 3.
- "More from \<Person\>" rows group by person seed; capped at 2.
- Rows with < 4 recs are dropped.
- A movie appears in at most one themed row (dedup), but may also be in Top picks.
- Total rows never exceed 10.

The network/orchestration path (`getRecommendationRows`, `_pipeline`) is exercised
manually in the browser, consistent with the existing engine's split.

## Out of scope

- YouTube recommendations and the YouTube data-source decision (separate effort).
- Filters/sorting controls on the page (could be a later enhancement).
- Any change to the home teaser row's behavior beyond sharing the `buildRecRail` helper.
