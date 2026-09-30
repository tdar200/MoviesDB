import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCompleteTvRow, TMDB_MAX_PAGE } from './tv-catalog.mjs';
import { titleKey, sortItemsByRating } from './tv-rows.mjs';

const film = (id, rating = 7, votes = 5000) => ({ id, title: `Film ${id}`, vote_average: rating, vote_count: votes });
const sources = { sources: [{ url: 'https://tmdb.test/movie/popular?page=1', mediaType: 'movie' }, { url: 'https://tmdb.test/tv/popular?page=1', mediaType: 'tv' }] };

test('complete mixed category fetches every source page and ranks late-page winners first', async () => {
  const calls = [];
  const all = { movie: [[film(1, 7)], [film(2, 9.2, 20)], [film(3, 8.8, 60000)], [film(4, 8)], [film(5, 8.5)], [film(6, 9, 100000)]], tv: [[{ id: 1, name: 'Show', vote_average: 8.9, vote_count: 800 }], [film(8, 8.5, 9000)]] };
  const row = await fetchCompleteTvRow(sources, async raw => {
    const url = new URL(raw), kind = url.pathname.split('/')[1], page = Number(url.searchParams.get('page'));
    calls.push(`${kind}:${page}`);
    return { results: all[kind][page - 1], total_pages: all[kind].length };
  });
  const truth = sortItemsByRating(Object.entries(all).flatMap(([media_type, pages]) => pages.flat().map(item => ({ ...item, media_type }))));
  assert.deepEqual(row.items.map(titleKey), truth.map(titleKey));
  assert.equal(row.items[0].id, 6, 'the last page contains the true winner');
  assert.equal(calls.length, 8);
  assert.equal(row.loadedPages, row.totalPages);
  assert.ok(!calls.includes('tv:3'), 'exhausted shorter feed is never requested again');
});

test('categories keep their whole membership and deduplicate only within the category', async () => {
  const def = { url: 'https://tmdb.test/discover/movie?page=1', mediaType: 'movie' };
  const fetchJson = async raw => ({ results: [film(1), film(Number(new URL(raw).searchParams.get('page')) + 1)], total_pages: 3 });
  const a = await fetchCompleteTvRow(def, fetchJson);
  const b = await fetchCompleteTvRow(def, fetchJson);
  assert.deepEqual(a.items.map(titleKey), b.items.map(titleKey));
  assert.equal(a.items.length, 4);
});

test('curated unpaged award lists use items and keep every title', async () => {
  let calls = 0;
  const row = await fetchCompleteTvRow({ url: 'https://tmdb.test/list/28', list: true }, async () => { calls++; return { items: Array.from({ length: 99 }, (_, i) => film(i + 1)) }; });
  assert.equal(calls, 1);
  assert.equal(row.items.length, 99);
});

test('failure of one source rejects the category instead of displaying a partial mixed list', async () => {
  let failures = 0;
  await assert.rejects(fetchCompleteTvRow(sources, async raw => {
    if (raw.includes('/tv/')) { failures++; throw Error('offline'); }
    return { results: [film(1)], total_pages: 1 };
  }), /offline/);
  assert.equal(failures, 2, 'one bounded retry');
});

test('a missing middle page is retried and included, never skipped', async () => {
  let failures = 0;
  const row = await fetchCompleteTvRow(sources.sources[0], async raw => {
    const page = Number(new URL(raw).searchParams.get('page'));
    if (page === 3 && failures++ === 0) throw Error('transient');
    return { results: [film(page)], total_pages: 5 };
  });
  assert.equal(row.items.length, 5);
  assert.equal(failures, 2);
});

test('navigation cancels further page scheduling and rejects incomplete data', async () => {
  let current = true, calls = 0;
  await assert.rejects(fetchCompleteTvRow(sources.sources[0], async () => { calls++; return { results: [film(1)], total_pages: 100 }; }, { isCurrent: () => current, onProgress: () => { current = false; } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('TMDB page limit is explicit and never requests invalid page 501', async () => {
  const pages = [];
  const row = await fetchCompleteTvRow(sources.sources[0], async raw => {
    const page = Number(new URL(raw).searchParams.get('page'));
    pages.push(page);
    return { results: [film(page)], total_pages: 900 };
  });
  assert.equal(Math.max(...pages), TMDB_MAX_PAGE);
  assert.equal(row.items.length, 500);
  assert.equal(row.limited, true);
});

test('malformed success payload cannot masquerade as an empty complete category', async () => {
  await assert.rejects(fetchCompleteTvRow(sources.sources[0], async () => ({ status_message: 'error' })), /no titles/);
});

test('failure stops sibling feeds from scheduling further pages or updating progress', async () => {
  const moviePages = [], progress = [];
  await assert.rejects(fetchCompleteTvRow(sources, async raw => {
    if (raw.includes('/tv/')) throw Error('offline');
    moviePages.push(Number(new URL(raw).searchParams.get('page')));
    await new Promise(resolve => setTimeout(resolve, 20));
    return { results: [film(1)], total_pages: 30 };
  }, { onProgress: state => progress.push(state) }), /offline/);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(moviePages, [1]);
  assert.deepEqual(progress, []);
});
