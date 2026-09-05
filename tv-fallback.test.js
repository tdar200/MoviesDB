// tv-fallback.test.js — choosing the next TV torrent when one has no peers.
//
// The bug: Comet ranks sources by a seed count that includes private-tracker
// swarms this client can never reach. Measured on Chernobyl S1E1 (2026-09-05),
// 13 of 14 sampled sources fetched no metadata in 45s while the index claimed
// 70/62/54/33/22/13 seeds; a control (Inception, Big Buck Bunny) connected at
// once, so BitTorrent itself was healthy. The app played source #1, sat on
// "Connecting to peers…" for the full 60s ready timeout, then stopped. With 73
// sources on offer, making the user hand-pick the live one is not a workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNextSource, describeSourceAttempt, clampReadyTimeout, TV_SOURCE_ATTEMPT_CAP } from './tv-fallback.js';

const sources = [
  { hash: 'aaa', quality: '1080p' },
  { hash: 'bbb', quality: '1080p' },
  { hash: 'ccc', quality: '720p' },
];

test('pickNextSource returns the first source when nothing has been tried', () => {
  assert.equal(pickNextSource(sources, [])?.hash, 'aaa');
});

test('pickNextSource skips every source already tried, in rank order', () => {
  assert.equal(pickNextSource(sources, ['aaa'])?.hash, 'bbb');
  assert.equal(pickNextSource(sources, ['aaa', 'bbb'])?.hash, 'ccc');
});

test('pickNextSource returns null once all sources are exhausted', () => {
  assert.equal(pickNextSource(sources, ['aaa', 'bbb', 'ccc']), null);
});

test('pickNextSource stops at the attempt cap so a dead title cannot loop forever', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ hash: 'h' + i, quality: '1080p' }));
  const tried = many.slice(0, TV_SOURCE_ATTEMPT_CAP).map((s) => s.hash);
  assert.equal(pickNextSource(many, tried), null);
});

test('pickNextSource tolerates junk input rather than throwing mid-playback', () => {
  assert.equal(pickNextSource(null, []), null);
  assert.equal(pickNextSource(sources, null)?.hash, 'aaa');
});

test('describeSourceAttempt says which attempt this is, not a bare "connecting"', () => {
  const msg = describeSourceAttempt({ attempt: 2, quality: '1080p', remux: true });
  assert.match(msg, /2/);
  assert.match(msg, /1080p/);
});

test('describeSourceAttempt names the remux step only when remuxing', () => {
  assert.match(describeSourceAttempt({ attempt: 1, quality: '1080p', remux: true }), /MP4/i);
  assert.doesNotMatch(describeSourceAttempt({ attempt: 1, quality: '1080p', remux: false }), /MP4/i);
});

// The 60s default exists for movies, where there is one source and waiting is
// right. Walking 5 TV sources at 60s each is 5 minutes of spinner, so the client
// asks for a shorter wait. Clamped because it arrives from the query string.
test('clampReadyTimeout honours a sane client request', () => {
  assert.equal(clampReadyTimeout('20000', 60000), 20000);
});

test('clampReadyTimeout falls back when the value is absent or junk', () => {
  assert.equal(clampReadyTimeout('', 60000), 60000);
  assert.equal(clampReadyTimeout('abc', 60000), 60000);
  assert.equal(clampReadyTimeout(null, 60000), 60000);
});

test('clampReadyTimeout refuses a value that would hammer or hang the helper', () => {
  assert.equal(clampReadyTimeout('1', 60000), 5000);
  assert.equal(clampReadyTimeout('999999', 60000), 60000);
});
