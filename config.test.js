import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, CONFIG } from './config.js';

test('ENDPOINTS.recommendations builds /{type}/{id}/recommendations with default page 1', () => {
  const url = ENDPOINTS.recommendations('movie', 27205);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/27205/recommendations?`), url);
  assert.match(url, /[?&]api_key=/);
  assert.match(url, /[?&]page=1(&|$)/);
});

test('ENDPOINTS.recommendations honors an explicit page and tv type', () => {
  const url = ENDPOINTS.recommendations('tv', 1399, 3);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/tv/1399/recommendations?`), url);
  assert.match(url, /[?&]page=3(&|$)/);
});

test('ENDPOINTS.similar builds /{type}/{id}/similar with default page 1', () => {
  const url = ENDPOINTS.similar('movie', 27205);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/27205/similar?`), url);
  assert.match(url, /[?&]api_key=/);
  assert.match(url, /[?&]page=1(&|$)/);
});

test('ENDPOINTS.similar honors an explicit page', () => {
  const url = ENDPOINTS.similar('tv', 1399, 2);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/tv/1399/similar?`), url);
  assert.match(url, /[?&]page=2(&|$)/);
});

test('ENDPOINTS.appendDetail builds /{type}/{id} with the four appended sub-resources', () => {
  const url = ENDPOINTS.appendDetail('movie', 27205);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/27205?`), url);
  assert.match(url, /[?&]api_key=/);
  assert.match(url, /[?&]append_to_response=recommendations,similar,keywords,credits(&|$)/);
});

test('ENDPOINTS.appendDetail works for tv type and appends all of recommendations/similar/keywords/credits', () => {
  const url = ENDPOINTS.appendDetail('tv', 1399);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/tv/1399?`), url);
  // Exact value + order, mirroring the movie-type assertion (order matters per the contract).
  assert.match(url, /[?&]append_to_response=recommendations,similar,keywords,credits(&|$)/);
});

test('ENDPOINTS.topRated builds /{type}/top_rated with default page 1', () => {
  const url = ENDPOINTS.topRated('movie');
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/top_rated?`), url);
  assert.match(url, /[?&]api_key=/);
  assert.match(url, /[?&]page=1(&|$)/);
});

test('ENDPOINTS.topRated generalizes to tv and honors an explicit page', () => {
  const url = ENDPOINTS.topRated('tv', 4);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/tv/top_rated?`), url);
  assert.match(url, /[?&]page=4(&|$)/);
});

test('existing ENDPOINTS.topRatedMovies remains intact', () => {
  const url = ENDPOINTS.topRatedMovies(2);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/top_rated?`), url);
  assert.match(url, /[?&]page=2(&|$)/);
  // Intentional equivalence: topRated('movie') generalizes topRatedMovies (guards against drift).
  assert.equal(ENDPOINTS.topRated('movie', 2), ENDPOINTS.topRatedMovies(2));
});

// --- discoverByGenres (parameterized opts) ---

test('discoverByGenres: base url, type, genre csv, default page', () => {
  const url = ENDPOINTS.discoverByGenres('movie', '878|28');
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/movie?`), `got ${url}`);
  assert.ok(url.includes(`api_key=${CONFIG.API_KEY}`));
  assert.ok(url.includes('with_genres=878%7C28') || url.includes('with_genres=878|28'),
    `expected piped with_genres, got ${url}`);
  assert.ok(url.includes('page=1'));
  assert.ok(url.includes('sort_by=popularity.desc'));
});

test('discoverByGenres: opts add vote_count.gte and vote_average.gte', () => {
  const url = ENDPOINTS.discoverByGenres('movie', '878', 1, {
    voteCountGte: 100, voteAverageGte: 6,
  });
  assert.ok(url.includes('vote_count.gte=100'), `got ${url}`);
  assert.ok(url.includes('vote_average.gte=6'), `got ${url}`);
});

test('discoverByGenres: omits vote_average.gte when not provided', () => {
  const url = ENDPOINTS.discoverByGenres('movie', '878', 1, { voteCountGte: 50 });
  assert.ok(url.includes('vote_count.gte=50'));
  assert.ok(!url.includes('vote_average.gte'), `should omit vote_average, got ${url}`);
});

test('discoverByGenres: movie uses primary_release_date.gte from dateGte', () => {
  const url = ENDPOINTS.discoverByGenres('movie', '878', 1, { dateGte: '1970-01-01' });
  assert.ok(url.includes('primary_release_date.gte=1970-01-01'), `got ${url}`);
  assert.ok(!url.includes('first_air_date.gte'));
});

test('discoverByGenres: tv uses first_air_date.gte from dateGte', () => {
  const url = ENDPOINTS.discoverByGenres('tv', '10765', 2, { dateGte: '1970-01-01' });
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/tv?`));
  assert.ok(url.includes('page=2'));
  assert.ok(url.includes('first_air_date.gte=1970-01-01'), `got ${url}`);
  assert.ok(!url.includes('primary_release_date.gte'));
});

test('discoverByGenres: without_genres and without_keywords from opts', () => {
  const url = ENDPOINTS.discoverByGenres('movie', '878', 1, {
    withoutGenres: '27|53', withoutKeywords: '4565',
  });
  assert.ok(url.includes('without_genres=27%7C53') || url.includes('without_genres=27|53'),
    `got ${url}`);
  assert.ok(url.includes('without_keywords=4565'), `got ${url}`);
});

test('discoverByGenres: omits date and without_* when opts empty', () => {
  const url = ENDPOINTS.discoverByGenres('movie', '878');
  assert.ok(!url.includes('primary_release_date.gte'));
  assert.ok(!url.includes('first_air_date.gte'));
  assert.ok(!url.includes('without_genres'));
  assert.ok(!url.includes('without_keywords'));
});

// --- discoverByKeyword (parameterized opts) ---

test('discoverByKeyword: keyword id + opts gates', () => {
  const url = ENDPOINTS.discoverByKeyword('tv', '4379', 1, {
    voteCountGte: 20, voteAverageGte: 5, dateGte: '1970-01-01', withoutKeywords: '12377',
  });
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/tv?`));
  assert.ok(url.includes('with_keywords=4379'), `got ${url}`);
  assert.ok(url.includes('vote_count.gte=20'));
  assert.ok(url.includes('vote_average.gte=5'));
  assert.ok(url.includes('first_air_date.gte=1970-01-01'));
  assert.ok(url.includes('without_keywords=12377'));
});

test('discoverByKeyword: bare call still valid (default page, no opts)', () => {
  const url = ENDPOINTS.discoverByKeyword('movie', '9882');
  assert.ok(url.includes('with_keywords=9882'));
  assert.ok(url.includes('page=1'));
  assert.ok(!url.includes('vote_average.gte'));
});

// --- discoverByCast (parameterized opts) ---

test('discoverByCast: person id + opts gates', () => {
  const url = ENDPOINTS.discoverByCast('movie', '5', 2, {
    voteCountGte: 20, withoutGenres: '99',
  });
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/movie?`));
  assert.ok(url.includes('with_cast=5'), `got ${url}`);
  assert.ok(url.includes('page=2'));
  assert.ok(url.includes('vote_count.gte=20'));
  assert.ok(url.includes('without_genres=99'));
});

test('discoverByCast: bare call still valid (default page, no opts)', () => {
  const url = ENDPOINTS.discoverByCast('tv', '5');
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/tv?`));
  assert.ok(url.includes('with_cast=5'));
  assert.ok(url.includes('page=1'));
  assert.ok(!url.includes('vote_count.gte'), `bare call must not hardcode a vote floor, got ${url}`);
});
