# Recommendation Engine Overhaul — Design

**Date:** 2026-06-02
**Status:** Approved
**Supersedes (engine internals of):** [2026-05-30-recommendation-engine-design.md](2026-05-30-recommendation-engine-design.md), and the engine model of [2026-05-31-downvote-and-basket-recs-design.md](2026-05-31-downvote-and-basket-recs-design.md). The **basket-primary / watched = hide-only** decisions from the downvote-basket design are explicitly **kept** (see Decisions).

## Goal

Make the recommendation engine an order of magnitude better. The user reports it as
irrelevant, repetitive/samey, sparse/empty, and stale/obscure — all four symptoms. A
research+audit pass (TMDB API docs + recsys literature, cross-checked against the code)
traced every symptom to a concrete cause and produced the architecture below.

Hard constraints (unchanged): pure browser, vanilla ES modules, **no backend, no ML
training**, only the TMDB API + localStorage/sessionStorage. All heavy logic stays in
unit-tested pure functions exercised with the existing injected `now` clock.

## Decisions (from brainstorming)

- **Scope: full overhaul.** All improvements below, delivered in two independently
  shippable/testable phases.
- **Basket-primary is preserved. Watched stays hide-only.** Recommendations are driven by
  the explicit starred **basket** (positive) and **downvotes** (negative). Watched history
  is used **only to exclude** already-seen titles — it does **not** shape taste, and the
  dwell/episode engagement store is **not** reactivated as a taste signal. Cold-start is
  padded with **trending/top-rated**, never with watch history.
- **Out of scope:** watch-provider / "available to stream" filtering (needs region +
  provider config/UI — a clean follow-up); a full Thompson/UCB theme-bandit (a deterministic
  epsilon-style exploration row covers the need at far less complexity); the YouTube engine
  (still pending its data-source decision).

## Diagnosis — root causes (verified against the code)

1. **Ignores TMDB's own recommendation data.** `/{type}/{id}/recommendations` is a
   *collaborative* "people who liked X also liked Y" list (TMDB staff: "significantly better"
   than `/similar`, and the same engine the TMDB website uses); `/similar` is its content
   fallback. Neither is in `config.js` ENDPOINTS, and `generateCandidates` never calls them —
   it rebuilds a weak keyword/cast/genre imitation. *Biggest miss.*
2. **One media type only.** `generateCandidates` computes a secondary type (`types[1]`) but
   never queries it and hard-tags every candidate `media_type: primaryType`. A movie-leaning
   basket returns **zero** TV (and vice-versa).
3. **Tiny candidate pool.** ~13 Discover requests, **page 1 only**, each truncated to
   `slice(0,10)` → a few dozen titles after dedup; the rec page asks for 60 and starves.
4. **Ranking ignores quality.** `scoreCandidate` never reads `vote_average`/`vote_count`/
   release date; the popularity term is ~negligible. A 12-vote obscurity outranks a
   12,000-vote classic when seeds match.
5. **No diversity step.** `rankCandidates` is a pure greedy sort+slice → the top clusters
   around the single strongest seed/actor.
6. **Cold-start & negative feedback mishandled.** Empty/tiny basket → near-empty page
   (`trending`/`topRatedMovies` exist but are unused). One downvote gets `STAR_BONUS=2.5` and
   `combineProfiles` deletes any seed whose net weight ≤ 0, so disliking one action film can
   erase the whole action theme; downvotes are never expressed as Discover `without_*`.
7. **Page assembly repeats & drops rows.** `groupIntoRows`: "Top picks" doesn't claim its
   items (they reappear in lower rows); title rows starve later person rows; inconsistent
   `Number()` coercion (`hasSeed` strict `===` vs `Number(s.id)`) silently drops rows.

## Target architecture — two-stage funnel

A bounded set of TMDB calls generates a few-hundred-title candidate pool; then **all precise
work happens for free in the browser** as pure functions.

### Stage 1 · Candidate generation (`recommendations.js`, `config.js`)

