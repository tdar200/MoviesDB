# Recommendation Engine Overhaul — Tracked Follow-ups

**Date:** 2026-06-02
**Status:** Deferred (none block merge — the final integrated review verdict was
READY-WITH-FOLLOWUPS). Captured here so they aren't lost.

The overhaul (collaborative `/recommendations`+`/similar` backbone, mixed movie+TV,
hybrid quality scoring, MMR diversity, Rocchio downvotes, calibrated Netflix-style rows,
cold-start blend) shipped with 158 passing unit tests + two headless harnesses. These are
the known refinements deferred during review.

## 1. `mergeCandidates` dedupes by id alone — movie/TV id collision *(highest value)*

`mergeCandidates` keys by `String(c.id)`. TMDB movie and TV id namespaces are independent,
so a movie and a TV show can share the same numeric id. When both land in the candidate
pool (now likely, since movie+TV are genuinely mixed), the first record wins and the
loser's `media_type`/title/genre_ids are dropped while its `_seeds` are merged onto the
winner — so a card can get a wrong `media_type` and a mis-attributed "Because you liked
‹other-media title›" evidence label.

**Fix:** key by a composite `${media_type}:${id}` in `mergeCandidates`, and make the
`excludeIds` set and the `groupIntoRows` `placed` set composite to match. Touches several
call sites; warrants its own change + tests.

## 2. Exclude watched/basket/downvoted *before* `scorePool` (IDF skew)

`_pipeline` runs `scorePool(candidates, …)` (which computes IDF over the whole pool) and
filters `excludeIds` *after*. Watched/basket/downvoted titles that TMDB re-surfaces as
candidates therefore skew the IDF used for the content-cosine term. Second-order (content
is the 0.4 weight; only re-surfaced excluded titles pollute it), but cleaner to exclude
first.

**Fix:** filter `excludeIds` from `candidates` before `scorePool` in `_pipeline`
(matches the `rankCandidates` ordering).

## 3. Explore-gem reservation can starve the top-genre row (thin catalogs)

`groupIntoRows` reserves "hidden gems" (high vote_average / low vote_count) for the explore
row before the genre block runs. In a thin catalog where most of the top genre's items
qualify as gems, the "More ‹TopGenre›" row can drop below `minItems` and disappear while a
"Hidden gems" row appears. Only bites degenerate small pools; real catalogs have ample
items.

**Fix:** gate the explore reservation so it only claims gems once the top-genre row is
already satisfied (or draw gems from the leftover tail).

## 4. Headless harness function extraction is brace/paren-balanced (fragile)

`rec-dom-harness.mjs` / `rec-css-harness.mjs` extract `createRecommendationCard` /
`buildRecRail` from `script.js` by counting braces/parens without skipping
string/template/comment/regex contents. Balanced today; a future `'}'`-in-a-string edit to
those functions would silently mis-slice. Test infra only.

**Fix:** export the two builders from a small module and import them in the harness, or make
the extractor token-aware.

## Cosmetic / minor

- **Cold-start lead-row label:** on an empty basket, `renderRecommendationsPage` relabels
  row 0 as "Trending to get started", but `groupIntoRows` returns the `top_rated`-sourced
  "Top picks" as row 0 (the real trending row is row 1) — so the lead rail is top-rated
  content labeled "trending."
- **Harness kicker fixture drift:** `rec-dom-harness.mjs`'s inline `REC_ROW_KICKERS` omits
  the `trending` key the real `renderRecommendationsPage` now has.
- **Test-constant duplication:** `META_V` / `META_TTL` in the meta-cache tests are hand-mirrored
  from the source constants; consider exporting + importing them.
- **`META_CACHE_MAX_ENTRIES = 500`** (~1 MB) shares the `localStorage` quota with the session
  results cache; the `QuotaExceededError` catch already degrades gracefully, but watch it.
