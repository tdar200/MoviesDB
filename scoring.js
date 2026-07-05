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
// RT is deliberately absent: OMDB only exposes the critic Tomatometer (no free
// audience-score API exists) and critic taste diverges from "good to watch" —
// it sank Interstellar (73% RT vs IMDb 8.7@2.5M) while inflating critic darlings.
// rtScore stays on the movie object for display only.
const W_TMDB = 1;
const W_IMDB = 2;

// TV calibration. Series ratings run structurally hotter than film ratings —
// only fans finish and rate a show, so at equal IMDb rank TV sits ~0.2-0.3 above
// film (top TV ~9.5 vs top film ~9.3; rank-16 TV 9.0 vs rank-16 film 8.7).
// Subtract the average gap so the combined view compares media on one scale.
const TV_CALIBRATION_OFFSET = 0.25;

// Proven-at-scale bonus. The Bayesian prior separates 1k from 10k votes but
// saturates past that — 30k and 2.5M votes score identically. Above the pivot,
// each decade of combined votes adds a small log-scale edge so a title vetted by
// millions outranks an equal-rated one vetted by thousands. Reward-only (small
// titles are never punished, low-buzz gems keep their shot) and capped so
// popularity can never buy back a rating deficit.
const VOTE_SCALE_PIVOT = 10000;
const VOTE_SCALE_WEIGHT = 0.15; // per decade of votes above the pivot
const VOTE_SCALE_CAP = 0.4;

function provenAtScaleBonus(votes) {
  if (votes <= VOTE_SCALE_PIVOT) return 0;
  return Math.min(VOTE_SCALE_WEIGHT * Math.log10(votes / VOTE_SCALE_PIVOT), VOTE_SCALE_CAP);
}

// Confidence-weighted quality score. Blends the audience sources present
// (TMDB always; IMDb via OMDB enrichment), shrinks toward the global mean
// using TMDB+IMDb votes as confidence, rewards proven-at-scale vote mass,
// and calibrates TV down to the film rating scale.
export function calculateScore(movie) {
  const tmdbVotes = movie.vote_count || 0;
  const tmdbRating = movie.vote_average || 0;
  const imdbRating = typeof movie.imdbRating === 'number' ? movie.imdbRating : null;
  const imdbVotes = typeof movie.imdbVotes === 'number' ? movie.imdbVotes : 0;

  let weightedSum = tmdbRating * W_TMDB;
  let weightTotal = W_TMDB;
  if (imdbRating !== null) {
    weightedSum += imdbRating * W_IMDB;
    weightTotal += W_IMDB;
  }
  const combinedRating = weightedSum / weightTotal;
  const totalVotes = tmdbVotes + imdbVotes;
  const tvOffset = movie.media_type === 'tv' ? TV_CALIBRATION_OFFSET : 0;

  return bayesianRating(combinedRating, totalVotes, BROWSE_PRIOR_COUNT) + provenAtScaleBonus(totalVotes) - tvOffset;
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
