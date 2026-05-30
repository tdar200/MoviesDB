# Engagement Signals, Favorites & Collection-Wide Recommendations — Design

**Date:** 2026-05-31
**Status:** Approved

## Goal

Make recommendations reflect *how much* the user engages with a title (not just
that they opened it), let the user explicitly **star** favorites as strong taste
anchors, surface stars in a dedicated **Favorites** tab, and make ranking +
explanations reflect the user's **whole collection** rather than a single title.

## Key constraint (grounding)

Playback happens inside **cross-origin third-party iframes** (videasy, vidfast,
etc.). The parent page **cannot read real playback progress/percentage** from
them. "Time spent watching" is therefore approximated by measurable proxies:
**dwell time** (player-modal open duration) and **TV episode depth**.

## Decisions (from brainstorming)

- **Engagement signal:** dwell time + episode depth, with sane caps.
- **Stars:** strong, **decay-proof** taste anchors; toggle on cards + in player.
- **Reasons:** **hybrid** — lead with a taste theme, add a dominant title when one stands out.
- **Ranking:** explicitly reward candidates aligned with *many* of the user's titles.
- **Favorites tab:** added — a dedicated view of starred titles.

---

## 1. New signal stores (localStorage)

Both follow the existing `watchedHistory` storage pattern in `script.js` and
degrade gracefully (missing data → neutral defaults).

- **`titleEngagement`** — `{ [id]: { dwellMs, episodes, opens, lastAt } }`
  - `dwellMs`: accumulated, capped engagement time.
  - `episodes`: count of distinct TV episodes reached.
  - `opens`: number of times the title was opened.
- **`starredTitles`** — `{ [id]: { ...movie, starredAt } }`
  - Stores the full movie object (id, media_type, genre_ids, vote_average,
    title/name, poster_path, etc.) so a starred-but-never-watched title can both
    render in the Favorites tab and shape the taste profile.

## 2. Capturing engagement (dwell + episode depth)

In `script.js` (DOM/timer code):

- **On `openPlayer(movie)`:** set `playerOpenedAt = Date.now()`, reset
  `playerHiddenMs = 0`; increment `titleEngagement[id].opens`.
- **`visibilitychange` handler:** while the player modal is open and the tab is
  hidden, accumulate hidden time so it can be **subtracted** (pause accumulation
  while the tab is backgrounded).
