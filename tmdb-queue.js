// tmdb-queue.js
// The ONE shared queue for all TMDB traffic (grid pages, per-card credits and
// providers, recommendations enrichment). Uncoordinated pools were the root
// cause of 429 storms: the grid burst 40+ raw fetches while recommendations ran
// its own 12-wide queue. A single cap + start spacing keeps the whole app under
// TMDB's per-IP limit (~50 req/s): 16 concurrent, one start per 22ms ≈ 45 req/s
// worst case — near the pre-queue cold-grid speed without the unbounded burst.
import { createFetchQueue } from './fetch-queue.js';

// No storage-backed memo here: at grid scale (hundreds of URLs, 30-50KB discover
// pages) re-stringifying one big sessionStorage blob per response burns seconds of
// main thread and blows the quota. In-memory memo still de-dupes within the page;
// recommendations keeps its own bounded localStorage meta-cache for persistence.
// Pages expire after 15 minutes so daily category refreshes actually reach TMDB;
// the 256-entry LRU cap keeps background refresh from retaining every page.
export const tmdbQueue = createFetchQueue({
  fetchImpl: (url, options) => fetch(url, options),
  maxInflight: 16,
  minGapMs: 22,
  memoTtlMs: 15 * 60 * 1000,
  maxMemoEntries: 256,
  // Empty feeds can recover immediately; do not cache an outage as no titles.
  shouldMemoize: json => ![json && json.results, json && json.items].some(items => Array.isArray(items) && items.length === 0),
});

// Returns parsed JSON; throws after built-in 429 retries on persistent failure.
export const fetchTmdbJson = (url) => tmdbQueue.fetchJson(url);
