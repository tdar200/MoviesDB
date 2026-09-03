// helper-auth.js — the stream helper's access key.
//
// Once the helper is published to the public internet (Tailscale Funnel), anyone
// with the URL could make this machine download arbitrary torrents. So every
// helper API endpoint requires a shared key, passed as the `key` query parameter
// (a query parameter, not a header, because <video src> and <track src> cannot
// send headers). The static app itself stays open — the key is what the shared
// link carries (?helperkey=...), and the page keeps it in localStorage.
//
// Pure functions so they are unit-tested; stream-server.mjs calls
// helperRequestAllowed() once per request.

// Paths that touch torrents or their files. Everything else is the static app.
export const HELPER_API_PATHS = ['/yts', '/tv-torrents', '/subtitles', '/subtitle', '/stream', '/stream-status', '/stream-stop'];

export function isHelperApiPath(pathname) {
  return HELPER_API_PATHS.includes(pathname);
}

// True when the request may proceed. With no key configured the helper is open
// (local `npm start`); with one configured, API paths must present exactly it.
export function helperRequestAllowed({ pathname, searchParams, requiredKey }) {
  if (!requiredKey) return true;
  if (!isHelperApiPath(pathname)) return true;
  const given = searchParams?.get?.('key') || '';
  return timingSafeEqualStr(given, requiredKey);
}

// Constant-time comparison so the key cannot be guessed byte by byte.
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
