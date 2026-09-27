// live-channels.mjs — free 24/7 sports channels from the iptv-org playlist.
//
// The playlist is CC0, rebuilt hourly, ~430 sports channels; a football
// allowlist plus a liveness probe at fetch time leaves the ones worth showing.
// Streams rot weekly, so nothing is trusted without a probe, and the last good
// list is served (marked stale) when the download itself fails.
import { createHash } from 'node:crypto';
import { CHROME_UA } from './live-fixtures.mjs';
import { isPublicHttpUrl } from './live-relay.mjs';

export const SPORTS_M3U_URL = 'https://iptv-org.github.io/iptv/categories/sports.m3u';

export const UK_M3U_URL = 'https://iptv-org.github.io/iptv/countries/uk.m3u';

// Official or broadcaster-run free streams that carry football, verified
// reachable from the UK and measured (true resolution) on 27 Sep 2026. An exact
// id list, because the old name patterns ("Sky Sport", "Setanta", "DAZN", ...)
// now match almost nothing but unauthorised restreams and slide-looping fakes.
export const CHANNEL_IDS = new Set([
  'TVRSport.ro@SD', 'Teledeporte.es@SD', 'KTVSport.kw@SD', 'DDSports.in@SD', 'Sportitalia.it@SD',
  'InterTV.it@SD', 'geFast.br@SD', 'ElHeddafTV.dz@SD', 'AlIraqiaSport.iq@SD', 'TraceSportStars.fr@HD',
  'talkSPORT.uk@SD', 'beINSPORTSXTRA.us@SD', 'Africa24Sport.fr@SD', 'HTSporTV.tr@SD', 'RealMadridTV.es@SD',
  'MUTV.uk@SD', 'FIFAPlus.uk@English', 'FIFAPlus.uk@Spain', 'FIFAPlus.uk@Italy', 'FIFAPlus.uk@German',
  'FIFAPlus.uk@French', 'FIFAPlus.uk@Portuguese', 'FIFAPlus.uk@HispanicAmerica', 'FIFAPlus.uk@UnitedStates',
  'FIFAPlusWomen.uk@English', 'GolazoNetwork.us@SD',
]);

// Safety net even for listed ids: bare IP hosts and known restream hosts.
const DENIED_HOSTS = [/(^|\.)mcquack\.net$/, /(^|\.)megogo\.xyz$/, /siauliai/, /(^|\.)uplink\.kz$/, /(^|\.)streamhostingcdn\.top$/,
  /(^|\.)s\.gy$/, /(^|\.)freeott\.top$/, /(^|\.)workers\.dev$/, /(^|\.)highfly\.dev$/, /(^|\.)dstv\.cx$/, /(^|\.)antik\.sk$/];

export function isDeniedHost(raw) {
  let h;
  try { h = new URL(raw).hostname.toLowerCase(); } catch { return true; }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[')) return true;
  return DENIED_HOSTS.some(re => re.test(h));
}

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
  const seen = new Set();
  return list.filter(c => {
    if (c.geoBlocked || !CHANNEL_IDS.has(c.tvgId) || isDeniedHost(c.url) || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
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

export function createChannelFeed({ fetchImpl = fetch, probe = probeHls, now = Date.now, ttlMs = 900_000, concurrency = 8 } = {}) {
  let cache = null; // { at, channels }
  async function fetchChannels() {
    if (cache && now() - cache.at < ttlMs) return { channels: cache.channels, stale: false, fetchedAt: new Date(cache.at).toISOString() };
    try {
      const res = await fetchImpl(SPORTS_M3U_URL, { headers: { 'User-Agent': CHROME_UA } });
      if (!res.ok) throw new Error(`iptv-org ${res.status}`);
      let text = await res.text();
      // The UK list adds FIFA+ UK and other UK-only entries; optional.
      try { const uk = await fetchImpl(UK_M3U_URL, { headers: { 'User-Agent': CHROME_UA } }); if (uk.ok) text += '\n' + await uk.text(); } catch { /* sports list alone is fine */ }
      const candidates = filterFootballChannels(parseM3u(text));
      // A playlist entry pointing at a private/loopback/multicast target is treated
      // as dead without any request: the probe must not become an SSRF vector.
      // The probe answers true/false (playlist alive) or { status, height } (segment
      // probed and measured). Alive channels are listed sharpest first.
      const alive = await mapLimit(candidates, concurrency, async ch => {
        if (!isPublicHttpUrl(ch.url)) return null;
        const r = await probe(ch.url, fetchImpl);
        const ok = r === true || (r && r.status === 'ok');
        return ok ? { ch, height: (r && r.height) || 0 } : null;
      });
      const channels = alive.filter(Boolean)
        .map((a, i) => ({ id: channelId(a.ch), name: a.ch.name, logo: a.ch.logo || null, url: a.ch.url, height: a.height, order: i }))
        .sort((a, b) => b.height - a.height || a.order - b.order)
        .map(({ order, ...c }) => c);
      cache = { at: now(), channels };
      return { channels, stale: false, fetchedAt: new Date(cache.at).toISOString() };
    } catch (err) {
      if (cache) return { channels: cache.channels, stale: true, fetchedAt: new Date(cache.at).toISOString() };
      return { channels: [], stale: true, fetchedAt: null };
    }
  }
  return { fetchChannels };
}
