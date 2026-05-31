# Downvote + Basket-Primary Recommendations — Design

**Date:** 2026-05-31
**Status:** Approved

## Goal

Make the recommendation engine driven by explicit user signals: a **basket** of
starred titles (positive seeds) and a new **downvote** (negative steer). The star
button adds a title to the basket, the engine generates recommendations primarily
from that basket, and downvoting steers recommendations away from similar content.

## Decisions (from brainstorming)

- **Downvote = steer away.** Never recommend the exact downvoted title AND down-weight
  its genres/keywords/cast so the engine avoids similar content. Mutually exclusive
  with star (downvoting un-stars; starring un-downvotes).
- **Basket-primary.** Recommendations are driven mainly by the explicit basket
  (starred titles). Watched history and engagement no longer shape the taste profile.
  An empty basket means no recommendations.
- **Watched = hide only.** Titles you've watched are still excluded from
  recommendations (no re-suggesting seen titles), but they don't shape taste.
- **UI:** Rename the "Favorites" tab to "Basket", add a 👎 downvote button beside the
  ★ on every card, and provide a small Basket | Downvoted toggle to review/undo
  downvoted titles.
- **Engine approach (A):** Build a positive profile from the basket and a negative
  profile from downvoted titles (same shape), combine them at scoring
  (`positive − PENALTY · negative`). Reuses the existing tested profile builder.

## Architecture & file boundaries

- **`recommendations.js`** — extend the engine to a positive + negative profile model
  with steer-away scoring and an expanded exclusion set. Pure functions stay testable.
- **`recommendations.test.js`** — tests for the negative profile, steer-away scoring,
  exclusion set, and empty-basket cold-start.
- **`script.js`** — new `downvotedTitles` store (mirroring `starredTitles`) with
  mutual exclusivity; a shared `createDownvoteButton`; downvote buttons on all card
  types and the player header; Basket tab relabel + Basket|Downvoted toggle; updated
  signal assembly feeding the engine; live re-render of rec views on ★/👎 toggle.
- **`index.html`** — relabel the Favorites tab button text to "Basket".
- **`style.css`** — downvote button states beside the star; the Basket|Downvoted toggle.

## Signal stores (script.js)

- **Basket** = existing `starredTitles` store, unchanged in schema — it *is* the basket.
- **Downvoted** = new `downvotedTitles` store keyed by id (same shape as starred):
  `getDownvotedStore`, `saveDownvotedStore`, `isDownvoted`, `toggleDownvote`,
  `getDownvotedList`.
- **Mutual exclusivity:** `toggleStar(movie)` deletes `movie.id` from the downvoted
  store before/while starring; `toggleDownvote(movie)` deletes it from the starred
  store. A title is in exactly one of {neutral, basket, downvoted}.
- Both toggles call `clearRecommendationCache()` (star already does); downvote does too.
- **Watched** (`watchedHistory`) continues recording under the 3-minute rule; the
  engine consumes its ids only for exclusion.

## Engine model (recommendations.js)

Basket-primary, steer-away. Approach A:

- **Positive profile** — built from enriched **basket** items via the existing profile
  builder. The basket is the sole positive driver. Because the basket is explicit
  rather than time-based, recency/engagement drop out of basket weighting; weight is a
  light rating nudge only (reusing `ratingNudge`). Caps unchanged (~15 genres / ~30
  keywords / ~20 people).
- **Negative profile** — built from enriched **downvoted** items, producing the same
  genres/keywords/people structure (what to avoid).
- **Candidate generation** — seeds TMDB Discover from the *positive* profile's top
  genres/keywords/people only (existing `generateCandidates` logic, fed the positive
  profile). No extra network cost beyond enriching downvoted titles' metadata (cached
  permanently in `recMetaCache`, same as basket/positive titles).
