// profile-import.js
// Seed the signal stores (basket / seen / downvoted) from a portable payload carried
// in the URL hash: https://site/#import=<base64url JSON>. localStorage is per-browser
// and per-origin, so a taste profile built anywhere else can't follow the user here —
// this is the bridge. Pure functions only; script.js owns the localStorage glue.

const TIERS = ['loved', 'liked', 'seen', 'down'];

// Mirrors signalSnapshot() in script.js — the only fields a store entry may carry.
const SNAPSHOT_FIELDS = [
  'id', 'media_type', 'genre_ids', 'vote_average', 'title', 'name',
  'poster_path', 'release_date', 'first_air_date', 'overview',
];

function sanitizeSnapshot(entry) {
  const out = {};
  for (const f of SNAPSHOT_FIELDS) {
    if (entry[f] !== undefined) out[f] = entry[f];
  }
  return out;
}

function isValidEntry(e) {
  return !!e && typeof e === 'object' && typeof e.id === 'number'
    && (typeof e.title === 'string' || typeof e.name === 'string');
}

// btoa/atob exist in browsers and in Node >= 16; escape/unescape make them UTF-8 safe.
function toBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b64)));
}

export function encodeImportPayload(payload) {
  const full = { v: 1 };
  for (const tier of TIERS) full[tier] = payload[tier] || [];
  return toBase64Url(JSON.stringify(full));
}

// Returns a normalized payload ({v:1, loved, liked, seen, down} — arrays always
// present) or null for anything malformed. Tolerates the hash having gone through
// encodeURIComponent (some apps re-encode location.hash).
export function decodeImportPayload(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  let parsed;
  try {
    let raw = encoded;
    if (raw.includes('%')) raw = decodeURIComponent(raw);
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null;
  const out = { v: 1 };
  for (const tier of TIERS) {
    const list = parsed[tier] ?? [];
    if (!Array.isArray(list) || !list.every(isValidEntry)) return null;
    out[tier] = list;
  }
  return out;
}

// Merge a decoded payload into plain store objects ({starred, downvoted, seen} keyed
// by id). An id the user has already marked — in ANY store — is skipped entirely: the
// user's own signal always wins, which also makes re-importing the same link a no-op.
// starredAt/seenAt/downvotedAt are staggered downward from `now` so payload order
// becomes the basket's display order (it sorts descending).
export function mergeImportIntoStores(payload, stores, now) {
  const starred = { ...stores.starred };
  const downvoted = { ...stores.downvoted };
  const seen = { ...stores.seen };
  const taken = (id) => id in starred || id in downvoted || id in seen;

  let added = 0;
  let offset = 0;
  const stamp = () => now - (offset++);

  for (const entry of payload.loved) {
    if (taken(entry.id)) continue;
    starred[entry.id] = { ...sanitizeSnapshot(entry), reaction: 'loved', starredAt: stamp() };
    added++;
  }
  for (const entry of payload.liked) {
    if (taken(entry.id)) continue;
    starred[entry.id] = { ...sanitizeSnapshot(entry), reaction: 'liked', starredAt: stamp() };
    added++;
  }
  for (const entry of payload.seen) {
    if (taken(entry.id)) continue;
    seen[entry.id] = { ...sanitizeSnapshot(entry), seenAt: stamp() };
    added++;
  }
  for (const entry of payload.down) {
    if (taken(entry.id)) continue;
    downvoted[entry.id] = { ...sanitizeSnapshot(entry), downvotedAt: stamp() };
    added++;
  }
  return { starred, downvoted, seen, added };
}