- **On `closePlayer()` and a `pagehide` flush** (covers tab close):
  `dwell = now − playerOpenedAt − playerHiddenMs`, clamped to ≥ 0 and **capped
  per session at ~3h** (`SESSION_DWELL_CAP_MS`). Add to
  `titleEngagement[id].dwellMs` (also cap the stored total at a ceiling so one
  title can't dominate, e.g. 24h). Then `clearRecommendationCache()`.
- **Episode depth (TV):** in the existing episode-change path that calls
  `saveWatchProgress(showId, season, episode)`, also record the distinct
  `season:episode` key into `titleEngagement[id]` and set `episodes` to the
  distinct count. Bingeing many episodes raises engagement.

Capture failures are wrapped in try/catch and never block playback.

## 3. New weighting formula (pure, `recommendations.js`)

Today each item's profile weight = `recencyWeight × ratingNudge`. New:

```
weight = recencyDecay × ratingNudge × engagementBoost × starBonus
```

- **`engagementBoost(dwellMs, episodes)`** ∈ `[0.4 … 2.5]` (`ENGAGEMENT_MIN` /
  `ENGAGEMENT_MAX`):
  - Quick bail (`dwellMs < QUICK_BAIL_MS`, ~2 min) → trends toward `0.4`
    (downweights sampled-and-dropped titles).
  - Long dwell and/or many episodes → trends toward `2.5`.
  - Items with **no** engagement record (legacy/unplayed) → neutral `1.0`.
- **Stars are decay-proof anchors:**
  - For a starred item, `recencyDecay` is forced to `1.0` (no time decay).
  - A `starBonus` of `STAR_BONUS = 2.5` multiplies the weight.
  - Non-starred items use `starBonus = 1.0` and normal `recencyWeight`.
- **Input union:** the profile is built from `watched ∪ starred`. Each item is
  annotated by the caller with `_engagement` (`{ dwellMs, episodes, opens }` or
  null) and `_starred` (boolean). `buildTasteProfile` reads these.

## 4. Collection-wide ranking

- **Seed provenance → titles:** when seeds are generated, each seed records which
  watched/starred title(s) contributed it (derivable from `profile.topTitles`'
  `keywordIds`/`peopleIds`/`genreIds`). A candidate's accumulated `_seeds`
  therefore map back to a set of distinct contributing titles.
- **Coverage bonus** in `scoreCandidate`: multiply the base score by
  `1 + COVERAGE_WEIGHT × log2(1 + distinctContributors)` (`COVERAGE_WEIGHT` ~0.5).
  A candidate aligned with 6 of the user's titles outranks one matching a single
  title, all else equal.
- Base scoring (seed-weight sum + genre overlap + popularity prior) is unchanged
  otherwise.

## 5. Hybrid reasons (`recommendations.js`)

`generateReasons(candidate, profile)` returns up to 2 strings:

- **Lead with a taste theme** built from the candidate's top matched profile
  dimensions: top matched genre(s) and/or strongest matched person/keyword —
  e.g. `"Matches your love of Sci-Fi & Christopher Nolan"`,
  `"From your most-watched genre: Thriller"`.
- **Add a dominant title** when one contributing title supplies the majority of
  the matched seed weight: append `"esp. <Title>"` —
  e.g. `"Your Crime taste · esp. Breaking Bad"`.
- Falls back to a genre-only theme when person/keyword signal is weak, and to
  `"Picked for your taste"` if nothing matches.

## 6. Star UI

- A **gold star toggle** on each movie card (browse grid, recommendations rail,
  Watched grid, Favorites grid) and in the **player header**. Filled gold when
  starred, outline when not.
- Toggling updates `starredTitles`, re-renders the star state, and calls
  `clearRecommendationCache()`. Clicking the star does **not** trigger
  play (stops propagation).

## 7. Favorites tab

- A new **`Favorites`** tab in the header tab bar, next to `Watched`.
- `switchToFavorites()` mirrors `switchToWatched()` (hides filters, sets a mode
  flag `isFavoritesMode`, removes the recommendations rail) and calls
  `loadFavorites()`.
- `loadFavorites()` mirrors `loadWatchedHistory()`: reads `starredTitles`
  (sorted by `starredAt` desc), renders cards via `createMovieCard`, and shows an
  empty state (`"No favorites yet. Tap the ★ on any title to add it."`) when empty.
- Unstarring from the Favorites grid removes the card (re-render).
- The recommendations rail is suppressed in Favorites mode (added to the same
  guard used for Watched/YouTube; the existing `loadTrending` paths already
  remove the rail when leaving Movies).

## 8. Engine entry-point change

`getRecommendations(items, opts)` accepts a **unified annotated input** —
`watched ∪ starred`, each item carrying `_engagement` and `_starred`. The caller
(`script.js`) assembles this from the three stores. Candidate exclusion drops the
union of watched **and** starred ids. Session cache signature includes star and
engagement state so toggling a star or finishing a long watch busts the cache.

## 9. Boundaries & testing

- **Pure logic** in `recommendations.js` (unit-tested with fixtures, no
  network/DOM): `engagementBoost`, the extended `buildTasteProfile` weighting,
  the `scoreCandidate` coverage bonus, and the hybrid `generateReasons`.
- **Capture, storage, star UI, Favorites tab** in `script.js` (timers,
  visibility, DOM): manually verified in the browser, wrapped in try/catch.
- Existing 8 engine tests must continue to pass; new tests cover the new pure
  behavior. Legacy watched-history items (no engagement/star fields) must produce
  the same results as before (neutral defaults).

## Tunable constants (confirmed defaults)

| Constant | Value | Meaning |
|---|---|---|
| `ENGAGEMENT_MIN` / `ENGAGEMENT_MAX` | 0.4 / 2.5 | engagement boost range |
| `QUICK_BAIL_MS` | ~120000 (2 min) | dwell below this trends to min boost |
| `SESSION_DWELL_CAP_MS` | ~10800000 (3 h) | per-session dwell cap |
| `STAR_BONUS` | 2.5 | multiplier for starred items |
| `COVERAGE_WEIGHT` | ~0.5 | strength of collection-breadth bonus |
| Profile caps | 15 genres / 30 keywords / 20 people / top 20 recs | unchanged |
