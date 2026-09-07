// Advance the deadline only on real playback progress, not 'playing' events.
export function playbackHealth(previous, { now, time, paused, started, timeoutMs = 30000 }) {
  if (!previous || time > previous.time + 0.25 || (paused && started)) return { time, since: now, stalled: false };
  return { time: previous.time, since: previous.since, stalled: now - previous.since >= timeoutMs };
}
