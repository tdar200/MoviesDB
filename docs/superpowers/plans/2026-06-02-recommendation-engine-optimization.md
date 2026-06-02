# Recommendation Engine Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the merged recommendation engine fully optimized — ~70→~22 TMDB calls/refresh, ~2–4× faster, instant-feeling page, better cold-start/gem picks — with no relevance regression.

**Architecture:** Three phases. Phase 1 = network + compute (kill redundant calls/delays, cap Discover, raise concurrency, exclude-before-score, in-memory memo, bounded re-rank). Phase 2 = perceived speed (progressive row streaming, skeleton rails + lazy hydration, debounced stale-while-revalidate). Phase 3 = relevance tuning (cold-start quality floor, seed-strength, Bayesian prior) + the 5 deferred follow-ups.

**Tech Stack:** Vanilla ES modules (browser), TMDB API, localStorage/sessionStorage, `node --test`, Puppeteer harness (system Chrome).

**Note on commits:** every `git commit` appends the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (omitted from individual steps for brevity).

**Baseline:** the full suite has **158** tests passing. Verify each task by delta + `fail 0`. Spec: `docs/superpowers/specs/2026-06-02-recommendation-engine-optimization-design.md`.

---

## Phase 1 — Speed & efficiency (network + compute)

All commits end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (stated once; applies to every commit below). Baseline before Phase 1: **158 tests passing, 0 failing**. Each task states the new total as a delta.

---

### Task 1: Remove hand-rolled BATCH + delay(300) throttling; submit each phase's URLs via Promise.all

The queue (`createFetchQueue`) is already the sole concurrency control; the three `for`-loop `BATCH`/`delay(300)` re-throttlers starve it (it never sees >BATCH URLs at once) and add ~3.6s of dead time. Replace each with a single `Promise.all` over the phase's full URL list. This is a network/UX change with **no unit test** — verified via `node --check`, full suite (no regression), and the harness.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — `enrichWatchedTitles`, `generateCandidates` (its appendDetail loop only — the post-loop collab/discover/filler merge stays), `discoverCandidates`, and the module-level `delay` helper.

- [ ] **Step 1: Verify the current state (no new test — this is a network change).** Confirm the suite is green before touching anything so the post-change run is a clean delta.
  - Run: `npm test`
  - Expected: **PASS**, `tests 158 / fail 0` (unchanged baseline).

- [ ] **Step 2: Implement — flatten `enrichWatchedTitles` to one `Promise.all`.** In `enrichWatchedTitles(watched)`, replace the entire `BATCH`/`for`/`delay(300)` body with a single parallel map over the full list (the queue caps concurrency). Replace the function body with:
  ```js
  // Attach _keywords/_people to each watched item. Concurrency is bounded by the
  // module fetch queue (maxInflight); no manual batching/delay — it only starves the queue.
  async function enrichWatchedTitles(watched) {
    const metas = await Promise.all(
      watched.map((m) => fetchTitleMeta(m.media_type === 'tv' ? 'tv' : 'movie', m.id))
    );
    return watched.map((m, j) => ({ ...m, _keywords: metas[j].keywords, _people: metas[j].people }));
  }
  ```

- [ ] **Step 3: Implement — flatten the appendDetail loop in `generateCandidates`.** In `generateCandidates`, replace the per-seed `BATCH`/`for`/`delay(300)` loop that builds `tagged` (from `const seeds = topSeeds(...)` through the loop end, i.e. the block that fetches `ENDPOINTS.appendDetail` per seed) with a single `Promise.all` over all seeds. Keep the post-loop `mergeCandidates`/`discoverCandidates`/`fillerCandidates`/`coldStartBlend` tail **unchanged** for now. Replace the seed-fetch block with:
  ```js
  const seeds = topSeeds(basketEnriched);
  const results = await Promise.all(
    seeds.map((seed) => {
      const type = seed.media_type === 'tv' ? 'tv' : 'movie';
      return fetchJson(ENDPOINTS.appendDetail(type, seed.id))
        .then((json) => ({ seed, json }))
        .catch(() => null);
    })
  );
  const tagged = [];
  for (const r of results) {
    if (!r) continue;
    const { keywords, people } = enrichmentFromAppend(r.json);
    const enrichedSeed = { ...r.seed, _keywords: keywords, _people: people };
    tagged.push(...extractSeedCandidates(enrichedSeed, r.json));
  }
  ```

- [ ] **Step 4: Implement — flatten `discoverCandidates` to one `Promise.all`.** In `discoverCandidates`, replace the `BATCH`/`for`/`delay(300)` loop with a single `Promise.all` over all `requests`. Replace the loop body with:
  ```js
  const results = await Promise.all(
    requests.map((r) =>
      fetchJson(r.url).then((d) => ({ d, seed: r.seed, url: r.url })).catch(() => null))
  );
  const tagged = [];
  for (const r of results) {
    if (!r) continue;
    const reqType = r.url.includes('/discover/tv?') ? 'tv' : 'movie';
    for (const movie of (r.d.results || [])) {
      tagged.push({ ...movie, media_type: movie.media_type || reqType, _seeds: [r.seed] });
    }
  }
  ```

- [ ] **Step 5: Implement — remove the now-unused `delay` helper.** With all three callers gone, the module-level `function delay(ms) { ... }` (near the meta-cache constants) has no remaining references. Delete the entire `delay` function declaration. (The `defaultDelay` inside `fetch-queue.js` is separate and stays.)

- [ ] **Step 6: Run — parse + full suite + grep for orphan references.**
  - Run: `node --check recommendations.js && grep -n 'delay(' recommendations.js; npm test`
  - Expected: `node --check` exits 0; the `grep` prints **nothing** (no surviving `delay(` calls in recommendations.js); `npm test` **PASS**, `tests 158 / fail 0` (network-only change, count unchanged).

- [ ] **Step 7: Run — headless harness regression.**
  - Run: `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs`
  - Expected: prints `rec-dom-harness: PASS`.

- [ ] **Step 8: Commit.** `git commit -am "perf(rec): drop hand-rolled BATCH+delay throttling; submit each phase via Promise.all"`

**New total: 158 tests passing, 0 failing.**

---

### Task 2: Enrich basket seeds once via `enrichAndExpandBasket` (stop double-enriching)

Today `_pipeline` calls `enrichWatchedTitles(basket)` (2 calls/seed: keywords + credits) to build the profile, then `generateCandidates` fetches `appendDetail` per seed — which **returns the same keywords+credits**. Factor a helper that fetches `appendDetail` **once per capped seed** and returns both `{ enrichedBasket, collabCandidates }`. `_pipeline` calls it before `buildTasteProfile`; `generateCandidates` drops its appendDetail loop and consumes `collabCandidates`. `enrichWatchedTitles` stays for **downvoted** titles only.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — new `enrichAndExpandBasket(basket, { fetchImpl })`, edits to `generateCandidates` (drop seed loop, take `collabCandidates`) and `_pipeline` (call helper before `buildTasteProfile`; enrich downvoted only).
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` — export `enrichAndExpandBasket`; add a unit test of its shaping via an injected fetch.

- [ ] **Step 1: Write failing test — the helper shapes both outputs from one payload per seed.** The helper is network-touching, so make `fetchImpl` injectable (defaulting to the module `fetchJson`) and unit-test the pure shaping with a fixture appendDetail payload. Add to `recommendations.test.js` (append near the `extractSeedCandidates` block, after `APPEND_JSON` is defined around line 576):
  ```js
  import { enrichAndExpandBasket } from './recommendations.js';

  test('enrichAndExpandBasket: one appendDetail call per capped seed yields enrichment + collab pool', async () => {
    // Two basket seeds; an injected fetch returns the shared APPEND_JSON shape (keywords+credits
    // for the profile AND recommendations+similar for the collab pool) from ONE call per seed.
    const APPEND_WITH_META = {
      ...APPEND_JSON,
      keywords: { keywords: [{ id: 9882, name: 'space' }, { id: 4379, name: 'time travel' }] },
      credits: {
        cast: [{ id: 6193, name: 'Leonardo DiCaprio' }],
        crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director' }],
      },
    };
    const basket = [
      { id: 27205, title: 'Inception', media_type: 'movie' },
      { id: 157336, title: 'Interstellar', media_type: 'movie' },
    ];
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return APPEND_WITH_META; };

    const { enrichedBasket, collabCandidates } = await enrichAndExpandBasket(basket, { fetchImpl });

    // (1) exactly one fetch per seed (no separate keywords+credits round-trips).
    assert.equal(calls.length, 2, 'one appendDetail call per seed');
    assert.ok(calls.every((u) => u.includes('append_to_response=')), 'used the appendDetail endpoint');

    // (2) enrichment attached for buildTasteProfile, in the {id,name} shape it expects.
    assert.equal(enrichedBasket.length, 2);
    assert.deepEqual(enrichedBasket[0]._keywords, [{ id: 9882, name: 'space' }, { id: 4379, name: 'time travel' }]);
    assert.deepEqual(
      enrichedBasket[0]._people,
      [{ id: 6193, name: 'Leonardo DiCaprio' }, { id: 525, name: 'Christopher Nolan' }],
      'cast + director, same shape as enrichWatchedTitles produced',
    );
    // original seed fields preserved.
    assert.equal(enrichedBasket[1].id, 157336);

    // (3) collab pool extracted from the SAME payload (rec + similar), seed-provenance tagged.
    assert.ok(collabCandidates.some((c) => c.id === 155 && c._seeds.some((s) => s.source === 'rec')),
      'rec candidate present with rec provenance');
    assert.ok(collabCandidates.some((c) => c.id === 49026 && c._seeds.some((s) => s.source === 'similar')),
      'similar candidate present with similar provenance');
    // (4) merged/deduped: candidate 155 appears once though both seeds surfaced it.
    assert.equal(collabCandidates.filter((c) => c.id === 155).length, 1, 'merged across seeds (deduped)');
  });
  ```

- [ ] **Step 2: Run — expect FAIL (helper not exported / not implemented).**
  - Run: `npm test 2>&1 | grep -E "enrichAndExpandBasket|tests |fail "`
  - Expected: **FAIL** — import resolves to `undefined`, so the test throws (`enrichAndExpandBasket is not a function`); `fail 1`.

- [ ] **Step 3: Implement `enrichAndExpandBasket`.** Add this exported helper next to `generateCandidates` in the network layer (it must follow `topSeeds`, `enrichmentFromAppend`, `extractSeedCandidates`, `mergeCandidates`, and `fetchJson`, all already defined). `fetchImpl` defaults to the module `fetchJson` so production calls are queued; tests inject a fake. It caps seeds via `topSeeds` (which already honors `MAX_SEEDS`):
  ```js
  // Enrich the basket seeds AND expand them in ONE appendDetail call per (capped) seed.
  // appendDetail returns keywords+credits (→ _keywords/_people for buildTasteProfile) AND
  // recommendations+similar (→ extractSeedCandidates collab pool) — both read from the SAME
  // payload, so a seed is never fetched twice. Returns { enrichedBasket, collabCandidates }.
  // fetchImpl is injectable for tests; production uses the queued module fetchJson.
  export async function enrichAndExpandBasket(basket, { fetchImpl = fetchJson } = {}) {
    const seeds = topSeeds(basket);
    const results = await Promise.all(
      seeds.map((seed) => {
        const type = seed.media_type === 'tv' ? 'tv' : 'movie';
        return fetchImpl(ENDPOINTS.appendDetail(type, seed.id))
          .then((json) => ({ seed, json }))
          .catch(() => null);
      })
    );
    const enrichedBasket = [];
    const tagged = [];
    for (const r of results) {
      if (!r) continue;
      const { keywords, people } = enrichmentFromAppend(r.json);
      enrichedBasket.push({ ...r.seed, _keywords: keywords, _people: people });
      tagged.push(...extractSeedCandidates({ ...r.seed, _keywords: keywords, _people: people }, r.json));
    }
    return { enrichedBasket, collabCandidates: mergeCandidates(tagged) };
  }
  ```

- [ ] **Step 4: Run — expect PASS on the new test.**
  - Run: `npm test 2>&1 | grep -E "enrichAndExpandBasket|tests |fail "`
  - Expected: **PASS** — the new test passes; `fail 0`.

- [ ] **Step 5: Implement — `generateCandidates` takes `collabCandidates`, drops its appendDetail loop.** `generateCandidates` no longer expands seeds itself; it receives the already-merged collab pool. Change its signature and replace the seed-fetch block (the `Promise.all` over `topSeeds` added in Task 1.1) plus the `const collab = mergeCandidates(tagged);` line with a direct use of the passed pool. The function's purpose becomes: **Discover ∪ collab, then filler-blend** (the Discover + `coldStartBlend` tail stays — note the trending/filler split in this phase's filler-split task and the order-fix task both also edit this function; describe relative to purpose). New `generateCandidates`:
  ```js
  // Combine the pre-expanded collaborative pool with Discover candidates, then blend
  // cold-start filler by basket size. Seed expansion now happens once in
  // enrichAndExpandBasket (called by _pipeline before buildTasteProfile), so this no
  // longer fetches appendDetail per seed.
  async function generateCandidates(collabCandidates, basketSize, profile, negProfile = null) {
    const collab = collabCandidates || [];
    const discover = await discoverCandidates(profile, negProfile);
    const personalPool = mergeCandidates([...collab, ...discover]);
    const filler = await fillerCandidates();
    return coldStartBlend(personalPool, filler, basketSize);
  }
  ```

- [ ] **Step 6: Implement — `_pipeline` calls `enrichAndExpandBasket` before `buildTasteProfile`; downvoted uses `enrichWatchedTitles`.** In `_pipeline`, the basket-enrichment line currently reads `const basketEnriched = annotatePos(await enrichWatchedTitles(basket));`. Replace the basket enrichment + the later `generateCandidates(...)` call so the collab pool is produced once and threaded through:
  - Replace `const basketEnriched = annotatePos(await enrichWatchedTitles(basket));` with:
    ```js
    const { enrichedBasket, collabCandidates } = await enrichAndExpandBasket(basket);
    const basketEnriched = annotatePos(enrichedBasket);
    ```
  - Leave `const downEnriched = annotateNeg(await enrichWatchedTitles(downvoted));` **unchanged** (downvoted still uses the keywords+credits path — no appendDetail).
  - Replace `const candidates = await generateCandidates(basketEnriched, profile, negProfile);` with:
    ```js
    const candidates = await generateCandidates(collabCandidates, basket.length, profile, negProfile);
    ```
  (Pass `basket.length` — the raw basket size — so `coldStartBlend` weighting matches the prior `basketEnriched.length`.)

- [ ] **Step 7: Run — parse + full suite.**
  - Run: `node --check recommendations.js && npm test 2>&1 | tail -8`
  - Expected: `node --check` exits 0; **PASS**, `tests 159 / fail 0` (+1 from the new helper test; the `generateCandidates`/`_pipeline` edits are network-path, untested by units).

- [ ] **Step 8: Run — headless harness regression.**
  - Run: `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs`
  - Expected: prints `rec-dom-harness: PASS`.

- [ ] **Step 9: Commit.** `git commit -am "perf(rec): enrichAndExpandBasket — expand+enrich seeds once, drop double appendDetail"`

**New total: 159 tests passing, 0 failing.**

---

### Task 3: Cap Discover fan-out (pages:1, maxKeywords:4, maxPeople:3; slice facets after concat)

`discoverCandidates` should call `buildDiscoverRequests` with explicit caps, and `buildDiscoverRequests` must slice `keywordFacets` to `maxKeywords` **after** concatenating `genreKeywordIds` (today the genre-derived keyword ids inflate the facet count past `maxKeywords`).

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — `buildDiscoverRequests` (slice `keywordFacets` after concat), `discoverCandidates` (pass caps).
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` — unit test the facet/page cap.

