// Tests for tv-rows.mjs — the pure row model behind the TV home screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogRowDefs, dedupeAcrossRows, dedupeItems, titleKey, signalRows } from './tv-rows.mjs';

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

test('a full assembly puts signal rows first and never repeats a title', () => {
  const assembled = dedupeAcrossRows([
    ...signalRows({ continueWatching: [{ id: 100, media_type: 'movie' }] }),
    { key: 'popular', title: 'Popular', items: [{ id: 100, media_type: 'movie' }, { id: 101, media_type: 'movie' }] },
  ]);
  assert.equal(assembled[0].key, 'continue');
  // 100 is in Continue Watching, so Popular shows only 101.
  assert.deepEqual(assembled[1].items.map(i => i.id), [101]);
});
