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
import {
  pickNextSource, describeSourceAttempt, clampReadyTimeout, TV_SOURCE_ATTEMPT_CAP,
  deferFailedSources, rememberSourceFailure, TV_SOURCE_FAILURE_TTL_MS,
  describeTvSource,
} from './tv-fallback.js';

const sources = [
  { hash: 'aaa', quality: '1080p' },
  { hash: 'bbb', quality: '1080p' },
  { hash: 'ccc', quality: '720p' },
];

test('pickNextSource returns the first source when nothing has been tried', () => {
  assert.equal(pickNextSource(sources, [])?.hash, 'aaa');
});

test('pickNextSource leaves a failed 1080p source for an available alternative', () => {
  assert.equal(pickNextSource(sources, ['aaa'])?.hash, 'ccc');
  assert.equal(pickNextSource(sources, ['aaa', 'ccc'])?.hash, 'bbb');
});

test('pickNextSource retains same-quality copies as later fallbacks', () => {
  const mixed = [
    { hash: 'a', quality: '1080p' },
    { hash: 'b', quality: '1080p' },
    { hash: 'c', quality: '1080p' },
    { hash: 'd', quality: '720p' },
  ];
  assert.equal(pickNextSource(mixed, ['a'])?.hash, 'd');
  assert.equal(pickNextSource(mixed, ['a', 'd'])?.hash, 'b');
  assert.equal(pickNextSource(mixed, ['a', 'd', 'b'])?.hash, 'c');
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

test('recently failed sources move to the end until their quarantine expires', () => {
  const failures = new Map();
  rememberSourceFailure(failures, 'aaa', 1000);
  assert.deepEqual(deferFailedSources(sources, failures, 1001).map((s) => s.hash), ['bbb', 'ccc', 'aaa']);
  assert.deepEqual(
    deferFailedSources(sources, failures, 1000 + TV_SOURCE_FAILURE_TTL_MS + 1).map((s) => s.hash),
    ['aaa', 'bbb', 'ccc'],
  );
});

test('TV source labels omit unreliable index seeds and show actual connected peers', () => {
  const source = { quality: '1080p', seeds: 116, remux: true, provider: 'Comet' };
  assert.equal(describeTvSource(source), '1080p · MKV→MP4 · Comet');
  assert.equal(describeTvSource(source, 0), '1080p · 0 connected · MKV→MP4 · Comet');
  assert.equal(describeTvSource(source, 4), '1080p · 4 connected · MKV→MP4 · Comet');
  assert.doesNotMatch(describeTvSource(source, 4), /116|seed/i);
});

test('cached source labels do not claim a BitTorrent peer count', () => {
  assert.equal(describeTvSource({ quality: '1080p', debrid: true }, 0), '1080p · ⚡ cached');
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
  assert.equal(clampReadyTimeout('999999', 60000), 360000);
});

test('clampReadyTimeout permits the five-minute torrent startup grace period', () => {
  assert.equal(clampReadyTimeout('312000', 60000), 312000);
});
