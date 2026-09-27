// live-sources.mjs — the live-stream source adapter registry.
//
// An adapter = { name, hosts, listMatches(), streamsFor(sourceId) }. The helper
// treats every adapter alike, so a new source (streamed.pk, another add-on) is
// one new module dropped into the registry. Hosts are tried in order on network
// errors because these domains move; the host that answered is tried first next.
import { isNetworkError } from './dns-fetch.js';

export function createSourceRegistry(adapters) {
  const list = adapters.slice();
  return {
    list: () => list.slice(),
    get: name => list.find(a => a.name === name) || null,
  };
}

// Returns an async function `run(fn)` that calls fn(host) over `hosts`, moving on
// only for network errors (DNS, refused, reset); HTTP errors are the caller's.
export function withHostFailover(hosts) {
  let preferred = 0;
  return async function run(fn) {
    const order = hosts.map((_, i) => hosts[(preferred + i) % hosts.length]);
    let lastError = null;
    for (const host of order) {
      try {
        const out = await fn(host);
        preferred = hosts.indexOf(host);
        return out;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        lastError = err;
      }
    }
    throw lastError || new Error('no hosts configured');
  };
}
