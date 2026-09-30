// Tests for tv-rows.mjs — the pure row model behind the TV home screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogRowDefs, dedupeAcrossRows, dedupeItems, orderRowItems, titleKey, signalRows, sortItemsByRating, staticHomeRows } from './tv-rows.mjs';

test('dedupeItems dedupes progressively against a shared seen set', () => {
  const seen = new Set();
  const rowA = dedupeItems([{ id: 1, media_type: 'movie' }, { id: 2, media_type: 'movie' }], seen);
  const rowB = dedupeItems([{ id: 2, media_type: 'movie' }, { id: 3, media_type: 'movie' }], seen);
  assert.deepEqual(rowA.map(i => i.id), [1, 2]);
  assert.deepEqual(rowB.map(i => i.id), [3]);
});

test('titleKey separates movie and tv namespaces', () => {
  assert.notEqual(titleKey({ id: 7, media_type: 'movie' }), titleKey({ id: 7, media_type: 'tv' }));
});

test('sortItemsByRating orders highest first, keeps ties stable, and does not mutate', () => {
  const items = [
    { id: 1, vote_average: 7.1 },
    { id: 2, vote_average: 9.3 },
    { id: 3, vote_average: 9.3 },
    { id: 4 },
  ];
  assert.deepEqual(sortItemsByRating(items).map(item => item.id), [2, 3, 1, 4]);
  assert.deepEqual(items.map(item => item.id), [1, 2, 3, 4]);
});

test('orderRowItems preserves Continue Watching and rates every other rail', () => {
  const items = [{ id: 1, vote_average: 5 }, { id: 2, vote_average: 9 }];
  assert.deepEqual(orderRowItems({ key: 'continue', items }).map(item => item.id), [1, 2]);
  assert.deepEqual(orderRowItems({ key: 'mylist', items }).map(item => item.id), [2, 1]);
});

test('catalogRowDefs builds distinct TMDB feeds, not slices of one', () => {
  const defs = catalogRowDefs('KEY', 'https://api.themoviedb.org/3');
  const urls = defs.map(d => d.url);
  // Every row hits a different endpoint URL.
  assert.equal(new Set(urls).size, urls.length);
  // The staples a Netflix home expects are present.
  const keys = defs.map(d => d.key);
  for (const k of ['trending', 'popular', 'top_rated', 'now_playing']) assert.ok(keys.includes(k), `missing ${k}`);
  // The key is threaded into the query and the base is honoured.
  assert.ok(urls.every(u => u.includes('api_key=KEY')));
  assert.ok(urls.every(u => u.startsWith('https://api.themoviedb.org/3/')));
  // Genre rows carry a with_genres filter so they are genuinely different content.
  assert.ok(defs.some(d => /with_genres=\d/.test(d.url)));
  // Every row has a human title.
  assert.ok(defs.every(d => typeof d.title === 'string' && d.title.length));
});

test('catalogRowDefs defaults the TMDB base when omitted', () => {
  const defs = catalogRowDefs('KEY');
  assert.ok(defs.every(d => d.url.startsWith('https://api.themoviedb.org/3/')));
});

test('dedupeAcrossRows keeps a title only in its first row', () => {
  const rows = [
    { key: 'a', title: 'A', items: [{ id: 1, media_type: 'movie' }, { id: 2, media_type: 'movie' }] },
    { key: 'b', title: 'B', items: [{ id: 2, media_type: 'movie' }, { id: 3, media_type: 'movie' }] },
  ];
  const out = dedupeAcrossRows(rows);
  assert.deepEqual(out[0].items.map(i => i.id), [1, 2]);
  assert.deepEqual(out[1].items.map(i => i.id), [3]); // 2 was already shown in A
});

test('dedupeAcrossRows treats the same id in movie vs tv as different titles', () => {
  const rows = [
    { key: 'a', title: 'A', items: [{ id: 5, media_type: 'movie' }] },
    { key: 'b', title: 'B', items: [{ id: 5, media_type: 'tv' }] },
  ];
  const out = dedupeAcrossRows(rows);
  assert.equal(out.length, 2);
  assert.equal(out[1].items.length, 1);
});

test('dedupeAcrossRows infers movie vs tv when media_type is absent', () => {
  // Movie endpoints return items with `title` and no media_type; tv endpoints return `name`.
  const rows = [
    { key: 'a', title: 'A', items: [{ id: 9, title: 'Film Nine' }] },
    { key: 'b', title: 'B', items: [{ id: 9, name: 'Show Nine' }] },
  ];
  const out = dedupeAcrossRows(rows);
  assert.equal(out.length, 2, 'a movie and a show sharing an id are not the same title');
});

