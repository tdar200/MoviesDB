// stream-window.mjs — which torrent pieces to prioritise for one byte range.
//
// Extracted from handleStream because it had a bug that only non-faststart files
// expose. A "faststart" MP4 carries its moov index at the front, so a player can
// decode from byte 0; plenty of scene releases do not, and their index sits at the
// END. Chrome then issues two requests, bytes=0- and bytes=<near EOF>-, and cannot
// render a single frame until the tail arrives.
//
// The old code deselected the whole file and selected ONE forward window per
// request, so those two requests overwrote each other's priorities and neither
// finished: 40+ peers, megabytes per second, readyState stuck at 0 (observed
// Aug 19, 2026 streaming a Severance episode). Returning a tail range alongside the
// playhead window - and selecting both - is what makes such files playable.
//
// Pure arithmetic, no torrent objects, so the edge cases are actually testable.

// Default forward run. Large enough to keep many peers busy, small enough to stay
// near the read position.
const AHEAD_PIECES = 256;
// Enough of the file end to contain a moov atom for a feature-length encode.
const TAIL_BYTES = 4 * 1024 * 1024;
// Pieces from the playhead marked critical (fetched first) for time-to-first-frame.
const CRITICAL_PIECES = 5;

// { file: {offset, length}, pieceLength, start } ->
//   { fileStart, fileEnd, window, tail, critical }  (all piece ranges, inclusive)
export function pieceWindow({
  file,
  pieceLength,
  start = 0,
  ahead = AHEAD_PIECES,
  tailBytes = TAIL_BYTES,
  critical = CRITICAL_PIECES,
}) {
  const pl = Math.max(1, Number(pieceLength) || 1);
  const offset = Math.max(0, Number(file?.offset) || 0);
  const length = Math.max(0, Number(file?.length) || 0);

  const fileStart = Math.floor(offset / pl);
  const fileEnd = Math.max(fileStart, Math.floor((offset + Math.max(0, length - 1)) / pl));

  const clamp = (p) => Math.min(fileEnd, Math.max(fileStart, p));
  const from = clamp(Math.floor((offset + Math.max(0, start)) / pl));

  return {
    fileStart,
    fileEnd,
    // The sequential run from the playhead.
    window: { from, to: clamp(from + Math.max(0, ahead)) },
    // The end of the file, so a moov-at-end index arrives without waiting for the
    // whole download. Cheap: a few pieces.
    tail: { from: clamp(Math.floor((offset + Math.max(0, length - tailBytes)) / pl)), to: fileEnd },
    // Fetched first, for time to first frame.
    critical: { from, to: clamp(from + Math.max(0, critical)) },
  };
}
