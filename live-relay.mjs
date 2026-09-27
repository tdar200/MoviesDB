// live-relay.mjs — pure pieces of the live HLS relay.
//
// Upstream sports CDNs demand Referer AND Origin (verified: 403 with either
// alone) and browsers cannot set those, so the helper fetches the playlist,
// rewrites every URI to point back at itself, and proxies segments. To keep the
// relay from being an open proxy on the funnel, every upstream URL it accepts
// carries an HMAC signature the helper minted (relayPath / rewritePlaylist).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CHROME_UA } from './live-fixtures.mjs';

export function signUpstream({ u, ref, org }, secret) {
  if (!secret) throw new Error('relay secret required');
  return createHmac('sha256', String(secret)).update(`${u || ''}\n${ref || ''}\n${org || ''}`).digest('hex').slice(0, 32);
}

export function verifyUpstream({ u, ref, org, s }, secret) {
  if (typeof s !== 'string' || s.length !== 32) return false;
  if (!secret) return false;
  const want = Buffer.from(signUpstream({ u, ref, org }, secret), 'utf8');
  const got = Buffer.from(s, 'utf8');
  return want.length === got.length && timingSafeEqual(want, got);
}

// Public hosts only: the URL is fetched server-side, so block SSRF targets.
function isPrivateIPv4(dotted) {
  if (/^(127\.|10\.|169\.254\.|0\.)/.test(dotted)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(dotted)) return true;
  if (/^192\.168\./.test(dotted)) return true;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(dotted)) return true;
  if (/^(224\.|255\.)/.test(dotted)) return true;
  return false;
}

function extractIPv4FromIPv6(h) {
  // Handles ::7f00:1, ::ffff:7f00:1, ::ffff:0:7f00:1, 64:ff9b::7f00:1
  const match = h.match(/([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (match) { const [a, b] = match.slice(1).map(x => parseInt(x, 16)); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return null;
}

export function isPublicHttpUrl(raw, protocols = ['http:', 'https:']) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!protocols.includes(u.protocol)) return false;
  let h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return false;
  if (isPrivateIPv4(h)) return false;
  if (h === '::1' || h === '::' || /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return false;
  if (/^::/.test(h) || /^64:ff9b::/.test(h) || /^::ffff:/.test(h)) {
    const v4 = extractIPv4FromIPv6(h);
    if (v4 && isPrivateIPv4(v4)) return false;
  }
  return true;
}

export function relayPath(kind, { u, ref, org }, secret, key = '') {
  const q = new URLSearchParams();
  q.set('u', u || '');
  q.set('s', signUpstream({ u, ref, org }, secret));
  q.set('ref', ref || '');
  q.set('org', org || '');
  if (key) q.set('key', key);
  return `/live/${kind === 'hls' ? 'hls' : 'seg'}?${q.toString()}`;
}

export function upstreamHeaders(ref, org, userAgent = CHROME_UA) {
  const h = { 'User-Agent': userAgent, Accept: '*/*' };
  if (ref) h.Referer = ref;
  if (org) h.Origin = org;
  return h;
}

const PLAYLIST_URI_TAGS = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/;
const SEGMENT_URI_TAGS = /^#EXT-X-(KEY|MAP|SESSION-KEY):/;

export function rewritePlaylist(text, { playlistUrl, relayBase = '', ref, org, secret, key }) {
  const base = relayBase.replace(/\/+$/, '');
  const relay = (kind, target) => base + relayPath(kind, { u: new URL(target, playlistUrl).toString(), ref, org }, secret, key);
  const lines = String(text || '').split('\n');
  let variantNext = false;
  return lines.map(rawLine => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) variantNext = true;
      if (PLAYLIST_URI_TAGS.test(line)) return line.replace(/URI="([^"]+)"/, (_, t) => `URI="${relay('hls', t)}"`);
      if (SEGMENT_URI_TAGS.test(line)) return line.replace(/URI="([^"]+)"/, (_, t) => `URI="${relay('seg', t)}"`);
      return line;
    }
    const isPlaylist = variantNext || /\.m3u8?(\?|$)/i.test(line);
    variantNext = false;
    return relay(isPlaylist ? 'hls' : 'seg', line.trim());
  }).join('\n');
}
