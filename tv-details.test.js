import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTitleRecommendations } from './tv-details.js';

test('mergeTitleRecommendations combines recommendations then similar without duplicates or current title', () => {
  const current = { id: 10, media_type: 'movie' };
  const recommended = [
    { id: 10, title: 'Current' },
    { id: 20, title: 'First' },
    { id: 30, title: 'Second' },
  ];
  const similar = [
    { id: 20, title: 'Duplicate First' },
    { id: 40, title: 'Fallback' },
  ];
  const out = mergeTitleRecommendations(recommended, similar, current);
  assert.deepEqual(out.map(movie => movie.id), [20, 30, 40]);
  assert.ok(out.every(movie => movie.media_type === 'movie'));
});

test('mergeTitleRecommendations keeps movie and TV namespaces distinct and honors its limit', () => {
  const recommended = [
    { id: 5, title: 'Movie Five', media_type: 'movie' },
    { id: 5, name: 'TV Five', media_type: 'tv' },
    { id: 6, title: 'Movie Six', media_type: 'movie' },
  ];
  const out = mergeTitleRecommendations(recommended, [], { id: 99, media_type: 'movie' }, 2);
  assert.deepEqual(out.map(movie => `${movie.media_type}:${movie.id}`), ['movie:5', 'tv:5']);
});

test('mergeTitleRecommendations tolerates empty and malformed payloads', () => {
  assert.deepEqual(mergeTitleRecommendations(null, undefined, { id: 1, media_type: 'movie' }), []);
  assert.deepEqual(mergeTitleRecommendations([null, {}, { id: 2, title: 'Valid' }], [], null), [
    { id: 2, title: 'Valid', media_type: 'movie' },
  ]);
});
