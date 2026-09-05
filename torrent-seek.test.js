import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absolutePosition, seekTarget, seekToFraction, formatTime } from './torrent-seek.js';

test('absolutePosition adds the stream base to the video clock', () => {
  assert.equal(absolutePosition(600, 12), 612);
  assert.equal(absolutePosition(0, 5), 5);
  assert.equal(absolutePosition(-3, 0), 0);      // never negative
  assert.equal(absolutePosition(NaN, NaN), 0);
});

test('seekTarget jumps relative and clamps to the episode', () => {
  assert.equal(seekTarget(600, 10, 3600), 610);       // forward
  assert.equal(seekTarget(600, -30, 3600), 570);      // back
  assert.equal(seekTarget(5, -30, 3600), 0);          // cannot go before start
  assert.equal(seekTarget(3599, 30, 3600), 3599);     // cannot pass the end
});

test('seekToFraction maps a scrub-bar position to a time', () => {
  assert.equal(seekToFraction(0, 3600), 0);
  assert.equal(seekToFraction(0.5, 3600), 1800);
  assert.equal(seekToFraction(1, 3600), 3599);        // clamped just shy of the end
  assert.equal(seekToFraction(-1, 3600), 0);
  assert.equal(seekToFraction(2, 3600), 3599);
});

test('formatTime renders mm:ss and h:mm:ss', () => {
  assert.equal(formatTime(5), '0:05');
  assert.equal(formatTime(75), '1:15');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(-5), '0:00');
});