- [ ] **Step 1: Write failing test — capped facets and single page.** Add after the existing `buildDiscoverRequests` tests (after line 1226). The fixture profile carries many keywords + the genre-typed keyword id, so the post-concat slice is observable:
  ```js
  test('buildDiscoverRequests caps keyword facets AFTER concat and honors page/people caps', () => {
    // 5 real keywords + DISC_CAP_PROFILE.genres carries a keyword-typed id (4565 Dystopia),
    // so genreKeywordIds adds one more keyword facet. maxKeywords=4 must bound the TOTAL
    // (real + genre-derived) keyword facets to 4 per (type,page), not 4-real-then-append.
    const DISC_CAP_PROFILE = {
      genres: { '878': 5, '28': 4, '4565': 3 }, // 4565 Dystopia is type:'keyword'
      keywords: {
        '4379': { name: 'Time Travel', weight: 6 },
        '9882': { name: 'Space', weight: 5 },
        '12377': { name: 'Zombie', weight: 4 },
        '818': { name: 'Based on Novel', weight: 3 },
        '9748': { name: 'Revenge', weight: 2 },
      },
      people: { '1': { name: 'A', weight: 5 }, '2': { name: 'B', weight: 4 }, '3': { name: 'C', weight: 3 }, '4': { name: 'D', weight: 2 } },
      mediaTypeBias: { movie: 5, tv: 1 },
      topTitles: [],
    };
    const reqs = buildDiscoverRequests(DISC_CAP_PROFILE, null, { pages: 1, maxKeywords: 4, maxPeople: 3 });

    // Single page only.
    assert.ok(reqs.every((r) => r.url.includes('page=1')), 'pages:1 only');
    assert.ok(!reqs.some((r) => r.url.includes('page=2')), 'no page=2 at pages:1');

    // Keyword facets capped at 4 PER media type (distinct keyword ids in keyword reqs / 2 types).
    const movieKwIds = new Set(reqs
      .filter((r) => r.seed.type === 'keyword' && r.url.includes('/discover/movie?'))
      .map((r) => r.seed.id));
    assert.ok(movieKwIds.size <= 4, `keyword facets must be <= maxKeywords after concat, got ${movieKwIds.size}`);

    // People facets capped at 3 per media type.
    const moviePeople = new Set(reqs
      .filter((r) => r.seed.type === 'person' && r.url.includes('/discover/movie?'))
      .map((r) => r.seed.id));
    assert.ok(moviePeople.size <= 3, `people facets must be <= maxPeople, got ${moviePeople.size}`);
  });
  ```

- [ ] **Step 2: Run — expect FAIL.**
  - Run: `npm test 2>&1 | grep -E "caps keyword facets AFTER concat|tests |fail "`
  - Expected: **FAIL** — without the post-concat slice, `movieKwIds.size` is 5 (4 real keywords + 1 genre-derived Dystopia keyword), exceeding 4; `fail 1`.

- [ ] **Step 3: Implement — slice `keywordFacets` to `maxKeywords` after concat.** In `buildDiscoverRequests`, the `keywordFacets` array is built as `[...topKeywords, ...genreKeywordIds.map(...)]`. Append a `.slice(0, maxKeywords)` to that concatenation so the genre-derived keyword ids count against the cap. Replace the `keywordFacets` assignment with:
  ```js
  // Keyword facets = real theme keywords + any keyword-typed ids misfiled under genres,
  // then capped to maxKeywords AFTER concatenation so genre-derived keyword ids don't
  // inflate the facet count past the cap.
  const keywordFacets = [
    ...topKeywords,
    ...genreKeywordIds.map((id) => ({ id, name: GENRE_NAMES.get(id) || 'keyword', weight: 1 })),
  ].slice(0, maxKeywords);
  ```

- [ ] **Step 4: Implement — `discoverCandidates` passes the caps.** In `discoverCandidates`, the request build currently reads `const requests = buildDiscoverRequests(profile, negProfile, {});`. Replace the opts object with the caps:
  ```js
  const requests = buildDiscoverRequests(profile, negProfile, { pages: 1, maxKeywords: 4, maxPeople: 3 });
  ```

- [ ] **Step 5: Run — expect PASS + no regression.**
  - Run: `node --check recommendations.js && npm test 2>&1 | tail -8`
  - Expected: `node --check` exits 0; **PASS**, `tests 160 / fail 0` (+1).

- [ ] **Step 6: Commit.** `git commit -am "perf(rec): cap Discover fan-out (pages:1, maxKeywords:4, maxPeople:3); slice facets after concat"`

**New total: 160 tests passing, 0 failing.**

---

### Task 4: Raise queue concurrency 6 → 12

The module-level `createFetchQueue` instance in `recommendations.js` caps `maxInflight: 6`. With the throttle loops gone (Task 1.1), raise it to 12 so a ~22-call refresh drains in ~2 waves; stays under TMDB's ~20-concurrent ceiling, and the 429 backoff self-heals bursts. Network change — no unit test.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — the `_recFetchQueue` `createFetchQueue({ ... maxInflight: 6 ... })` literal.

- [ ] **Step 1: Implement — bump `maxInflight`.** In the `_recFetchQueue = createFetchQueue({...})` object, change `maxInflight: 6,` to:
  ```js
  maxInflight: 12,
  ```
  (Only the module instance in `recommendations.js` — the `createFetchQueue` default of 6 in `fetch-queue.js` is unchanged, and `fetch-queue.test.js` constructs its own queues with explicit `maxInflight`, so it is unaffected.)

