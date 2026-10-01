import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackHealth, bufferRecovery } from './playback-health.js';
test('a source with metadata but no playback progress times out', () => {
 let state = playbackHealth(null, { now: 0, time: 0, paused: false, started: false });
 state = playbackHealth(state, { now: 30001, time: 0, paused: false, started: false });
 assert.equal(state.stalled, true);
});
test('progress renews the deadline, while an intentional pause never fails over', () => {
 let state = playbackHealth(null, { now: 0, time: 0, paused: false, started: false });
 state = playbackHealth(state, { now: 29000, time: 10, paused: false, started: true });
 assert.equal(state.stalled, false);
 state = playbackHealth(state, { now: 99000, time: 10, paused: true, started: true });
 assert.equal(state.stalled, false);
 state = playbackHealth(state, { now: 120000, time: 10, paused: false, started: true });
 assert.equal(state.stalled, false);
 assert.equal(playbackHealth(state, { now: 130000, time: 10, paused: false, started: true }).stalled, true);
});

test('buffer recovery requires sustained low buffer and insufficient throughput', () => {
 let state = bufferRecovery(null, { now: 0, bufferedSeconds: 1, readyState: 2, paused: false, downloadSpeed: 400, requiredSpeed: 500 });
 assert.equal(state.recover, false);
 state = bufferRecovery(state, { now: 15001, bufferedSeconds: 1, readyState: 2, paused: false, downloadSpeed: 400, requiredSpeed: 500 });
 assert.equal(state.recover, true);
});

test('buffer recovery resets when playback, buffer, or throughput is healthy', () => {
 const hungry = { since: 0, recover: false };
 assert.equal(bufferRecovery(hungry, { now: 20000, bufferedSeconds: 5, readyState: 2, paused: false, downloadSpeed: 400, requiredSpeed: 500 }).recover, false);
 assert.equal(bufferRecovery(hungry, { now: 20000, bufferedSeconds: 1, readyState: 4, paused: false, downloadSpeed: 400, requiredSpeed: 500 }).recover, false);
 assert.equal(bufferRecovery(hungry, { now: 20000, bufferedSeconds: 1, readyState: 2, paused: false, downloadSpeed: 700, requiredSpeed: 500 }).recover, false);
 assert.equal(bufferRecovery(hungry, { now: 20000, bufferedSeconds: 1, readyState: 2, paused: true, downloadSpeed: 400, requiredSpeed: 500 }).recover, false);
});

// A torrent that is already 100% on disk needs no download speed at all: its "download speed" is ~0 B/s forever, which the
// starvation rule read as "too slow to sustain playback" and used to restart or switch a perfectly good, fully local movie.
test('bufferRecovery never fires for a fully downloaded torrent, however empty the buffer is', () => {
  const starving = { bufferedSeconds: 0.2, readyState: 2, paused: false, downloadSpeed: 500, requiredSpeed: 330_000 };
  let state = null;
  for (let t = 0; t <= 60_000; t += 3000) {
    state = bufferRecovery(state, { now: t, ...starving, downloadComplete: true });
    assert.equal(state.recover, false, `still no recovery at ${t} ms`);
  }
  // The same conditions on a torrent that is still downloading DO recover after the timeout (unchanged behaviour).
  let live = null;
  for (let t = 0; t <= 16_000; t += 3000) live = bufferRecovery(live, { now: t, ...starving, downloadComplete: false });
  assert.equal(live.recover, true);
  // Omitting the flag keeps the old behaviour.
  let legacy = null;
  for (let t = 0; t <= 16_000; t += 3000) legacy = bufferRecovery(legacy, { now: t, ...starving });
  assert.equal(legacy.recover, true);
});

import { connectionVerdict } from './playback-health.js';
const limits = { noPeersMs: 13000, noDataMs: 22000, slowMs: 20000, minSustainBps: 700 * 1024 };

test('connectionVerdict: a fully downloaded torrent is never dead or too slow (it is a local file)', () => {
  // 0 peers, 0 B/s, nothing "downloaded" since we started watching: all true of a complete file.
  assert.deepEqual(connectionVerdict({ elapsed: 60000, peers: 0, progress: 1, maxProgress: 1, maxSpeed: 0, ...limits }), { dead: false, tooSlow: false });
  assert.deepEqual(connectionVerdict({ elapsed: 60000, peers: 46, progress: 1, maxProgress: 1, maxSpeed: 500, ...limits }), { dead: false, tooSlow: false });
});

test('connectionVerdict: unchanged for a torrent that is still downloading', () => {
  assert.equal(connectionVerdict({ elapsed: 14000, peers: 0, progress: 0.2, maxProgress: 0.2, maxSpeed: 0, ...limits }).dead, true, 'no peers for 13 s');
  assert.equal(connectionVerdict({ elapsed: 23000, peers: 5, progress: 0, maxProgress: 0, maxSpeed: 0, ...limits }).dead, true, 'peers but no bytes for 22 s');
  assert.equal(connectionVerdict({ elapsed: 21000, peers: 5, progress: 0.01, maxProgress: 0.01, maxSpeed: 200 * 1024, ...limits }).tooSlow, true, 'peak speed cannot sustain 1080p');
  assert.deepEqual(connectionVerdict({ elapsed: 21000, peers: 5, progress: 0.01, maxProgress: 0.01, maxSpeed: 3 * 1024 * 1024, ...limits }), { dead: false, tooSlow: false }, 'a fast one is kept');
  assert.deepEqual(connectionVerdict({ elapsed: 5000, peers: 0, progress: 0, maxProgress: 0, maxSpeed: 0, ...limits }), { dead: false, tooSlow: false }, 'too early to judge');
});
