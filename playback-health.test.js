import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackHealth } from './playback-health.js';
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