- [ ] **Step 2: Run — parse + full suite.**
  - Run: `node --check recommendations.js && npm test 2>&1 | tail -8`
  - Expected: `node --check` exits 0; **PASS**, `tests 160 / fail 0` (unchanged — the queue's own concurrency-cap test pins its injected `maxInflight: 2`, independent of this constant).

- [ ] **Step 3: Run — headless harness regression.**
  - Run: `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs`
  - Expected: prints `rec-dom-harness: PASS`.

- [ ] **Step 4: Commit.** `git commit -am "perf(rec): raise module fetch-queue maxInflight 6 -> 12"`

**New total: 160 tests passing, 0 failing.**

---

### Task 5: Exclude watched ∪ basket ∪ downvoted BEFORE `scorePool` in `_pipeline`

Move the exclusion ahead of scoring so excluded items never enter `scorePool` (skipping their full scoring + the expensive `generateReasons`) and never skew the IDF corpus. This matches `rankCandidates`' already-correct order. No new unit test — it is a reorder of an existing, tested behavior; verified by full suite + `node --check`.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — `_pipeline` (build `excludeIds`, filter `candidates` first, drop the post-score `.filter`).

- [ ] **Step 1: Run — confirm green baseline.**
  - Run: `npm test 2>&1 | tail -4`
  - Expected: **PASS**, `tests 160 / fail 0`.

- [ ] **Step 2: Implement — filter candidates before scoring.** In `_pipeline`, the current sequence is:
  ```js
  const candidates = await generateCandidates(collabCandidates, basket.length, profile, negProfile);
  const excludeIds = new Set(
    [...basket, ...downvoted].map((m) => m.id).concat(watchedIds)
  );
  const scored = scorePool(candidates, { profile, now, dislikeVector })
    .filter((s) => !excludeIds.has(s.movie.id));
  const recs = mmrRerank(scored, { lambda, limit });
  ```
  Replace it so the exclusion happens on `candidates` (before `scorePool`) and the post-score `.filter` is dropped:
  ```js
  const candidates = await generateCandidates(collabCandidates, basket.length, profile, negProfile);
  const excludeIds = new Set(
    [...basket, ...downvoted].map((m) => m.id).concat(watchedIds)
  );
  const pool = candidates.filter((c) => !excludeIds.has(c.id));
  const scored = scorePool(pool, { profile, now, dislikeVector });
  const recs = mmrRerank(scored, { lambda, limit });
  ```

- [ ] **Step 3: Run — parse + full suite.**
  - Run: `node --check recommendations.js && npm test 2>&1 | tail -8`
  - Expected: `node --check` exits 0; **PASS**, `tests 160 / fail 0` (behavior-preserving reorder).

- [ ] **Step 4: Commit.** `git commit -am "perf(rec): exclude watched/basket/downvoted before scorePool in _pipeline"`

**New total: 160 tests passing, 0 failing.**

---

### Task 6: In-memory memo mirror + batched write-through in `fetch-queue.js`

Replace the per-fetch `JSON.parse`/`JSON.stringify` of the whole memo blob with an in-memory mirror read **once** at queue creation. Serve `fetchJson` memo reads from the mirror; write-through to it; **debounce/flush** `storage.setItem` (microtask) instead of stringifying the growing blob on every fetch. Extend `fetch-queue.test.js` to assert reads come from the mirror (`getItem` once at creation, not per fetch) and that the memo still de-dupes/persists.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/fetch-queue.js` — `createFetchQueue` (closure mirror `memo`, `readMemo`→mirror, `writeMemo`→mirror + debounced flush, `clearMemo`→clear mirror + storage).
- `/home/tahseen-dar/Projects/MoviesDB/fetch-queue.test.js` — new assertions.

- [ ] **Step 1: Write failing tests — getItem once at creation; mirror still persists/dedupes.** Append to `fetch-queue.test.js`. The fake storage needs a `getItem` counter — add a counting wrapper inside the tests (don't modify the shared `fakeStorage` to avoid touching other tests):
  ```js
  // Wrap fakeStorage to count getItem(MEMO_KEY) reads.
  function countingStorage() {
    const s = fakeStorage();
    let getItemCount = 0;
    return {
      getItem: (k) => { getItemCount++; return s.getItem(k); },
      setItem: (k, v) => s.setItem(k, v),
      removeItem: (k) => s.removeItem(k),
      _map: s._map,
      _getItemCount: () => getItemCount,
    };
  }

  test('memo mirror: storage.getItem is read once at creation, not per fetch', async () => {
    const storage = countingStorage();
    const fetchImpl = async (url) => jsonResponse({ url });
    const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });
    const atCreation = storage._getItemCount();
    assert.equal(atCreation, 1, 'mirror seeded by exactly one getItem at creation');

    await q.fetchJson('https://api/m/1');
    await q.fetchJson('https://api/m/2');
    await q.fetchJson('https://api/m/1'); // memo hit
    await flush();
    assert.equal(storage._getItemCount(), 1, 'no further getItem reads per fetch (served from mirror)');
  });

  test('memo mirror: writes flush through to storage and de-dupe/persist across a new queue', async () => {
    const storage = fakeStorage();
    let calls = 0;
    const fetchImpl = async (url) => { calls++; return jsonResponse({ url }); };
    const q1 = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

    await q1.fetchJson('https://api/persist');
    await flush(); // allow the debounced flush to run
    assert.equal(calls, 1);
    // Written through to the backing storage.
    assert.ok(storage.getItem('recFetchMemo'), 'memo flushed to storage');

    // A NEW queue seeds its mirror from storage -> served from memo, no refetch.
    const q2 = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });
    const out = await q2.fetchJson('https://api/persist');
    assert.deepEqual(out, { url: 'https://api/persist' });
    assert.equal(calls, 1, 'new queue serves the persisted entry from its mirror, no refetch');
  });
  ```

- [ ] **Step 2: Run — expect FAIL.**
  - Run: `npm test 2>&1 | grep -E "memo mirror|tests |fail "`
  - Expected: **FAIL** — the current `readMemo()` calls `storage.getItem` on every `fetchJson`, so `_getItemCount()` is > 1 after fetches; `fail 1` (or 2).

- [ ] **Step 3: Implement — closure mirror + debounced flush.** Edit `createFetchQueue` in `fetch-queue.js`. Seed a `memo` object once from storage at creation; serve reads from it; write-through + schedule a single debounced flush. Replace the existing `readMemo`/`writeMemo` block (the two functions between the `let active = 0;` declaration and `pump()`) with:
  ```js
  // In-memory mirror of the URL->json memo, seeded ONCE from storage at creation.
  // Reads serve from this object; writes go through to it and schedule a single
  // debounced flush of storage.setItem (instead of parse+stringify of the whole blob
  // per fetch). dirty/flushScheduled bound the flush to one microtask per write burst.
  let memo = {};
  if (storage) {
    try {
      memo = JSON.parse(storage.getItem(MEMO_KEY) || '{}');
    } catch {
      memo = {};
    }
  }
  let dirty = false;
  let flushScheduled = false;

  function flushMemo() {
    flushScheduled = false;
    if (!storage || !dirty) return;
    dirty = false;
    try {
      storage.setItem(MEMO_KEY, JSON.stringify(memo));
    } catch {
      // storage full / unavailable -> mirror remains the source of truth this session.
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    Promise.resolve().then(flushMemo);
  }

  function writeMemo(url, json) {
    memo[url] = json;
    if (!storage) return;
    dirty = true;
    scheduleFlush();
  }
  ```

- [ ] **Step 4: Implement — `fetchJson` reads the mirror; `clearMemo` clears mirror + storage.** In `fetchJson`, replace the leading `const memo = readMemo();` (the now-removed function) and its hasOwnProperty guard so it reads the closure `memo` directly. Replace the first three lines of `fetchJson` with:
  ```js
  function fetchJson(url) {
    if (Object.prototype.hasOwnProperty.call(memo, url)) {
      return Promise.resolve(memo[url]);
    }
  ```
  And replace `clearMemo`:
  ```js
  function clearMemo() {
    memo = {};
    dirty = false;
    if (storage) storage.removeItem(MEMO_KEY);
  }
  ```

- [ ] **Step 5: Run — expect PASS (new + all existing fetch-queue tests).**
  - Run: `node --check fetch-queue.js && npm test 2>&1 | grep -E "memo mirror|memoizes|de-dupes|clearMemo|tests |fail "`
  - Expected: `node --check` exits 0; **PASS** — new mirror tests green AND the pre-existing `memoizes…`, `de-dupes…`, `clearMemo…` tests still green (the debounced flush completes within the existing `flush()` helper before assertions); `fail 0`.

- [ ] **Step 6: Run — full suite.**
  - Run: `npm test 2>&1 | tail -8`
  - Expected: **PASS**, `tests 162 / fail 0` (+2).

- [ ] **Step 7: Commit.** `git commit -am "perf(fetch-queue): in-memory memo mirror + debounced write-through"`

**New total: 162 tests passing, 0 failing.**

---

### Task 7: Bound + memoize the re-rank; single-pass min/max

Three compute cuts: (a) pre-truncate `mmrRerank`'s input to `min(pool, 6·limit)` by score before the O(N²) re-rank; (b) memoize a genre `Set` + seedTitleId `Set` per Scored item so `itemSim` reads cached Sets; (c) replace `Math.min(...arr)`/`Math.max(...arr)` in `scorePool` and `mmrRerank` with a single-pass loop (also removes the latent `RangeError` spread cliff on huge pools).

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — new pure helper `minMax(arr)`; `itemSim` (read cached `_genreSet`/`_seedSet` when present); `mmrRerank` (truncate input; attach cached Sets; use `minMax`); `scorePool` (use `minMax` for collab range).
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` — unit tests for truncation, single-pass min/max, and small-pool invariance.

- [ ] **Step 1: Write failing tests.** Append after the existing `mmrRerank` tests (after line 1100). Tests cover the new exported `minMax`, top-K truncation keeping the highest-scored, and small-pool behavior unchanged:
  ```js
  import { minMax } from './recommendations.js';

  test('minMax: single-pass result matches the spread Math.min/Math.max', () => {
    const arr = [3, -1, 7, 7, 0, 2.5, -8];
    assert.deepEqual(minMax(arr), { min: Math.min(...arr), max: Math.max(...arr) });
  });

  test('minMax: empty array yields {min:0,max:0} (no -Infinity/Infinity)', () => {
    assert.deepEqual(minMax([]), { min: 0, max: 0 });
  });

  test('mmrRerank: pre-truncates to 6*limit by score, keeping the highest-scored', () => {
    // 40 distinct-genre, distinct-seed candidates; limit=2 => 6*limit=12 survive truncation.
    // Items 0..39 have descending scores; the kept set must be the top-12 by score, and the
    // final 2 picks must come from that top band (ids 0/1 are the two highest).
    const scored = [];
    for (let i = 0; i < 40; i += 1) {
      scored.push(sc(1000 + i, 1 - i * 0.01, {
        genres: [i + 1],
        seeds: [{ source: 'rec', type: 'title', id: i, seedId: i, rank: 0, weight: 1 }],
      }));
    }
    const out = mmrRerank(scored, { lambda: 1, limit: 2, simFn: itemSim });
    // lambda=1 is pure relevance => the two highest-scored ids survive in order.
    assert.deepEqual(out.map((r) => r.movie.id), [1000, 1001]);
  });

  test('mmrRerank: behavior unchanged on a small pool (below the 6*limit bound)', () => {
    // 3 items, limit 10 => truncation is a no-op; result equals the pre-change ordering.
    const scored = [
      sc(1, 0.9, { genres: [1] }),
      sc(2, 0.7, { genres: [2] }),
      sc(3, 0.5, { genres: [3] }),
    ];
    const out = mmrRerank(scored, { lambda: 1, limit: 10, simFn: itemSim });
    assert.deepEqual(out.map((r) => r.movie.id), [1, 2, 3]);
  });

  test('itemSim: cached _genreSet/_seedSet give the same result as recomputed Sets', () => {
    // Same two movies, one pair plain and one pair with caches pre-attached; results match.
    const a = { id: 1, genre_ids: [878, 28], _seeds: [{ source: 'rec', type: 'title', id: 5, seedId: 5 }] };
    const b = { id: 2, genre_ids: [878, 18], _seeds: [{ source: 'rec', type: 'title', id: 5, seedId: 5 }] };
    const plain = itemSim(a, b);
    const a2 = { ...a, _genreSet: new Set([878, 28]), _seedSet: new Set([5]) };
    const b2 = { ...b, _genreSet: new Set([878, 18]), _seedSet: new Set([5]) };
    assert.ok(Math.abs(itemSim(a2, b2) - plain) < 1e-12, 'cached Sets match recomputed');
  });
  ```

- [ ] **Step 2: Run — expect FAIL.**
  - Run: `npm test 2>&1 | grep -E "minMax|pre-truncates|cached _genreSet|behavior unchanged on a small pool|tests |fail "`
  - Expected: **FAIL** — `minMax` import is `undefined`; `fail` > 0.

- [ ] **Step 3: Implement — exported `minMax` helper.** Add near the other pure helpers (e.g. just below `jaccard`, before `seedTitleIds`):
  ```js
  // Single-pass min/max over a numeric array. Avoids Math.min(...arr)/Math.max(...arr),
  // which both spread the whole array onto the call stack (a RangeError cliff at N in the
  // tens of thousands) and walk it twice. Empty array => {min:0,max:0}.
  export function minMax(arr) {
    if (!arr || arr.length === 0) return { min: 0, max: 0 };
    let min = arr[0];
    let max = arr[0];
    for (let i = 1; i < arr.length; i += 1) {
      const v = arr[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }
  ```

- [ ] **Step 4: Implement — `itemSim` reads cached Sets when present.** In `itemSim`, the two `new Set((a.genre_ids||[])...)` lines and the two `seedTitleIds(...)` calls rebuild Sets on every pairwise call. Make them read a precomputed cache when attached. Replace the body of `itemSim` (after the `if (a.id === b.id) return 1;` guard) with:
  ```js
  const ga = a._genreSet || new Set((a.genre_ids || []).map(Number));
  const gb = b._genreSet || new Set((b.genre_ids || []).map(Number));
  const genreJ = jaccard(ga, gb);
  const sa = a._seedSet || seedTitleIds(a);
  const sb = b._seedSet || seedTitleIds(b);
  const provJ = jaccard(sa, sb);
  return 0.6 * genreJ + 0.4 * provJ;
  ```

- [ ] **Step 5: Implement — `mmrRerank` truncation, cached-Set attach, single-pass min/max.** Three edits inside `mmrRerank` (this function is also touched by other phases — describe relative to its purpose: it sorts desc, collapses near-dups, runs greedy MMR with a per-seed cap):
  - After the `const sorted = [...scored].sort((a, b) => b.score - a.score);` line, pre-truncate to `6·limit` by score and attach per-item Set caches on the truncated working set so the O(N²) inner loop reads cached Sets. Insert immediately after the `sorted` line:
    ```js
    // Bound the O(N^2) re-rank: keep only the top (6*limit) by score before collapsing.
    // `sorted` is already score-desc, so a prefix slice is the top band. No-op when unbounded.
    const bound = Number.isFinite(limit) ? Math.min(sorted.length, 6 * limit) : sorted.length;
    const work = sorted.slice(0, bound);
    // Memoize each movie's genre Set + rec/similar seedId Set once so itemSim reads caches
    // instead of rebuilding Sets on every pairwise comparison.
    for (const s of work) {
      if (!s.movie._genreSet) s.movie._genreSet = new Set((s.movie.genre_ids || []).map(Number));
      if (!s.movie._seedSet) s.movie._seedSet = seedTitleIds(s.movie);
    }
    ```
    Then change the near-duplicate-collapse loop that currently iterates `for (const cand of sorted)` to iterate `for (const cand of work)`.
  - In the relevance-normalization block, replace:
    ```js
    const scores = survivors.map((s) => s.score);
    const lo = Math.min(...scores);
    const hi = Math.max(...scores);
    const span = hi - lo;
    ```
    with:
    ```js
    const { min: lo, max: hi } = minMax(survivors.map((s) => s.score));
    const span = hi - lo;
    ```

- [ ] **Step 6: Implement — `scorePool` single-pass collab min/max.** In `scorePool`, replace:
  ```js
  const collabRaw = candidates.map(collabScore);
  const cMin = collabRaw.length ? Math.min(...collabRaw) : 0;
  const cMax = collabRaw.length ? Math.max(...collabRaw) : 0;
  const cRange = cMax - cMin;
  ```
  with:
  ```js
  const collabRaw = candidates.map(collabScore);
  const { min: cMin, max: cMax } = minMax(collabRaw);
  const cRange = cMax - cMin;
  ```

- [ ] **Step 7: Run — expect PASS + regression suite.**
  - Run: `node --check recommendations.js && npm test 2>&1 | tail -8`
  - Expected: `node --check` exits 0; **PASS**, `tests 167 / fail 0` (+5). The existing `mmrRerank`/`scorePool`/`itemSim` regression tests stay green (small pools below the bound are untouched; cached Sets equal recomputed Sets).

- [ ] **Step 8: Commit.** `git commit -am "perf(rec): bound+memoize mmrRerank; single-pass min/max in scorePool & mmrRerank"`

**New total: 167 tests passing, 0 failing.**

---

### Task 8: Split filler into `trendingCandidates()` (always) + `topRatedFiller()` (cold-start only)

`fillerCandidates` currently fetches 3 calls (1 trending + 2 top_rated) every refresh, most of which a full basket discards. Split it: `trendingCandidates()` (1 `trending(1)` call, always merged → standing "Trending this week" row) and `topRatedFiller()` (2 `top_rated` calls, cold-start only). `generateCandidates` merges trending unconditionally and blends top-rated via `coldStartBlend` only when `basketSize < COLD_START_FULL`. Verify: trending row renders on a full basket; cold-start still blends top_rated. Network/UX — verified via `node --check` + harness + full suite.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — new `trendingCandidates()` + `topRatedFiller()` (replacing `fillerCandidates`); `generateCandidates` (merge trending always, blend top-rated cold-start-only).
- `/home/tahseen-dar/Projects/MoviesDB/rec-dom-harness.mjs` — extend the fixture to include a `trending`-kind row and assert it renders.

- [ ] **Step 1: Run — confirm green baseline + harness pass before splitting.**
  - Run: `npm test 2>&1 | tail -4 && PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs`
  - Expected: **PASS**, `tests 167 / fail 0`; harness prints `rec-dom-harness: PASS`.

- [ ] **Step 2: Implement — split `fillerCandidates` into `trendingCandidates` + `topRatedFiller`.** Replace the entire `fillerCandidates` function with two functions, preserving the existing seed-tagging (`source:'trending'` and `source:'toprated'`) and the `media_type` filtering for trending:
  ```js
  // Standing Trending source: one /trending/all/week call (mixed media_type). Always fetched
  // and merged into the pool so "Trending this week" is a row on every basket. Each candidate
  // gets a provenance SeedTag (source:'trending', id = title id, 0-based rank).
  async function trendingCandidates() {
    const tagged = [];
    await fetchJson(ENDPOINTS.trending(1))
      .then((d) => (d.results || []).forEach((m, rank) => {
        // /trending/all/week can include person results — keep only movie/tv.
        const mediaType = m.media_type === 'tv' ? 'tv' : m.media_type === 'movie' ? 'movie' : null;
        if (!mediaType) return;
        tagged.push({ ...m, media_type: mediaType,
          _seeds: [{ source: 'trending', type: 'title', id: m.id, rank, weight: 1 }] });
      }))
      .catch(() => {});
    return mergeCandidates(tagged);
  }

  // Cold-start-only filler: two /top_rated calls (movie + tv). Fetched ONLY for thin baskets
  // (the coldStartBlend caller gates on basketSize), so a full basket never pays for it.
  async function topRatedFiller() {
    const tagged = [];
    await Promise.all(['movie', 'tv'].map((type) =>
      fetchJson(ENDPOINTS.topRated(type, 1))
        .then((d) => (d.results || []).forEach((m, rank) => {
          tagged.push({ ...m, media_type: type,
            _seeds: [{ source: 'toprated', type: 'title', id: m.id, rank, weight: 1 }] });
        }))
        .catch(() => {})));
    return mergeCandidates(tagged);
  }
  ```

- [ ] **Step 3: Implement — `generateCandidates` merges trending always, blends top-rated cold-start-only.** In `generateCandidates` (the form left by Task 1.2: it takes `collabCandidates, basketSize, profile, negProfile`, fetches Discover, and `coldStartBlend`s filler), replace the body so trending is merged unconditionally into the personal pool and `topRatedFiller` is fetched + blended **only** when `basketSize < COLD_START_FULL`:
  ```js
  async function generateCandidates(collabCandidates, basketSize, profile, negProfile = null) {
    const collab = collabCandidates || [];
    const [discover, trending] = await Promise.all([
      discoverCandidates(profile, negProfile),
      trendingCandidates(),
    ]);
    // Trending is a standing row on every basket: merged into the pool unconditionally.
    const personalPool = mergeCandidates([...collab, ...discover, ...trending]);
    // Top-rated filler only for cold/thin baskets; a full basket never fetches it.
    if (basketSize < COLD_START_FULL) {
      const filler = await topRatedFiller();
      return coldStartBlend(personalPool, filler, basketSize);
    }
    return personalPool;
  }
  ```
  (`coldStartBlend` with a full basket already returns personalized-only, so a full basket short-circuits cleanly without the extra fetch.)

- [ ] **Step 4: Extend the harness — add a `trending`-kind row + assert it renders.** In `rec-dom-harness.mjs`, the `scriptTail` fixture `rows` array and `REC_ROW_KICKERS` map drive what renders. Add a trending row to the fixture and a kicker entry, then assert exactly one trending rail.
  - In the `rows` array (between the `top` row object and the `explore` row object), add:
    ```js
    { kind: 'trending', title: 'Trending this week', recs: [
      { movie: { id: 4, title: 'Dune', media_type: 'movie', vote_average: 8.0, vote_count: 50000, _seeds: [{ source: 'trending', type: 'title', id: 4, rank: 0, weight: 1 }] },
        score: 0.8, reasons: ['Trending this week'] },
    ] },
    ```
  - In `REC_ROW_KICKERS`, add `trending: 'Popular right now',` so the rail gets a non-empty kicker (the harness already asserts every rail has one).
  - After the existing `// (b) exactly one explore rail.` assertion block, add a trending assertion:
    ```js
    // (b2) the trending row renders exactly once (standing Trending this week row).
    const trendingCount = await page.$$eval('[data-rec-kind="trending"]', (els) => els.length);
    assert.equal(trendingCount, 1, 'exactly one trending rail (standing Trending this week row)');
    ```

- [ ] **Step 5: Run — parse + full suite + harness.**
  - Run: `node --check recommendations.js && npm test 2>&1 | tail -8 && PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs`
  - Expected: `node --check` exits 0; **PASS**, `tests 167 / fail 0` (network split is untested by units; the existing `groupIntoRows: emits a single Trending this week row…` test still passes since `trendingCandidates` keeps `source:'trending'`); harness prints `rec-dom-harness: PASS` (now including the trending-rail assertion, confirming the standing trending row renders on a full basket).

- [ ] **Step 6: Commit.** `git commit -am "perf(rec): split filler into trendingCandidates (always) + topRatedFiller (cold-start only)"`

**New total: 167 tests passing, 0 failing.**

---

**Phase 1 end state:** 167 tests passing (up from 158: +1 helper, +1 Discover cap, +2 fetch-queue mirror, +5 re-rank/min-max), 0 failing. Per-refresh TMDB calls ~70 → ~22; ~3.6s of dead-time delays removed; large main-thread compute cut (bounded O(N²) re-rank, cached Sets, single-pass min/max, O(1)-amortized memo). All network/UX changes verified by `node --check recommendations.js`, the full suite, and the extended `rec-dom-harness.mjs`.

## Phase 2 — Perceived speed (rendering UX)

> Baseline: full suite = **158 tests passing, fail=0**. Phase 2 adds no `node --test` unit tests (DOM + engine-streaming work), so every task below must keep the count at exactly **158 pass / 0 fail** — that is the regression gate. Each non-test verification uses: `node --check recommendations.js`, `node --check script.js`, `npm test`, and the headless harness `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs`. All commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
>
> Cross-phase note: `_pipeline`, `generateCandidates`, `getRecommendationRows`, `groupIntoRows`, and `clearRecommendationCache` are edited by other phases too. All edits below are described **relative to each function's purpose** (e.g. "the await that fetches Discover", "the candidate-merge that blends filler", "the sessionStorage delete loop"), never by line number or by another phase's task number, so they apply regardless of whether Phase 1's `enrichAndExpandBasket` refactor / parallel-`Promise.all` rewrite has landed first. Where Phase 1 already parallelized a fetch group, the relevant step here degrades to "confirm the `Promise.all` is in place and wire the `onRow` emission into it."

---

### Task 9: Engine streaming hook — `onRow` callback + parallel Discover/filler fan-out

Add an `onRow(row)` streaming callback to the engine so the page can paint each rail as its underlying data resolves, instead of awaiting the whole fan-out. The collaborative-provenance rows ("Because you liked X") + the calibrated **Top Picks** are computed and emitted once the collaborative pool resolves; "More ‹Genre›" rows are emitted when Discover lands; "Trending this week" when trending lands. Run `discoverCandidates` and the filler/trending fetches in **parallel** (`Promise.all`), not sequential awaits. The hero Top Picks is held until the full pool completes (it must be calibrated against the complete scored pool) — only the cheaper collab provenance rows lead.

This is an engine-internal sequencing change with no pure-function surface, so there is **no new `node --test` unit test**; it is verified by `node --check`, the unchanged unit suite (the scoring/grouping functions it reuses keep their existing tests green), and a new harness assertion in Task 2.10 that drives a fake streaming engine through `renderRecommendationsPage`.

**Files:**
- `recommendations.js` — `_pipeline(input, opts)` (accept + thread `onRow`/`now`; reorder so collab pool resolves first); `generateCandidates(basketEnriched, profile, negProfile)` (parallelize Discover + filler via `Promise.all`, return the staged pools instead of one pre-blended array); `getRecommendationRows(input, opts)` (accept `onRow`, drive `groupIntoRows` per-stage emission); `groupIntoRows(ranked, profile, opts)` (no behavioral change — reused as the single source of row identity; confirm `kind`/`recs` shape unchanged).

- [ ] **Step 1: write the failing check — `onRow` is plumbed through the public entrypoint.**
  Append a focused assertion to the existing engine suite that proves `getRecommendationRows` invokes a supplied `onRow` at least once and that the streamed rows union-equal the returned `rows`. Add to `recommendations.test.js` (the import block and a fixed-clock `NOW` already exist at top — reuse them; do **not** redeclare them):

  ```js
  // --- Phase 2.9: streaming onRow emission ---
  import { getRecommendationRows as _streamRows } from './recommendations.js';

  test('getRecommendationRows streams every returned row through onRow exactly once', async () => {
    // Empty basket => cold-start trending path: no network seeds needed, the engine still
    // produces a trending-led row set, so onRow must fire for each row it ultimately returns.
    const streamed = [];
    const { rows } = await _streamRows(
      { basket: [], downvoted: [], watchedIds: [] },
      { limit: 12, now: NOW, onRow: (r) => streamed.push(r) },
    );
    // Every returned row was announced via onRow, and nothing extra was announced.
    const key = (r) => `${r.kind}::${r.title}`;
    assert.deepEqual(
      streamed.map(key).sort(),
      rows.map(key).sort(),
      'streamed rows must be exactly the returned rows (no dupes, no drops)',
    );
    assert.ok(streamed.length >= 1, 'at least one row should stream even cold-start');
  });
  ```

- [ ] **Step 2: run — expect FAIL.**
  `npm test`
  Expected: the new test fails (currently `getRecommendationRows` ignores `onRow`, so `streamed` stays empty → `assert.ok(streamed.length >= 1)` throws). Suite reports **158 pass, 1 fail** (the new test); confirm the failure is the streaming assertion, not a regression elsewhere.

- [ ] **Step 3: implement — parallelize fan-out and thread `onRow` through the pipeline.**

  **(a) In `generateCandidates`** — its purpose is to produce the merged candidate pool from collab + Discover + filler. Replace its sequential tail (the part that, after building the collab `tagged`/`collab` pool, does `await discoverCandidates(...)` then `await fillerCandidates()` then `coldStartBlend`) so the two independent network groups run concurrently and the staged pools are returned for streaming. If Phase 1 has already converted the per-seed collab loop to a single `Promise.all` and/or moved collab generation into `enrichAndExpandBasket`, keep that; this step only governs the Discover/filler stage and the return shape. Replace the post-collab block with:

  ```js
  // Discover and the filler/trending fetches are independent of each other and of the
  // already-resolved collab pool — fan them out concurrently instead of awaiting in series.
  const [discover, filler] = await Promise.all([
    discoverCandidates(profile, negProfile),
    fillerCandidates(),
  ]);
  const personalPool = mergeCandidates([...collab, ...discover]);
  const blended = coldStartBlend(personalPool, filler, basketEnriched.length);
  // Return the staged pools so _pipeline can score/emit rows as each lands. `pool` is the
  // final blended candidate set (identical to the pre-streaming return value); `collab`,
  // `discover`, `filler` expose the provenance sub-pools for progressive emission.
  return { pool: blended, collab, discover, filler };
  ```

  Note: callers that previously consumed `generateCandidates`'s return as a bare array now read `.pool`. The only caller is `_pipeline` (edited in (b)); no other module imports it.

  **(b) In `_pipeline`** — accept `onRow` from `opts`, and after computing the net `profile`/`dislikeVector`, change the candidate step so it (1) gets the staged pools, (2) scores+excludes+re-ranks the **full** blended pool exactly as today to produce the canonical `recs` (so the cache payload and the `{ profile, recs }` return are byte-identical to the non-streaming path), and (3) when `onRow` is supplied, builds the row set via `groupIntoRows` and emits the cheaper collab-provenance + Top-Picks rows first, then Discover-derived genre rows, then trending — using each row's own `kind`/`_seeds.source` to order emission, holding the `top` (calibrated hero) row until last among the early batch. Replace the candidate/score/rerank block (the `const candidates = await generateCandidates(...)` through `const recs = mmrRerank(...)` span) with:

  ```js
  const staged = await generateCandidates(basketEnriched, profile, negProfile);
  const excludeIds = new Set(
    [...basket, ...downvoted].map((m) => m.id).concat(watchedIds)
  );
  const scoreAndRank = (pool) => {
    const scored = scorePool(pool, { profile, now, dislikeVector })
      .filter((s) => !excludeIds.has(s.movie.id));
    return mmrRerank(scored, { lambda, limit });
  };
  // Canonical, cache-identical result: score+rank the FULL blended pool.
  const recs = scoreAndRank(staged.pool);

  // Progressive emission (page surface only): when a sink is supplied, derive the row set
  // ONCE from the canonical recs (so streamed rows are a strict subset of the final page),
  // then announce them in resolve-cost order — collaborative provenance rows + the genre
  // calibrated hero first (their data, the collab pool, resolved earliest), then Discover
  // genre rows, then trending. groupIntoRows owns row identity; we only reorder emission.
  if (typeof onRow === 'function') {
    const rows = groupIntoRows(recs, profile, { genreDist: genreHistogram(basket), ...(opts.groupOpts || {}) });
    const isCollabRow = (row) => row.kind === 'top' || row.kind === 'title'
      || row.kind === 'explore';
    const earlyNonHero = rows.filter((r) => isCollabRow(r) && r.kind !== 'top');
    const hero = rows.filter((r) => r.kind === 'top');
    const genreRows = rows.filter((r) => r.kind === 'genre');
    const trendingRows = rows.filter((r) => r.kind === 'trending');
    // Emit in display order WITHIN each cost-tier so the page never has to re-order:
    // provenance rows, then hero Top Picks, then genre, then trending.
    for (const r of [...earlyNonHero, ...hero, ...genreRows, ...trendingRows]) onRow(r);
  }
  ```

  Update `_pipeline`'s `opts` destructure (the `const { limit = 20, now = Date.now(), gamma = DOWNVOTE_GAMMA, lambda = MMR_LAMBDA_PAGE } = opts;` line) to also pull `onRow`: add `onRow` to that destructured list. The `genreHistogram` and `groupIntoRows` symbols are already module-scope exports — no new import.

  **(c) In `getRecommendationRows`** — its purpose is to score, calibrate, and group the page rows. Thread the new `onRow`: add `onRow` to its `opts` destructure (`const { limit = 60, now = Date.now(), groupOpts = {}, gamma } = opts;` → add `onRow`) and pass `onRow` (plus `groupOpts`) into the `_pipeline(sig, { ... })` call so the pipeline can stream. Leave the final `return { rows: groupIntoRows(recs, profile, { genreDist, ...groupOpts }) };` unchanged — it remains the authoritative, fully-ordered row set the caller renders/falls back to (streaming is additive, never the source of truth).

- [ ] **Step 4: run — expect PASS.**
  `node --check recommendations.js && npm test`
  Expected: `node --check` exits 0. Suite returns to **158 pass, 0 fail** — wait: the new streaming test is the 159th. State the new total: **159 tests, 158 prior + 1 new, all passing, fail=0.** Confirm DELTA = +1 and fail=0.

- [ ] **Step 5: commit.**
  `git add recommendations.js recommendations.test.js && git commit -m "feat(rec): streaming onRow hook + parallel Discover/filler fan-out"`

---

### Task 10: Skeleton rails + IntersectionObserver lazy hydration in `renderRecommendationsPage`

Replace the global spinner for the rec view with 2–3 shimmer placeholder `.rec-rail-section`s rendered immediately into a **visible** `#main`, swapped for real rails as `onRow` fires. Below-the-fold rows append only `buildRecRail`'s header + a fixed-min-height empty `.rec-scroller`, and hydrate their cards via an `IntersectionObserver` (`rootMargin: '600px'`) the first time the scroller nears the viewport. Add the shimmer CSS to `style.css`. Verified via the harness only (no unit test) — the harness gets a new fixture path that drives a **fake streaming engine** through the real `renderRecommendationsPage` slice and asserts skeletons appear before rows and that rows hydrate.

**Files:**
- `script.js` — `renderRecommendationsPage()` (drop `main.innerHTML='' + setLoading(true)`; render skeletons; consume engine `onRow` to append/hydrate rails under the existing `recPageRenderToken` last-writer guard, applied per-append); `buildRecRail(recs, { kicker, heading, subline })` (add an opt to defer card construction → header + empty fixed-height scroller); new helper `buildRecSkeleton(count)`; new helper `observeLazyRail(section, recs)`.
- `style.css` — append `.rec-skeleton` / shimmer keyframes + the fixed-min-height empty-scroller rule.
- `rec-dom-harness.mjs` — extract the new builders + a stubbed `renderRecommendationsPage` path and assert skeleton-before-rows + hydrate-on-observe.

- [ ] **Step 1: write the failing check — extend the harness for skeletons + lazy hydration.**
  In `rec-dom-harness.mjs`, after the existing `slice('buildRecRail')` line, also extract the two new builders, and append a new assertion block before the final `console.log`. Add:

  ```js
  const skeletonSrc = slice('buildRecSkeleton');
  const lazyRailSrc = slice('buildLazyRecRail');
  ```

  Wire those into the injected `inlineScript` (concatenate them alongside `createCardSrc`/`buildRailSrc`), then append this assertion block inside the `try` (after assertion (d)):

  ```js
  // (e) skeleton rails render synchronously (before any real row), then a real rail can
  //     replace them. Build 3 skeletons into a fresh mount and assert their shimmer class.
  const skeletonInfo = await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'sk-host';
    document.body.appendChild(host);
    const sk = buildRecSkeleton(3);                 // REAL builder from script.js
    host.appendChild(sk);
    return {
      sections: host.querySelectorAll('.rec-rail-section.rec-skeleton').length,
      cards: host.querySelectorAll('.rec-skel-card').length,
    };
  });
  assert.equal(skeletonInfo.sections, 3, 'expected 3 skeleton rail sections');
  assert.ok(skeletonInfo.cards >= 3, 'each skeleton rail should carry shimmer cards');

  // (f) a lazy rail appends header + an empty fixed-height scroller (no cards yet); calling
  //     its hydrate() fills the scroller with real cards. Proves below-the-fold deferral.
  const lazyInfo = await page.evaluate(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const recs = [
      { movie: { id: 9, title: 'Primer', media_type: 'movie', vote_average: 7, vote_count: 100, _seeds: [] },
        score: 0.5, reasons: ['A rarer pick'] },
    ];
    const { section, hydrate } = buildLazyRecRail(recs, { kicker: 'k', heading: 'More Sci-Fi' });
    host.appendChild(section);
    const before = section.querySelectorAll('.rec-card').length;
    const reservedMinHeight = getComputedStyle(section.querySelector('.rec-scroller')).minHeight;
    hydrate();
    const after = section.querySelectorAll('.rec-card').length;
    return { before, after, reservedMinHeight };
  });
  assert.equal(lazyInfo.before, 0, 'lazy rail must not build cards until hydrated');
  assert.equal(lazyInfo.after, 1, 'hydrate() builds the deferred cards');
  assert.notEqual(lazyInfo.reservedMinHeight, '0px', 'lazy scroller reserves min-height (no CLS)');
  ```

- [ ] **Step 2: run — expect FAIL.**
  `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs`
  Expected: FAIL — `slice('buildRecSkeleton')` throws `function buildRecSkeleton not found in script.js` (the builders don't exist yet). This is the expected pre-implementation failure.

- [ ] **Step 3: implement — skeleton/lazy builders + skeleton-driven `renderRecommendationsPage`.**

  **(a) New helper `buildRecSkeleton(count = 3)`** — add immediately above `buildRecRail` in `script.js`. Renders `count` shimmer rail sections sharing the real `.rec-rail-section` chrome so the swap is layout-stable:

  ```js
  // Shimmer placeholder rails shown immediately in a VISIBLE #main while the first real
  // rows resolve. Mirrors .rec-rail-section structure so replacing a skeleton with a real
  // rail causes no layout shift. Card count is fixed so the reserved height is deterministic.
  function buildRecSkeleton(count = 3) {
    const frag = document.createDocumentFragment();
    for (let s = 0; s < count; s++) {
      const section = document.createElement('section');
      section.className = 'rec-rail-section rec-skeleton';
      const header = document.createElement('div');
      header.className = 'rec-header';
      const kick = document.createElement('span');
      kick.className = 'rec-kicker rec-skel-line';
      header.appendChild(kick);
      const head = document.createElement('h2');
      head.className = 'rec-heading rec-skel-line rec-skel-line--wide';
      header.appendChild(head);
      section.appendChild(header);
      const rail = document.createElement('div');
      rail.className = 'rec-rail';
      const scroller = document.createElement('div');
      scroller.className = 'rec-scroller';
      for (let c = 0; c < 6; c++) {
        const card = document.createElement('div');
        card.className = 'rec-skel-card';
        scroller.appendChild(card);
      }
      rail.appendChild(scroller);
      section.appendChild(rail);
      frag.appendChild(section);
    }
    return frag;
  }
  ```

  **(b) New helper `buildLazyRecRail(recs, { kicker, heading, subline })`** — add directly below `buildRecRail`. Builds the rail chrome with an **empty** fixed-height scroller and returns `{ section, hydrate }`; `hydrate()` builds the real cards once:

  ```js
  // Below-the-fold rail: header + an empty, min-height-reserved scroller (no cards built,
  // so their poster <img>s never request data) until hydrate() runs. hydrate() is idempotent.
  function buildLazyRecRail(recs, { kicker, heading, subline }) {
    const section = buildRecRail([], { kicker, heading, subline });
    const scroller = section.querySelector('.rec-scroller');
    scroller.classList.add('rec-scroller--reserved');
    let hydrated = false;
    const hydrate = () => {
      if (hydrated) return;
      hydrated = true;
      scroller.classList.remove('rec-scroller--reserved');
      recs.forEach((rec, index) => scroller.appendChild(createRecommendationCard(rec, index)));
    };
    return { section, hydrate };
  }

  // Hydrate a lazy rail when it nears the viewport (rootMargin pre-empts the scroll). Falls
  // back to immediate hydration where IntersectionObserver is unavailable.
  function observeLazyRail(section, hydrate) {
    if (typeof IntersectionObserver !== 'function') { hydrate(); return; }
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (e.isIntersecting) { hydrate(); obs.disconnect(); }
      }
    }, { rootMargin: '600px' });
    io.observe(section);
  }
  ```

  **(c) Rewrite `renderRecommendationsPage`** so it shows skeletons in a visible `#main` and consumes the engine's `onRow` stream, appending each rail under a **per-append** token guard, with above-the-fold rows hydrated eagerly and below-the-fold rows lazy. Replace the body of `renderRecommendationsPage` (from `main.innerHTML = '';` through the final `main.appendChild(page);`) with:

  ```js
    main.innerHTML = '';
    // Visible #main + skeletons instead of the global spinner: the page is interactive
    // immediately and the reserved rail heights prevent layout shift on swap-in.
    setLoading(false);
    hideError();
    const page = document.createElement('div');
    page.className = 'rec-page';
    page.appendChild(buildRecSkeleton(3));
    main.appendChild(page);

    const items = buildSignalItems();
    const coldStart = items.basket.length === 0;
    if (coldStart) page.classList.add('rec-cold-start');

    const REC_ROW_KICKERS = {
      top: 'Calibrated to your basket',
      title: 'Because you liked it',
      genre: 'More of this genre',
      trending: 'Popular this week',
      explore: 'A little different',
    };
    // Above-the-fold budget: the first N rows hydrate eagerly; the rest defer to scroll.
    const EAGER_ROWS = 3;
    let appended = 0;
    let skeletonCleared = false;

    // Append one streamed row. Guarded per-append by recPageRenderToken so a newer render
    // (e.g. a rapid second toggle) can't have its rails interleaved with this stale stream.
    const appendRow = (row) => {
      if (token !== recPageRenderToken) return;
      if (!skeletonCleared) {
        page.querySelectorAll('.rec-skeleton').forEach((sk) => sk.remove());
        skeletonCleared = true;
      }
      const i = appended++;
      const heading = coldStart && i === 0 ? 'Trending to get started' : row.title;
      const kicker = coldStart && i === 0 ? 'Popular right now' : (REC_ROW_KICKERS[row.kind] || null);
      if (i < EAGER_ROWS) {
        const railSection = buildRecRail(row.recs, { kicker, heading });
        railSection.classList.add(`rec-row-${row.kind}`);
        railSection.setAttribute('data-rec-kind', row.kind);
        if (row.kind === 'explore') railSection.classList.add('rec-explore');
        page.appendChild(railSection);
      } else {
        const { section, hydrate } = buildLazyRecRail(row.recs, { kicker, heading });
        section.classList.add(`rec-row-${row.kind}`);
        section.setAttribute('data-rec-kind', row.kind);
        if (row.kind === 'explore') section.classList.add('rec-explore');
        page.appendChild(section);
        observeLazyRail(section, hydrate);
      }
    };

    let rows = [];
    let failed = false;
    try {
      ({ rows } = await getRecommendationRows(items, { limit: 60, onRow: appendRow }));
    } catch (e) {
      console.warn('Recommendation page failed:', e);
      failed = true;
    }

    if (token !== recPageRenderToken) return; // superseded by a newer render — don't touch #main

    // Reconcile: if the stream under-delivered (or onRow was not honored), fall back to the
    // authoritative `rows`. Already-appended rows are skipped so the stream isn't duplicated.
    if (failed) {
      main.innerHTML = '<p class="no-results rec-empty">Couldn’t load recommendations right now. Try again shortly.</p>';
      return;
    }
    if (appended === 0 && rows.length === 0) {
      main.innerHTML = '<p class="no-results rec-empty">No recommendations yet — keep watching to tune your taste.</p>';
      return;
    }
    for (let i = appended; i < rows.length; i++) appendRow(rows[i]);
  ```

  Note: `appendRow` is defined inside `renderRecommendationsPage`, so it closes over the function-scoped `token` (`const token = ++recPageRenderToken;` at the top of the function — unchanged). The earlier `filteredMovies = []; displayedCount = 0; hasMorePages = false;` lifecycle-neutralization block and the `recommendations-row` / `load-more-indicator` removals at the top of the function stay as-is.

  **(d) Append shimmer CSS to `style.css`** (end of file is fine; placed near the `.rec-page` block conceptually):

  ```css
  /* ---- Skeleton rails + shimmer (perceived-speed loading state) ---- */
  @keyframes recShimmer {
    to { background-position: -200% 0; }
  }
  .rec-skeleton .rec-skel-line,
  .rec-skel-card {
    background: linear-gradient(90deg,
      rgba(255, 255, 255, 0.05) 25%,
      rgba(255, 255, 255, 0.12) 37%,
      rgba(255, 255, 255, 0.05) 63%);
    background-size: 200% 100%;
    animation: recShimmer 1.4s ease-in-out infinite;
    border-radius: 10px;
  }
  .rec-skel-line { height: 0.85rem; width: 7rem; margin-bottom: 0.5rem; }
  .rec-skel-line--wide { height: 1.4rem; width: 16rem; }
  .rec-skel-card { flex: 0 0 182px; width: 182px; aspect-ratio: 2 / 3; }
  /* Reserve a below-the-fold rail's height so hydration causes no layout shift. */
  .rec-scroller--reserved { min-height: 273px; }
  @media (prefers-reduced-motion: reduce) {
    .rec-skeleton .rec-skel-line,
    .rec-skel-card { animation: none; }
  }
  ```

- [ ] **Step 4: run — expect PASS.**
  `node --check script.js && PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs && npm test`
  Expected: `node --check` exits 0; harness prints `rec-dom-harness: PASS` (assertions (a)–(f) all green — skeletons render with 3 sections + shimmer cards, lazy rail builds 0 cards until `hydrate()` then 1, and reserves a non-`0px` min-height); `npm test` reports **159 pass, 0 fail** (unchanged from Task 2.9 — no new unit test, DELTA = 0).

- [ ] **Step 5: commit.**
  `git add script.js style.css rec-dom-harness.mjs && git commit -m "feat(rec): skeleton rails + IntersectionObserver lazy row hydration"`

---

### Task 11: Debounced recompute + stale-while-revalidate on ★/👎

On a star/downvote toggle: flip the clicked card's state **instantly** (the existing `sync()` already does this on click — keep it) and **debounce** the heavy rec-page recompute ~1000ms after the last toggle so N rapid toggles trigger **one** pipeline run. When the recompute runs, keep the current rows visible and **cross-fade** to the new rows instead of `main.innerHTML=''` + spinner. Decouple `clearRecommendationCache` from deletion: **mark entries stale (keep the payload)** so `_pipeline` can paint the last good result instantly while a fresh one computes underneath. Verified via harness + `node --check` + `npm test` (no unit test for the debounce timing — it's a DOM/timing concern).

**Files:**
- `script.js` — `onSignalChanged()` (debounce the rec-page recompute; the home-teaser branch stays immediate); new `scheduleRecRecompute()` debounce helper; `renderRecommendationsPage()` (cross-fade instead of clear-and-spinner when rows already exist); `toggleStar(movie)` / `toggleDownvote(movie)` (no signature change — they already call `clearRecommendationCache()`; behavior shifts via the cache change below).
- `recommendations.js` — `clearRecommendationCache()` (mark stale, keep payload); `_pipeline(input, opts)` (serve a **stale** cached payload immediately to a `onStale` sink, then recompute and overwrite). 
- `style.css` — append the `.rec-page--fading` cross-fade rule.
- `rec-dom-harness.mjs` — assert optimistic flip + single-recompute under rapid toggles via a counted fake engine.

- [ ] **Step 1: write the failing check — stale-while-revalidate cache + debounce contract in the harness.**
  Append a new assertion block to `rec-dom-harness.mjs` (before the final `console.log`) that drives a counted fake recompute through the real debounce helper extracted from `script.js`. Extract the helper and add the block:

  ```js
  const debounceSrc = slice('scheduleRecRecompute');
  ```
  (concatenate `debounceSrc` into `inlineScript`, and inject a stub `renderRecommendationsPage` + a fake clock by prepending to `scriptHead`:)

  ```js
  // (append to scriptHead, before createCardSrc) — stub the recompute target + a manual timer.
  const scriptHeadDebounce = `
    window.__recomputeCount = 0;
    function renderRecommendationsPage() { window.__recomputeCount++; }
    const REC_RECOMPUTE_DEBOUNCE_MS = 1000;
    let __recTimer = null;
  `;
  ```
  (assemble `inlineScript` as `scriptHead + scriptHeadDebounce + createCardSrc + ... + debounceSrc + scriptTail`.) Then the assertion:

  ```js
  // (g) N rapid scheduleRecRecompute() calls collapse to ONE renderRecommendationsPage run.
  const recomputeRuns = await page.evaluate(async () => {
    window.__recomputeCount = 0;
    for (let i = 0; i < 5; i++) scheduleRecRecompute();   // 5 rapid toggles
    await new Promise((r) => setTimeout(r, 1300));         // past the 1000ms debounce
    return window.__recomputeCount;
  });
  assert.equal(recomputeRuns, 1, '5 rapid toggles must debounce to exactly 1 recompute');
  ```

- [ ] **Step 2: run — expect FAIL.**
  `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs`
  Expected: FAIL — `slice('scheduleRecRecompute')` throws `function scheduleRecRecompute not found in script.js`.

- [ ] **Step 3: implement — debounce, cross-fade, and stale-while-revalidate.**

  **(a) Debounce helper + `onSignalChanged` rewrite in `script.js`.** Add a module-scope constant and timer near `recPageRenderToken`, and a `scheduleRecRecompute` helper, then route the rec-page branch of `onSignalChanged` through it. Add above `onSignalChanged`:

  ```js
  // Rapid curation (several ★/👎 in a row) should trigger ONE heavy pipeline run, not one
  // per click. The clicked card already flips optimistically (createStar/DownvoteButton's
  // sync()); only the full-page recompute is debounced.
  const REC_RECOMPUTE_DEBOUNCE_MS = 1000;
  let __recRecomputeTimer = null;
  function scheduleRecRecompute() {
    if (__recRecomputeTimer) clearTimeout(__recRecomputeTimer);
    __recRecomputeTimer = setTimeout(() => {
      __recRecomputeTimer = null;
      renderRecommendationsPage();
    }, REC_RECOMPUTE_DEBOUNCE_MS);
  }
  ```

  In `onSignalChanged`, replace the rec-page branch (the `if (tabRecommended.classList.contains('active')) { renderRecommendationsPage(); }` arm) so it debounces; leave the home-teaser `else if` branch calling `renderRecommendationsRow()` immediately (a single cheap row):

  ```js
  function onSignalChanged() {
    if (tabRecommended.classList.contains('active')) {
      scheduleRecRecompute();
    } else if (currentApp === 'movies' && !isWatchedMode && !isFavoritesMode && !isSearchMode && !isTop250Mode) {
      renderRecommendationsRow();
    }
  }
  ```

  **(b) Cross-fade instead of clear-and-spinner in `renderRecommendationsPage`.** This builds on Task 2.10's skeleton rewrite. The principle: only show skeletons on the **first** paint (empty `#main`); on a recompute when a `.rec-page` already exists, build the new page off-DOM and cross-fade-swap it. Replace Task 2.10's opening lines (`main.innerHTML = ''; setLoading(false); ... main.appendChild(page);`) with:

  ```js
    const existingPage = main.querySelector('.rec-page');
    setLoading(false);
    hideError();
    const page = document.createElement('div');
    page.className = 'rec-page';
    if (existingPage) {
      // Stale-while-revalidate recompute: keep the old rows visible; build the new page
      // detached and cross-fade it in once rows arrive (no blank flash, no spinner).
      page.classList.add('rec-page--incoming');
    } else {
      // First paint: visible #main + skeletons (no global spinner).
      main.innerHTML = '';
      page.appendChild(buildRecSkeleton(3));
      main.appendChild(page);
    }
  ```

  And replace Task 2.10's final reconcile line (`for (let i = appended; i < rows.length; i++) appendRow(rows[i]);`) with a version that, on the cross-fade path, swaps the detached page in and fades the old one out:

  ```js
    for (let i = appended; i < rows.length; i++) appendRow(rows[i]);
    if (existingPage && page.isConnected === false) {
      // The fresh page was built detached; cross-fade it over the stale one.
      main.appendChild(page);
      requestAnimationFrame(() => {
        page.classList.remove('rec-page--incoming');
        existingPage.classList.add('rec-page--fading');
        existingPage.addEventListener('transitionend', () => existingPage.remove(), { once: true });
        // Safety net if transitionend doesn't fire (e.g. reduced-motion).
        setTimeout(() => existingPage.remove(), 400);
      });
    }
  ```

  Note: in the cross-fade path `appendRow` appends rails into the detached `page` (it never touches `main` directly — it always does `page.appendChild(...)`), so the `page.isConnected === false` guard holds until the swap. The per-append `token !== recPageRenderToken` guard inside `appendRow` (from Task 2.10) still protects against a newer render superseding this one mid-stream.

  **(c) Stale-while-revalidate cache in `recommendations.js`.** `clearRecommendationCache`'s purpose is to invalidate session results after a signal change; change it from **deleting** entries to **marking them stale while keeping the payload**. Replace its `sessionStorage.removeItem(k)` deletion loop with an in-place stale-flag rewrite:

  ```js
  // Mark every per-limit session results cache entry STALE (keep the payload) so the next
  // _pipeline run can paint the last good result instantly while a fresh one computes. A
  // signature mismatch still hard-invalidates; staleness only governs the fast-path repaint.
  export function clearRecommendationCache() {
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(RECS_CACHE_KEY)) {
          try {
            const v = JSON.parse(sessionStorage.getItem(k) || 'null');
            if (v) { v.stale = true; sessionStorage.setItem(k, JSON.stringify(v)); }
          } catch { sessionStorage.removeItem(k); } // unparseable → drop it
        }
      }
    } catch { /* ignore */ }
  }
  ```

  In `_pipeline`, its cache-read fast-path currently returns the cached payload only when `cached.sig === sig`. Change it so a **fresh** (non-stale) signature match still short-circuits, but a **stale** signature match does **not** early-return — it recomputes and overwrites, clearing the flag. Replace the cache-read block (the `try { const cached = JSON.parse(...); if (cached && cached.sig === sig) return ...; } catch {}` span) with:

  ```js
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    // Fresh hit: serve as-is. Stale hit (same sig, flagged by clearRecommendationCache):
    // fall through to recompute — the caller can read the still-present payload for an
    // instant repaint while this runs. Signature mismatch: ignore entirely.
    if (cached && cached.sig === sig && !cached.stale) {
      return { profile: cached.profile, recs: cached.recs };
    }
  } catch { /* ignore cache read errors */ }
  ```

  The existing write at the end of `_pipeline` (`sessionStorage.setItem(cacheKey, JSON.stringify({ sig, profile, recs }))`) already writes a payload **without** a `stale` flag, so a successful recompute implicitly clears staleness — no change needed there.

  **(d) Cross-fade CSS in `style.css`** (append near the skeleton block from Task 2.10):

  ```css
  /* ---- Cross-fade on recompute (stale-while-revalidate) ---- */
  .rec-page { transition: opacity 0.32s ease; }
  .rec-page--incoming { opacity: 0; }
  .rec-page--fading {
    opacity: 0;
    position: absolute;
    left: 0; right: 0;
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .rec-page, .rec-page--incoming, .rec-page--fading { transition: none; }
  }
  ```

- [ ] **Step 4: run — expect PASS.**
  `node --check script.js && node --check recommendations.js && PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs && npm test`
  Expected: both `node --check` exit 0; harness prints `rec-dom-harness: PASS` with assertion (g) green (5 rapid `scheduleRecRecompute()` → `__recomputeCount === 1`); `npm test` reports **159 pass, 0 fail** (DELTA = 0 — no new unit test; the cache change is exercised by existing `_pipeline`/cache tests staying green, which confirms the fresh-hit fast-path and overwrite still behave). If any existing cache-related unit test asserted on deletion semantics, it must still pass — staleness is additive and a fresh write clears it; investigate any failure before proceeding.

- [ ] **Step 5: commit.**
  `git add script.js recommendations.js style.css rec-dom-harness.mjs && git commit -m "feat(rec): debounced recompute + stale-while-revalidate cross-fade on toggle"`

---

**Phase 2 verification summary:** after Task 2.11 the suite is **159 tests passing, 0 fail** (+1 from baseline 158, the single streaming unit test in Task 2.9); both `node --check`s pass; and `rec-dom-harness.mjs` prints PASS with assertions (a)–(g). TTFR is now collab-pool latency (provenance rows + Top Picks stream first); the rec view shows shimmer rails immediately with reserved heights (CLS ~0) and hydrates below-the-fold rows on scroll; and rapid ★/👎 curation flips cards at ~0ms while collapsing to one debounced, cross-faded recompute over the last-good (stale-but-painted) result.

## Phase 3 — Relevance tuning + the 5 deferred follow-ups

> All commits end with the trailer (stated once; do not repeat per task):
> `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
> Baseline: 158 tests pass, 0 fail. Conventions: `import { test } from 'node:test'; import assert from 'node:assert/strict';` fixed clock `NOW = 1_700_000_000_000`. Test runner: `node --test` (npm test). Each task states the new total as a DELTA from the prior task with fail=0.

---

### Task 12: Composite media_type:id keying through merge / pipeline exclude / grouping (follow-up a)

Land the id-collision fix FIRST: it changes the dedupe key shape that every later relevance task's candidates flow through, so doing it first keeps subsequent before/afters honest. A movie id 5 and a tv id 5 must stay distinct through `mergeCandidates`, the `_pipeline` `excludeIds` set, and the `groupIntoRows` `placed` set.

**Files:**
- `recommendations.js` — new exported helper `candidateKey(item)`; `mergeCandidates` (~L477); `groupIntoRows` `recId`/`placed` (~L874-907); `_pipeline` `excludeIds` (~L1290-1294).
- `recommendations.test.js` — new tests after the existing `mergeCandidates` tests (~L100 / ~L654).

- [ ] **Step 1: Write failing tests** — append to `recommendations.test.js` (the import of `mergeCandidates` already exists at L4; add `candidateKey` to that import line, and `groupIntoRows` is imported at L253):

```js
import { candidateKey } from './recommendations.js';

test('candidateKey composes media_type and id so movie 5 != tv 5', () => {
  assert.equal(candidateKey({ id: 5, media_type: 'movie' }), 'movie:5');
  assert.equal(candidateKey({ id: 5, media_type: 'tv' }), 'tv:5');
  assert.notEqual(
    candidateKey({ id: 5, media_type: 'movie' }),
    candidateKey({ id: 5, media_type: 'tv' })
  );
  // Missing media_type is treated as 'movie' (TMDB movie endpoints omit it).
  assert.equal(candidateKey({ id: 5 }), 'movie:5');
});

test('mergeCandidates keeps a movie id 5 and a tv id 5 distinct', () => {
  const merged = mergeCandidates([
    { id: 5, media_type: 'movie', genre_ids: [878],
      _seeds: [{ source: 'rec', type: 'title', id: 1, seedId: 1, rank: 0, weight: 1 }] },
    { id: 5, media_type: 'tv', genre_ids: [10765],
      _seeds: [{ source: 'rec', type: 'title', id: 2, seedId: 2, rank: 0, weight: 1 }] },
  ]);
  assert.equal(merged.length, 2, 'movie 5 and tv 5 must not collapse');
  const movie = merged.find((c) => c.media_type === 'movie');
  const tv = merged.find((c) => c.media_type === 'tv');
  assert.deepEqual(movie.genre_ids, [878]);
  assert.deepEqual(tv.genre_ids, [10765]);
});

test('mergeCandidates still accumulates seeds for the SAME media_type+id', () => {
  const merged = mergeCandidates([
    { id: 5, media_type: 'movie', genre_ids: [878],
      _seeds: [{ source: 'rec', type: 'title', id: 1, seedId: 1, rank: 0, weight: 1 }] },
    { id: 5, media_type: 'movie', genre_ids: [878],
      _seeds: [{ source: 'similar', type: 'title', id: 2, seedId: 2, rank: 1, weight: 0.5 }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]._seeds.length, 2);
});

test('groupIntoRows: a movie id 5 and a tv id 5 both survive (no cross-type claim)', () => {
  // Same numeric id, different media_type, same genre. With id-only keying the second
  // would be treated as "already placed" and dropped from every row.
  const ranked = [
    ...[5].map((id) => grq(id, { genres: [878], score: 1, va: 8, vc: 9000 })),
    { movie: { id: 5, media_type: 'tv', genre_ids: [878], _seeds: [], vote_average: 8, vote_count: 9000 },
      score: 0.99, parts: {}, reasons: ['r'] },
    ...[60, 61, 62].map((id) => grq(id, { genres: [878], score: 0.5, va: 7, vc: 9000 })),
  ];
  // First ranked item (movie 5) gets media_type via grq? grq omits media_type -> 'movie' default.
  ranked[0].movie.media_type = 'movie';
  const rows = groupIntoRows(ranked, { ...GROUP_PROFILE, topTitles: [], people: {} },
    { topCount: 2, minItems: 1, genreDist: { '878': 1 } });
  const allKeys = rows.flatMap((row) => row.recs.map((r) => `${r.movie.media_type}:${r.movie.id}`));
  assert.ok(allKeys.includes('movie:5'), 'movie 5 present');
  assert.ok(allKeys.includes('tv:5'), 'tv 5 present (must not be dropped as a dup of movie 5)');
});
```

- [ ] **Step 2: Run — expect FAIL** — `node --test recommendations.test.js` → fails: `candidateKey` is not exported (TypeError / ImportError), and (if that were stubbed) the merge/group tests collapse movie 5 with tv 5.

- [ ] **Step 3: Implement** — in `recommendations.js`:

  Add the exported helper just above `mergeCandidates` (~L476):

```js
// Composite identity for a candidate: TMDB ids are unique only WITHIN a media_type, so a movie
// and a tv show can share a numeric id. Keying by `${media_type}:${id}` keeps them distinct
// through merge, the pipeline exclude set, and row placement. Missing media_type => 'movie'
// (TMDB movie detail endpoints omit the field; tv carries it explicitly).
export function candidateKey(item) {
  const mt = item.media_type === 'tv' ? 'tv' : 'movie';
  return `${mt}:${item.id}`;
}
```

  In `mergeCandidates`, replace the `const key = String(c.id);` line with:
```js
    const key = candidateKey(c);
```

  In `groupIntoRows`, replace the `recId` definition (`const recId = (r) => String(r.movie.id);`) with:
```js
  const recId = (r) => candidateKey(r.movie);
```
  (Every `placed`/`recId(r)` call site already routes through this one helper, so the whole `placed` set becomes composite-keyed with no other edit.)

  In `_pipeline`, replace the `excludeIds` set construction and its `.filter` so both use the composite key. Replace:
```js
  const excludeIds = new Set(
    [...basket, ...downvoted].map((m) => m.id).concat(watchedIds)
  );
  const scored = scorePool(candidates, { profile, now, dislikeVector })
    .filter((s) => !excludeIds.has(s.movie.id));
```
  with:
```js
  // Composite-key the exclude set so a basketed/watched movie can't suppress a tv show of the
  // same numeric id (and vice versa). watchedIds carry their own media_type in the watched store;
  // map them via candidateKey too. A bare numeric watched id (legacy) is excluded for BOTH types.
  const excludeIds = new Set();
  for (const m of [...basket, ...downvoted]) excludeIds.add(candidateKey(m));
  for (const w of watchedIds) {
    if (w && typeof w === 'object') excludeIds.add(candidateKey(w));
    else { excludeIds.add(`movie:${w}`); excludeIds.add(`tv:${w}`); }
  }
  const scored = scorePool(candidates, { profile, now, dislikeVector })
    .filter((s) => !excludeIds.has(candidateKey(s.movie)));
```

  > Note on `watchedIds`: `signalSignature`/`hashIds` consume `watchedIds` as a numeric id list, so the legacy bare-number branch above (exclude both `movie:w` and `tv:w`) preserves today's behavior exactly for numeric watched ids while still honoring object-shaped entries if a caller passes them. This keeps the existing pipeline-level exclusion at least as strict as before.

- [ ] **Step 4: Run — expect PASS** — `node --test recommendations.test.js` (the 4 new tests pass; the existing `mergeCandidates dedupes by id` (L91, ids 100/200, no media_type → both key `movie:…`, still dedupe/distinct) and `mergeCandidates accumulates rec+similar…` (L636, ids 155/1399 both `movie:`/`tv:` → unchanged) stay green). Then full regression `npm test` → fail=0.

- [ ] **Step 5: Commit** — `git add -A && git commit` — message: `fix(rec): composite media_type:id key for merge/exclude/placement (follow-up a)`.

**New total: 158 + 4 = 162 tests, fail=0.**

---

### Task 13: Lower BAYES_PRIOR_COUNT 500 → 150 (item 14)

Let a few-hundred-vote gem express most of its rating instead of being shrunk toward C=6.5. Pure-constant change; the "great beats obscure" regression and the "2-vote 10.0 < 5000-vote 8.0" regression must stay green (verified by computation: under m=150, hype(10,2)=6.546 stays in (6.5,6.6); great(8.2/8000)=8.169 still > obscure(9.9/6)=6.631).

**Files:**
- `recommendations.js` — `BAYES_PRIOR_COUNT` constant (L35).
- `recommendations.test.js` — `bayesianRating` tests (L32-51); new explicit-default test.

- [ ] **Step 1: Write failing test** — append after the existing `bayesianRating respects injected m and C` test (~L51):

```js
test('bayesianRating default m is 150 (few-hundred-vote calibration)', () => {
  // A 1000-vote 8.0 keeps ~87% of its rating under m=150, vs ~62% under the old m=500.
  const wr = bayesianRating(8.0, 1000); // = (1000/1150)*8 + (150/1150)*6.5
  assert.ok(Math.abs(wr - 7.8043) < 1e-3, `expected ~7.804 under m=150, got ${wr}`);
  // m=500 would give ~7.0 — assert we are clearly above that old value.
  assert.ok(wr > 7.5, 'a 1000-vote 8.0 must now sit well above the old m=500 result (~7.0)');
});
```

- [ ] **Step 2: Run — expect FAIL** — `node --test recommendations.test.js` → the new test fails (current m=500 gives 7.0, not ~7.804).

- [ ] **Step 3: Implement** — in `recommendations.js`, change the constant:
```js
const BAYES_PRIOR_COUNT = 150;      // m: pseudo-count for the bayesian rating prior (few-hundred-vote pool calibration)
```

- [ ] **Step 4: Run — expect PASS** — `node --test recommendations.test.js`. Confirm the two anchored regressions still pass: `bayesianRating shrinks a 2-vote 10.0 below a 5000-vote 8.0` (L32; hype now 6.546, still `>6.5 && <6.6`, still `< classic` 7.956) and `scorePool: a high-vote great title outranks a low-vote obscure one` (L824; great's bayes 8.169 still tops obscure's 6.631). No pinned expectation in those two changed, so no edit there. Then `npm test` → fail=0.

- [ ] **Step 5: Commit** — `git add -A && git commit` — message: `tune(rec): lower BAYES_PRIOR_COUNT 500->150 for few-hundred-vote gems (item 14)`.

**New total: 162 + 1 = 163 tests, fail=0.**

---

### Task 14: Cold-start quality floor — W_PRIOR additive term in scorePool (item 12)

Make `scorePool` `score = (W_COLLAB·collabN + W_CONTENT·contentN + W_PRIOR·qualityN) · recency`, where `qualityN` is the min-max-normalized `bayesianRating` across the pool, and weights become `0.55 / 0.30 / 0.15`. The old standalone `qualityMultiplier` factor is folded into the additive `qualityN` term (so an empty-profile pool no longer multiplies everything by a base of 0 → all-zero). Cold-start scores become non-zero and quality-ordered; warm ordering moves <5%.

**Files:**
- `recommendations.js` — `W_COLLAB`/`W_CONTENT` (L29-30), new `W_PRIOR` (after L30); `scorePool` (L206-242).
- `recommendations.test.js` — existing `scorePool` tests (L801-963) updated in lockstep; new cold-start tests.

- [ ] **Step 1: Write failing tests** — append after the existing `scorePool` suite (~L963):

```js
test('scorePool cold-start: empty-profile pool produces NON-ZERO, quality-ordered scores', () => {
  // Empty profile => content 0 for all; identical collab seed => collabN 0 for all; same recency.
  // Before: base 0 * quality * recency = 0 for every item. After: W_PRIOR*qualityN drives the sort.
  const profile = { genres: {}, keywords: {}, people: {}, mediaTypeBias: { movie: 0, tv: 0 }, topTitles: [] };
  const rd = new Date(NOW).toISOString().slice(0, 10);
  const greatPopular = { id: 1, media_type: 'movie', genre_ids: [878], vote_average: 8.5, vote_count: 20000,
    release_date: rd, _seeds: [] };
  const obscureLow   = { id: 2, media_type: 'movie', genre_ids: [878], vote_average: 5.0, vote_count: 30,
    release_date: rd, _seeds: [] };
  const out = scorePool([greatPopular, obscureLow], { profile, now: NOW });
  assert.equal(out[0].movie.id, 1, 'high-vote great title leads on the quality floor');
  assert.ok(out[0].score > 0, 'cold-start top score must be non-zero (was exactly 0 before)');
  // Variance across the pool > 0 (the spec cold-start guardrail).
  const scores = out.map((o) => o.score);
  assert.ok(Math.max(...scores) - Math.min(...scores) > 0, 'cold-start scores must vary');
});

test('scorePool exposes parts.qualityN (min-max normalized bayesian rating) in [0,1]', () => {
  const profile = { genres: {}, keywords: {}, people: {}, mediaTypeBias: { movie: 0, tv: 0 }, topTitles: [] };
  const rd = new Date(NOW).toISOString().slice(0, 10);
  const hiQ = { id: 1, media_type: 'movie', genre_ids: [878], vote_average: 9, vote_count: 50000, release_date: rd, _seeds: [] };
  const loQ = { id: 2, media_type: 'movie', genre_ids: [878], vote_average: 4, vote_count: 50000, release_date: rd, _seeds: [] };
  const out = scorePool([hiQ, loQ], { profile, now: NOW });
  const hi = out.find((o) => o.movie.id === 1);
  const lo = out.find((o) => o.movie.id === 2);
  assert.equal(hi.parts.qualityN, 1, 'highest bayesian rating normalizes to 1');
  assert.equal(lo.parts.qualityN, 0, 'lowest normalizes to 0');
});

test('scorePool weights are 0.55 collab / 0.30 content / 0.15 prior (defaults)', () => {
  // Verify the additive composition: a candidate with collabN=1, contentN=0, qualityN=0 scores
  // 0.55*recency; one with contentN=1 only scores 0.30*recency. Build a 2-item pool where
  // item A maxes collab and item B maxes content, both with identical (mid) quality.
  const profile = { genres: { '878': 5 }, keywords: {}, people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [] };
  const rd = new Date(NOW).toISOString().slice(0, 10);
  const collabMax = { id: 1, media_type: 'movie', genre_ids: [99], vote_average: 7, vote_count: 1000,
    release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 9, rank: 0, weight: 1 }] };   // collab 1, content 0
  const contentMax = { id: 2, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000,
    release_date: rd, _seeds: [{ source: 'similar', type: 'title', id: 9, rank: 7, weight: 1 }] }; // collab 0, content 1
  const out = scorePool([collabMax, contentMax], { profile, now: NOW });
  const a = out.find((o) => o.movie.id === 1);
  const b = out.find((o) => o.movie.id === 2);
  // Both same quality => qualityN min-max => 0 for both; recency 1. score = W*part.
  assert.ok(Math.abs(a.score - 0.55) < 1e-9, `collab-max => 0.55, got ${a.score}`);
  assert.ok(Math.abs(b.score - 0.30) < 1e-9, `content-max => 0.30, got ${b.score}`);
});
```

  Then UPDATE the existing warm-pool ordering tests that asserted on a quality-MULTIPLIER world. Their *ordering* assertions stay, but the `high-vote great title` regression now wins via the additive `qualityN` term, not the multiplier — re-confirm it explicitly (no change to the assertion, just leave it; verified great's bayes 8.169 > obscure 6.631 → qualityN 1 vs 0). No existing `scorePool` test pins a numeric score except the new ones above and the dislike-floor tests (L893-916), which use a single-item pool: with one item, `qualityN` min-max span=0 → qualityN=0, so the dislike tests' relative `penalized < base` still holds (both sides drop the same quality term). Leave L893-940 unchanged.

- [ ] **Step 2: Run — expect FAIL** — `node --test recommendations.test.js` → cold-start/qualityN/weights tests fail (no `qualityN` part; cold-start scores are 0; default weights are 0.6/0.4 with no prior term).

- [ ] **Step 3: Implement** — in `recommendations.js`:

  Update the weight constants (L29-30) and add `W_PRIOR`:
```js
const W_COLLAB = 0.55;              // collaborative score weight in the hybrid
const W_CONTENT = 0.30;             // content (cosine) score weight in the hybrid
const W_PRIOR = 0.15;               // quality-prior weight: a cold-start floor so empty-profile pools sort by rating
```

  Rewrite `scorePool` to add the pooled quality min-max and the additive term. Replace the function body from the signature through the `return scored.sort(...)`:

```js
export function scorePool(candidates, { profile, now = Date.now(), weights = { collab: W_COLLAB, content: W_CONTENT, prior: W_PRIOR }, dislikeVector } = {}) {
  // weights may be supplied partially (e.g. content-only callers); fill missing knobs from defaults.
  const wCollab = typeof weights.collab === 'number' ? weights.collab : W_COLLAB;
  const wContent = typeof weights.content === 'number' ? weights.content : W_CONTENT;
  const wPrior = typeof weights.prior === 'number' ? weights.prior : W_PRIOR;

  const tagVectors = candidates.map(buildTagVector);
  const idf = computeIdf(tagVectors);
  const rawProfVec = profileVector(profile);
  const profVec = applyIdf(rawProfVec, idf);
  const idfDegenerate = Object.values(profVec).every((w) => w === 0);

  const collabRaw = candidates.map(collabScore);
  const cMin = collabRaw.length ? Math.min(...collabRaw) : 0;
  const cMax = collabRaw.length ? Math.max(...collabRaw) : 0;
  const cRange = cMax - cMin;

  // Quality floor: min-max-normalize the pooled bayesian rating so an empty/tiny-profile pool
  // (collab 0, content 0) still sorts by "popular + well-rated to get started" instead of all-0.
  const qualityRaw = candidates.map((c) => bayesianRating(c.vote_average, c.vote_count));
  const qMin = qualityRaw.length ? Math.min(...qualityRaw) : 0;
  const qMax = qualityRaw.length ? Math.max(...qualityRaw) : 0;
  const qRange = qMax - qMin;

  const scored = candidates.map((c, i) => {
    const collabN = cRange > 0 ? (collabRaw[i] - cMin) / cRange : 0;
    const contentN = idfDegenerate
      ? cosineSim(rawProfVec, tagVectors[i])
      : cosineSim(profVec, applyIdf(tagVectors[i], idf));
    const qualityN = qRange > 0 ? (qualityRaw[i] - qMin) / qRange : 0;
    const quality = qualityMultiplier(c.vote_average, c.vote_count); // retained for parts/back-compat reads
    const recency = recencyMultiplier(c.release_date || c.first_air_date, now);
    let score = (wCollab * collabN + wContent * contentN + wPrior * qualityN) * recency;
    const overlap = dislikeOverlapVec(tagVectors[i], dislikeVector);
    if (overlap > 0) {
      score *= Math.max(DOWNVOTE_SCORE_FLOOR, 1 - DOWNVOTE_SCORE_STRENGTH * overlap);
    }
    return {
      movie: c,
      score,
      parts: { collab: collabN, content: contentN, quality, qualityN, recency },
      reasons: generateReasons(c, profile),
    };
  });
  return scored.sort((a, b) => b.score - a.score);
}
```

  > `bayesianRating` is defined above `scorePool` in the same file (L80), so no import is needed. `qualityMultiplier` stays computed for `parts.quality` (the `scorePool returns Scored items…` test at L818 asserts `typeof parts.quality === 'number'`, and `mmrRerank`/grouping read `score` only). The `weights: { collab: 0, content: 1 }` content-only test (L871) now also implies `prior` defaults to 0.15 — but that test's two candidates have identical va/vc (7/1000) → qualityN span 0 → 0 for both, so the prior term is inert and content still decides. Same for L840 (collab min-max), L855, L942 (all identical va/vc across their pools).

- [ ] **Step 4: Run — expect PASS** — `node --test recommendations.test.js`. Verify in order: the 3 new tests pass; `scorePool returns Scored items sorted desc` (L801, strong 8/5000 still tops weak 5/10 — collab+content+quality all favor it) passes; `high-vote great title outranks low-vote obscure` (L824) passes via qualityN; `normalizes collab via min-max` (L840) `parts.collab` unchanged; content/weights/dislike/idf tests (L855-963) pass. Then `npm test` → fail=0.

- [ ] **Step 5: Verify the network/UX surface didn't regress** — `node --check recommendations.js`; `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs` → `rec-dom-harness: PASS` (the harness fixture's scores are literals, unaffected).

- [ ] **Step 6: Commit** — `git add -A && git commit` — message: `feat(rec): cold-start quality floor (W_PRIOR=0.15 additive term in scorePool) (item 12)`.

**New total: 163 + 3 = 166 tests, fail=0.**

---

### Task 15: Thread basket seed strength into collabScore (item 13)

Give `topSeeds` a normalized `_seedWeight` (buildTasteProfile-style), thread it through the basket expansion into `extractSeedCandidates` so each SeedTag's `weight = SOURCE_WEIGHT × seedStrength` (seedStrength rescaled to ~[0.5, 2]). `collabScore` already multiplies `sw·weight`, so the scorer is untouched. A co-rec from a strong seed must outrank one from a weak seed at equal source/rank.

**Files:**
- `recommendations.js` — new exported helper `seedStrength(weights)` (pure, near `extractSeedCandidates` ~L452); `extractSeedCandidates` gains a `seedStrength` arg (~L453-474); `topSeeds` sets `_seedWeight` (~L1127); `generateCandidates` passes `seedStrength` into `extractSeedCandidates` (~L1201).
- `recommendations.test.js` — new tests after the existing `extractSeedCandidates` tests (~L634).

- [ ] **Step 1: Write failing tests** — append after the existing `extractSeedCandidates` suite (~L634); add `seedStrength` to the `recommendations.js` import at L4:

```js
import { seedStrength } from './recommendations.js';

test('seedStrength rescales a normalized [0,1] weight into ~[0.5,2]', () => {
  assert.ok(Math.abs(seedStrength(0) - 0.5) < 1e-9, 'weakest seed => 0.5');
  assert.ok(Math.abs(seedStrength(1) - 2) < 1e-9, 'strongest seed => 2');
  assert.ok(Math.abs(seedStrength(0.5) - 1.25) < 1e-9, 'midpoint => 1.25');
  // Out-of-range / missing clamps into the band (never negative, never explosive).
  assert.equal(seedStrength(undefined), 0.5);
  assert.equal(seedStrength(2), 2);
  assert.equal(seedStrength(-1), 0.5);
});

test('extractSeedCandidates scales SeedTag.weight by SOURCE_WEIGHT * seedStrength', () => {
  // seedStrength 2 (a #1-fave seed) doubles the rec weight from 1.0 to 2.0.
  const out = extractSeedCandidates(SEED_ITEM, APPEND_JSON, 2);
  const rec = out.find((c) => c.id === 155);   // a rec (REC_SOURCE_WEIGHT 1.0)
  const sim = out.find((c) => c.id === 49026);  // a similar (SIMILAR_SOURCE_WEIGHT 0.5)
  assert.ok(Math.abs(rec._seeds[0].weight - 2.0) < 1e-9, `rec weight 1.0*2 => 2.0, got ${rec._seeds[0].weight}`);
  assert.ok(Math.abs(sim._seeds[0].weight - 1.0) < 1e-9, `similar weight 0.5*2 => 1.0, got ${sim._seeds[0].weight}`);
});

test('extractSeedCandidates defaults seedStrength to 1 (back-compat unchanged weights)', () => {
  const out = extractSeedCandidates(SEED_ITEM, APPEND_JSON); // no third arg
  assert.equal(out.find((c) => c.id === 155)._seeds[0].weight, 1.0);   // REC_SOURCE_WEIGHT * 1
  assert.equal(out.find((c) => c.id === 49026)._seeds[0].weight, 0.5); // SIMILAR_SOURCE_WEIGHT * 1
});

test('a co-rec from a STRONG seed outranks one from a WEAK seed at equal source/rank', () => {
  // Same candidate shape, same source ('rec') and rank (0); only the producing seed's
  // strength differs. collabScore must reflect strong > weak.
  const strongSeedItem = { id: 1, title: 'Fave', media_type: 'movie' };
  const weakSeedItem   = { id: 2, title: 'Meh',  media_type: 'movie' };
  const json = (candId) => ({ recommendations: { results: [
    { id: candId, title: 'Co-Rec', media_type: 'movie', genre_ids: [878], vote_average: 8, vote_count: 5000 },
  ] }, similar: { results: [] } });
  const fromStrong = extractSeedCandidates(strongSeedItem, json(900), seedStrength(1))[0]; // seedStrength 2
  const fromWeak   = extractSeedCandidates(weakSeedItem,   json(901), seedStrength(0))[0]; // seedStrength 0.5
  assert.ok(collabScore(fromStrong) > collabScore(fromWeak),
    `strong-seed co-rec (${collabScore(fromStrong)}) must outrank weak (${collabScore(fromWeak)})`);
  assert.ok(Math.abs(collabScore(fromStrong) - 2.0) < 1e-9); // 1.0(rec) * 2.0(strength) / (1+0)
  assert.ok(Math.abs(collabScore(fromWeak) - 0.5) < 1e-9);   // 1.0(rec) * 0.5(strength) / (1+0)
});
```

- [ ] **Step 2: Run — expect FAIL** — `node --test recommendations.test.js` → fails: `seedStrength` not exported; `extractSeedCandidates` ignores its third arg (weights stay 1.0/0.5).

- [ ] **Step 3: Implement** — in `recommendations.js`:

  Add `seedStrength` above `extractSeedCandidates` (~L452):
```js
// Rescale a normalized [0,1] basket-seed strength into the collaborative weight band ~[0.5, 2]:
// the weakest basket seed still contributes (0.5), the strongest doubles its co-recs (2.0).
// Out-of-range / missing => clamped into the band. collabScore multiplies SeedTag.weight directly,
// so this is the only place seed strength enters the collaborative score.
export function seedStrength(normWeight) {
  const w = typeof normWeight === 'number' && Number.isFinite(normWeight) ? normWeight : 0;
  const clamped = Math.max(0, Math.min(1, w));
  return 0.5 + 1.5 * clamped;
}
```

  Give `extractSeedCandidates` a `seedStrength = 1` parameter and fold it into the per-tag weight. Change the signature line:
```js
export function extractSeedCandidates(seedItem, appendDetailJson, seedStrength = 1) {
```
  and inside `fromList`, change the SeedTag `weight` from `weight` to the scaled value. Replace the `_seeds: [{ source, type: 'title', id: seedId, seedId, seedTitle, rank, weight }],` line with:
```js
      _seeds: [{ source, type: 'title', id: seedId, seedId, seedTitle, rank, weight: weight * seedStrength }],
```
  (`weight` here is the `SOURCE_WEIGHT` passed by the two `fromList(...)` calls — `REC_SOURCE_WEIGHT`/`SIMILAR_SOURCE_WEIGHT` — so the product is `SOURCE_WEIGHT × seedStrength`, exactly the spec.)

  In `topSeeds` (~L1127), set a normalized `_seedWeight` so the strongest basket seed → 1, weakest → 0. Replace the body:
```js
function topSeeds(basketEnriched) {
  // Rank seeds by their buildTasteProfile-style weight (_seedWeight when present, else
  // insertion-order fallback), cap to MAX_SEEDS, then attach a pool-normalized [0,1]
  // _seedStrength so generateCandidates can scale each seed's co-rec weight (item 13).
  const ranked = [...basketEnriched]
    .map((m, i) => ({ m, w: typeof m._seedWeight === 'number' ? m._seedWeight : (basketEnriched.length - i) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, MAX_SEEDS);
  const ws = ranked.map((x) => x.w);
  const lo = ws.length ? Math.min(...ws) : 0;
  const hi = ws.length ? Math.max(...ws) : 0;
  const span = hi - lo;
  return ranked.map((x) => ({ ...x.m, _seedStrength: span > 0 ? (x.w - lo) / span : 1 }));
}
```
  (When all weights tie — e.g. the insertion-order fallback over a single-seed basket — `span===0` → `_seedStrength` defaults to 1, preserving today's behavior.)

  In `generateCandidates` (~L1201), pass the seed's strength through. Replace:
```js
      tagged.push(...extractSeedCandidates(enrichedSeed, r.json));
```
  with:
```js
      tagged.push(...extractSeedCandidates(enrichedSeed, r.json, seedStrength(r.seed._seedStrength)));
```

  > `topSeeds` now returns shallow copies carrying `_seedStrength`; `generateCandidates` already builds `enrichedSeed` as another shallow copy, so `_seedStrength` survives on `r.seed`. The existing comment block above the `enrichedSeed` line ("never mutate the shared basketEnriched object") still holds — `_seedStrength` lives only on the `topSeeds` copy.

- [ ] **Step 4: Run — expect PASS** — `node --test recommendations.test.js`. The new tests pass; the existing `extractSeedCandidates tags rec candidates … REC_SOURCE_WEIGHT` (L578, weight 1.0) and `…similar weighted below rec` (L608, weight 0.5) stay green (default `seedStrength=1`). Then `npm test` → fail=0.

- [ ] **Step 5: Verify network surface** — `node --check recommendations.js`; `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs` → PASS (unaffected; pure-data path).

- [ ] **Step 6: Commit** — `git add -A && git commit` — message: `feat(rec): thread basket seed strength into collabScore weights (item 13)`.

**New total: 166 + 4 = 170 tests, fail=0.**

---

### Task 16: Gate explore-gem reservation behind a satisfied top-genre row (follow-up c)

Today `groupIntoRows` reserves+claims explore gems BEFORE the genre rows are built, so in a thin top-genre catalog the gems starve the user's #1 genre row. Fix: claim gems only once the top-genre row has its `minItems`; otherwise leave the gems available to the genre row (no explore row that pass).

**Files:**
- `recommendations.js` — `groupIntoRows` (reservation block ~L916-935, genre-row block ~L949-962, explore-push block ~L983-991).
- `recommendations.test.js` — new tests after the existing explore test (~L410).

- [ ] **Step 1: Write failing tests** — append after `groupIntoRows: exactly one deterministic explore row` (~L410):

```js
test('groupIntoRows: thin top-genre pool keeps the genre row alive (gems do not starve it)', () => {
  // Only 4 sci-fi(878) titles total in the top genre. 3 are "gems" (hi-rating, lo-votes).
  // If gems are reserved first they claim 3 of 4 and the genre row falls below minItems(4).
  // Gated: the genre row keeps all 4; no explore row is pushed.
  const ranked = [
    grq(40, { genres: [878], score: 0.9, va: 7.0, vc: 9000 }),  // popular, not a gem
    grq(50, { genres: [878], score: 0.2, va: 8.6, vc: 40 }),    // gem
    grq(51, { genres: [878], score: 0.2, va: 8.9, vc: 25 }),    // gem
    grq(52, { genres: [878], score: 0.2, va: 8.7, vc: 30 }),    // gem
  ];
  const opts = { topCount: 0, minItems: 4, genreDist: { '878': 1 } };
  const rows = groupIntoRows(ranked, { ...GROUP_PROFILE, topTitles: [], people: {} }, opts);
  const genreRow = rows.find((r) => r.kind === 'genre');
  assert.ok(genreRow, 'the top-genre row must survive a thin catalog');
  assert.equal(genreRow.recs.length, 4, 'genre row keeps all 4 titles (gems not pre-claimed)');
  assert.equal(rows.filter((r) => r.kind === 'explore').length, 0, 'no explore row when it would starve the genre row');
});

test('groupIntoRows: a healthy pool still yields BOTH the genre row and the explore row', () => {
  // 4 popular sci-fi for the genre row + 4 gems for explore: both rows satisfiable.
  const ranked = [
    ...[40, 41, 42, 43].map((id) => grq(id, { genres: [878], score: 0.9, va: 7.0, vc: 9000 })),
    grq(50, { genres: [878], score: 0.2, va: 8.6, vc: 40 }),
    grq(51, { genres: [878], score: 0.2, va: 8.9, vc: 25 }),
    grq(52, { genres: [878], score: 0.2, va: 8.7, vc: 30 }),
    grq(53, { genres: [878], score: 0.2, va: 8.3, vc: 60 }),
  ];
  const opts = { topCount: 0, minItems: 4, genreDist: { '878': 1 } };
  const rows = groupIntoRows(ranked, { ...GROUP_PROFILE, topTitles: [], people: {} }, opts);
  const genreRow = rows.find((r) => r.kind === 'genre');
  const explore = rows.find((r) => r.kind === 'explore');
  assert.ok(genreRow && genreRow.recs.length >= 4, 'genre row satisfied');
  assert.ok(explore && explore.recs.length >= 4, 'explore row satisfied');
  // No overlap between the two rows.
  const g = new Set(genreRow.recs.map((r) => r.movie.id));
  assert.ok(explore.recs.every((r) => !g.has(r.movie.id)), 'genre and explore rows are disjoint');
});
```

- [ ] **Step 2: Run — expect FAIL** — `node --test recommendations.test.js` → the thin-pool test fails: today gems claim 3 of the 4 sci-fi titles first, the genre row gets 1 (< minItems 4) and is dropped, and an explore row of 3 (< minItems) is also dropped — leaving NO genre row.

- [ ] **Step 3: Implement** — in `groupIntoRows`, restructure so gems are SELECTED early (for determinism) but CLAIMED only after the top-genre row is satisfied.

  Replace the explore-reservation block (the `const topGenre = genreOrder[0]; let exploreGems = []; … if (exploreGems.length >= minItems) claim(exploreGems); else exploreGems = [];` block, ~L919-935) with a selection-only version that does NOT claim yet:
```js
  // Select the explore gems (high-rating, low-vote-count titles in the top basket genre) but DON'T
  // claim them yet: claiming is gated on the top-genre row being satisfiable first, so a thin
  // catalog never lets "Hidden gems" starve the user's #1 genre row (follow-up c). Deterministic
  // selection: rarest first, then highest rating, then id.
  const topGenre = genreOrder[0];
  let exploreGems = [];
  if (topGenre != null) {
    exploreGems = ranked
      .filter((r) => !placed.has(recId(r))
        && (r.movie.genre_ids || []).map(num).includes(topGenre)
        && num(r.movie.vote_average) >= exploreMinVote
        && num(r.movie.vote_count) > 0
        && num(r.movie.vote_count) < exploreMaxCount)
      .sort((a, b) =>
        (num(a.movie.vote_count) - num(b.movie.vote_count))
        || (num(b.movie.vote_average) - num(a.movie.vote_average))
        || (num(a.movie.id) - num(b.movie.id)))
      .slice(0, exploreCount);
  }
  const exploreIds = new Set(exploreGems.map(recId));
```

  In the genre-row loop (~L950-962), when building the TOP-genre row, first try WITHOUT the reserved gems; only if that can't meet `minItems` do we let the gems back in (and then suppress the explore row). Replace the genre-row loop with:
```js
  // 3. More <Genre> — budget allocated by the basket genre histogram when present. For the TOP
  // genre, prefer to exclude the reserved gems (they belong in the explore row); but if doing so
  // would starve the genre row below minItems, RECLAIM the gems into the genre row and drop explore.
  for (const gid of genreOrder.slice(0, genreRows)) {
    const budget = genreDist
      ? Math.max(minItems, Math.round((genreDist[String(gid)] || 0) * itemsPerRow))
      : itemsPerRow;
    const inGenre = (r) => !placed.has(recId(r)) && (r.movie.genre_ids || []).map(num).includes(gid);
    const isTopGenre = gid === topGenre;
    // For the top genre, first attempt the row WITHOUT the reserved gems.
    let recs = ranked
      .filter((r) => inGenre(r) && !(isTopGenre && exploreIds.has(recId(r))))
      .slice(0, Math.min(budget, itemsPerRow));
    if (isTopGenre && recs.length < minItems) {
      // Thin catalog: the genre row needs the gems. Reclaim them and cancel the explore row.
      recs = ranked.filter(inGenre).slice(0, Math.min(budget, itemsPerRow));
      exploreGems = [];
      exploreIds.clear();
    }
    if (recs.length >= minItems) {
      claim(recs);
      // Now that the top-genre row is satisfied (and didn't need the gems), reserve them so the
      // remaining personalized rows below can't absorb them before the explore row is pushed.
      if (isTopGenre && exploreGems.length >= minItems) claim(exploreGems);
      rows.push({ kind: 'genre', title: `More ${GENRE_NAMES.get(gid) || 'like this'}`, recs });
    }
  }
```

  Update the explore-push block (~L983-991) so it only pushes when the gems survived (still `>= minItems` and were claimed):
```js
  // 5. Exactly one DETERMINISTIC explore row, pushed last. Gems were reserved + claimed only AFTER
  // the top-genre row was satisfied without them (follow-up c), so a thin catalog has no explore row.
  if (exploreGems.length >= minItems && exploreGems.every((r) => placed.has(recId(r)))) {
    rows.push({
      kind: 'explore',
      title: `Hidden gems in ${GENRE_NAMES.get(topGenre) || 'your taste'}`,
      recs: exploreGems,
    });
  }
```

  > Ordering note (cross-phase-safe): this preserves the function's contract — gems are still selected deterministically and the explore row is still "exactly one, last." The only behavior change is *when* the claim happens (after the top-genre row), described relative to the row's purpose, so it composes with any other phase's edits to `groupIntoRows`. If `topCount > 0` (Top Picks claims some items first via `calibrate`), gems already-placed by Top Picks are excluded by the `!placed.has(recId(r))` selection filter, unchanged.

- [ ] **Step 4: Run — expect PASS** — `node --test recommendations.test.js`. Verify the 2 new tests pass AND the existing explore tests stay green: `exactly one deterministic explore row, stable across calls` (L388 — its pool has 4 popular(vc 5000) sci-fi for the genre row + 4 gems, so the genre row is satisfied without gems → gems claimed → explore row present and deterministic) and `no id appears in two rows` (L341). Then `npm test` → fail=0.

- [ ] **Step 5: Verify network surface** — `node --check recommendations.js`; `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs` → PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit` — message: `fix(rec): gate explore gems behind a satisfied top-genre row (follow-up c)`.

**New total: 170 + 2 = 172 tests, fail=0.**

---

### Task 17: Token-robust harness extraction + cosmetics (follow-ups d, b)

(d) The harness pulls `buildRecRail`/`createRecommendationCard` out of `script.js` with a brace-balancing `slice()` that a `'}'`-inside-a-string would mis-slice. Make extraction marker-delimited (token-free) — robust regardless of string contents. script.js cannot be Node-`import`ed (module-top-level `document.getElementById` side effects), so the harness keeps injecting the REAL builder source into the page; we only harden *how* that source is located. (b) Fix the ride-along cosmetics: the harness kicker fixture, and assert the cold-start lead-row label.

**Files:**
- `script.js` — add marker comments around `createRecommendationCard` (~L1869) and `buildRecRail` (~L1969).
- `rec-dom-harness.mjs` — replace `slice(name)` (L11-30) with a marker extractor; extend assertions.

- [ ] **Step 1: Add a harness self-check that FAILS today** — extend `rec-dom-harness.mjs` with a brittle-extraction guard before launch. After `const scriptSrc = readFileSync(...)` (L8), add:

```js
// Guard (follow-up d): the builders must be delimited by extraction markers so a '}' inside a
// template string can't mis-slice. Fail loudly if the markers are missing.
for (const name of ['createRecommendationCard', 'buildRecRail']) {
  const begin = `// >>> REC-HARNESS-EXPORT ${name}`;
  const end = `// <<< REC-HARNESS-EXPORT ${name}`;
  if (!scriptSrc.includes(begin) || !scriptSrc.includes(end)) {
    throw new Error(`rec-dom-harness: missing extraction markers for ${name} in script.js`);
  }
}
```

- [ ] **Step 2: Run — expect FAIL** — `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs` → throws `missing extraction markers for createRecommendationCard` (markers not yet in script.js).

- [ ] **Step 3: Implement markers + marker extractor.**

  In `script.js`, wrap each builder with markers. Immediately ABOVE `function createRecommendationCard(rec, index) {` add a line:
```js
// >>> REC-HARNESS-EXPORT createRecommendationCard
```
  and immediately BELOW its closing brace `}` (the one returning `card`, ~L1964) add:
```js
// <<< REC-HARNESS-EXPORT createRecommendationCard
```
  Likewise wrap `buildRecRail`: above `function buildRecRail(recs, { kicker, heading, subline }) {` add:
```js
// >>> REC-HARNESS-EXPORT buildRecRail
```
  and below its closing `}` (returning `section`, ~L2001) add:
```js
// <<< REC-HARNESS-EXPORT buildRecRail
```

  In `rec-dom-harness.mjs`, replace the entire `function slice(name) { … }` (L11-30) with a marker-delimited extractor:
```js
// Extract a builder's REAL source from script.js by its REC-HARNESS-EXPORT markers. Token-free:
// a '}' (or any brace) inside a template string can no longer mis-slice the body.
function slice(name) {
  const begin = `// >>> REC-HARNESS-EXPORT ${name}`;
  const end = `// <<< REC-HARNESS-EXPORT ${name}`;
  const start = scriptSrc.indexOf(begin);
  if (start < 0) throw new Error(`marker ${begin} not found in script.js`);
  const bodyStart = start + begin.length;
  const stop = scriptSrc.indexOf(end, bodyStart);
  if (stop < 0) throw new Error(`marker ${end} not found in script.js`);
  return scriptSrc.slice(bodyStart, stop);
}
```

  Fix the (b) cosmetic kicker-fixture drift: the in-page `REC_ROW_KICKERS` in the harness `scriptTail` (L62-67) is missing the `trending` kicker that the real renderer (`script.js` L2092-2098) carries. Add it so the fixture mirrors production. Replace the harness `REC_ROW_KICKERS` object literal with:
```js
  const REC_ROW_KICKERS = {
    top: 'Calibrated to your basket',
    title: 'Because you liked it',
    genre: 'More of this genre',
    trending: 'Popular this week',
    explore: 'A little different',
  };
```

- [ ] **Step 4: Extend harness assertions (cold-start label, follow-up b cosmetic).** Add a `trending` row to the harness `rows` fixture (L48-60) and assert its kicker resolves, proving the fixture/production kicker maps agree. In `scriptTail`, change the `rows` fixture to include a trending row between top and explore:
```js
    { kind: 'trending', title: 'Trending this week', recs: [
      { movie: { id: 4, title: 'Dune', media_type: 'movie', vote_average: 8.0, vote_count: 11000, _seeds: [] },
        score: 0.7, reasons: ['Popular this week'] },
    ] },
```
  Then after the existing rail-info assertions (~L108), add:
```js
  // (e) the trending rail resolves its production kicker (fixture<->renderer kicker maps agree).
  const trendingKicker = railInfo.find((r) => r.kind === 'trending')?.kicker;
  assert.equal(trendingKicker, 'Popular this week', 'trending rail kicker must match the renderer map');
```

- [ ] **Step 5: Run — expect PASS** — `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs` → `rec-dom-harness: PASS` (marker guard passes, extraction works, trending kicker asserts). Then `node --check script.js` and `node --check rec-dom-harness.mjs`. Run `npm test` → still 172 tests, fail=0 (no unit-test count change; script.js/harness are not under `node --test`).

- [ ] **Step 6: Commit** — `git add -A && git commit` — message: `chore(rec): marker-based harness extraction + kicker-fixture cosmetics (follow-ups d,b)`.

**New total: 172 tests, fail=0 (harness-only changes; unit count unchanged).**

---

### Phase 3 close-out verification

- [ ] **Step 1: Full regression** — `npm test` → `tests 172`, `pass 172`, `fail 0`.
- [ ] **Step 2: Syntax + harness** — `node --check recommendations.js && node --check script.js && node --check rec-dom-harness.mjs`; `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node rec-dom-harness.mjs` → `rec-dom-harness: PASS`.
- [ ] **Step 3: Confirm the cold-start guardrail** — the spec's measurement proxy ("empty-basket top-20 score variance > 0; a high-quality recent title outranks a low-vote obscurity") is now covered by the Task 3.3 cold-start tests; no separate run needed.
```

**Note on the spec deviation I made** (surfacing the assumption per the rules): item 15(d) says "export `buildRecRail`/`createRecommendationCard` for `rec-dom-harness.mjs` to import." A literal Node `import` of `script.js` is impossible — `script.js` runs `document.getElementById(...)` at module top level and `addEventListener(...)` at the bottom, so importing it under Node throws `document is not defined` before any export is reachable. The spec offers the explicit alternative — "(or make the `slice()` extractor token-aware)" — which I took via marker-delimited extraction (`// >>> REC-HARNESS-EXPORT <name>` … `// <<< …`). This eliminates the `'}'`-in-a-string mis-slice risk (the stated motivation) while keeping the harness's existing inject-into-page mechanism that works around the DOM side effects. The two builders still get exercised as the REAL `script.js` source — no copy drift.
