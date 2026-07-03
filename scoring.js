// scoring.js — browse-grid scoring for the Movies tab.
// Rating-first: the score IS a (confidence-weighted) rating on the 0-10 scale,
// so a well-rated 800-vote gem outranks a lower-rated 8000-vote blockbuster.
// Votes act as confidence via the shared IMDb-style Bayesian shrink.
import { bayesianRating } from './recommendations.js';

// Confidence-weighted quality score. When an RT critic score is present it is
// averaged with the TMDB rating (both on 0-10) before the Bayesian shrink.
export function calculateScore(movie) {
  const voteCount = movie.vote_count || 0;
  const tmdbRating = movie.vote_average || 0;
  const rtScore = movie.rtScore; // 0-100 scale
  let combinedRating = tmdbRating;
  if (rtScore !== null && rtScore !== undefined) {
    combinedRating = (tmdbRating + rtScore / 10) / 2;
  }
  return bayesianRating(combinedRating, voteCount);
}

// Recency ladder relative to the current year (age 0 => 15x, -2x per year, floor 1x).
// Matches the historical hard-coded ladder (2026=15 ... 2020=3, older=1) as of 2026.
export function recencyBoost(year, currentYear = new Date().getFullYear()) {
  const age = Math.max(0, currentYear - (year || 0));
  return Math.max(15 - 2 * age, 1);
}

// Newest + Weighted sort key. Boost only the above-baseline portion of the score:
// a multiplicative boost on the raw 0-10 score would let the year ladder swamp the
// compressed rating range, turning the sort into year-desc. Baseline 5.0 with a 0.1
// floor keeps below-baseline titles ordered by recency without zeroing them out.
export function newestWeightedScore(score, year, currentYear = new Date().getFullYear()) {
  return Math.max(score - 5.0, 0.1) * recencyBoost(year, currentYear);
}
