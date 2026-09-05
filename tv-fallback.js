// tv-fallback.js — walking the TV torrent list when a source has no peers.
//
// Comet's seed counts come from tracker scrapes that include private swarms this
// client cannot reach, so the top-ranked source is regularly unreachable while
// claiming dozens of seeds. Sitting on one such source for the full ready timeout
// looks identical to a slow start. Instead, try the next one automatically.

// A dead title should not walk all 73 sources: at ~20s each that is a 25-minute
// spinner. Stop after this many and tell the user plainly.
export const TV_SOURCE_ATTEMPT_CAP = 5;

// Next source in rank order that has not been tried yet, or null when the list is
// exhausted or the cap is reached.
export function pickNextSource(sources, tried) {
  const list = Array.isArray(sources) ? sources : [];
  const seen = new Set(Array.isArray(tried) ? tried : []);
  if (seen.size >= TV_SOURCE_ATTEMPT_CAP) return null;
  return list.find((s) => s && !seen.has(s.hash)) || null;
}

// Status text while a source is being tried. Naming the attempt number is the
// point: "Connecting to peers…" forever reads as progress, when in fact the first
// source was dead and the app had already moved on.
export function describeSourceAttempt({ attempt = 1, quality = '', remux = false } = {}) {
  const mode = remux ? ' · preparing browser MP4' : '';
  const label = quality ? ` (${quality}${mode})` : '';
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
  return Math.min(Math.max(n, 5000), 60000);
}
