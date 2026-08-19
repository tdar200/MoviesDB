// yts-api.mjs — YTS metadata lookup for the local stream helper.
//
// Why this is its own module: the lookup is the single most failure-prone step in
// the torrent path, and it fails for a reason nothing in the app can control.
// UK (and many other) ISPs block the YTS domains under court order, so from a
// home connection the hosts are intermittently unreachable: `yts.mx` never
// resolves at all, and the others come and go. Measured Aug 18, 2026 on a UK line
// three rounds apart: round 1 all three hosts failed, rounds 2-3 all fine.
//
// The old implementation tried the hosts in SERIES with a 12s timeout each, so one
// blocked host cost the user 12s of "Finding a torrent…" before the next was even
// attempted, and a bad moment cost 36s and then an error. Here we:
//   - race every host at once, so the slowest never gates the fastest,
//   - prefer an answer that actually contains the movie over an empty one,
//   - retry the whole race once, since the failures are transient,
//   - cache successes, and serve a STALE cache entry rather than fail, because a
//     slightly old torrent list is far more useful than an error the user can do
//     nothing about.

// Tried in order of proven reliability; `yts.mx` is kept last because it is the
// most widely DNS-blocked, but racing means its failure costs nothing.
export const YTS_HOSTS = [
  'https://movies-api.accel.li/api/v2',
  'https://yts.bz/api/v2',
  'https://yts.mx/api/v2',
];

export const YTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// imdb id -> { movie, at }. Entries are never evicted on failure: an expired one
// is still the best answer available when every host is blocked.
const cache = new Map();

export function clearYtsCache() {
  cache.clear();
}

// One host attempt. Resolves with { movie } on a valid payload (movie may be null
// when YTS simply does not have the title); rejects on anything else, so the race
// below can ignore it.
async function askHost(base, imdb, { fetchImpl, timeoutMs }) {
  const api = `${base}/list_movies.json?query_term=${encodeURIComponent(imdb)}`;
  const res = await fetchImpl(api, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow', // yts.bz answers 301 to its canonical host
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${base} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body?.status !== 'ok' || !body?.data) throw new Error(`${base} -> unexpected payload`);
  return { movie: body.data.movies?.[0] || null };
}

// Race every host. Returns { movie } from the first host that has the movie, or
// { movie: null } if hosts answered but none had it. Throws if all of them failed.
async function raceHosts(imdb, { hosts, fetchImpl, timeoutMs }) {
  let announce;
  const firstWithMovie = new Promise((resolve) => { announce = resolve; });

  const attempts = hosts.map((base) =>
    askHost(base, imdb, { fetchImpl, timeoutMs }).then(
      (hit) => {
        if (hit.movie) announce(hit); // short-circuit the race
        return hit;
      },
      (err) => { throw new Error(`${base}: ${err?.message || err}`); }
    )
  );

  // Whichever comes first: a host with the movie, or every host settling.
  const all = Promise.allSettled(attempts);
  const winner = await Promise.race([firstWithMovie, all.then(() => null)]);
  if (winner) return winner;

  const settled = await all;
  if (settled.some((s) => s.status === 'fulfilled')) return { movie: null }; // answered, not on YTS
  const err = new Error('YTS lookup failed on every host');
  err.hostErrors = settled.map((s) => s.reason?.message || String(s.reason));
  throw err;
}

// Look up one movie by IMDb id.
// Returns the YTS movie object, or null when YTS genuinely does not have it.
// Throws (with .hostErrors) only when no host could be reached at all AND there is
// nothing cached to fall back on.
export async function fetchYtsMovie(imdb, {
  hosts = YTS_HOSTS,
  fetchImpl = fetch,
  timeoutMs = 8000,
  ttlMs = YTS_CACHE_TTL_MS,
  retries = 1,
  retryDelayMs = 1200,
  now = () => Date.now(),
} = {}) {
  const cached = cache.get(imdb);
  if (cached && now() - cached.at < ttlMs) return cached.movie;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      const { movie } = await raceHosts(imdb, { hosts, fetchImpl, timeoutMs });
      if (movie) cache.set(imdb, { movie, at: now() });
      return movie;
    } catch (err) {
      lastErr = err;
    }
  }

  // Every host is down. A stale answer beats a dead end.
  if (cached) return cached.movie;
  throw lastErr;
}
