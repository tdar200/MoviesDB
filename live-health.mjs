// live-health.mjs — is a live stream actually playable from here?
//
// Measured 2026-09-27: most Nuvio streams return a playlist, but many have
// segment CDNs that time out from this network, and some wrap video in image
// containers (RIFF/PNG) hls.js cannot play. Probing each stream once (playlist,
// at most one variant hop, first segment's first bytes) under one shared
// deadline lets /live/streams drop the broken ones and put working ones first,
// instead of the TV's recover cascade discovering it 30 s at a time.

// The helper's fetchUpstream throws an Error with this name for a URL it refuses
// to fetch (non-public target: LAN, loopback, ...). The name is the contract, so
// this module needs nothing from stream-server.mjs.
export const BLOCKED_TARGET = 'LiveBlockedTarget';

export function classifySegmentBytes(b) {
  if (!b || !b.length) return 'unknown';
  const s = Buffer.from(b.subarray(0, 12)).toString('latin1');
  // 'G' of 'GIF8' is 0x47, the TS sync byte: rule out GIF before calling it TS.
  if (s.startsWith('GIF8')) return 'wrapped';
  if (b[0] === 0x47) return 'ts';
  if (s.startsWith('#EXTM3U') || s.startsWith('#EXT')) return 'playlist';
  if (s.startsWith('ID3')) return 'id3';
  const box = s.slice(4, 8);
  if (box === 'ftyp' || box === 'styp' || box === 'moof' || box === 'sidx') return 'fmp4';
  if (s.startsWith('RIFF')) return 'wrapped';
  if (b[0] === 0x89 && s.slice(1, 4) === 'PNG') return 'wrapped';
  if (b[0] === 0xff && b[1] === 0xd8) return 'wrapped';
  return 'unknown';
}

export function firstMediaUri(text) {
  let variantNext = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    if (line.startsWith('#')) { if (line.startsWith('#EXT-X-STREAM-INF:')) variantNext = true; continue; }
    return { uri: line, isVariant: variantNext };
  }
  return null;
}

function headersFor(stream) {
  const h = {};
  if (stream.referer) h.Referer = stream.referer;
  if (stream.origin) h.Origin = stream.origin;
  return h;
}

async function readFirstBytes(res, n = 16) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    try {
      const { value } = await reader.read();
      return value ? value.subarray(0, n) : new Uint8Array(0);
    } finally {
      reader.cancel().catch(() => {});
    }
  }
  return new Uint8Array(await res.arrayBuffer()).subarray(0, n);
}

// undici holds the connection until a body is consumed or cancelled.
function discardBody(res) {
  try { const c = res.body && res.body.cancel && res.body.cancel(); if (c && c.catch) c.catch(() => {}); } catch { /* already closed */ }
}

class ProbeResult extends Error {
  constructor(status, detail) { super(detail); this.result = { status, detail }; }
}

// Tallest RESOLUTION advertised by a master playlist (0 for a media playlist).
export function maxVariantHeight(text) {
  let max = 0;
  const re = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) max = Math.max(max, Number(m[1]));
  return max;
}

export async function probeStream(stream, { fetchUpstream, timeoutMs = 5000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const headers = headersFor(stream);
  const getPlaylist = async (url, what) => {
    const res = await fetchUpstream(url, headers, ac.signal);
    if (!res.ok) { discardBody(res); throw new ProbeResult('http-error', `${what} ${res.status}`); }
    const text = await res.text();
    if (!text.trimStart().startsWith('#EXTM3U')) throw new ProbeResult('bad-playlist', 'not a playlist');
    return text;
  };
  try {
    let url = stream.url;
    let text = await getPlaylist(url, 'playlist');
    let first = firstMediaUri(text);
    const height = maxVariantHeight(text);
    const ok = detail => (height ? { status: 'ok', detail, height } : { status: 'ok', detail });
    if (first && first.isVariant) {
      url = new URL(first.uri, url).href;
      text = await getPlaylist(url, 'variant');
      first = firstMediaUri(text);
    }
    if (!first) return { status: 'bad-playlist', detail: 'no media uri' };
    if (/#EXT-X-MAP:/.test(text)) return ok('fmp4-map');
    const segUrl = new URL(first.uri, url).href;
    const seg = await fetchUpstream(segUrl, headers, ac.signal);
    if (!seg.ok) { discardBody(seg); return { status: 'http-error', detail: `segment ${seg.status}` }; }
    const kind = classifySegmentBytes(await readFirstBytes(seg));
    if (kind === 'ts' || kind === 'fmp4' || kind === 'id3') return ok(kind);
    if (kind === 'wrapped') return { status: 'wrapped', detail: 'wrapped' };
    return { status: 'error', detail: `segment ${kind}` };
  } catch (err) {
    if (err instanceof ProbeResult) return err.result;
    if (err && err.name === BLOCKED_TARGET) return { status: 'blocked', detail: 'non-public target' };
    if (ac.signal.aborted || err.name === 'AbortError' || err.name === 'TimeoutError') return { status: 'timeout', detail: 'timeout' };
    return { status: 'error', detail: String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

const DROP = new Set(['wrapped', 'http-error', 'bad-playlist', 'blocked']);

export function createStreamHealth({ probe, now = Date.now, ttlMs = 120000, concurrency = 16 } = {}) {
  const cache = new Map(); // url -> { at, status, height }
  async function statusOf(stream) {
    const hit = cache.get(stream.url);
    if (hit && now() - hit.at < ttlMs) return hit;
    let result;
    try { const r = await probe(stream); result = { status: r.status, height: r.height || 0 }; } catch { result = { status: 'error', height: 0 }; }
    const entry = { at: now(), status: result.status, height: result.height };
    cache.set(stream.url, entry);
    return entry;
  }
  async function rank(streams) {
    const list = streams || [];
    const out = new Array(list.length);
    let next = 0;
    const worker = async () => { while (next < list.length) { const i = next++; out[i] = await statusOf(list[i]); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    // Working streams first, then the sharpest (probe's master-playlist height
    // wins over Nuvio's label), then Nuvio's speed rank.
    const kept = list.map((s, i) => ({ ...s, health: out[i].status, height: Math.max(s.height || 0, out[i].height || 0) }))
      .filter(s => !DROP.has(s.health));
    const group = h => (h === 'ok' ? 0 : 1);
    return kept.sort((a, b) => group(a.health) - group(b.health) || (b.height || 0) - (a.height || 0) || (b.rank || 0) - (a.rank || 0));
  }
  return { rank };
}
