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
  for (const part of ['recommendations', 'similar', 'keywords', 'credits']) {
    assert.ok(url.includes(part), `expected ${part} in ${url}`);
  }
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
});
