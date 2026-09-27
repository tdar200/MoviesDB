// lan-info.mjs — pick the helper's LAN address so a same-network client (the TV)
// can reach it directly instead of round-tripping through the Tailscale funnel.
//
// The funnel is HTTPS and public, so it always works, but it routes every byte
// through a Tailscale relay and caps throughput far below a video bitrate. A
// client on the same LAN can instead hit http://<lan-ip>:<port> directly, which
// is an order of magnitude faster. This module only chooses the address; the
// browser decides whether it can actually reach it (see the probe in script.js).

// Rank private IPv4 ranges: 192.168.* first (typical home LAN), then 10.*, then
// the 172.16–31.* block. Non-private and non-IPv4 addresses are ignored.
function privacyRank(ip) {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return -1; // not a private LAN address
}

// Given the shape of os.networkInterfaces(), return the best private LAN IPv4, or
// null if the host has none (e.g. only a public IP, or only the loopback).
export function pickLanIPv4(interfaces) {
  const candidates = [];
  for (const name of Object.keys(interfaces || {})) {
    for (const ni of interfaces[name] || []) {
      if (!ni || ni.internal) continue;
      // Node <18 reports family 'IPv4'; some builds report the number 4.
      if (ni.family !== 'IPv4' && ni.family !== 4) continue;
      const rank = privacyRank(ni.address);
      if (rank < 0) continue;
      candidates.push({ address: ni.address, rank });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates.length ? candidates[0].address : null;
}

// The full base URL a LAN client should use, or null when there is no LAN address.
export function lanBaseUrl(interfaces, port) {
  const ip = pickLanIPv4(interfaces);
  return ip ? `http://${ip}:${port}` : null;
}

// The browser's decision: adopt the LAN base only if it is a real private-IP
// http(s) URL. This guards against ever "downgrading" to something that isn't a
// LAN address (a public host, a bare hostname), which would be worse than the
// funnel we already have.
export function isAdoptableLanBase(base) {
  if (typeof base !== 'string' || !base) return false;
  let u;
  try { u = new URL(base); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return privacyRank(u.hostname) >= 0;
}
