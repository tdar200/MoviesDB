// Tests for ENDPOINTS.discoverFull — the TV filter view's TMDB discover query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS } from './config.js';

test('discoverFull builds a genre+rating+year+sort+language query for movies', () => {
  const url = ENDPOINTS.discoverFull('movie', 2, { genreId: 28, minRating: 7, yearGte: '2020', sortBy: 'vote_average.desc', language: 'en' });
  assert.ok(url.startsWith('https://api.themoviedb.org/3/discover/movie?'), url);
  const q = new URL(url).searchParams;
  assert.equal(q.get('with_genres'), '28');
  assert.equal(q.get('vote_average.gte'), '7');
  assert.equal(q.get('vote_count.gte'), '200'); // a rating floor adds a vote floor
  assert.equal(q.get('primary_release_date.gte'), '2020-01-01');
  assert.equal(q.get('sort_by'), 'vote_average.desc');
  assert.equal(q.get('with_original_language'), 'en');
  assert.equal(q.get('page'), '2');
});

test('discoverFull uses first_air_date for tv year and defaults sort', () => {
  const url = ENDPOINTS.discoverFull('tv', 1, { yearGte: '2019' });
  const q = new URL(url).searchParams;
  assert.equal(q.get('first_air_date.gte'), '2019-01-01');
  assert.equal(q.get('sort_by'), 'popularity.desc');
});

test('discoverFull honours an explicit vote floor and provider', () => {
  const url = ENDPOINTS.discoverFull('movie', 1, { minVotes: 1000, providerId: 8, excludeGenres: '16,27' });
  const q = new URL(url).searchParams;
  assert.equal(q.get('vote_count.gte'), '1000');
  assert.equal(q.get('with_watch_providers'), '8');
  assert.equal(q.get('without_genres'), '16,27');
});

test('discoverFull omits unset filters', () => {
  const q = new URL(ENDPOINTS.discoverFull('movie', 1, {})).searchParams;
  assert.equal(q.get('with_genres'), null);
  assert.equal(q.get('vote_average.gte'), null);
  assert.equal(q.get('with_watch_providers'), null);
  assert.equal(q.get('with_original_language'), null);
  assert.equal(q.get('api_key') && q.get('page'), '1');
});