- **Per-seed collaborative expansion (primary).** For each basket seed (capped to the top
  `MAX_SEEDS = 12` by basket weight to bound fan-out), one
  `GET /{seed.media_type}/{seed.id}?append_to_response=recommendations,similar,keywords,credits`
  call returns, in a single request: the seed's keywords + credits (for content vectors and
  Discover expansion) **and** its `recommendations` (page 1) **and** `similar` (page 1).
  - Candidates from `recommendations` → `_seeds:[{ source:'rec', seedId, seedTitle, rank, weight }]`.
  - Candidates from `similar` → `{ source:'similar', ... }` (weighted below `rec`).
  - **Each candidate keeps its real `media_type` from the response** → movie + TV mix.
  - Switching fallback: if a seed's `recommendations` is empty/short (obscure/new title), its
    `similar` and content/Discover paths carry it (no wasted slot).
- **Discover expansion (breadth + themed rows).** Aggregate the basket's top genres /
  keywords / people into pipe-OR Discover queries, run for **both** media types weighted by
  `mediaTypeBias`, with real quality gates and negative steering (see Config). Pages 1–2, no
  `slice(0,10)`.
- **Cold-start blend.** `personalizedWeight = min(1, basketSize / 5)`; fill the remaining
  `1 - personalizedWeight` of the pool from `/trending/all/week` + `/{type}/top_rated`
  (filtered against watched ∪ downvoted ∪ basket). **Empty basket → trending-only path**
  (never returns `[]`/empty rows).
- **Merge & exclude.** `mergeCandidates` dedupes by id, accumulating `_seeds` provenance and
  source tags; exclude `watched ∪ downvoted ∪ basket`.
- All network goes through the Stage 5 fetch queue + cache.

### Stage 2 · Scoring (pure, **zero extra calls** — uses only already-fetched fields)

```
score(c) = (W_COLLAB · collabN(c) + W_CONTENT · contentN(c)) · qualityPrior(c) · recency(c)
```
- **collab** — co-recommendation tally: how many distinct seeds surfaced `c` via
  `recommendations`/`similar`, weighted by source (`rec` > `similar`) and seed weight.
  Min-max normalized across the pool. Dominant term when the pool is small.
- **content** — cosine of `c`'s tag vector (genres always present; keywords/people from
  `_seeds` provenance and, for seeds/enriched items, real keyword/credit ids) against the
  **TF-IDF basket-centroid** profile vector (IDF computed over the fetched union).
- **qualityPrior** — Bayesian/IMDb-weighted rating
  `WR = v/(v+m)·R + m/(v+m)·C` (R=`vote_average`, v=`vote_count`, m=prior count e.g. 500,
  C=global mean ≈ 6.5), mapped to a multiplier. **Shrinks** low-vote titles toward the mean
  rather than excluding them (keeps niche gems alive).
- **recency** — gentle release/first-air-year nudge (bounded multiplier).
- Defaults: `W_COLLAB = 0.6`, `W_CONTENT = 0.4` (named constants, tunable; shift toward
  content as the collaborative pool thins). **Reciprocal Rank Fusion** (`Σ 1/(60+rank_i)`
  over the rec / similar / content / popularity rank-lists) is provided as a robust,
  normalization-free alternative ordering for the home teaser row.

### Stage 3 · Re-rank (pure)

- **Near-duplicate / franchise collapse** to one best representative (same collection where
  known, or `itemSim > 0.9`).
- **MMR**: `MMR(i) = λ·rel(i) − (1−λ)·max_{j∈S} itemSim(i,j)`. `λ = 0.8` home teaser (relevance
  matters most in scarce space), `λ = 0.6` rec page. `itemSim` = weighted genre Jaccard +
  shared keyword/person provenance overlap (no extra calls).
- **Per-seed cap**: ≤ `PER_SEED_CAP = 3` of 20 from any single seed (via `_seeds`), so one
  favorite can't flood the row.
