# Recommendation Engine Optimization — Design

**Date:** 2026-06-02
**Status:** Approved
**Builds on:** [2026-06-02-recommendation-engine-overhaul-design.md](2026-06-02-recommendation-engine-overhaul-design.md)
and closes items in [2026-06-02-recommendation-engine-overhaul-followups.md](2026-06-02-recommendation-engine-overhaul-followups.md).

## Goal

Make the just-shipped recommendation engine "fully optimized" — faster, cheaper (fewer TMDB
calls), feel instant, and pick better — **without regressing relevance**. Driven by a 4-dimension
audit (network, compute, perceived-perf, relevance) measured against the merged code. Appetite:
**Balanced** — take every free/near-free win; trim breadth only where it provably doesn't cost picks.

Hard constraints unchanged: browser-only, vanilla ES modules, no backend, only TMDB + localStorage.
Pure functions stay unit-tested; network/UX verified via the headless harnesses + manual.

## Measured baseline (typical 5-seed basket, cold cache)

- **~70 API calls/refresh**: enrich **10 (redundant)** + per-seed appendDetail 5 + Discover **52** + filler 3.
- **~3.6s pure dead time** from three hand-rolled `BATCH + delay(300)` loops re-throttling a queue that
  already caps concurrency at 6 (and starving it — it never sees >6 URLs, so it can't pipeline).
- **Time-to-first-row = full fan-out**: the page awaits the entire pipeline behind a blank `#main`+spinner.
- **A single ★/👎 click** wipes the whole results cache + re-runs the entire pipeline + rebuilds every row.
- **Cold-start scores are all exactly 0** (empty profile → base 0 → quality/recency multipliers annihilated).

## Plan — 3 phases

Phases are ordered so the cheap, high-leverage, near-zero-risk wins land first. Relevance changes in
Phase 3 ship **one at a time behind the existing `recommendations.test.js` regression assertions** and an
intra-list-diversity-vs-relevance guardrail.

### Phase 1 — Speed & efficiency (network + compute; all S/M, ~zero relevance risk)

1. **Delete the hand-rolled `BATCH + delay(300)` throttling** in `enrichWatchedTitles`, `generateCandidates`,
   and `discoverCandidates`. Submit each phase's full URL list at once via `Promise.all` over `fetchJson`;
   `createFetchQueue`'s `maxInflight` + 429 backoff (fetch-queue.js) is the **sole** concurrency control.
   *Removes ~3.6s/refresh, same call count, and lets the queue pipeline continuously.*
2. **Stop enriching basket titles twice.** Today `_pipeline` calls `enrichWatchedTitles(basket)` (2 calls/title:
   keywords + credits) to build the profile, then `generateCandidates` fetches `appendDetail` per seed which
   **already returns the same keywords+credits**. Factor a helper `enrichAndExpandBasket(basket)` that fetches
   `appendDetail` **once per seed** and returns `{ enrichedBasket, collabCandidates }` — using
   `enrichmentFromAppend` to attach `_keywords/_people` (for `buildTasteProfile`) **and** `extractSeedCandidates`
   for the rec/similar collab pool, from the **same** payload. `_pipeline` calls it before `buildTasteProfile`;
   `generateCandidates` drops its own appendDetail loop and takes the `collabCandidates` it produced. Keep
   `enrichWatchedTitles` for **downvoted** titles only (no appendDetail path). *Saves 2 × min(basketSize,
   MAX_SEEDS) calls/refresh — 10 for a 5-basket. Most involved Phase 1 change (reorders `_pipeline`); the
   appendDetail keyword/credit shape is already parsed identically by `enrichmentFromAppend`.*
3. **Cap Discover fan-out.** `discoverCandidates` calls
   `buildDiscoverRequests(profile, negProfile, { pages: 1, maxKeywords: 4, maxPeople: 3 })`, and
   `buildDiscoverRequests` **slices `keywordFacets` to `maxKeywords` after** concatenating `genreKeywordIds`
   (stop the facet-count inflation). *Discover 52 → ~16 calls (−69%); still ~320 raw titles before dedup,
   far above the 60-rec page.*
4. **Raise queue concurrency 6 → 12** (`createFetchQueue` `maxInflight`). *A ~22-call refresh drops from many
   waves to ~2–3; stays under TMDB's ~20-concurrent ceiling; 429 backoff self-heals bursts.*
5. **Exclude `watched ∪ basket ∪ downvoted` BEFORE `scorePool`** in `_pipeline` (filter `candidates` first,
   drop the post-score `.filter`). *Dual win: fixes the IDF-corpus skew (followup #2) AND skips full scoring +
   the expensive `generateReasons` on items that get discarded. Matches `rankCandidates`' already-correct order.*
6. **In-memory memo mirror + batched write-through** in `fetch-queue.js`. Read `sessionStorage` once at queue
   creation into a closure object; serve `fetchJson` memo reads from it; write-through to it; debounce/flush
   `sessionStorage.setItem` (microtask / end-of-run) instead of `JSON.parse`+`JSON.stringify`-ing the whole
   growing blob on every fetch. *Per-fetch O(M) → O(1) amortized; removes ~140 parse/stringify cycles per
   ~70-call run off the main thread.*
7. **Bound + memoize the re-rank.** Pre-truncate `mmrRerank`'s input to `min(pool, 6 × limit)` by score before
   re-ranking; attach a precomputed genre `Set` + seedTitleId `Set` to each Scored item so `itemSim` reads
   cached Sets instead of rebuilding them on every pairwise call; replace `Math.min(...arr)`/`Math.max(...arr)`
   in `scorePool` and `mmrRerank` with a single-pass loop. *Cuts the O(N²) re-rank ~3–10× at N=500–1000 and
   removes the latent `RangeError` stack-overflow cliff on huge pools.*
8. **Stop fetching discarded filler.** Split `fillerCandidates` into `trendingCandidates()` (always, **1**
   `trending(1)` call) and `topRatedFiller()` (**2** `top_rated` calls, cold-start only). In
   `generateCandidates`: merge `trendingCandidates()` into the pool **unconditionally** (so "Trending this
   week" becomes a standing row on all baskets) and blend `topRatedFiller()` via `coldStartBlend` **only when
   `basketSize < COLD_START_FULL`**. *Full basket: 3 filler calls → 1 (and gains a standing Trending row);
   cold basket unchanged.*

**Phase 1 result:** ~70 → **~22** calls; ~2–4× faster cold refresh; large main-thread compute cut.

### Phase 2 — Perceived speed (rendering UX; M/L)

9. **Progressive / streaming row emission.** Give the engine an `onRow` callback (or async generator) so rows
   paint as their data resolves: collaborative-provenance rows ("Because you liked X") + Top Picks the moment
   the collaborative pool returns, "More ‹Genre›" when Discover lands, "Trending this week" when trending
   lands. Run `discoverCandidates` and the filler/trending fetches **in parallel** (`Promise.all`) instead of
   the current sequential awaits. `renderRecommendationsPage` appends each rail the moment it arrives, keeping
   the `recPageRenderToken` last-writer guard per-append. *Hold the genre-calibrated hero Top Picks until the
   pool completes to avoid a re-order; emit the cheaper collab rows first. TTFR: full-fan-out → collab-pool latency.*
10. **Skeleton rails + lazy row hydration.** Replace the global spinner for the rec view with 2–3 shimmer
    placeholder `.rec-rail-section`s rendered immediately into a **visible** `#main`, swapped for real rails as
    rows arrive. For below-the-fold rows, append only the header + a fixed-min-height empty scroller and
    populate cards via `IntersectionObserver` (rootMargin ~600px) so off-screen cards (up to ~200 nodes) aren't
    built — and their upstream data isn't fetched — until scrolled toward. *Reserves layout (no pop-in shift);
    cuts initial DOM to the visible rows.*
11. **Debounce recompute + stale-while-revalidate on ★/👎.** On toggle: flip the clicked card's state
    optimistically (`sync()`), then **debounce** the heavy recompute ~800–1500ms after the last toggle (rapid
    curation → one pipeline run, not one-per-click). When recompute runs, keep current rows visible and
    cross-fade to the new rows instead of `main.innerHTML=''`+spinner. Decouple `clearRecommendationCache` from
    deletion: mark entries stale (keep payload) so the last good result paints instantly while a fresh one
    computes underneath. *Removes the most jarring cost in the app.*

**Phase 2 result:** page feels instant; smooth curation.

### Phase 3 — Relevance tuning + the 5 deferred follow-ups (S/M, incremental behind tests)

12. **Cold-start quality floor.** Add a third hybrid term:
    `score = (W_COLLAB·collabN + W_CONTENT·contentN + W_PRIOR·qualityN) · recency`, where `qualityN` is the
    min-max-normalized Bayesian rating across the pool. Weights `0.55 / 0.30 / 0.15` (collab/content ratio
    ~unchanged, warm ranking moves <5%). *On an empty/tiny basket base=0 today → all scores 0; `qualityN`
    becomes the de-facto sort key → a "popular + well-rated to get started" page instead of TMDB order.*
13. **Thread basket seed strength into the collaborative score.** Set `m._seedWeight` in `topSeeds` from a
    normalized `buildTasteProfile`-style weight; pass it through the basket-expansion → `extractSeedCandidates`
    so each SeedTag's `weight = SOURCE_WEIGHT × seedStrength` (rescaled to ~[0.5, 2]). `collabScore` already
    multiplies `sw·weight`, so no scorer change. *A co-rec from your #1 fave should outweigh one from your
    weakest star — currently flat. `PER_SEED_CAP=3` bounds mono-fave dominance.*
14. **Lower `BAYES_PRIOR_COUNT` 500 → ~150** so 500–2000-vote hidden gems express 80–90% of their rating
    instead of being shrunk toward C=6.5 (m=500 is IMDb-million-vote calibration, wrong for a few-hundred-title
    browser pool). Validate the existing "high-vote great title beats low-vote obscure at equal seed match"
    regression stays green.
15. **Close the 5 tracked follow-ups:**
    - **(a) movie/TV id-collision:** key `mergeCandidates` (and the `excludeIds` set + `groupIntoRows`
      `placed` set) by composite `${media_type}:${id}` so a movie and TV show sharing a numeric id don't
      collide (corrupting media_type / evidence labels).
    - **(c) explore-vs-genre starvation:** gate the explore-gem reservation so it only claims gems once the
      top-genre row is satisfied (don't let "Hidden gems" starve the user's #1 genre row in thin catalogs).
    - **(d) harness fragility:** export `buildRecRail`/`createRecommendationCard` for the harness to import (or
      make the `slice()` extractor token-aware) so a future `'}'`-in-a-string can't mis-slice.
    - **(b) IDF skew** is closed by Phase 1's exclude-before-scoring change; the **cosmetics** (cold-start
      lead-row label, harness kicker fixture drift, meta-cache test-constant duplication) ride along.

**Phase 3 result:** better picks — especially cold-start and gems; deferred correctness items closed.

## Explicitly deferred (not this pass)

Per the audit, these are **deliberate, test-anchored values**, to be tuned later as A/B dials behind the
diversity/relevance guardrail, not changed blind here:
- MMR `λ` (0.8/0.6) and `PER_SEED_CAP` (3) — defensible as-is.
- `DOWNVOTE_GAMMA` count-scaling (downvote responsiveness) — a safety-vs-responsiveness dial.
- The unrated-title (v=0 → 0.925 prior) confidence penalty — low impact given `MIN_VOTE_COUNT=10`.

## Testing & measurement

- **Pure functions** (the re-rank memoization/min-max helpers; the Phase 3 scoring/merge/grouping changes) get
  unit tests in `recommendations.test.js`; fetch-queue changes (in-memory memo) in `fetch-queue.test.js`. The
  existing 158 tests stay green; relevance changes re-run the regression assertions between each.
- **Network/UX** (delays, Discover cap, concurrency, filler split, progressive render, skeletons, debounce)
  verified via `rec-dom-harness.mjs` (extended) + manual; system Chrome.
- **Measurement proxies** (prove each optimization, all client-side):
  - Calls-per-refresh counter (total + per-phase) → target ~70 → **~22**.
  - Wall-clock latency via `performance.mark/measure` per phase → inter-phase delay ~3.6s → ~0; cold refresh 2–4× faster.
  - Time-to-first-row mark (render start → first `appendChild`) → full-fan-out → collab-pool latency; CLS ~0 after skeletons.
  - `itemSim` invocation counter → ~10⁵–10⁶ → ~K² at K=6·limit; `generateReasons` call count → ~N → ~survivors.
  - Intra-list diversity (mean pairwise `itemSim`) vs mean relevance as a **guardrail** — later phases must stay in a tolerance band of the shipped values.
  - Cold-start: empty-basket top-20 score variance > 0 (today exactly 0); a high-quality recent title outranks a low-vote obscurity.
  - Toggle: click→card-flip ~0ms (optimistic); pipeline runs per N rapid toggles → 1 (debounced), not N.

## Risks

- Removing delays + raising concurrency raises 429 probability under toggle-storms — bounded by the existing
  Retry-After/exponential backoff; ship the **debounce before/with** the concurrency raise if storms are a
  concern. Verify the backoff path under a simulated 429.
- The Discover cap can under-fill unexpectedly-thin/obscure baskets — keep the adaptive page-2 gate ready as a
  fallback (only fetch page 2 if the post-collab+page-1 pool is below a threshold); guard with the pool-size metric.
- The basket-enrichment reorder (item 2) must preserve the profile exactly — `enrichmentFromAppend` already
  produces the same `{id,name}` keyword/people shape `fetchTitleMeta` did; verify a profile built from
  appendDetail matches one built from `enrichWatchedTitles` for the same titles.
- Progressive render + stale-while-revalidate introduce visible re-order/reflow when later phases land
  (especially after a downvote) — **cross-fade not hard-swap**, hold the calibrated Top Picks until the pool
  completes, bound the staleness window.
- `sessionStorage` quota: stale-row snapshots + any scored-pool cache share quota with the 500-entry meta
  cache — store a trimmed projection (card-render fields only), keep any scored-pool cache **in-memory** (module
  `Map`), keep the debounced memo flush small.
- Scoring-weight changes (items 12–14) interact — ship one at a time behind the guardrail + regression tests so
  a regression is attributable.
- None of these files are orval/codegen output (all hand-written), so the global codegen confirm-gate does not apply.
