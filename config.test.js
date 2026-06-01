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
