// live-source-highfly.mjs — "Sports Streams" by Highfly (a public Stremio add-on)
// as a live-football source. Reachable from Sky with no headers; measured
// 27 Sep 2026: true 1080p for all four live Nations League matches.
//
// Catalog:  GET {host}/catalog/sport/sports_football.json
//           metas: { id: "streamed:denmark-vs-wales-2442761", name: "Denmark vs Wales",
//                    releaseInfo: "LIVE" | "27 Sep 2026 · 18:45 UTC" }
//           "leaf:" ids are 24/7 channels, not matches, and are skipped.
// Streams:  GET {host}/stream/sport/{id}.json
//           { name: "Leaf · PL: POLSAT SPORT 3 ᴿᴬᵂ",
//             title: "1920x1080 · Stereo · ~10.4 Mbps · Leaf · small delay",
//             url: "https://papacito.cfd/m3u/1562583/live.m3u8" }
//           Locked premium entries ("🔒", url google.com) and "Note:" rows are dropped.
import { withHostFailover } from './live-sources.mjs';
import { CHROME_UA } from './live-fixtures.mjs';
import { stripDecorations } from './live-source-nuvio.mjs';

export const HIGHFLY_HOSTS = ['https://sports.highfly.dev'];

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseReleaseInfo(text) {
  const s = String(text || '').trim();
  if (/^live\b/i.test(s)) return { status: 'in', kickoff: null };
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\D+(\d{1,2}):(\d{2})\s*UTC/i.exec(s);
  if (!m || MONTHS[m[2].toLowerCase()] == null) return { status: null, kickoff: null };
  const d = new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]), Number(m[4]), Number(m[5])));
  return { status: null, kickoff: d.toISOString().replace(/\.000Z$/, 'Z') };
}

// Channel names carry decorations the Nuvio stripper does not cover:
// geometric shapes (◉) and superscript letters (ᴿᴬᵂ).
function cleanName(text) {
  return stripDecorations(String(text || '').replace(/[■-◿ᴀ-ᶿʰ-˿]/g, ''));
}

export function parseHighflyCatalog(json) {
  const metas = (json && json.metas) || [];
  const out = [];
  for (const meta of metas) {
    if (!meta || !meta.id || String(meta.id).startsWith('leaf:')) continue;
    const title = cleanName(meta.name);
    const m = /^(.*?)\s+vs\.?\s+(.*)$/i.exec(title);
    if (!m) continue;
    const { status, kickoff } = parseReleaseInfo(meta.releaseInfo);
    out.push({ sourceId: meta.id, title, league: null, kickoff, home: m[1].trim(), away: m[2].trim(), poster: null, status });
  }
  return out;
}

export function parseHighflyStreams(json) {
  const list = (json && json.streams) || [];
  const out = [];
  for (const s of list) {
    const url = s && s.url;
    if (!/^https?:\/\//.test(url || '')) continue;
    const name = String(s.name || '');
    if (/🔒/.test(name) || /^note:/i.test(name.trim()) || /(^|\.)google\.com\//.test(url) || !/\.m3u8?(\?|$)/i.test(url)) continue;
    const title = String(s.title || '');
    const res = /(\d{3,4})\s*x\s*(\d{3,4})/.exec(title);
    const mbps = /~?\s*(\d+(?:\.\d+)?)\s*Mbps/i.exec(title);
    const height = res ? Number(res[2]) : 0;
    out.push({
      url,
      referer: '',
      origin: '',
      userAgent: CHROME_UA,
      label: cleanName(name) || 'Stream',
      language: '',
      quality: height ? `${height}p` : '',
      height,
      rank: mbps ? Math.round(Number(mbps[1]) * 1000) : 0,
    });
  }
  return out;
}

const CATALOG_TTL_MS = 60_000;
const CATALOG_STALE_MAX_MS = 30 * 60_000;

export function createHighflyAdapter({ fetchImpl = fetch, hosts = HIGHFLY_HOSTS, now = Date.now, catalogTimeoutMs = 10_000 } = {}) {
  const run = withHostFailover(hosts);
  const getJson = (path, timeoutMs) => run(async host => {
    const opts = { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } };
    if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(host + path, opts);
    if (!res.ok) throw new Error(`Highfly ${res.status}`);
    return res.json();
  });
  let lastGood = null;
  async function listMatches() {
    if (lastGood && now() - lastGood.at < CATALOG_TTL_MS) return lastGood.list;
    try {
      const list = parseHighflyCatalog(await getJson('/catalog/sport/sports_football.json', catalogTimeoutMs));
      lastGood = { at: now(), list };
      return list;
    } catch (err) {
      if (lastGood && now() - lastGood.at < CATALOG_STALE_MAX_MS) return lastGood.list;
      throw err;
    }
  }
  return {
    name: 'highfly',
    hosts,
    listMatches,
    streamsFor: id => getJson(`/stream/sport/${encodeURIComponent(id)}.json`).then(parseHighflyStreams),
  };
}