- **Scoring** — `score = positiveOverlap − PENALTY · negativeOverlap`, where
  `negativeOverlap` counts the candidate's genres/keywords/people shared with the
  negative profile (weighted by the negative profile's weights). `PENALTY` is tuned so
  a disliked theme is suppressed but not hard-vetoed — a strong positive match can
  still surface (steer away, not veto). Default `PENALTY = 1.0` (comparable to a
  positive match), exposed as a named constant for tuning.
- **Exclusion** — drop any candidate whose id is in `watched ∪ downvoted ∪ basket`
  (basket items are seeds, not recommendations; downvoted and watched are never shown).
- **Cold-start** — empty basket → engine returns no recommendations. The home teaser
  row hides; the Recommendation tab shows an empty state prompting the user to add
  titles to their basket (★).

### Interface (recommendations.js)

```js
// Positive + negative enriched signal assembly and profiles are derived inside _pipeline.
export async function getRecommendations(input, opts)      // → [{ movie, score, reasons }]
export async function getRecommendationRows(input, opts)   // → { rows: [Row] }
export function scoreCandidate(candidate, posProfile, negProfile, opts) // steer-away
export function clearRecommendationCache()
```

`input` carries the basket items, downvoted items, watched ids, and engagement store
(engagement retained in the call shape but not used for basket weighting). `_pipeline`
enriches basket + downvoted titles, builds `posProfile` and `negProfile`, generates
candidates from `posProfile`, scores with both, and excludes `watched ∪ downvoted ∪
basket`. The session cache key incorporates the basket + downvoted signature so
toggling either busts it.

## UI (index.html, script.js, style.css)

- **Tab relabel:** "Favorites" → "Basket" (visible button text only; the
  `tab-favorites` id, `tabFavorites` var, and `switchToFavorites`/`loadFavorites`
  internals stay to limit blast radius). The Basket tab lists the starred seeds.
- **Downvote button:** a shared `createDownvoteButton(movie)` mirroring
  `createStarButton`, placed beside the ★ on browse cards (`createMovieCard`),
  recommendation cards (`createRecommendationCard`), and the player header. The pair
  reflects three states: neutral, ★ (in basket), 👎 (downvoted). Activating one clears
  the other (mutual exclusivity) and re-syncs both buttons.
- **Downvoted management:** a small segmented toggle in the Basket tab —
  **Basket | Downvoted (N)** — switching the rendered list between basket seeds and
  downvoted titles. Each item is removable/undoable via its button.
- **Live refresh:** toggling ★ or 👎 on a recommendation card (home row or tab) busts
  the rec cache and re-renders the current rec view so the change applies immediately.

## Data flow

```
basket (starred) ─┐
downvoted ────────┼─► _pipeline → posProfile + negProfile
watched (ids) ────┘        → candidates (seeded from posProfile)
                           → score = positiveOverlap − PENALTY · negativeOverlap
                           → exclude watched ∪ downvoted ∪ basket
                           → ranked recs → rows / teaser row
```

`buildSignalItems()` becomes the assembler that returns the basket items, downvoted
items, watched ids, and engagement store for the pipeline.

## Testing

Pure functions in `recommendations.test.js`:

- Negative profile builds the expected genres/keywords/people from downvoted items.
- Steer-away scoring: a candidate matching a downvoted theme scores below an equivalent
  candidate that doesn't; a strong positive match still outranks a mild negative
  (not a hard veto).
- Exclusion set is `watched ∪ downvoted ∪ basket`.
- Empty basket → `getRecommendations`/`getRecommendationRows` return empty.

The `downvotedTitles` store + mutual exclusivity get a focused test where practical;
DOM/UI wiring (buttons on cards, tab relabel, toggle, live refresh) is verified
headlessly, consistent with prior features.

## Out of scope

- Changing the watched 3-minute rule (just shipped).
- The YouTube recommendation engine (separate, still pending its data-source decision).
- Persisting signals to a backend / cross-device sync (localStorage only, as today).
