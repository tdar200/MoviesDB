// live-channels.mjs — free 24/7 sports channels from the iptv-org playlist.
//
// The playlist is CC0, rebuilt hourly, ~430 sports channels; a football
// allowlist plus a liveness probe at fetch time leaves the ones worth showing.
// Streams rot weekly, so nothing is trusted without a probe, and the last good
// list is served (marked stale) when the download itself fails.
import { createHash } from 'node:crypto';
import { CHROME_UA } from './live-fixtures.mjs';

export const SPORTS_M3U_URL = 'https://iptv-org.github.io/iptv/categories/sports.m3u';

export const CHANNEL_ALLOWLIST = [
  /setanta sports/i, /digi ?sport/i, /bein/i, /golazo/i, /premier sports/i, /sportitalia/i,
  /\bmutv\b/i, /real madrid tv/i, /inter tv/i, /\bespn/i, /fox soccer/i, /sky sport/i, /tnt sport/i,
  /\bdazn\b/i, /\beleven\b/i, /\bsport ?tv\b/i, /futbol/i, /\bfoot\b/i, /la ?liga tv/i, /bundesliga/i,
  /premier league/i, /fifa/i, /uefa/i, /soccer/i,
];

const ATTR = /([a-zA-Z0-9-]+)="([^"]*)"/g;

export function parseM3u(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\r$/, '').trim());
  const out = [];
  let pending = null;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const comma = line.lastIndexOf(',');
      const head = comma >= 0 ? line.slice(0, comma) : line;
      let rawName = comma >= 0 ? line.slice(comma + 1).trim() : '';
      for (const m of head.matchAll(ATTR)) attrs[m[1]] = m[2];
      const geoBlocked = /\[Geo-blocked\]/i.test(rawName);
      const not247 = /\[Not 24\/7\]/i.test(rawName);
      const name = rawName.replace(/\s*\[(Geo-blocked|Not 24\/7)\]/gi, '').trim();
      pending = { name, url: '', tvgId: attrs['tvg-id'] || '', logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || '', geoBlocked, not247 };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending) { pending.url = line; out.push(pending); pending = null; }
  }
  return out;
}

export function filterFootballChannels(list) {
  return list.filter(c => !c.geoBlocked && CHANNEL_ALLOWLIST.some(re => re.test(c.name) || re.test(c.tvgId)));
}

export function channelId(ch) {
  if (ch.tvgId) return ch.tvgId;
  return 'u' + createHash('sha1').update(ch.url).digest('hex').slice(0, 12);
}

// Many of these servers reject HEAD, so GET the playlist and read a little of it.
export async function probeHls(url, fetchImpl = fetch, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { 'User-Agent': CHROME_UA }, redirect: 'follow' });
    if (!res.ok) return false;
    const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (/mpegurl|x-mpegURL|vnd\.apple/i.test(type)) return true;
    const body = await res.text();
    return body.trimStart().startsWith('#EXTM3U');
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createChannelFeed({ fetchImpl = fetch, probe = probeHls, now = Date.now, ttlMs = 900_000 } = {}) {
  let cache = null; // { at, channels }
  async function fetchChannels() {
    if (cache && now() - cache.at < ttlMs) return { channels: cache.channels, stale: false, fetchedAt: new Date(cache.at).toISOString() };
    try {
      const res = await fetchImpl(SPORTS_M3U_URL, { headers: { 'User-Agent': CHROME_UA } });
      if (!res.ok) throw new Error(`iptv-org ${res.status}`);
      const candidates = filterFootballChannels(parseM3u(await res.text()));
      const alive = await mapLimit(candidates, 8, async ch => (await probe(ch.url, fetchImpl)) ? ch : null);
      const channels = alive.filter(Boolean).map(ch => ({ id: channelId(ch), name: ch.name, logo: ch.logo || null, url: ch.url }));
      cache = { at: now(), channels };
      return { channels, stale: false, fetchedAt: new Date(cache.at).toISOString() };
    } catch (err) {
      if (cache) return { channels: cache.channels, stale: true, fetchedAt: new Date(cache.at).toISOString() };
      return { channels: [], stale: true, fetchedAt: null };
    }
  }
  return { fetchChannels };
}
