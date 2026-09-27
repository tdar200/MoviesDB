// opensubtitles.mjs — external subtitle fallbacks for torrents that ship none.
import { inflateRawSync } from 'node:zlib';
// Supports the keyed OpenSubtitles.com API and Stremio's official public,
// no-key OpenSubtitles add-on resource.
//
// API: https://api.opensubtitles.com/api/v1 — every request needs Api-Key + a
// registered User-Agent. Search returns candidate files; a second POST /download
// call turns a file_id into a temporary link, which we then fetch as SRT text.

const OS_BASE = 'https://api.opensubtitles.com/api/v1';
const STREMIO_BASE = 'https://opensubtitles-v3.strem.io';
const YTS_SUBS_BASE = 'https://yts-subs.com';

function osHeaders(apiKey, post) {
  const h = {
    'Api-Key': apiKey,
    'User-Agent': 'MoviesDB v1.0',
    'Accept': 'application/json',
  };
  if (post) h['Content-Type'] = 'application/json';
  return h;
}

// OpenSubtitles wants imdb_id as a bare integer ("tt0816692" -> 816692).
export function imdbToNumber(imdbId) {
  const n = String(imdbId || '').trim().replace(/^tt/i, '').replace(/^0+/, '');
  return /^\d+$/.test(n) ? Number(n) : null;
}

// Search for the best English subtitle for a title (or a specific episode).
// Returns { fileId, release, lang } or null when nothing usable is found.
export async function searchSubtitle({ apiKey, imdbId, languages = 'en', season, episode }, fetchImpl = fetch) {
  const num = imdbToNumber(imdbId);
  if (!apiKey || num == null) return null;
  const params = new URLSearchParams({ languages, order_by: 'download_count', order_direction: 'desc' });
  const hasEp = Number.isFinite(Number(season)) && Number.isFinite(Number(episode)) && Number(season) > 0;
  if (hasEp) {
    // For an episode, the imdb id is the series' — scope it with season/episode.
    params.set('parent_imdb_id', String(num));
    params.set('season_number', String(Number(season)));
    params.set('episode_number', String(Number(episode)));
    params.set('type', 'episode');
  } else {
    params.set('imdb_id', String(num));
    params.set('type', 'movie');
  }
  const r = await fetchImpl(`${OS_BASE}/subtitles?${params.toString()}`, { headers: osHeaders(apiKey) });
  if (!r.ok) throw new Error(`opensubtitles search HTTP ${r.status}`);
  const data = await r.json();
  const items = (data && data.data || []).filter(d => d && d.attributes && Array.isArray(d.attributes.files) && d.attributes.files.length && d.attributes.files[0].file_id != null);
  if (!items.length) return null;
  // The API already sorts by download_count desc, but be defensive.
  items.sort((a, b) => (b.attributes.download_count || 0) - (a.attributes.download_count || 0));
  const best = items[0].attributes;
  return { fileId: String(best.files[0].file_id), release: best.release || '', lang: best.language || languages };
}

// Turn a file_id into SRT text. Two hops: POST /download for a temporary link,
// then GET that link. Returns the raw subtitle text (SRT, usually).
export async function fetchSubtitleText({ apiKey, fileId }, fetchImpl = fetch) {
  if (!apiKey || !fileId) throw new Error('opensubtitles: apiKey and fileId required');
  const r = await fetchImpl(`${OS_BASE}/download`, {
    method: 'POST',
    headers: osHeaders(apiKey, true),
    body: JSON.stringify({ file_id: Number(fileId) }),
  });
  if (!r.ok) throw new Error(`opensubtitles download HTTP ${r.status}`);
  const body = await r.json();
  if (!body || !body.link) throw new Error('opensubtitles: no download link (quota exhausted?)');
  const sub = await fetchImpl(body.link);
  if (!sub.ok) throw new Error(`opensubtitles subtitle fetch HTTP ${sub.status}`);
  return await sub.text();
}

function releaseScore(item, releaseName) {
  const wanted = String(releaseName || '').toLowerCase();
  const offered = [item.subtitleFileName, item.movieReleaseName, item.releaseGroup].filter(Boolean).join(' ').toLowerCase();
  return ['yts', 'bluray', 'webrip', 'web-dl', '1080p', '720p', '2160p']
    .reduce((score, token) => score + (wanted.includes(token) && offered.includes(token) ? (token === 'yts' ? 20 : 3) : 0), 0);
}

