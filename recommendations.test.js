import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recencyWeight, ratingNudge, buildTasteProfile } from './recommendations.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed clock for deterministic tests

test('recencyWeight decays ~half over 30 days', () => {
  const fresh = recencyWeight(NOW, NOW);
  const month = recencyWeight(NOW - 30 * DAY, NOW);
  assert.equal(fresh, 1);
  assert.ok(month > 0.49 && month < 0.51, `expected ~0.5, got ${month}`);
});

test('recencyWeight defaults to 0.5 when watchedAt missing', () => {
  assert.equal(recencyWeight(undefined, NOW), 0.5);
});

test('ratingNudge maps 0-10 into 0.75..1.25, neutral when missing', () => {
  assert.equal(ratingNudge(0), 1);
  assert.equal(ratingNudge(undefined), 1);
  assert.equal(ratingNudge(10), 1.25);
  assert.equal(ratingNudge(5), 1.0);
});

test('buildTasteProfile aggregates weighted genres, keywords, people', () => {
  const watched = [
    { id: 1, media_type: 'movie', title: 'A', genre_ids: [878, 28], vote_average: 8,
      watchedAt: NOW, _keywords: [{ id: 9, name: 'time travel' }], _people: [{ id: 5, name: 'Nolan' }] },
    { id: 2, media_type: 'tv', name: 'B', genre_ids: [878], vote_average: 6,
      watchedAt: NOW - 60 * DAY, _keywords: [{ id: 9, name: 'time travel' }], _people: [] },
  ];
  const p = buildTasteProfile(watched, NOW);
  assert.ok(p.genres['878'] > p.genres['28']);
  assert.equal(p.keywords['9'].name, 'time travel');
  assert.equal(p.people['5'].name, 'Nolan');
  assert.ok(p.mediaTypeBias.movie > 0 && p.mediaTypeBias.tv > 0);
  assert.equal(p.topTitles[0].id, 1);
  assert.deepEqual(p.topTitles[0].keywordIds, [9]);
});
