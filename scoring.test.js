import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateScore, recencyBoost, newestWeightedScore } from './scoring.js';

// --- calculateScore: Bayesian rating-first (votes are confidence, not the score) ---

test('calculateScore keeps a heavily-voted title near its raw rating', () => {
  // John Wick 4 numbers: 7.7 avg, 8000 votes -> shrink toward 6.5 is negligible
  const score = calculateScore({ vote_average: 7.7, vote_count: 8000 });
  assert.ok(Math.abs(score - 7.68) < 0.01, `expected ~7.68, got ${score}`);
});

test('calculateScore shrinks a low-vote title toward the global mean', () => {
  // 9.0 avg on only 50 votes -> (9*50 + 6.5*150) / 200 = 7.125
  const score = calculateScore({ vote_average: 9.0, vote_count: 50 });
  assert.ok(Math.abs(score - 7.125) < 0.01, `expected ~7.125, got ${score}`);
});

test('calculateScore ranks a well-rated gem above a lower-rated blockbuster', () => {
  const gem = calculateScore({ vote_average: 8.5, vote_count: 800 });
  const blockbuster = calculateScore({ vote_average: 7.7, vote_count: 8000 });
  assert.ok(gem > blockbuster, `gem ${gem} should beat blockbuster ${blockbuster}`);
});

test('calculateScore averages TMDB with RT when rtScore is present', () => {
  // (7.7 + 9.4)/2 = 8.55 combined, 8000 votes -> ~8.51
  const score = calculateScore({ vote_average: 7.7, vote_count: 8000, rtScore: 94 });
  assert.ok(Math.abs(score - 8.51) < 0.01, `expected ~8.51, got ${score}`);
});

test('calculateScore returns the global mean for a vote-less title', () => {
  const score = calculateScore({ vote_average: 8.0, vote_count: 0 });
  assert.ok(Math.abs(score - 6.5) < 0.01, `expected ~6.5, got ${score}`);
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
