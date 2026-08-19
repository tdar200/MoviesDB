// stream-window.test.js — which torrent pieces to prioritise for a byte range.
//
// The bug this pins down (Aug 19, 2026): a scene-release MP4 is often NOT
// "faststart", so its moov index sits at the END of the file. Chrome therefore
// issues two requests - bytes=0- and bytes=<near EOF>- - and cannot decode a single
// frame until it has read the tail. handleStream used to deselect the whole file
// and select ONE forward window per request, so the head and tail requests
// overwrote each other's piece priorities and neither ever completed: 40+ peers,
// megabytes per second, readyState stuck at 0 for two minutes.
//
// Prioritising the tail alongside the playhead is what makes non-faststart files
// playable at all. YTS movies are faststart, which is why only TV exposed this.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pieceWindow } from './stream-window.mjs';

const FILE = { offset: 0, length: 1_000_000 };  // 1MB file
const P = 16_384;                                // 16KB pieces => ~61 pieces

test('the forward window starts at the requested byte', () => {
  const w = pieceWindow({ file: FILE, pieceLength: P, start: 100_000, ahead: 10 });
  assert.equal(w.window.from, Math.floor(100_000 / P));
});

test('the forward window extends `ahead` pieces, clamped to the file end', () => {
  const w = pieceWindow({ file: FILE, pieceLength: P, start: 0, ahead: 10 });
  assert.equal(w.window.to, 10);
  const far = pieceWindow({ file: FILE, pieceLength: P, start: 990_000, ahead: 100 });
  assert.equal(far.window.to, w.fileEnd, 'must not select past the last piece of the file');
});

test('a tail range is always returned, covering the end of the file', () => {
  const w = pieceWindow({ file: FILE, pieceLength: P, start: 0, ahead: 10, tailBytes: 64_000 });
  assert.ok(w.tail, 'there must be a tail range');
  assert.equal(w.tail.to, w.fileEnd);
  assert.equal(w.tail.from, Math.floor((1_000_000 - 64_000) / P));
});

test('the tail never runs below the start of the file', () => {
  const w = pieceWindow({ file: FILE, pieceLength: P, start: 0, ahead: 10, tailBytes: 99_000_000 });
  assert.equal(w.tail.from, w.fileStart);
});

test('piece indexes are absolute, offset by the file position in the torrent', () => {
  // A season pack puts the episode far into the torrent; selection is torrent-wide.
  const w = pieceWindow({ file: { offset: 5_000_000, length: 1_000_000 }, pieceLength: P, start: 0, ahead: 4 });
  assert.equal(w.fileStart, Math.floor(5_000_000 / P));
  assert.equal(w.window.from, Math.floor(5_000_000 / P));
  assert.equal(w.fileEnd, Math.floor((5_000_000 + 1_000_000 - 1) / P));
});

test('the first few pieces from the playhead are marked critical', () => {
  const w = pieceWindow({ file: FILE, pieceLength: P, start: 0, ahead: 20, critical: 5 });
  assert.equal(w.critical.from, 0);
  assert.equal(w.critical.to, 5);
});

test('a tail request does not produce a window that swallows the whole file', () => {
  // Serving the tail must stay narrow, or it re-prioritises everything and starves
  // the playhead - which is exactly how the two requests used to fight.
  const w = pieceWindow({ file: FILE, pieceLength: P, start: 990_000, ahead: 256 });
  assert.ok(w.window.to - w.window.from < 10, 'window is clamped near the end of the file');
});

test('a zero-length file does not produce a negative range', () => {
  const w = pieceWindow({ file: { offset: 0, length: 0 }, pieceLength: P, start: 0, ahead: 10 });
  assert.ok(w.window.to >= w.window.from);
  assert.ok(w.tail.to >= w.tail.from);
});

test('every returned range is ordered and within the file', () => {
  for (const start of [0, 1, 500_000, 999_999]) {
    const w = pieceWindow({ file: FILE, pieceLength: P, start, ahead: 8, tailBytes: 32_000 });
    for (const [name, r] of Object.entries({ window: w.window, tail: w.tail, critical: w.critical })) {
      assert.ok(r.from <= r.to, `${name} inverted at start=${start}`);
      assert.ok(r.from >= w.fileStart && r.to <= w.fileEnd, `${name} out of file bounds at start=${start}`);
    }
  }
});