test('dedupeAcrossRows drops rows that empty out and skips junk items', () => {
  const rows = [
    { key: 'a', title: 'A', items: [{ id: 1, media_type: 'movie' }] },
    { key: 'b', title: 'B', items: [{ id: 1, media_type: 'movie' }, null, { title: 'no id' }] },
    { key: 'c', title: 'C', items: [] },
  ];
  const out = dedupeAcrossRows(rows);
  assert.deepEqual(out.map(r => r.key), ['a']);
});

test('signalRows surfaces Continue Watching and My List only when populated', () => {
  assert.deepEqual(signalRows({}), []);
  const rows = signalRows({
    continueWatching: [{ id: 1, media_type: 'movie' }],
    myList: [{ id: 2, media_type: 'tv' }],
  });
  assert.deepEqual(rows.map(r => r.key), ['continue', 'mylist']);
  assert.equal(rows[0].title, 'Continue Watching');
  assert.equal(rows[1].title, 'My List');
});

test('signalRows caps each row to the limit', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: i, media_type: 'movie' }));
  const rows = signalRows({ continueWatching: many }, 20);
  assert.equal(rows[0].items.length, 20);
});

test('staticHomeRows puts a capped IMDb Top 250 rail on All', () => {
  const imdbTop250 = Array.from({ length: 250 }, (_, i) => ({
    id: i + 1,
    title: `Rank ${i + 1}`,
    media_type: 'movie',
    imdb_rank: i + 1,
  }));
  const rows = staticHomeRows('all', { imdbTop250 }, 12);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'imdb_top250');
  assert.equal(rows[0].title, 'IMDb Top 250');
  assert.deepEqual(rows[0].items.map(movie => movie.imdb_rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const complete = staticHomeRows('all', { imdbTop250 }, imdbTop250.length);
  assert.equal(complete[0].items.length, 250);
  assert.equal(complete[0].items.at(-1).imdb_rank, 250);
});

test('staticHomeRows keeps the IMDb rail exclusive to All', () => {
  const imdbTop250 = [{ id: 1, title: 'One', media_type: 'movie', imdb_rank: 1 }];
  assert.deepEqual(staticHomeRows('movie', { imdbTop250 }), []);
  assert.deepEqual(staticHomeRows('tv', { imdbTop250 }), []);
  assert.deepEqual(staticHomeRows('all'), []);
});

test('staticHomeRows includes a complete Emmy winners rail on All', () => {
  const emmyWinners = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    name: `Winner ${i + 1}`,
    media_type: 'tv',
  }));
  const rows = staticHomeRows('all', { emmyWinners }, emmyWinners.length);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'emmy_winners');
  assert.equal(rows[0].title, 'Emmy Award Winners');
  assert.equal(rows[0].items.length, 20);
  assert.ok(rows[0].items.every(item => item.media_type === 'tv'));
});

test('staticHomeRows places IMDb and Emmy collections in distinct rails', () => {
  const imdbTop250 = [{ id: 1, title: 'Film', media_type: 'movie' }];
  const emmyWinners = [{ id: 1, name: 'Series', media_type: 'tv' }];
  assert.deepEqual(
    staticHomeRows('all', { imdbTop250, emmyWinners }).map(row => row.key),
    ['imdb_top250', 'emmy_winners'],
  );
});

test('a full assembly puts signal rows first and never repeats a title', () => {
  const assembled = dedupeAcrossRows([
    ...signalRows({ continueWatching: [{ id: 100, media_type: 'movie' }] }),
    { key: 'popular', title: 'Popular', items: [{ id: 100, media_type: 'movie' }, { id: 101, media_type: 'movie' }] },
  ]);
  assert.equal(assembled[0].key, 'continue');
  // 100 is in Continue Watching, so Popular shows only 101.
  assert.deepEqual(assembled[1].items.map(i => i.id), [101]);
});

test('orderRowItems leaves rows flagged noSort in their given order', () => {
  const items = [{ id: 1, vote_average: 1 }, { id: 2, vote_average: 9 }];
  assert.deepEqual(orderRowItems({ key: 'today', noSort: true, items }).map(i => i.id), [1, 2]);
  assert.deepEqual(orderRowItems({ key: 'today', items }).map(i => i.id), [2, 1]);
});