export async function searchStremioSubtitle({ imdbId, season, episode, releaseName = '' }, fetchImpl = fetch) {
  const imdb = String(imdbId || '').trim().toLowerCase();
  if (!/^tt\d+$/.test(imdb)) return null;
  const isEpisode = Number(season) > 0 && Number(episode) > 0;
  const type = isEpisode ? 'series' : 'movie';
  const id = isEpisode ? `${imdb}:${Number(season)}:${Number(episode)}` : imdb;
  const response = await fetchImpl(`${STREMIO_BASE}/subtitles/${type}/${id}.json`);
  if (!response.ok) throw new Error(`stremio subtitles HTTP ${response.status}`);
  const body = await response.json();
  const candidates = (body && body.subtitles || [])
    .filter(item => item && ['en', 'eng'].includes(String(item.lang || '').toLowerCase()) && /^https:\/\/subs\d*\.strem\.io\//.test(item.url || ''))
    .map(item => ({ item, match: /\/file\/(\d+)(?:\?|$)/.exec(item.url) }))
    .filter(entry => entry.match)
    .sort((a, b) => releaseScore(b.item, releaseName) - releaseScore(a.item, releaseName));
  if (!candidates.length) return null;
  const best = candidates[0];
  return { fileId: best.match[1], url: best.item.url, release: best.item.subtitleFileName || best.item.movieReleaseName || '', lang: 'en' };
}

export async function fetchStremioSubtitleText({ url }, fetchImpl = fetch) {
  if (!/^https:\/\/subs\d*\.strem\.io\//.test(String(url || ''))) throw new Error('stremio subtitles: invalid download URL');
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`stremio subtitle fetch HTTP ${response.status}`);
  return await response.text();
}

function htmlText(value) {
  return String(value || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function filenameScore(text, releaseName) {
  const wanted = new Set(String(releaseName || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  const offered = new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  let score = 0;
  for (const token of wanted) if (offered.has(token)) score += ['yts', 'bluray', 'webrip', 'web', 'dl'].includes(token) ? 10 : 1;
  return score;
}

export async function searchYtsSubtitle({ imdbId, releaseName = '' }, fetchImpl = fetch) {
  const imdb = String(imdbId || '').trim().toLowerCase();
  if (!/^tt\d+$/.test(imdb) || !/\byts\b/i.test(releaseName)) return null;
  const listing = await fetchImpl(`${YTS_SUBS_BASE}/movie-imdb/${imdb}`);
  if (!listing.ok) throw new Error(`yts subtitles search HTTP ${listing.status}`);
  const html = await listing.text();
  const rows = Array.from(html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), match => match[1]);
  const candidates = rows.flatMap(row => {
    if (!/class="sub-lang">\s*English\s*</i.test(row)) return [];
    const href = /href="(\/subtitles\/[^"]+-english-yify-(\d+))"/i.exec(row);
    return href ? [{ path: href[1], fileId: href[2], release: htmlText(row), score: filenameScore(htmlText(row), releaseName) }] : [];
  }).sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  const best = candidates[0];
  const detail = await fetchImpl(`${YTS_SUBS_BASE}${best.path}`);
  if (!detail.ok) throw new Error(`yts subtitles detail HTTP ${detail.status}`);
  const encoded = /data-link="([A-Za-z0-9+/=]+)"/.exec(await detail.text());
  if (!encoded) throw new Error('yts subtitles download link missing');
  const url = Buffer.from(encoded[1], 'base64').toString('utf8');
  if (!/^https:\/\/subtitles\.yts-subs\.com\/subtitles\/[a-z0-9-]+\.zip$/i.test(url)) throw new Error('yts subtitles: invalid download URL');
  return { fileId: best.fileId, url, release: best.release, lang: 'en' };
}

export function firstSrtFromZip(bytes) {
  const zip = Buffer.from(bytes);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('subtitle archive has no central directory');
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) break;
    const method = zip.readUInt16LE(offset + 10), compressed = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28), extraLen = zip.readUInt16LE(offset + 30), commentLen = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42), name = zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (/\.srt$/i.test(name)) {
      const localName = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28);
      const start = local + 30 + localName + localExtra, data = zip.subarray(start, start + compressed);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
      throw new Error(`unsupported subtitle zip compression ${method}`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('subtitle archive contains no SRT file');
}

export async function fetchYtsSubtitleText({ url }, fetchImpl = fetch) {
  if (!/^https:\/\/subtitles\.yts-subs\.com\/subtitles\/[a-z0-9-]+\.zip$/i.test(String(url || ''))) throw new Error('yts subtitles: invalid download URL');
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`yts subtitle fetch HTTP ${response.status}`);
  return firstSrtFromZip(await response.arrayBuffer());
}
