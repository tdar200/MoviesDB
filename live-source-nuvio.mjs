// live-source-nuvio.mjs — Nuvio Live Sports (a public Stremio add-on wrapping
// DaddyLive) as a live-football source. Reachable from Sky, JSON, CORS-open.
//
// Catalog:  GET {host}/catalog/tv/nuvio_sports_live/genre=Football.json
// Streams:  GET {host}/stream/tv/{id}.json
// Their stream `url` is their own /api/manifest proxy. The playlist must be
// fetched through Nuvio's /api/manifest wrapper because the inner playlists
// are bound to Nuvio's resolver IP; the wrapper does NOT rewrite segment URLs,
// so the helper relay rewrites and proxies segments with Referer/Origin from
// behaviorHints.proxyHeaders (see live-relay.mjs).
import { withHostFailover } from './live-sources.mjs';
import { CHROME_UA } from './live-fixtures.mjs';

export const NUVIO_HOSTS = ['https://nuviosports.xyz'];

// Names and descriptions are decorated with emoji, flag "tag" characters
// (U+E0000..U+E007F) and variation selectors. Strip all of it.
export function stripDecorations(text) {
  return String(text || '')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[️‍]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTeams(title) {
  const m = /^(.*?)\s+vs\.?\s+(.*)$/i.exec(title);
  return m ? [m[1].trim(), m[2].trim()] : [title, ''];
}

export function parseNuvioCatalog(json) {
  const metas = (json && json.metas) || [];
  return metas.map(meta => {
    const title = stripDecorations(meta.name).replace(/^LIVE:\s*/i, '');
    const desc = stripDecorations(meta.description);
    const leagueMatch = /League:\s*([^\n]+?)(?:\s+Category:|\s+Status:|$)/.exec(desc);
    const cast = Array.isArray(meta.cast) ? meta.cast.map(stripDecorations) : [];
    const [h, a] = cast.length >= 2 ? [cast[0], cast[1]] : splitTeams(title);
    let kickoff = null;
    if (meta.released) { const d = new Date(meta.released); if (!Number.isNaN(d.getTime())) kickoff = d.toISOString().replace(/\.000Z$/, 'Z'); }
    return {
      sourceId: meta.id,
      title,
      league: leagueMatch ? leagueMatch[1].trim() : null,
      kickoff,
      home: h || '',
      away: a || '',
      poster: meta.poster || null,
      status: /LIVE NOW/i.test(desc) ? 'in' : null,
    };
  });
}

export function parseNuvioStreams(json) {
  const list = (json && json.streams) || [];
  return list.map(s => {
    let url = s.url || '';
    let referer = '', origin = '';
    try {
      const u = new URL(url);
      if (u.pathname.endsWith('/api/manifest') && u.searchParams.get('url')) {
        referer = u.searchParams.get('referer') || '';
        origin = u.searchParams.get('origin') || '';
        // Keep url as the wrapper URL; do not unwrap to the inner playlist
      }
    } catch { /* keep as-is */ }
    const hints = (s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) || {};
    const lines = String(s.title || '').split('\n').map(stripDecorations).filter(Boolean);
    const q = /Quality:\s*(\S+)/i.exec(lines.join(' '));
    return {
      url,
      referer: hints.Referer || referer,
      origin: hints.Origin || origin,
      userAgent: hints['User-Agent'] || CHROME_UA,
      label: lines[0] || 'Stream',
      language: s.language || '',
      quality: s.resolution || (q ? q[1] : ''),
      rank: Number.isFinite(Number(s.speedScore)) ? Number(s.speedScore) : (Number(s.score) || 0),
    };
  }).filter(s => /^https?:\/\//.test(s.url));
}

// The catalog is polled every minute by the TV. Nuvio is slow at peak (catalog
// > 8 s, streams 5-37 s measured 27 Sep 2026), so the catalog is cached for 60 s
// and the last good list (up to 30 min old) is served when a fetch fails or
// stalls, instead of every match flipping to "no stream" for one poll.
const CATALOG_TTL_MS = 60_000;
const CATALOG_STALE_MAX_MS = 30 * 60_000;

export function createNuvioAdapter({ fetchImpl = fetch, hosts = NUVIO_HOSTS, now = Date.now, catalogTimeoutMs = 10_000 } = {}) {
  const run = withHostFailover(hosts);
  const getJson = (path, timeoutMs) => run(async host => {
    const opts = { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } };
    if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(host + path, opts);
    if (!res.ok) throw new Error(`Nuvio ${res.status}`);
    return res.json();
  });
  let lastGood = null; // { at, list }
  async function listMatches() {
    if (lastGood && now() - lastGood.at < CATALOG_TTL_MS) return lastGood.list;
    try {
      const list = parseNuvioCatalog(await getJson('/catalog/tv/nuvio_sports_live/genre=Football.json', catalogTimeoutMs));
      lastGood = { at: now(), list };
      return list;
    } catch (err) {
      if (lastGood && now() - lastGood.at < CATALOG_STALE_MAX_MS) return lastGood.list;
      throw err;
    }
  }
  return {
    name: 'nuvio',
    hosts,
    listMatches,
    streamsFor: id => getJson(`/stream/tv/${encodeURIComponent(id)}.json`).then(parseNuvioStreams),
  };
}
