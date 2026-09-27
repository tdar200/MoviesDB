import test from 'node:test';
import assert from 'node:assert/strict';
import { liveHudState } from './tv-player.js';

test('liveHudState decides what the HUD shows for live vs on-demand', () => {
  assert.deepEqual(liveHudState(true), { showProgress: false, showSeekButtons: false, timeText: 'LIVE', help: 'OK Play / pause · Back Return' });
  assert.deepEqual(liveHudState(false), { showProgress: true, showSeekButtons: true, timeText: null, help: '← → Seek · OK Play / pause · Back Return' });
});
