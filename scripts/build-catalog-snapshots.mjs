// Refresh the complete static catalogue used by cold TV starts. The TV keeps its
// own durable cache and refreshes stale snapshots, so releases don't freeze data.
import { mkdir, writeFile } from 'node:fs/promises';
import { CONFIG } from '../config.js';
import { catalogRowDefs } from '../tv-rows.mjs';
import { fetchCompleteTvRow } from '../tv-catalog.mjs';
import { categorySnapshot, categoryCacheIdentity } from '../tv-catalog-cache.mjs';
import { createFetchQueue } from '../fetch-queue.js';
const outdir = new URL('../catalog-cache/', import.meta.url);
await mkdir(outdir, { recursive: true });
const queue = createFetchQueue({ fetchImpl: fetch, maxInflight: 16, minGapMs: 22 });
const kinds = process.argv.includes('--all-tabs') ? ['all', 'movie', 'tv'] : ['all'];
const defs = [...new Map(kinds.flatMap(kind => catalogRowDefs(CONFIG.API_KEY, CONFIG.BASE_URL, kind)).map(def => [categoryCacheIdentity(def).key, def])).values()];
let next = 0, finished = 0;
const started = Date.now();
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < defs.length) {
    const def = defs[next++];
    const row = await fetchCompleteTvRow(def, url => {
      const canonical = new URL(url);
      canonical.searchParams.sort();
      return queue.fetchJson(canonical.toString());
    });
    const snapshot = categorySnapshot(def, row);
    await writeFile(new URL(`${snapshot.key}.json`, outdir), JSON.stringify(snapshot));
    console.log(`${++finished}/${defs.length} ${def.title}: ${row.items.length} titles, ${row.loadedPages} pages (${Math.round((Date.now()-started)/1000)}s)`);
  }
}));
