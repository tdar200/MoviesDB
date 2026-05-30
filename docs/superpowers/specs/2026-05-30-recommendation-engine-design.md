# Recommendation Engine — Design

**Date:** 2026-05-30
**Status:** Approved

## Goal

Build a content-based recommendation engine that suggests movies/TV shows based
on the user's watched history. Suggestions surface as a "Recommended for you" row
on the Movies home view, each with a short reason badge.

## Decisions (from brainstorming)

- **Engine:** Content-based scoring (transparent, tunable, fits client-side app).
- **Profile signals:** Genres + keywords + cast/crew (richest profile; per-title
  metadata cached permanently in localStorage).
- **UI surface:** A "Recommended for you" horizontal row at the top of the Movies
  home view, above trending.
- **Explainability:** Yes — each card shows up to 2 reason badges.

## Architecture & file boundaries

A new standalone ES module **`recommendations.js`** holds all engine logic.
`script.js` only wires it in (calls it after watched data loads, renders the
returned row). Keeps the large `script.js` from growing a new tangled
responsibility and lets the engine be reasoned about / tested in isolation.

Public interface:

```js
export async function buildTasteProfile(watchedHistory)  // → profile object
export async function getRecommendations(profile, opts)  // → [{ movie, score, reasons[] }]
export function clearRecommendationCache()
```

## Data flow

```
watchedHistory (localStorage)
  → enrichWatchedTitles()   // fetch keywords + credits per title, CACHED in localStorage
  → buildTasteProfile()     // weighted genre / keyword / person vectors
  → generateCandidates()    // TMDB Discover seeded by top genres / keywords / people
  → scoreCandidates()       // weighted overlap vs profile, drop already-watched
  → top N with reasons      // rendered as "Recommended for you" row on Movies home
```

## Taste profile (genres + keywords + cast/crew)

For each watched title fetch:

- **keywords** via `/{type}/{id}/keywords` (new endpoint to add to `config.js`)
- **credits** via the existing `credits` endpoint → top ~5 cast + director

Both cached permanently under a new `recMetaCache` localStorage key — each title
is fetched once ever.

Profile = three weighted maps: `genres{}`, `keywords{}`, `people{}`. Each watched
title contributes weight = **recency decay** (newer `watchedAt` counts more) × a
small rating nudge. Keep top ~15 genres, ~30 keywords, ~20 people.

## Candidate generation & scoring

Candidates come from TMDB **Discover** (already used in the app) seeded by the
profile's top genres, top keywords, and top people — a few pages each, merged &
deduped. Each candidate scores as the weighted overlap of its genres / keywords /
cast against the profile vectors, plus a light popularity/vote prior consistent
with the app's existing scoring sensibilities. Drop any candidate whose `id` is in
watched history. Sort desc, take top ~20.

## Reason badges

Scoring knows which features matched, so each rec carries up to 2 reasons, e.g.
`"Sci-Fi · time-travel"` or `"Because you watched Inception"` (when one strong
title drove the match). Rendered as a small badge on the card.

## UI integration

A "Recommended for you" horizontal row injected at the top of the Movies home
view, above trending, reusing `createMovieCard`. Hidden entirely when watched
history is empty.

- **Cold-start fallback:** show nothing (no awkward empty state); normal trending
  view is unaffected.
- Recomputed on Movies-home load and after a new title is added to watched history.

## Caching & cost control

- `recMetaCache` — per-title keywords/credits, permanent.
- Recommendation results cached for the session (recompute on watched-history
  change) so we don't re-hit Discover on every tab switch.
- Calls batched/sequential-friendly to respect the TMDB rate limiting the app
  already handles.

## Testing

Pure functions (`buildTasteProfile`, `scoreCandidates`, reason generation) are
unit-testable with fixture watched-history objects — no network. Add a small test
harness for the scoring math (the riskiest logic).

## Tuning knobs (confirmed defaults)

- Cold-start shows nothing rather than a generic "popular" row.
- Recommendations row lives only on Movies home.
- Profile caps: ~15 genres / ~30 keywords / ~20 people; top ~20 recs.
