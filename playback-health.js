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
  timeoutMs = 15000, headroom = 1.15, downloadComplete = false,
}) {
  // Download speed only predicts a stall while there is something left to download. A torrent that is already
  // 100% on disk reports ~0 B/s forever, and that is not starvation.
  if (downloadComplete) return { since: null, recover: false };
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

// Is the source we are waiting on dead (no peers / no bytes) or too slow to sustain 1080p? Judged on swarm numbers, so it
// only applies while there is something left to download: a torrent that is already complete is a local file, which needs
// no peers, no bytes and no speed (it reports 0 peers and ~0 B/s while idle, and was wrongly treated as dead / too slow).
export function connectionVerdict({ elapsed, peers = 0, progress = 0, maxProgress = 0, maxSpeed = 0, noPeersMs, noDataMs, slowMs, minSustainBps }) {
  if (Number(progress) >= 1) return { dead: false, tooSlow: false };
  const dead = (elapsed > noPeersMs && Number(peers) === 0) || (elapsed > noDataMs && maxProgress <= 0.0005);
  const tooSlow = elapsed > slowMs && maxSpeed > 0 && maxSpeed < minSustainBps;
  return { dead, tooSlow };
}