- **Downvote re-rank penalty**: bounded multiplicative down-weight for candidates sharing many
  tags with the disliked centroid (in addition to the Rocchio profile and the `without_*`
  prefilter).

### Stage 4 · Page assembly (rebuild `groupIntoRows`, Netflix staged model)

- **Row archetypes** (each = one generator over the already-fetched pool):
  - **Top Picks for you** — global MMR top-N, genre mix **calibrated** to the basket.
  - **Because you liked ‹Seed›** — per strong seed, from that seed's rec/similar candidates.
  - **More ‹Genre›** — top basket genres.
  - **Trending this week** — `/trending`, filtered against watched/downvoted/placed.
  - **Hidden gems / Something a little different** — one labeled exploration row: high
    `vote_average` + low `vote_count` in a liked genre, or an adjacent unseen genre.
    **Deterministic** (seeded, no `Math.random`) so the page is stable across visits.
- **Filter & order:**
  - Global **placed-ID Set** → cross-row de-dup (a title appears in ≤ 1 row). **Top Picks now
    claims its items** (fixes the dup bug).
  - **Steck calibration**: genre-row budget ∝ basket genre histogram; within Top Picks, greedy
    KL-minimizing selection so the shown genre mix tracks the basket (prevents monothematic
    collapse).
  - **Row order** by `Σ(title affinity) · evidence strength · row-type prior`; strongest row
    first (users scan vertically).
  - **Evidence labels**: the row title is the explanation; per-card "Recommended because you
    liked X" derived from `_seeds`.
  - **Fix** the `Number()` coercion so person/genre rows stop vanishing.
- Home teaser = the single highest-scoring row.

### Stage 5 · Infra (`recommendations.js`)

- **Concurrency-limited fetch queue** (`MAX_INFLIGHT ≈ 6`) with exponential backoff honoring
  `Retry-After` on HTTP 429; `fetchJson` routes through it.
- **URL-keyed `sessionStorage` memo** for list responses (rec/similar/discover/trending) so
  re-renders and back-nav cost zero network.
- **Versioned + TTL + size-bounded meta cache** for per-title `append_to_response` enrichment
  (replaces the unbounded permanent `recMetaCache`).
- **Watched-aware results cache key**: `signalSignature` includes a hash of `watchedIds`, so a
  just-watched title can't resurface mid-session even on a signature match.

## Config changes (`config.js`)

- **Add ENDPOINTS:**
  - `recommendations(type, id, page = 1)` → `/{type}/{id}/recommendations`
  - `similar(type, id, page = 1)` → `/{type}/{id}/similar`
  - `appendDetail(type, id)` → `/{type}/{id}?append_to_response=recommendations,similar,keywords,credits`
  - `topRated(type, page = 1)` → `/{type}/top_rated` (generalizes the movie-only `topRatedMovies`)
- **Parameterize the rec Discover helpers** (`discoverByGenres/Keyword/Cast`): add
  `vote_average.gte`, a `primary_release_date.gte`/`first_air_date.gte` window, and
  `without_genres`/`without_keywords`; source the floors from `CONFIG.MIN_VOTE_COUNT`,
  `CONFIG.MIN_RATING`, `CONFIG.MIN_YEAR` (currently hardcoded to 50/20 and ignored).
- **Respect the `type` field** in `MOVIE_GENRES`/`THEME_KEYWORDS` when composing
  `with_genres`/`without_genres` vs `with_keywords`/`without_keywords` — keyword IDs that
  masquerade as genres (e.g. `Dystopia 4565`, `Time Travel 4379`) must not be passed as genre
  IDs. (Item `genre_ids` from TMDB are always real genre ids and stay safe.)

## Engine interface (`recommendations.js`)

