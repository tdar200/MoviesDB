// guard-origins.js — which top-level origins count as "the MoviesDB app".
//
// Shared by background.js (tab-level) and defuse.js (frame-level). The guard only
// ever acts on frames embedded under one of these origins, so every other site the
// browser visits is left completely alone.
//
// Default: anywhere the app is served locally (`npm start` / `npm run serve`) or
// over the LAN. If you also host the app somewhere public, add its origin here,
// e.g.  /^https:\/\/moviesdb\.example\.com$/ .
//
// (Odd name on purpose: this runs in the page's main world, so it must not collide
// with any identifier a provider's own scripts might declare.)
const MOVIESDB_GUARD_ORIGINS__ = [
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/,
];

// Frames on these hosts are embedded by the app on purpose and open new tabs for
// legitimate reasons (YouTube's "Watch on YouTube"), so they are never guarded.
const MOVIESDB_GUARD_EXEMPT_HOSTS__ = /(^|\.)(youtube|youtube-nocookie)\.com$/i;

function moviesdbGuardIsAppOrigin__(origin) {
  return MOVIESDB_GUARD_ORIGINS__.some((re) => re.test(origin));
}
