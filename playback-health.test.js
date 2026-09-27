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
