import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeImportPayload,
  decodeImportPayload,
  mergeImportIntoStores,
} from './profile-import.js';

const snap = (id, title, extra = {}) => ({
  id,
  media_type: 'movie',
  genre_ids: [28, 878],
  vote_average: 8.2,
  title,
  poster_path: `/p${id}.jpg`,
  release_date: '1999-03-31',
  ...extra,
});

test('encode → decode roundtrips a payload', () => {
  const payload = {
    v: 1,
    loved: [snap(603, 'The Matrix')],
    liked: [snap(348, 'Alien')],
    seen: [snap(4944, 'Whiplash')],
    down: [snap(155, 'The Dark Knight')],
  };
  const encoded = encodeImportPayload(payload);
  assert.equal(typeof encoded, 'string');
  // base64url: no chars that need URI-encoding in a hash
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.deepEqual(decodeImportPayload(encoded), payload);
});

test('decode rejects garbage and wrong shapes with null', () => {
  assert.equal(decodeImportPayload('not-base64!!!'), null);
  assert.equal(decodeImportPayload(''), null);
  assert.equal(decodeImportPayload(null), null);
  // valid base64 of valid JSON, but not an import payload
  const notPayload = encodeImportPayload({ v: 1 });
  // hand-roll a wrong-shape blob: v mismatch
  const wrongVersion = Buffer.from(JSON.stringify({ v: 2, loved: [] }), 'utf8')
    .toString('base64url');
  assert.equal(decodeImportPayload(wrongVersion), null);
  // entries must have a numeric id and a title or name
  const badEntry = Buffer.from(
    JSON.stringify({ v: 1, loved: [{ title: 'No id' }] }), 'utf8').toString('base64url');
  assert.equal(decodeImportPayload(badEntry), null);
  // minimal-but-valid payload decodes (empty tiers are fine)
  assert.deepEqual(decodeImportPayload(notPayload),
    { v: 1, loved: [], liked: [], seen: [], down: [] });
});

test('merge routes tiers to the right stores with the right marks', () => {
  const payload = {
    v: 1,
    loved: [snap(603, 'The Matrix')],
    liked: [snap(348, 'Alien')],
    seen: [snap(4944, 'Whiplash')],
    down: [snap(155, 'The Dark Knight')],
  };
  const out = mergeImportIntoStores(payload,
    { starred: {}, downvoted: {}, seen: {} }, 1000000);

  assert.equal(out.starred[603].reaction, 'loved');
  assert.equal(out.starred[348].reaction, 'liked');
  assert.equal(out.starred[603].title, 'The Matrix');
  assert.ok(out.starred[603].starredAt > 0);
  assert.ok(out.seen[4944].seenAt > 0);
  assert.ok(out.downvoted[155].downvotedAt > 0);
  assert.equal(out.added, 4);
});

test('merge never overrides an existing user signal for the same id', () => {
  const payload = {
    v: 1,
    loved: [snap(155, 'The Dark Knight')],   // user already downvoted this
    liked: [snap(603, 'The Matrix')],        // user already loved this
    seen: [snap(348, 'Alien')],              // user already liked this
    down: [snap(4944, 'Whiplash')],          // user already marked seen
  };
  const stores = {
    starred: {
      603: { id: 603, title: 'The Matrix', reaction: 'loved', starredAt: 5 },
      348: { id: 348, title: 'Alien', reaction: 'liked', starredAt: 4 },
    },
    downvoted: { 155: { id: 155, title: 'The Dark Knight', downvotedAt: 3 } },
    seen: { 4944: { id: 4944, title: 'Whiplash', seenAt: 2 } },
  };
  const out = mergeImportIntoStores(payload, stores, 1000000);

  assert.equal(out.starred[603].reaction, 'loved');
  assert.equal(out.starred[603].starredAt, 5);
  assert.equal(out.starred[348].reaction, 'liked');
  assert.ok(out.downvoted[155]);
  assert.equal(out.starred[155], undefined);
  assert.ok(out.seen[4944]);
  assert.equal(out.downvoted[4944], undefined);
  assert.equal(out.added, 0);
});

test('merge staggers starredAt so payload order becomes basket order', () => {
  const payload = {
    v: 1,
    loved: [snap(1, 'First'), snap(2, 'Second'), snap(3, 'Third')],
    liked: [snap(4, 'Fourth')],
    seen: [],
    down: [],
  };
  const out = mergeImportIntoStores(payload,
    { starred: {}, downvoted: {}, seen: {} }, 1000000);

  // Basket sorts by starredAt descending — earlier payload entries must sort first.
  assert.ok(out.starred[1].starredAt > out.starred[2].starredAt);
  assert.ok(out.starred[2].starredAt > out.starred[3].starredAt);
  assert.ok(out.starred[3].starredAt > out.starred[4].starredAt);
});

test('merge strips fields outside the signal-snapshot shape', () => {
  const dirty = { ...snap(603, 'The Matrix'), _seeds: ['x'], evil: 'payload', score: 99 };
  const out = mergeImportIntoStores(
    { v: 1, loved: [dirty], liked: [], seen: [], down: [] },
    { starred: {}, downvoted: {}, seen: {} }, 1000000);

  assert.equal(out.starred[603].evil, undefined);
  assert.equal(out.starred[603]._seeds, undefined);
  assert.equal(out.starred[603].score, undefined);
  assert.equal(out.starred[603].title, 'The Matrix');
  assert.deepEqual(out.starred[603].genre_ids, [28, 878]);
});

test('decode survives a hash payload that went through encodeURIComponent', () => {
  const payload = { v: 1, loved: [snap(603, 'Amélie — 天使')], liked: [], seen: [], down: [] };
  const encoded = encodeImportPayload(payload);
  assert.deepEqual(decodeImportPayload(encodeURIComponent(encoded)), payload);
});
