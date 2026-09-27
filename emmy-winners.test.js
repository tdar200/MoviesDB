import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMMY_WINNERS } from './emmy-winners.js';

test('Emmy winners snapshot contains complete, unique TV cards', () => {
  assert.equal(EMMY_WINNERS.length, 20);
  assert.equal(new Set(EMMY_WINNERS.map(show => show.id)).size, EMMY_WINNERS.length);
  for (const show of EMMY_WINNERS) {
    assert.equal(show.media_type, 'tv');
    assert.ok(show.name);
    assert.match(show.poster_path, /^\//);
    assert.match(show.first_air_date, /^\d{4}-\d{2}-\d{2}$/);
  }
});
