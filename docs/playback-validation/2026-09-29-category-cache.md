# Persistent complete-category cache and startup performance

The complete category loader originally refetched thousands of pages after an app reload. In-memory page memoization helped only within one launch, and recommendation generation plus an initial ten-page trending fetch delayed category loading.

The optimized app ships 113 complete, pre-ranked category snapshots across All, Movies and TV. A first visit fetches one compact snapshot per category. Visited collections persist in IndexedDB, with a 24-hour freshness interval. Stale collections stay available while a single background category refresh runs, with two concurrent pages per source. Background completion updates the cache for the next visit without moving visible cards. Partial results, failed requests and temporary empty collections are not persisted as complete listings. Failed snapshot or storage reads still fall back to complete source fetching.

Memory retains at most 12 complete categories and 256 page responses. Page responses expire after 15 minutes; this prevents a later category refresh from falsely treating old API pages as new data. Persistent storage uses least recently used eviction at 64 categories or 120,000 titles. The physical TV reports IndexedDB support and an origin quota of 416,555,664 bytes. Storage failures cannot prevent browsing.

Home rendering starts from local personal/curated content and loads category data independently of recommendations. Complete categories bypass redundant rating sorts and render card batches. Hashed JavaScript/CSS URLs and versioned HLS URLs use long-lived browser caching; snapshot fetches also use normal HTTP caching. The HTML stays uncached so reopening the app receives the current version.

## Production measurement

Measured on 2026-09-29T20:47:18.829Z in headless desktop Chrome, 1920x1080. The first pass used a new browser profile; the second reloaded it. CDN files were already available. This measures rendered category readiness, rather than completion of every lazy artwork download.

| Check | First app load | Reload |
| --- | ---: | ---: |
| Hero ready | 0.830 s | 0.121 s |
| All 12 initial categories ready | 2.809 s | 0.259 s |
| TMDB category requests | 0 | 0 |
| Hosted category snapshot requests | 12 | 0 |

Every full category was checked for weighted rating order, including the cards held back for horizontal scrolling. No page errors occurred. The earlier full-source production run took 86.9 seconds for the same initial category batch. An early sample immediately after deployment took 13.2 seconds because three categories fell back to source fetching; later measurements used all hosted snapshots. These timings are observations, not fixed latency guarantees.

## Verification and deployment

- Full unit suite: 676 passed, 35 skipped, no failures.
- Full TV browser suite: 27 passed, no failures, including complete memberships, last-page winners, reload persistence, storage eviction, retries, fast navigation, Live/All transitions and playback.
- Production checks confirmed content-hashed assets, snapshot cache headers, full ranking and zero category/snapshot requests on a cached reload.
- Physical-TV API inspection confirmed IndexedDB support and quota. Our Planet S1E1 was open; playback was left in place pending the owner's refresh preference. The optimized app's foreground startup timing has not been measured on the physical TV. Reopening Movies activates the release.

Generated snapshots live in the ignored `catalog-cache/` directory. `npm run build:catalog` refreshes all accessible category feeds; `npm run build:web` includes them in the static deployment. Device caches refresh old snapshots in the background between deployments. TMDB's existing 500-page-per-source limit remains.
