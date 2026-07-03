// scoring.js — browse-grid scoring for the Movies tab.
// Rating-first: the score IS a (confidence-weighted) rating on the 0-10 scale,
// so a well-rated 800-vote gem outranks a lower-rated 8000-vote blockbuster.
// Votes act as confidence via the shared IMDb-style Bayesian shrink.
import { bayesianRating } from './recommendations.js';

// Stronger prior than the rec engine's m=150: the browse pool is full of brand-new
// titles whose first few hundred TMDB votes are self-selected fans, so a few hundred
// votes should NOT be enough to fully claim a 9.x rating.
const BROWSE_PRIOR_COUNT = 500;

// Rating blend weights. IMDb counts double: its voter base is 10-100x larger and
// general-audience, so it is the strongest single check against TMDB fan inflation.
const W_TMDB = 1;
const W_IMDB = 2;
const W_RT = 1;

// Confidence-weighted quality score. Blends whichever sources are present
// (TMDB always; IMDb and RT via OMDB enrichment, all normalized to 0-10),
// then shrinks toward the global mean using TMDB+IMDb votes as confidence.
export function calculateScore(movie) {
  const tmdbVotes = movie.vote_count || 0;
  const tmdbRating = movie.vote_average || 0;
  const imdbRating = typeof movie.imdbRating === 'number' ? movie.imdbRating : null;
  const imdbVotes = typeof movie.imdbVotes === 'number' ? movie.imdbVotes : 0;
  const rtScore = movie.rtScore; // 0-100 scale

  let weightedSum = tmdbRating * W_TMDB;
  let weightTotal = W_TMDB;
  if (imdbRating !== null) {
    weightedSum += imdbRating * W_IMDB;
    weightTotal += W_IMDB;
  }
  if (rtScore !== null && rtScore !== undefined) {
    weightedSum += (rtScore / 10) * W_RT;
    weightTotal += W_RT;
  }
  const combinedRating = weightedSum / weightTotal;

  return bayesianRating(combinedRating, tmdbVotes + imdbVotes, BROWSE_PRIOR_COUNT);
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