test('category rows are fetched highest-rated first, with a vote floor so obscure 10/10s do not lead', async () => {
  const { rowSources } = await import('./tv-rows.mjs');
  for (const kind of ['all', 'movie', 'tv']) {
    for (const d of catalogRowDefs('KEY', 'https://api.themoviedb.org/3', kind)) {
      for (const src of rowSources(d).filter(x => /\/discover\//.test(x.url))) {
        const q = new URL(src.url).searchParams;
        // The two weighted rows fetch a bounded POOL (recent by popularity, all-time by vote
        // count) and rank it by the weighted rating afterwards; every other category is
        // fetched highest-rated first. All of them have a vote floor.
        if (d.key === 'new_weighted') assert.equal(q.get('sort_by'), 'popularity.desc', `${kind}: ${d.title}`);
        else if (d.key === 'weighted_top') assert.equal(q.get('sort_by'), 'vote_count.desc', `${kind}: ${d.title}`);
        else assert.equal(q.get('sort_by'), 'vote_average.desc', `${kind}: ${d.title}`);
        assert.ok(Number(q.get('vote_count.gte')) >= 3, `${kind}: ${d.title} has a vote floor`);
      }
    }
  }
  const action = catalogRowDefs('KEY', undefined, 'all').find(d => d.title === 'Action & Adventure');
  const film = rowSources(action).find(x => x.mediaType === 'movie');
  assert.ok(Number(new URL(film.url).searchParams.get('vote_count.gte')) >= 500);
});

test('All tab: each category is one row mixing films and shows, not separate film and series rows', async () => {
  const { rowSources } = await import('./tv-rows.mjs');
  const all = catalogRowDefs('KEY', 'https://api.themoviedb.org/3', 'all');
  const titles = all.map(d => d.title);
  assert.equal(titles.some(t => / Series$/.test(t)), false, 'no "X Series" rows on All');
  assert.equal(new Set(titles).size, titles.length, 'one row per category');
  assert.ok(all.length >= 60, `${all.length} rows`);
  for (const t of ['Comedy', 'Drama', 'Crime', 'Documentaries', 'Horror', 'Heists', 'Pakistani', 'Korean', 'British', '90s Classics', 'On Netflix']) {
    const row = all.find(d => d.title === t);
    assert.ok(row, t);
    const kinds = rowSources(row).map(s => s.mediaType).sort();
    assert.deepEqual(kinds, ['movie', 'tv'], `${t} mixes films and shows`);
    for (const s of rowSources(row)) assert.match(s.url, new RegExp(`/discover/${s.mediaType}\\?`), `${t} ${s.mediaType}`);
  }
  // Core rails mix too; Trending is already mixed at the source.
  for (const key of ['popular', 'top_rated', 'now_playing', 'weighted_top']) {
    assert.deepEqual(rowSources(all.find(d => d.key === key)).map(s => s.mediaType).sort(), ['movie', 'tv'], key);
  }
  assert.match(all.find(d => d.key === 'trending').url, /\/trending\/all\//);
  const everyUrl = all.flatMap(d => rowSources(d).map(s => s.url));
  assert.equal(new Set(everyUrl).size, everyUrl.length, 'no two rows share a feed');
});

test('rowSourcesAtPage pages every source of a mixed row together', async () => {
  const { rowSourcesAtPage } = await import('./tv-rows.mjs');
  const comedy = catalogRowDefs('KEY', 'https://api.themoviedb.org/3', 'all').find(d => d.title === 'Comedy');
  const p3 = rowSourcesAtPage(comedy, 3);
  assert.equal(p3.length, 2);
  for (const s of p3) assert.match(s.url, /[?&]page=3(&|$)/);
  const single = rowSourcesAtPage({ url: 'https://x/y?a=1&page=1', mediaType: 'movie' }, 2);
  assert.deepEqual(single, [{ url: 'https://x/y?a=1&page=2', mediaType: 'movie', list: undefined }]);
});

test('rows sort by vote-weighted rating, so a 9.4 from few votes does not beat a well-rated classic', async () => {
  const { weightedRating } = await import('./tv-rows.mjs');
  const fewVotes = { id: 1, vote_average: 9.4, vote_count: 900 };
  const classic = { id: 2, vote_average: 8.7, vote_count: 28000 };
  const mid = { id: 3, vote_average: 8.5, vote_count: 20000 };
  assert.ok(weightedRating(classic) > weightedRating(fewVotes));
  assert.deepEqual(sortItemsByRating([fewVotes, mid, classic]).map(i => i.id), [2, 3, 1]);
  // No vote count (curated static lists): the plain rating stands.
  assert.equal(weightedRating({ vote_average: 8.1 }), 8.1);
  // Weighting pulls toward the mean, never past the raw rating.
  assert.ok(weightedRating(fewVotes) < 9.4 && weightedRating(fewVotes) > 6.8);
});
