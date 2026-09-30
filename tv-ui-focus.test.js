import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTvCards } from './tv-ui.js';

test('a new page goes after the cards already in the rail, best rated first', () => {
  const children = ['shown-1', 'shown-2']; // cards the viewer has already scrolled past
  const track = { append(card) { children.push(card); } };
  const page = [
    { id: 'low', vote_average: 6, vote_count: 5000 },
    { id: 'high', vote_average: 9, vote_count: 5000 },
    { id: 'mid', vote_average: 7.5, vote_count: 5000 },
  ];
  appendTvCards(track, page, null, movie => movie.id);
  assert.deepEqual(children, ['shown-1', 'shown-2', 'high', 'mid', 'low']);
});

test('appendTvCards tolerates a missing track', () => {
  assert.doesNotThrow(() => appendTvCards(null, [{ id: 1 }], null, movie => movie.id));
});
