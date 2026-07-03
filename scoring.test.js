import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateScore, recencyBoost, newestWeightedScore } from './scoring.js';

// --- calculateScore: Bayesian rating-first (votes are confidence, not the score) ---
// Browse prior m=500, C=6.5. Rating blend weights: TMDB 1, IMDb 2, RT 1.

test('calculateScore keeps a heavily-voted title near its raw rating', () => {
  // 7.7 avg, 8000 votes, m=500 -> (7.7*8000 + 6.5*500) / 8500 = 7.63
  const score = calculateScore({ vote_average: 7.7, vote_count: 8000 });
  assert.ok(Math.abs(score - 7.63) < 0.01, `expected ~7.63, got ${score}`);
});

test('calculateScore shrinks a low-vote title toward the global mean', () => {
  // 9.0 avg on only 50 votes -> (9*50 + 6.5*500) / 550 = 6.73
  const score = calculateScore({ vote_average: 9.0, vote_count: 50 });
  assert.ok(Math.abs(score - 6.73) < 0.01, `expected ~6.73, got ${score}`);
});

test('calculateScore ranks a well-rated gem above a lower-rated blockbuster', () => {
  const gem = calculateScore({ vote_average: 8.5, vote_count: 800 });
  const blockbuster = calculateScore({ vote_average: 7.7, vote_count: 8000 });
  assert.ok(gem > blockbuster, `gem ${gem} should beat blockbuster ${blockbuster}`);
});

test('calculateScore averages TMDB with RT when rtScore is present', () => {
  // (7.7 + 9.4)/2 = 8.55 combined, 8000 votes -> (8.55*8000 + 3250)/8500 = 8.43
  const score = calculateScore({ vote_average: 7.7, vote_count: 8000, rtScore: 94 });
  assert.ok(Math.abs(score - 8.43) < 0.01, `expected ~8.43, got ${score}`);
});

test('calculateScore returns the global mean for a vote-less title', () => {
  const score = calculateScore({ vote_average: 8.0, vote_count: 0 });
  assert.ok(Math.abs(score - 6.5) < 0.01, `expected ~6.5, got ${score}`);
});

// --- IMDb cross-validation: bigger general-audience sample outweighs TMDB fan votes ---

test('calculateScore weights IMDb double and counts its votes as confidence', () => {
  // Off Campus numbers: blend (8.95 + 2*8.2)/3 = 8.45, votes 615+2076=2691
  // -> (8.45*2691 + 3250)/3191 = 8.14
  const score = calculateScore({ vote_average: 8.95, vote_count: 615, imdbRating: 8.2, imdbVotes: 2076 });
  assert.ok(Math.abs(score - 8.14) < 0.01, `expected ~8.14, got ${score}`);
});

test('calculateScore deflates a TMDB fan-inflated title that IMDb rates much lower', () => {
  // Swapped numbers: TMDB 8.95@1847 but IMDb 7.3@14061
  const withImdb = calculateScore({ vote_average: 8.95, vote_count: 1847, imdbRating: 7.3, imdbVotes: 14061 });
  const tmdbOnly = calculateScore({ vote_average: 8.95, vote_count: 1847 });
  assert.ok(withImdb < tmdbOnly - 0.5, `expected a >=0.5 drop: ${tmdbOnly} -> ${withImdb}`);
  // blend (8.95 + 14.6)/3 = 7.85, votes 15908 -> (7.85*15908 + 3250)/16408 = 7.81
  assert.ok(Math.abs(withImdb - 7.81) < 0.01, `expected ~7.81, got ${withImdb}`);
});

test('calculateScore blends all three sources with TMDB 1 / IMDb 2 / RT 1 weights', () => {
  // (8.0 + 2*7.0 + 8.0)/4 = 7.5, votes 1000+10000 -> (7.5*11000 + 3250)/11500 = 7.46
  const score = calculateScore({ vote_average: 8.0, vote_count: 1000, imdbRating: 7.0, imdbVotes: 10000, rtScore: 80 });
  assert.ok(Math.abs(score - 7.46) < 0.01, `expected ~7.46, got ${score}`);
});

test('calculateScore ignores null imdbRating and non-numeric imdbVotes', () => {
  const clean = calculateScore({ vote_average: 7.7, vote_count: 8000 });
  const noisy = calculateScore({ vote_average: 7.7, vote_count: 8000, imdbRating: null, imdbVotes: null });
  assert.equal(noisy, clean);
});

test('calculateScore counts imdbRating without imdbVotes as rating-only evidence', () => {
  // blend applies but no extra confidence votes: (8.95 + 2*7.3)/3 = 7.85 @ 615 votes
  // -> (7.85*615 + 3250)/1115 = 7.245
  const score = calculateScore({ vote_average: 8.95, vote_count: 615, imdbRating: 7.3 });
  assert.ok(Math.abs(score - 7.25) < 0.01, `expected ~7.25, got ${score}`);
});

// --- recencyBoost: same ladder as before but relative to the current year ---

test('recencyBoost reproduces the existing ladder for 2026', () => {
  assert.equal(recencyBoost(2026, 2026), 15);
  assert.equal(recencyBoost(2025, 2026), 13);
  assert.equal(recencyBoost(2024, 2026), 11);
  assert.equal(recencyBoost(2023, 2026), 9);
  assert.equal(recencyBoost(2022, 2026), 7);
  assert.equal(recencyBoost(2021, 2026), 5);
  assert.equal(recencyBoost(2020, 2026), 3);
  assert.equal(recencyBoost(2019, 2026), 1);
  assert.equal(recencyBoost(0, 2026), 1);
});

test('recencyBoost is relative to currentYear so the ladder never goes stale', () => {
  assert.equal(recencyBoost(2027, 2027), 15);
  assert.equal(recencyBoost(2024, 2027), 9);
});

test('recencyBoost clamps future-dated releases to the max boost', () => {
  assert.equal(recencyBoost(2030, 2026), 15);
});

// --- newestWeightedScore: boost applies to the above-baseline portion only ---

test('newestWeightedScore ranks a good new title above John Wick 4', () => {
  const good2026 = newestWeightedScore(8.0, 2026, 2026); // (8-5)*15 = 45
  const jw4 = newestWeightedScore(7.68, 2023, 2026);     // (7.68-5)*9 = 24.1
  assert.ok(good2026 > jw4, `${good2026} should beat ${jw4}`);
});

test('newestWeightedScore does not let a mediocre new title beat a great older one', () => {
  const mediocre2026 = newestWeightedScore(6.0, 2026, 2026); // (6-5)*15 = 15
  const great2023 = newestWeightedScore(8.5, 2023, 2026);    // (8.5-5)*9 = 31.5
  assert.ok(great2023 > mediocre2026, `${great2023} should beat ${mediocre2026}`);
});

test('newestWeightedScore floors the baseline delta so below-baseline titles still order by year', () => {
  const bad2026 = newestWeightedScore(4.0, 2026, 2026); // 0.1*15 = 1.5
  const bad2019 = newestWeightedScore(4.0, 2019, 2026); // 0.1*1 = 0.1
  assert.ok(bad2026 > bad2019);
  assert.ok(bad2026 > 0);
});
