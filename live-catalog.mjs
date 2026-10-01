// live-catalog.mjs — the Channels tab: vetted free live channels grouped by
// category. The lists in channels/*.json were built by measuring every stream
// (true resolution via ffprobe) and keeping only official or broadcaster-run
// streams reachable from the UK without workarounds. At runtime the helper
// re-probes them in the background and serves only the ones that are alive.
import { isDeniedHost } from './live-channels.mjs';
import { isPublicHttpUrl } from './live-relay.mjs';
import { youtubeEmbedUrl } from './live-youtube.mjs';

export const CATEGORY_ORDER = [
  'News', 'General', 'Entertainment', 'Movies', 'Series', 'Documentary', 'Kids', 'Music', 'Sports',
  'Comedy', 'Classic TV', 'Lifestyle', 'Food', 'Travel & Outdoor', 'Education & Science', 'Business',
  'Religious', 'Weather', 'Shopping',
];

// Merge several vetted lists: official streams only, public http(s) hosts that
// are not known restream hosts, one entry per id and per url (sharpest wins).
// Row order within a category: the owner's languages first (English, then Urdu,
// Punjabi, Hindi, Arabic), then everything else; resolution breaks ties.
const LANGUAGE_ORDER = ['en', 'ur', 'pa', 'hi', 'ar'];
function langRank(e) {
  const i = LANGUAGE_ORDER.indexOf(String(e.language || '').toLowerCase().slice(0, 2));
  return i < 0 ? LANGUAGE_ORDER.length : i;
}
const isUk = e => /^(gb|uk)$/i.test(String(e.country || ''));

export function mergeCatalog(lists) {
  const byId = new Map();
  for (const list of lists || []) {
    for (const raw of list || []) {
      if (!raw || !raw.id || !raw.url || raw.official !== true) continue;
      if (!isPublicHttpUrl(raw.url) || isDeniedHost(raw.url)) continue;
      const e = { ...raw, category: CATEGORY_ORDER.includes(raw.category) ? raw.category : 'General', height: Number(raw.height) || 0 };
      const prev = byId.get(e.id);
      if (!prev || e.height > prev.height) byId.set(e.id, e);
    }
  }
  const byUrl = new Map();
  for (const e of byId.values()) {
    const prev = byUrl.get(e.url);
    if (!prev || e.height > prev.height) byUrl.set(e.url, e);
  }
  // The same channel often appears in several lists under different ids
  // (e.g. a Pluto channel via iptv-org and via the platform's own list).
  const byName = new Map();
  for (const e of byUrl.values()) {
    const key = e.category + '|' + String(e.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const prev = byName.get(key);
    if (!prev || e.height > prev.height) byName.set(key, e);
  }
  return Array.from(byName.values());
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createCatalogFeed({ entries, probe, now = Date.now, ttlMs = 30 * 60_000, concurrency = 16, rowLimit = 100 }) {
  const list = entries.slice();
  let alive = null; // Map id -> measured height, after the first full probe
  let lastAt = 0;
  let inFlight = null;

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const results = await mapLimit(list, concurrency, async e => {
        try { return await probe(e); } catch { return { status: 'error' }; }
      });
      const next = new Map();
      results.forEach((r, i) => { if (r && r.status === 'ok') next.set(list[i].id, r.height || 0); });
      alive = next;
      lastAt = now();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  function current() {
    // Before the first probe completes, serve the stored list (it was vetted).
    if (!alive) return list.map(e => ({ ...e }));
    return list.filter(e => alive.has(e.id)).map(e => ({ ...e, height: alive.get(e.id) || e.height }));
  }

  // Country rows first (the owner's picks): Pakistan, India news, India. Those
  // channels leave the generic rows, which ~90 Indian news channels would
  // otherwise crowd. Within a country row: category order, language, height.
  const COUNTRY_ROWS = [
    { name: 'Pakistan', match: e => e.country === 'PK' },
    { name: 'India · News', match: e => e.country === 'IN' && e.category === 'News' },
    { name: 'India', match: e => e.country === 'IN' },
  ];
  function categories() {
    const byQuality = (a, b) => langRank(a) - langRank(b) || (isUk(b) - isUk(a)) || b.height - a.height || String(a.name).localeCompare(String(b.name));
    const rest = [];
    const countryGroups = COUNTRY_ROWS.map(() => []);
    for (const e of current()) {
      const i = COUNTRY_ROWS.findIndex(r => r.match(e));
      if (i >= 0) countryGroups[i].push(e); else rest.push(e);
    }
    const out = [];
    COUNTRY_ROWS.forEach((r, i) => {
      if (!countryGroups[i].length) return;
      out.push({ name: r.name, channels: countryGroups[i].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || byQuality(a, b)).slice(0, rowLimit) });
    });
    const groups = new Map();
    for (const e of rest) {
      if (!groups.has(e.category)) groups.set(e.category, []);
      groups.get(e.category).push(e);
    }
    for (const name of CATEGORY_ORDER) if (groups.has(name)) out.push({ name, channels: groups.get(name).sort(byQuality).slice(0, rowLimit) });
    return out;
  }


  return {
    refresh,
    categories,
    get: id => current().find(e => e.id === id) || null,
    stale: () => !alive || now() - lastAt > ttlMs,
    size: () => list.length,
  };
}

// Some platform channels store a URL template instead of a fixed URL:
//   {channelId}  the part after "<platform>:" in the entry id
//   {plexToken}  a free anonymous Plex token the helper mints
//   {stitcherParams} / {sessionToken}  a Pluto session from its public start
//                endpoint (no account), minted by the helper about daily
// Anything else cannot be filled here and the entry is left out.
export function resolveTemplates(entries, { plexToken = '', plutoSession = null } = {}) {
  const out = [];
  for (const e of entries || []) {
    if (!e.urlTemplate) { out.push(e); continue; }
    const channelId = String(e.id).includes(':') ? String(e.id).slice(String(e.id).indexOf(':') + 1) : String(e.id);
    let url = e.urlTemplate.split('{channelId}').join(encodeURIComponent(channelId));
    if (url.includes('{plexToken}')) {
      if (!plexToken) continue;
      url = url.split('{plexToken}').join(encodeURIComponent(plexToken));
    }
    if (url.includes('{stitcherParams}') || url.includes('{sessionToken}')) {
      if (!plutoSession || !plutoSession.stitcherParams || !plutoSession.sessionToken) continue;
      // stitcherParams is already a query string; the token goes in as one value.
      url = url.split('{stitcherParams}').join(plutoSession.stitcherParams)
        .split('{sessionToken}').join(encodeURIComponent(plutoSession.sessionToken));
    }
    if (/\{[A-Za-z]+\}/.test(url)) continue;
    const { urlTemplate, ...rest } = e;
    out.push({ ...rest, url });
  }
  return out;
}

// What /live/catalog sends the TV for one channel. HLS channels play through the signed relay (/live/ch); a channel
// that is only an official YouTube live stream has nothing to relay: it carries the embed url when its owner allows
// embedding (played in the TV's embed player), or its channel id when not (opened in the TV's YouTube app).
export function catalogChannelPayload(e) {
  const base = { id: e.id, name: e.name, logo: e.logo || null, height: e.height || 0, category: e.category || null };
  if (e.youtube && e.via === 'app') return { ...base, youtubeApp: e.youtube };
  return e.youtube ? { ...base, embed: youtubeEmbedUrl(e.youtube), youtubeApp: e.youtube } : { ...base, play: `/live/ch?id=${encodeURIComponent(e.id)}` };
}
