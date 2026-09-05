// dns-fetch.js — reaching an index whose DNS the ISP has poisoned.
//
// UK ISPs block torrent indexes at the resolver: Sky answers torrentio.strem.fun
// with 2a02:c79:8ff:69::1, a sinkhole that never completes a TLS handshake, while
// public resolvers hand back the real Cloudflare addresses. The site itself is up
// (manifest.json answers in 60ms once you connect to the right address), so the
// fix is address resolution only — the Host header and TLS SNI must keep saying
// the real hostname or Cloudflare serves the wrong site.
//
// Composed from injected parts so the policy is unit-tested without a network.

import https from 'node:https';
import { Resolver } from 'node:dns/promises';

// Public resolvers that do not carry the ISP's block list.
export const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];

// Did the connection itself fail (worth retrying by IP), or did the server answer
// with something we should respect? An abort/timeout is the caller's decision and
// must never be retried behind their back.
export function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  if (err instanceof TypeError) return true;
  return ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']
    .includes(err.code);
}

// fetch, with a second attempt by resolved IP when the connection fails.
export function createResolvingFetch({ baseFetch = fetch, viaIpFetch = fetchViaPublicDns } = {}) {
  // Hosts proven to need the override. The direct attempt to a sinkholed host
  // costs a full connect timeout (~10s) and can never succeed, and paying it on
  // every lookup pushed the real request past the caller's timeout budget.
  const blocked = new Set();

  return async function resolvingFetch(url, options = {}) {
    const host = hostOf(url);
    if (blocked.has(host)) return viaIpFetch(url, options);
    try {
      return await baseFetch(url, options);
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      try {
        const res = await viaIpFetch(url, options);
        if (host) blocked.add(host);
        return res;
      } catch {
        throw err;   // report the original failure, not the fallback's
      }
    }
  };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Resolve through a public resolver, then connect to that address with the
// hostname preserved. `lookup` overrides ONLY address resolution, so https keeps
// sending the right Host header and the right SNI.
export async function fetchViaPublicDns(url, options = {}) {
  const target = new URL(url);
  const resolver = new Resolver();
  resolver.setServers(PUBLIC_DNS);
  const addresses = await resolver.resolve4(target.hostname);
  if (!addresses.length) throw new Error(`no A record for ${target.hostname}`);

  return new Promise((resolve, reject) => {
    const req = https.request(
      target,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        // net.connect may ask for every address (opts.all), in which case the
        // callback takes an array, not (address, family). Answering the wrong
        // shape yields "Invalid IP address: undefined".
        lookup: (_host, opts, cb) => (opts && opts.all
          ? cb(null, addresses.map((address) => ({ address, family: 4 })))
          : cb(null, addresses[0], 4)),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      }
    );
    req.on('error', reject);
    // Honour the caller's AbortSignal so a timeout still cuts this path short.
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) return req.destroy(new Error('aborted'));
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end();
  });
}
