import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogRowDefs, orderFeedItems, RECENT_DAYS } from './tv-rows.mjs';
import { fetchCompleteTvRow } from './tv-catalog.mjs';
import { categoryCacheIdentity } from './tv-catalog-cache.mjs';

const BASE = 'https://api.themoviedb.org/3';
const defsOf = kind => Object.fromEntries(catalogRowDefs('K', BASE, kind).map(d => [d.key, d]));
const DAY = 864e5;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const daysAgo = n => new Date(NOW - n * DAY).toISOString().slice(0, 10);

test('rows that mean "what is hot / new" keep their own order; only "best of" rows rank by rating', () => {
  for (const kind of ['all', 'movie', 'tv']) {
    const d = defsOf(kind);
    assert.equal(d.trending.order, 'feed', `${kind}: Trending keeps TMDB's trending rank`);
    assert.equal(d.popular.order, 'popularity', `${kind}: Popular ranks by popularity`);
    assert.equal(d.now_playing.order, 'recent', `${kind}: New Releases is about recency`);
    assert.ok(!d.highly_rated, `${kind}: "Critically Acclaimed" was the same six titles as "Highest Weighted Rating", so it is gone`);
    // Top Rated is TMDB's plain average, so it is visibly different from the weighted row.
    assert.equal(d.top_rated.order, 'raw', `${kind}: Top Rated ranks by the raw average`);
    // "Hot / new" rows are short feeds: 500 pages of Trending rated by stars made it a second Top Rated.
    for (const key of ['trending', 'popular', 'now_playing', 'top_rated']) assert.ok(d[key].maxPages >= 1 && d[key].maxPages <= 10, `${kind}: ${key} is a short feed`);
  }
});

test('orderFeedItems: feed keeps source order, popularity sorts by popularity, rating by weighted rating', () => {
  const items = [
    { id: 1, title: 'A', popularity: 10, vote_average: 9.5, vote_count: 10 },
    { id: 2, title: 'B', popularity: 90, vote_average: 6.0, vote_count: 50000 },
    { id: 3, title: 'C', popularity: 50, vote_average: 8.0, vote_count: 50000 },
  ];
  assert.deepEqual(orderFeedItems({ order: 'feed' }, items).map(i => i.id), [1, 2, 3]);
  assert.deepEqual(orderFeedItems({ order: 'popularity' }, items).map(i => i.id), [2, 3, 1]);
  // Weighted: C (8.0, 50k votes) ~7.97 > A (9.5, 10 votes, pulled to ~6.83) > B (6.0, 50k votes) ~6.01.
  assert.deepEqual(orderFeedItems({}, items).map(i => i.id), [3, 1, 2], 'default = weighted rating (a 9.5 from 10 votes does not lead)');
  // The raw average ranks by the plain rating, ties broken by the vote count (so it differs from the weighted order).
  assert.deepEqual(orderFeedItems({ order: 'raw' }, items).map(i => i.id), [1, 3, 2]);
  assert.deepEqual(orderFeedItems({ order: 'raw' }, [{ id: 1, vote_average: 8, vote_count: 10 }, { id: 2, vote_average: 8, vote_count: 900 }]).map(i => i.id), [2, 1]);
});

test('New Releases drops old theatrical re-releases (Shawshank in now_playing) and leads with what is popular', () => {
  const movies = [
    { id: 278, title: 'The Shawshank Redemption', release_date: '1994-09-23', popularity: 500, vote_average: 8.7, vote_count: 30000 },
    { id: 299534, title: 'Avengers: Endgame', release_date: '2019-04-24', popularity: 400, vote_average: 8.2, vote_count: 28000 },
    { id: 11, title: 'Fresh Film', release_date: daysAgo(10), popularity: 80, vote_average: 7.0, vote_count: 300 },
    { id: 12, title: 'Hot New Film', release_date: daysAgo(25), popularity: 300, vote_average: 6.5, vote_count: 900 },
    { id: 13, title: 'Last Spring', release_date: daysAgo(RECENT_DAYS + 30), popularity: 200, vote_average: 8.0, vote_count: 2000 },
  ];
  const shows = [{ id: 900, name: 'Airing Show', first_air_date: '2019-01-01', popularity: 150, vote_average: 8.0, vote_count: 900 }];
  const out = orderFeedItems({ order: 'recent' }, [...movies.map(m => ({ ...m, media_type: 'movie' })), ...shows.map(s => ({ ...s, media_type: 'tv' }))], NOW);
  assert.deepEqual(out.map(i => i.id), [12, 900, 11], 'recent films + currently airing shows, most popular first');
});