```js
// Pure (unit-tested with injected `now`)
export function buildTasteProfile(enriched, now)                 // existing, basket-driven
export function combineProfiles(pos, neg, opts)                  // → Rocchio gamma weighting
export function bayesianRating(voteAvg, voteCount, m, C)         // NEW quality prior
export function buildTagVector(item)                             // NEW genres+keywords+people
export function cosineSim(a, b)                                  // NEW
export function itemSim(a, b)                                    // NEW Jaccard + provenance
export function scoreCandidate(candidate, profile, opts)         // hybrid + quality + recency
export function mmrRerank(ranked, { lambda, perSeedCap, simFn })  // NEW
export function rrf(rankedLists)                                 // NEW (teaser ordering)
export function calibrate(candidates, basketGenreHistogram, opts)// NEW (Steck)
export function groupIntoRows(ranked, profile, opts)             // rebuilt
export function generateReasons(candidate, profile)              // evidence labels

// Network + cache (browser)
export async function getRecommendations(input, opts)            // → [{movie, score, reasons}]
export async function getRecommendationRows(input, opts)         // → { rows: [Row] }
export function clearRecommendationCache()
```

`input = { basket:[movie], downvoted:[movie], watchedIds:[id] }` (shape **unchanged** —
watched is exclude-only). `_pipeline` enriches basket (+ downvoted) via `appendDetail`, builds
the Rocchio-combined profile, generates candidates (per-seed rec/similar + Discover + cold-start
filler), scores, MMR re-ranks, and excludes `watched ∪ downvoted ∪ basket`.

## Signal assembly (`script.js`)

`buildSignalItems()` keeps returning `{ basket, downvoted, watchedIds }`. No engagement/watched
taste wiring (basket-primary preserved). The live re-render on ★/👎 toggle and the
`clearRecommendationCache()` calls remain.

## UI (`script.js`, `style.css`, `index.html`)

- Recommendation page renders the new row archetypes with **evidence labels** (row header +
  optional per-card "because you liked X").
- **Cold-start/empty state**: when the basket is empty, show a "Trending / popular to get
  started" rail (from the trending-only path) instead of the empty prompt.
- One labeled **exploration** row on the dedicated page.
- Reuse existing rail/card components and the `recPageRenderToken` last-writer-wins guard;
  keep the infinite-scroll regression fix (reset `filteredMovies/displayedCount/hasMorePages`
  + remove `#load-more-indicator` at the top of `renderRecommendationsPage`).

## Data flow

```
basket (stars) ─┐
downvoted ──────┤→ _pipeline:
watched (ids) ──┘    enrich basket(+downvoted) via appendDetail (rec, similar, keywords, credits)
                     profile = Rocchio(basketCentroid − 0.15·dislikedCentroid)   [basket-primary]
                     candidates = per-seed rec/similar (mixed media)  ∪  Discover(pipe-OR, gated, without_*)
                                  ∪  cold-start filler(trending/top_rated · (1 − personalizedWeight))
                     exclude watched ∪ downvoted ∪ basket
                     score = (0.6·collab + 0.4·content) · bayesianQuality · recency
                     re-rank = franchise-collapse → MMR(λ) → per-seed cap → downvote penalty
                     rows = Top Picks(calibrated) + Because-you-liked-X + genre + trending + exploration
                            (cross-row dedupe, evidence labels)
```

## Phasing

**Phase 1 — transformative core (most of the 10x on day one):**
1. `config.js` endpoints (`recommendations`, `similar`, `appendDetail`, `topRated`) + Stage 5
   fetch queue / 429 backoff / URL-keyed caching (so the larger fan-out is safe first).
2. Rebuild `generateCandidates`: per-seed `recommendations` (+ `similar` fallback) via
   `appendDetail`, **mixed media types**.
3. Normalized hybrid scoring: collab + content cosine + Bayesian quality prior + recency.
4. MMR diversity re-rank + per-seed cap + franchise collapse.
5. Cold-start trending/top-rated blend; never empty.

**Phase 2 — steering + presentation polish:**
6. Deeper, quality-gated Discover: pagination, pipe-OR multi-seed, `vote_average.gte`, date
   window, honor `CONFIG.MIN_*`.
