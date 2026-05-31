import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatchTimer } from './watch-timer.js';

test('createWatchTimer starts at zero elapsed', () => {
  const t = createWatchTimer();
  assert.equal(t.elapsed(1000), 0);
  assert.equal(t.isActive, false);
});

test('accumulates while active, measured against injected now', () => {
  const t = createWatchTimer();
  t.start(1000);
  assert.equal(t.isActive, true);
  assert.equal(t.elapsed(1500), 500);   // 500ms into an active interval
  assert.equal(t.elapsed(3000), 2000);
});

test('pause freezes accumulation; time while paused does not count', () => {
  const t = createWatchTimer();
  t.start(1000);
  t.pause(2000);                 // 1000ms accrued
  assert.equal(t.isActive, false);
  assert.equal(t.elapsed(9999), 1000); // later time does not add while paused
});

test('multiple start/pause intervals sum (trailer/hidden gaps excluded)', () => {
  const t = createWatchTimer();
  t.start(0);
  t.pause(60_000);     // watched 60s
  t.start(200_000);    // (gap = trailer / hidden, excluded)
  t.pause(320_000);    // watched another 120s
  assert.equal(t.elapsed(320_000), 180_000); // 60s + 120s = 3 min
});

test('start is idempotent — a second start does not reset the interval origin', () => {
  const t = createWatchTimer();
  t.start(1000);
  t.start(1400);                 // ignored
  assert.equal(t.elapsed(2000), 1000);
});

test('pause while inactive is a no-op', () => {
  const t = createWatchTimer();
  t.pause(5000);
  assert.equal(t.elapsed(6000), 0);
});

test('elapsed while active includes the in-progress interval', () => {
  const t = createWatchTimer();
  t.start(1000);
  t.pause(2000);     // 1000
  t.start(5000);     // active again
  assert.equal(t.elapsed(5500), 1500); // 1000 + 500 in-progress
});

test('reset zeroes everything', () => {
  const t = createWatchTimer();
  t.start(0);
  t.pause(10_000);
  t.reset();
  assert.equal(t.elapsed(99_999), 0);
  assert.equal(t.isActive, false);
});

test('never goes negative if now precedes since (clock skew guard)', () => {
  const t = createWatchTimer();
  t.start(5000);
  assert.equal(t.elapsed(4000), 0);
});