test('a series that is on the air is kept however old its premiere (that is what "new episodes" means)', () => {
  const out = orderFeedItems({ order: 'recent' }, [{ id: 1, name: 'Long Runner', first_air_date: '1989-12-17', media_type: 'tv', popularity: 5 }], NOW);
  assert.equal(out.length, 1);
});

test('fetchCompleteTvRow reads only maxPages of a short feed, and orders it by the row order', async () => {
  const def = { key: 'trending', title: 'Trending', url: `${BASE}/trending/all/week?api_key=K&page=1`, order: 'feed', maxPages: 3 };
  const pages = [];
  const fetchJson = async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    return { total_pages: 500, results: [{ id: page * 10 + 1, media_type: 'movie', title: `p${page}a`, vote_average: 5, vote_count: 10 }, { id: page * 10 + 2, media_type: 'movie', title: `p${page}b`, vote_average: 9.9, vote_count: 99999 }] };
  };
  const row = await fetchCompleteTvRow(def, fetchJson);
  assert.deepEqual([...pages].sort((a, b) => a - b), [1, 2, 3], 'not 500 pages');
  assert.deepEqual(row.items.map(i => i.id), [11, 12, 21, 22, 31, 32], 'feed order, not re-ranked by stars');
  assert.equal(row.loadedPages, 3);
  assert.equal(row.totalPages, 3, 'a complete (capped) row: loadedPages equals totalPages so the cache accepts it');
});

test('a rating row still reads its complete membership', async () => {
  const def = catalogRowDefs('K', BASE, 'movie').find(d => d.key === 'g35');
  const pages = [];
  const fetchJson = async url => { const page = Number(new URL(url).searchParams.get('page')); pages.push(page); return { total_pages: 5, results: [{ id: page, media_type: 'movie', title: `m${page}`, vote_average: page, vote_count: 5000 }] }; };
  const row = await fetchCompleteTvRow(def, fetchJson);
  assert.equal(pages.length, 5);
  assert.deepEqual(row.items.map(i => i.id), [5, 4, 3, 2, 1], 'best rated first');
});

test('cache identity: rows whose meaning changed get new keys; every rating row keeps its existing key', () => {
  // Keys recorded from the shipped build. A change here would orphan the stored / hosted
  // snapshots of hundreds-of-pages categories on every TV.
  const pinned = {
    'all:mg-comedy': 'v1-e0b0a335aa51262f', 'all:l28': 'v1-deb01cedec03e68b',
    'movie:g35': 'v1-b2765cfeb9bfce60', 'movie:l28': 'v1-deb01cedec03e68b',
    'tv:g35': 'v1-2594c4ed71a53bf3',
  };
  const oldFeedKeys = {
    'all:trending': 'v1-20d5839b4928de65', 'all:popular': 'v1-11bb689f1198ce09', 'all:now_playing': 'v1-1a86e85a6afc3744',
    'movie:trending': 'v1-b5560bb46da1b582', 'movie:popular': 'v1-a834ed99f80b651b', 'movie:now_playing': 'v1-2f4c88d1363c7ba3',
    'tv:trending': 'v1-59672df26b6709c0', 'tv:popular': 'v1-6e18a789adde13db', 'tv:now_playing': 'v1-49a4a0ecc817f9be',
    // Top Rated is now the raw average (a short feed), no longer a weighted complete-membership row.
    'all:top_rated': 'v1-ecbda18f7a43ee61', 'movie:top_rated': 'v1-154b2cfae38b7000', 'tv:top_rated': 'v1-6b9fbd90312b11ee',
  };
  for (const [id, key] of Object.entries(pinned)) {
    const [kind, rowKey] = id.split(':');
    assert.equal(categoryCacheIdentity(defsOf(kind)[rowKey]).key, key, `${id} must keep its key`);
  }
  for (const [id, oldKey] of Object.entries(oldFeedKeys)) {
    const [kind, rowKey] = id.split(':');
    assert.notEqual(categoryCacheIdentity(defsOf(kind)[rowKey]).key, oldKey, `${id} changed meaning, so the old rating-sorted snapshot must not be reused`);
  }
});