7. Rocchio downvote softening + hard `without_genres`/`without_keywords` + re-rank penalty.
8. Row rebuild: claim Top Picks, Steck calibration, cross-row dedupe, evidence labels,
   exploration row, fix the coercion bug.
9. Cache hardening: watched-aware signature, versioned/TTL/size-bounded meta cache.

Each numbered item is independently shippable and testable.

## Testing

Pure functions via `node --test` with injected `now`:
- `bayesianRating` shrinks low-vote toward the mean; a high-vote great title outranks a
  low-vote obscure one at equal seed match.
- `buildTagVector`/`cosineSim` and the TF-IDF basket centroid behave as specified.
- `mmrRerank` raises intra-list diversity; no seed exceeds `PER_SEED_CAP`; franchise collapse
  keeps the best representative.
- `combineProfiles` (Rocchio): one downvote no longer erases a strongly-basketed theme.
- `scoreCandidate` hybrid: monotonic in collab and content; quality/recency bounded.
- `groupIntoRows`: Top Picks claims its items (no cross-row dup), person/genre rows survive
  the coercion fix, shown genre mix ≈ basket histogram.
- `rrf` ordering; cold-start: empty basket → trending path returns items; blend ratio scales
  with basket size; watched-aware cache key busts correctly.

DOM/UI (row labels, exploration row, cold-start rail, empty→populated) verified headlessly
with system Chrome, consistent with prior features (use `$eval(sel, el => el.click())`, not
coordinate clicks).

## Measurement (offline proxies, no backend / no A-B test)

Log from the pure functions (console or a dev panel) before/after each change:
candidate-pool size (target: tens → several hundred for a 5-title basket); **% collaborative-
sourced** (majority once item 2 lands); **intra-list diversity** vs aggregate relevance while
tuning λ; **genre-calibration error** (KL/L1 of shown vs basket histogram → ~0); **basket
coverage** (fraction of seeds contributing ≥ 1 rec → ~100%); **max per-seed share** (→ the
cap); min `vote_count`/`vote_average` among shown (→ rises); cross-row duplication (→ 0);
request count / cache-hit rate / 429s per render. Plus a **manual rubric** over 5–8 fixed
sample baskets (monothematic, mixed movie+TV, tiny cold-start, with-downvotes): rate top-20 on
relevance / novelty / diversity, before vs after.

## Risks & mitigations

- **Fan-out → rate limits.** Ship the concurrency queue + backoff + caching (item 1) first;
  cap to `MAX_SEEDS` seeds.
- **Sparse `/recommendations` for obscure seeds.** `/similar` switching fallback + Discover /
  trending blend remain.
- **Approximate TF-IDF (union, not global corpus).** Keep collab dominant when the pool is
  small; raise content weight as it grows.
- **MMR/calibration over-tuning** can surface off-taste items. λ ≈ 0.8 on the scarce teaser;
  gate exploration behind a relevance threshold (serendipity = unexpectedness × relevance).
- **Quality prior over-suppressing gems.** Confidence-weighted shrinkage (not a hard cutoff)
  + the Hidden-gems exploration row.
- **Genre/keyword id collisions.** Respect the `type` field when composing Discover params.
- **Cache key/version changes have cross-session blast radius.** Bump the cache version
  deliberately behind clear commits; rely on the pure-function tests as the safety net. (No
  orval/codegen pipeline exists in this project, so the global codegen-confirmation gate does
  not literally apply, but cache-version changes are treated with the same care.)
- **Pure-function contract changes break existing tests.** Update tests in lockstep (TDD).
- **Behavioral instability** from live re-rank + exploration. Keep the top 1–2 rows stable;
  seed exploration deterministically; rotate only trending/lower rows.

## Out of scope

- Watch-provider / region "available to stream" filtering.
- Full Thompson/UCB theme-bandit (deterministic epsilon exploration row instead).
- Reactivating watched-history/engagement as a taste signal (basket-primary kept).
- The YouTube recommendation engine (separate, pending its data-source decision).
