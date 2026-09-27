#!/usr/bin/env node
// check-live.mjs — which live-football source rotted? One line per source.
//   npm run check-live
// Exit 1 when the primary adapter (nuvio) cannot list matches or streams.
import { createNuvioAdapter } from './live-source-nuvio.mjs';
import { createSourceRegistry } from './live-sources.mjs';
import { createChannelFeed } from './live-channels.mjs';

export async function runLiveCheck({ fetchImpl = fetch, log = console.log } = {}) {
  const registry = createSourceRegistry([createNuvioAdapter({ fetchImpl })]);
  const sources = {};
  for (const adapter of registry.list()) {
    const r = { ok: false, matches: 0, streams: 0, error: null };
    try {
      const matches = await adapter.listMatches();
      r.matches = matches.length;
      if (matches.length) r.streams = (await adapter.streamsFor(matches[0].sourceId)).length;
      r.ok = matches.length > 0 && r.streams > 0;
      if (!r.ok) r.error = matches.length ? 'first match has no streams' : 'no matches listed';
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
  const primary = sources.nuvio;
  return { ok: !!(primary && primary.ok), sources, channels };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  runLiveCheck({}).then(r => process.exit(r.ok ? 0 : 1)).catch(err => { console.error(err); process.exit(1); });
}
