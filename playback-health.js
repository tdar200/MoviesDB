// Advance the deadline only on real playback progress, not 'playing' events.
export function playbackHealth(previous, { now, time, paused, started, timeoutMs = 30000 }) {
  if (!previous || time > previous.time + 0.25 || (paused && started)) return { time, since: now, stalled: false };
  return { time: previous.time, since: previous.since, stalled: now - previous.since >= timeoutMs };
}

// Predict an imminent buffer stall from both browser state and measured torrent
// throughput. Every signal must agree, avoiding source churn when native HLS merely
// reports a small buffer while it is still decoding smoothly.
export function bufferRecovery(previous, {
  now, bufferedSeconds, readyState, paused, downloadSpeed, requiredSpeed,
  timeoutMs = 15000, headroom = 1.15,
}) {
  const starving = !paused
    && Number(readyState) < 3
    && Number(bufferedSeconds) < 2
    && Number(downloadSpeed) > 0
    && Number(requiredSpeed) > 0
    && Number(downloadSpeed) < Number(requiredSpeed) * headroom;
  if (!starving) return { since: null, recover: false };
  const since = previous?.since ?? now;
  return { since, recover: now - since >= timeoutMs };
}
