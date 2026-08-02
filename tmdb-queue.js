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
export const tmdbQueue = createFetchQueue({
  fetchImpl: (url) => fetch(url),
  maxInflight: 16,
  minGapMs: 22,
});

// Returns parsed JSON; throws after built-in 429 retries on persistent failure.
export const fetchTmdbJson = (url) => tmdbQueue.fetchJson(url);
