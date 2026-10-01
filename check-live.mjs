#!/usr/bin/env node
// check-live.mjs — which live-football source rotted? One line per source.
//   npm run check-live
// Exit 1 when no match source (Highfly, Nuvio) can list matches and streams.
import { createNuvioAdapter } from './live-source-nuvio.mjs';
import { createHighflyAdapter } from './live-source-highfly.mjs';
import { createSourceRegistry } from './live-sources.mjs';
import { createChannelFeed } from './live-channels.mjs';

const MATCHES_TO_TRY = 12;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runLiveCheck({ fetchImpl = fetch, log = console.log, pauseMs = 400 } = {}) {
  const registry = createSourceRegistry([createHighflyAdapter({ fetchImpl }), createNuvioAdapter({ fetchImpl })]);
  const sources = {};
  for (const adapter of registry.list()) {
    const r = { ok: false, matches: 0, streams: 0, error: null };
    try {
      const matches = await adapter.listMatches();
      r.matches = matches.length;
      // Feeds list upcoming matches first and those have no stream yet, so one match proves nothing: look until a
      // match has a stream (the first one used to report a healthy source as BAD).
      let tried = 0;
      let lastError = null;
      for (const match of matches.slice(0, MATCHES_TO_TRY)) {
        if (tried) await sleep(pauseMs); // a burst of lookups gets the source's rate limit (HTTP 429), which is not an outage
        tried += 1;
        try { r.streams = (await adapter.streamsFor(match.sourceId)).length; } catch (err) { lastError = err; r.streams = 0; }
        if (r.streams > 0) break;
      }
      r.ok = matches.length > 0 && r.streams > 0;
      if (!r.ok) r.error = !matches.length ? 'no matches listed' : lastError ? `no stream in ${tried} match${tried === 1 ? '' : 'es'} tried, last error: ${String(lastError.message || lastError)}` : `no stream in the first ${tried} match${tried === 1 ? '' : 'es'}`;
    } catch (err) { r.error = String(err.message || err); }
    sources[adapter.name] = r;
    log(`${adapter.name.padEnd(8)} ${r.ok ? 'ok ' : 'BAD'} matches=${r.matches} streams=${r.streams}${r.error ? ' error=' + r.error : ''}`);
  }
  const channels = { ok: false, count: 0, error: null };
  try {
    const { channels: list, stale } = await createChannelFeed({ fetchImpl }).fetchChannels();
    channels.count = list.length;
    channels.ok = list.length > 0 && !stale;
    if (!channels.ok) channels.error = stale ? 'download failed' : 'no channel alive';
  } catch (err) { channels.error = String(err.message || err); }
  log(`channels ${channels.ok ? 'ok ' : 'BAD'} alive=${channels.count}${channels.error ? ' error=' + channels.error : ''}`);
  // Healthy when at least one match source works (Highfly and Nuvio overlap).
  return { ok: Object.values(sources).some(r => r.ok), sources, channels };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  runLiveCheck({}).then(r => process.exit(r.ok ? 0 : 1)).catch(err => { console.error(err); process.exit(1); });
}
