// tv-fallback.js — walking the TV torrent list when a source has no peers.
//
// Comet's seed counts come from tracker scrapes that include private swarms this
// client cannot reach, so the top-ranked source is regularly unreachable while
// claiming dozens of seeds. Sitting on one such source for the full ready timeout
// looks identical to a slow start. Instead, try the next one automatically.

// A dead title should not walk all 73 sources: at ~20s each that is a 25-minute
// spinner. Stop after this many and tell the user plainly.
export const TV_SOURCE_ATTEMPT_CAP = 8;
export const TV_SOURCE_FAILURE_TTL_MS = 30 * 60 * 1000;

// Next source in rank order that has not been tried yet, or null when the list is
// exhausted or the cap is reached.
export function pickNextSource(sources, tried) {
  const list = Array.isArray(sources) ? sources : [];
  const seen = new Set(Array.isArray(tried) ? tried : []);
  if (seen.size >= TV_SOURCE_ATTEMPT_CAP) return null;
  const untried = list.filter((source) => source && !seen.has(source.hash));
  if (!untried.length) return null;

  // 1080p is the default, but tracker counts can point at dead private swarms.
  // Once the selected quality fails, try a different available resolution before
  // spending the attempt budget on another copy of the same resolution. This
  // makes the quality picker an actual fallback chain: 1080p first, then the best
  // available alternative, while retaining the remaining 1080p copies as a last resort.
  const lastHash = (Array.isArray(tried) ? tried : []).at(-1);
  const lastQuality = list.find((source) => source?.hash === lastHash)?.quality;
  if (lastQuality) {
    const alternate = untried.find((source) => source.quality !== lastQuality);
    if (alternate) return alternate;
  }
  return untried[0];
}

// Keep sources that recently failed at the end of a fresh episode lookup. They
// remain available as a last resort, but reopening the player no longer repeats
// the same dead private swarm before trying alternatives.
export function deferFailedSources(sources, failedUntil, now = Date.now()) {
  const list = Array.isArray(sources) ? sources : [];
  const active = [];
  const failed = [];
  for (const source of list) {
    const until = Number(failedUntil?.get?.(source?.hash)) || 0;
    (until > now ? failed : active).push(source);
  }
  return [...active, ...failed];
}

export function rememberSourceFailure(failedUntil, hash, now = Date.now(), ttlMs = TV_SOURCE_FAILURE_TTL_MS) {
  if (failedUntil?.set && hash) failedUntil.set(hash, now + ttlMs);
}

// The index's seed number is not shown as a live swarm count. It may include
// private or stale tracker entries. Once the helper connects, `connectedPeers`
// comes from WebTorrent's actual socket count and is safe to present as current.
export function describeTvSource(source = {}, connectedPeers = null) {
  const mode = source.transcode ? ' · HEVC→H.264 (GPU)' : source.remux ? ' · MKV→MP4' : '';
  const provider = source.provider ? ` · ${source.provider}` : '';
  const cached = source.debrid ? ' · ⚡ cached' : '';
  const live = !source.debrid && Number.isFinite(connectedPeers)
    ? ` · ${connectedPeers} connected`
    : '';
  return `${source.quality || 'unknown'}${cached}${live}${mode}${provider}`;
}

// Status text while a source is being tried. Naming the attempt number is the
// point: "Connecting to peers…" forever reads as progress, when in fact the first
// source was dead and the app had already moved on.
export function describeSourceAttempt({ attempt = 1, quality = '', remux = false, debrid = false, transcode = false } = {}) {
  const mode = transcode ? ' · HEVC→H.264 on GPU' : remux ? ' · preparing browser MP4' : '';
  const label = quality ? ` (${quality}${mode})` : '';
  // A debrid source is a cached file, not a swarm — "connecting to peers" would be
  // a lie, and there is nothing to wait on but the remux.
  if (debrid) {
    return attempt <= 1
      ? `Loading cached copy…${label}\nThis should be quick.`
      : `Cached source ${attempt}${label}…`;
  }
  return attempt <= 1
    ? `Connecting to peers…${label}\nFirst frames can take a moment.`
    : `Source ${attempt}${label} — the previous one had no reachable peers.`;
}

// The client asks for a shorter ready timeout so it can walk several sources in
// the time one dead source used to eat. It arrives from the query string, so
// clamp it: too small hammers the swarm, too large re-creates the original hang.
export function clampReadyTimeout(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 5000), 6 * 60 * 1000);
}