test('a "Best New Releases" row (recent pool, weighted rank) and a weighted-rating row sit near the top of every tab', () => {
  for (const kind of ['all', 'movie', 'tv']) {
    const defs = catalogRowDefs('K', BASE, kind);
    const keys = defs.map(d => d.key);
    const d = Object.fromEntries(defs.map(x => [x.key, x]));
    assert.ok(keys.indexOf('new_weighted') >= 0 && keys.indexOf('new_weighted') <= 3, `${kind}: Best New Releases is within the first four rows, got ${keys.indexOf('new_weighted')}`);
    assert.ok(keys.indexOf('weighted_top') >= 0 && keys.indexOf('weighted_top') <= 7, `${kind}: the weighted row is near the top`);
    assert.equal(keys.indexOf('new_weighted') > keys.indexOf('now_playing'), true, `${kind}: it follows the plain New Releases row`);
    // Both are ranked by the weighted rating (the default order) from a bounded pool.
    for (const key of ['new_weighted', 'weighted_top']) {
      assert.ok(!d[key].order || d[key].order === 'rating', `${kind}: ${key} ranks by weighted rating`);
      assert.ok(d[key].maxPages >= 1 && d[key].maxPages <= 25, `${kind}: ${key} has a bounded pool`);
    }
    // "New" means released recently: every source is date-floored to a month boundary that is
    // stable for the whole month (a daily-changing URL would miss the cache every day).
    for (const src of (d.new_weighted.sources || [{ url: d.new_weighted.url }])) {
      const u = new URL(src.url);
      const floor = u.searchParams.get('primary_release_date.gte') || u.searchParams.get('first_air_date.gte');
      assert.match(floor, /^\d{4}-\d{2}-01$/, `${kind}: floored to the first of a month`);
      assert.ok(Date.now() - Date.parse(floor) > 150 * DAY && Date.now() - Date.parse(floor) < 240 * DAY, `${kind}: about six months back`);
    }
  }
});

test('newSinceDate is the first of the month NEW_MONTHS back, identical for every day of a month', async () => {
  const { newSinceDate } = await import('./tv-rows.mjs');
  assert.equal(newSinceDate(Date.parse('2026-09-30T23:59:00Z')), '2026-03-01');
  assert.equal(newSinceDate(Date.parse('2026-09-01T00:00:00Z')), '2026-03-01');
  assert.equal(newSinceDate(Date.parse('2026-01-15T00:00:00Z')), '2025-07-01');
});

test('the weighted New row ranks by the weighted rating: a well-voted 7.9 beats a 9.4 from a handful of votes', async () => {
  const def = catalogRowDefs('K', BASE, 'movie').find(d => d.key === 'new_weighted');
  const fetchJson = async () => ({ total_pages: 1, results: [
    { id: 1, media_type: 'movie', title: 'Tiny 9.4', vote_average: 9.4, vote_count: 120, release_date: daysAgo(30) },
    { id: 2, media_type: 'movie', title: 'Solid 7.9', vote_average: 7.9, vote_count: 6000, release_date: daysAgo(40) },
    { id: 3, media_type: 'movie', title: 'Middling', vote_average: 6.0, vote_count: 6000, release_date: daysAgo(50) },
  ] });
  const row = await fetchCompleteTvRow(def, fetchJson);
  assert.deepEqual(row.items.map(i => i.id), [2, 1, 3]);
});

test('daily talk, news and soap shows do not swamp the hot / new rows, but rating rows keep them', () => {
  const items = [
    { id: 1, name: 'Late Night', media_type: 'tv', genre_ids: [10767, 35], popularity: 900, vote_average: 6, vote_count: 500, first_air_date: '2010-01-01' },
    { id: 2, name: 'Evening News', media_type: 'tv', genre_ids: [10763], popularity: 800, vote_average: 6, vote_count: 500, first_air_date: '2005-01-01' },
    { id: 3, name: 'Daily Soap', media_type: 'tv', genre_ids: [10766, 18], popularity: 700, vote_average: 6, vote_count: 500, first_air_date: '2005-01-01' },
    { id: 4, name: 'A Real Drama', media_type: 'tv', genre_ids: [18], popularity: 100, vote_average: 8, vote_count: 500, first_air_date: '2024-01-01' },
    { id: 5, title: 'A Film', media_type: 'movie', genre_ids: [28], popularity: 50, vote_average: 7, vote_count: 500, release_date: daysAgo(10) },
  ];
  for (const order of ['feed', 'popularity', 'recent']) {
    assert.deepEqual(orderFeedItems({ order }, items, NOW).map(i => i.id).sort(), [4, 5], `${order} drops the noise`);
  }
  assert.equal(orderFeedItems({}, items, NOW).length, 5, 'a rating row keeps everything');
});
