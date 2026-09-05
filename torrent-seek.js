// torrent-seek.js — restart-at-timestamp seeking for the remuxed torrent player.
//
// A live-remuxed MKV is a fragmented MP4 with no seekable index: the browser's
// native scrub bar cannot move within it, so "go back and forth" did nothing.
// Instead the player reloads the stream at a new start time (?t=<seconds>) and
// ffmpeg restarts decoding there. The video's own clock then runs from 0, so the
// true position is base + video.currentTime. These pure helpers do that bookkeeping.

// The absolute position in the episode, given the offset the current stream was
// started at and how far the <video> has played since.
export function absolutePosition(baseOffset, videoCurrentTime) {
  return Math.max(0, (Number(baseOffset) || 0) + (Number(videoCurrentTime) || 0));
}

// Where to restart after a relative jump (arrow keys, skip buttons). Clamped to
// the episode so a seek past the end or before the start is impossible; stops a
// hair short of the end so there is always something to play.
export function seekTarget(currentAbsolute, deltaSeconds, duration) {
  const d = Number(duration) || 0;
  let t = (Number(currentAbsolute) || 0) + (Number(deltaSeconds) || 0);
  if (t < 0) t = 0;
  if (d > 0 && t > d - 1) t = Math.max(0, d - 1);
  return t;
}

// Absolute target for a scrub-bar fraction (0..1 of the whole episode).
export function seekToFraction(fraction, duration) {
  const d = Number(duration) || 0;
  let f = Number(fraction);
  if (!Number.isFinite(f)) f = 0;
  f = Math.min(1, Math.max(0, f));
  const t = f * d;
  return d > 0 && t > d - 1 ? Math.max(0, d - 1) : t;
}

// mm:ss / h:mm:ss for the time readout.
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}
