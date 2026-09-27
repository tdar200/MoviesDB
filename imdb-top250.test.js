import test from 'node:test';
import assert from 'node:assert/strict';
import { IMDB_TOP_250, IMDB_TOP_250_SNAPSHOT_DATE } from './imdb-top250.js';

test('IMDb Top 250 snapshot is complete, ranked, and uniquely mapped to TMDB', () => {
  assert.match(IMDB_TOP_250_SNAPSHOT_DATE, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(IMDB_TOP_250.length, 250);
  assert.deepEqual(IMDB_TOP_250.map(movie => movie.imdb_rank),
    Array.from({ length: 250 }, (_, index) => index + 1));
  assert.equal(new Set(IMDB_TOP_250.map(movie => movie.id)).size, 250);
  for (const movie of IMDB_TOP_250) {
    assert.equal(movie.media_type, 'movie');
    assert.equal(typeof movie.id, 'number');
    assert.ok(movie.title);
    assert.ok(movie.poster_path);
  }
});
