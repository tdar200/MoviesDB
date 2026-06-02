# Recommendation Engine Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-architect the movies recommendation engine into a two-stage funnel built on TMDB's own collaborative endpoints, with quality-aware scoring and diversity re-ranking — making recommendations relevant, varied, populated, and fresh.

**Architecture:** Two-stage funnel. Stage 1 (bounded TMDB calls): per-seed `/recommendations`+`/similar` (mixed movie+TV), Discover expansion, cold-start trending blend. Stage 2 (free in-browser re-rank): normalized collab+content hybrid x Bayesian quality x recency, then MMR diversity + per-seed cap + franchise collapse, assembled into Netflix-style calibrated themed rows with evidence labels. Basket-primary preserved; watched stays hide-only.

**Tech Stack:** Vanilla ES modules (browser), TMDB API, localStorage/sessionStorage, `node --test`.

**Note on commits:** every `git commit` in this plan appends the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (omitted from individual steps for brevity).

**Test baseline (verified):** `recommendations.test.js` has 31 tests; the full suite (`npm test`) has 40 (incl. `watch-timer.test.js`=9). Expected counts in tasks build on these.

---

## Phase 1 — transformative core

### Task 1: Add ENDPOINTS.recommendations + ENDPOINTS.similar (collaborative/content list URLs)

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/config.test.js` (NEW — this section CREATES it; the Discover-endpoint tests are APPENDED later in Phase 2 by the Discover-parameterization work, which must not re-create the header)
- `/home/tahseen-dar/Projects/MoviesDB/config.js` (ENDPOINTS object; insert after the `keywords` builder at L72, before the `discoverByGenres` line at L74)

- [ ] **Step 1: Write the failing test (and the file header).** Create `/home/tahseen-dar/Projects/MoviesDB/config.test.js`. This is the single import header for the whole config suite — the Phase 2 Discover tests append below these without re-importing. These are pure URL builders, so no `now` arg is involved.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, CONFIG } from './config.js';

test('ENDPOINTS.recommendations builds /{type}/{id}/recommendations with default page 1', () => {
  const url = ENDPOINTS.recommendations('movie', 27205);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/27205/recommendations?`), url);
  assert.match(url, /[?&]api_key=/);
  assert.match(url, /[?&]page=1(&|$)/);
});

test('ENDPOINTS.recommendations honors an explicit page and tv type', () => {
  const url = ENDPOINTS.recommendations('tv', 1399, 3);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/tv/1399/recommendations?`), url);
  assert.match(url, /[?&]page=3(&|$)/);
});

test('ENDPOINTS.similar builds /{type}/{id}/similar with default page 1', () => {
  const url = ENDPOINTS.similar('movie', 27205);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/27205/similar?`), url);
  assert.match(url, /[?&]api_key=/);
  assert.match(url, /[?&]page=1(&|$)/);
});

test('ENDPOINTS.similar honors an explicit page', () => {
  const url = ENDPOINTS.similar('tv', 1399, 2);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/tv/1399/similar?`), url);
  assert.match(url, /[?&]page=2(&|$)/);
});
```

- [ ] **Step 2: Run it — expect FAIL.**
  Command: `node --test --test-name-pattern="ENDPOINTS.(recommendations|similar)" config.test.js`
  Expected: FAIL — `TypeError: ENDPOINTS.recommendations is not a function` (and the same for `similar`); test runner reports `# fail 4`, `# pass 0`.

- [ ] **Step 3: Minimal impl.** In `/home/tahseen-dar/Projects/MoviesDB/config.js`, insert the two builders into the `ENDPOINTS` object immediately after the existing `keywords` builder (L72), before the `discoverByGenres` line (L74). Mirror the existing `&`-joined query-string style.

```js
  // Per-seed COLLABORATIVE expansion: "people who liked X also liked Y" (TMDB's own engine).
  recommendations: (type, id, page = 1) => `${CONFIG.BASE_URL}/${type}/${id}/recommendations?api_key=${CONFIG.API_KEY}&page=${page}`,
  // Per-seed CONTENT fallback for obscure/new seeds whose recommendations list is thin.
  similar: (type, id, page = 1) => `${CONFIG.BASE_URL}/${type}/${id}/similar?api_key=${CONFIG.API_KEY}&page=${page}`,
```

- [ ] **Step 4: Run it — expect PASS.**
  Command: `node --test --test-name-pattern="ENDPOINTS.(recommendations|similar)" config.test.js`
  Expected: PASS — `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit.**
  `git commit -m "feat(rec): add ENDPOINTS.recommendations and similar URL builders"`

### Task 2: Add ENDPOINTS.appendDetail (single-call seed enrichment)

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/config.test.js` (append tests below the Task 1.1 tests; reuse the existing import header)
- `/home/tahseen-dar/Projects/MoviesDB/config.js` (ENDPOINTS object, immediately after the `similar` builder added in Phase 1)

- [ ] **Step 1: Write the failing test.** Append to `/home/tahseen-dar/Projects/MoviesDB/config.test.js`. The contract path is `/{type}/{id}?append_to_response=recommendations,similar,keywords,credits`. Assert the exact `append_to_response` value (order matters per the contract) and that all four sub-resources are present.

```js
test('ENDPOINTS.appendDetail builds /{type}/{id} with the four appended sub-resources', () => {
  const url = ENDPOINTS.appendDetail('movie', 27205);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/27205?`), url);
  assert.match(url, /[?&]api_key=/);
  assert.match(url, /[?&]append_to_response=recommendations,similar,keywords,credits(&|$)/);
});

test('ENDPOINTS.appendDetail works for tv type and appends all of recommendations/similar/keywords/credits', () => {
  const url = ENDPOINTS.appendDetail('tv', 1399);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/tv/1399?`), url);
  for (const part of ['recommendations', 'similar', 'keywords', 'credits']) {
    assert.ok(url.includes(part), `expected ${part} in ${url}`);
  }
});
```

- [ ] **Step 2: Run it — expect FAIL.**
  Command: `node --test --test-name-pattern="ENDPOINTS.appendDetail" config.test.js`
  Expected: FAIL — `TypeError: ENDPOINTS.appendDetail is not a function`; runner reports `# fail 2`, `# pass 0`.

- [ ] **Step 3: Minimal impl.** In `/home/tahseen-dar/Projects/MoviesDB/config.js`, add the builder directly after the `similar` line from Phase 1.

```js
  // Single-call seed enrichment: keywords + credits (content vectors / Discover expansion)
  // AND the seed's recommendations + similar lists, all in one request.
  appendDetail: (type, id) => `${CONFIG.BASE_URL}/${type}/${id}?api_key=${CONFIG.API_KEY}&append_to_response=recommendations,similar,keywords,credits`,
```

- [ ] **Step 4: Run it — expect PASS.**
  Command: `node --test --test-name-pattern="ENDPOINTS.appendDetail" config.test.js`
  Expected: PASS — `# pass 2`, `# fail 0`.

- [ ] **Step 5: Commit.**
  `git commit -m "feat(rec): add ENDPOINTS.appendDetail single-call seed enrichment URL"`

### Task 3: Add ENDPOINTS.topRated (generalizes movie-only topRatedMovies)

This task is the SOLE owner of `ENDPOINTS.topRated`. The cold-start filler work in Phase 4 USES `ENDPOINTS.topRated` (added here) and must NOT add it conditionally or defensively.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/config.test.js` (append tests below the Task 1.2 tests; reuse the existing import header)
- `/home/tahseen-dar/Projects/MoviesDB/config.js` (ENDPOINTS object, immediately after the `appendDetail` builder added in Phase 1; existing `topRatedMovies` at L65 stays untouched)

- [ ] **Step 1: Write the failing test.** Append to `/home/tahseen-dar/Projects/MoviesDB/config.test.js`. `topRated` generalizes `topRatedMovies` over media type with a default page of 1. Also assert that the existing `topRatedMovies` builder still works unchanged (back-compat — it stays intact).

```js
test('ENDPOINTS.topRated builds /{type}/top_rated with default page 1', () => {
  const url = ENDPOINTS.topRated('movie');
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/top_rated?`), url);
  assert.match(url, /[?&]api_key=/);
  assert.match(url, /[?&]page=1(&|$)/);
});

test('ENDPOINTS.topRated generalizes to tv and honors an explicit page', () => {
  const url = ENDPOINTS.topRated('tv', 4);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/tv/top_rated?`), url);
  assert.match(url, /[?&]page=4(&|$)/);
});

test('existing ENDPOINTS.topRatedMovies remains intact', () => {
  const url = ENDPOINTS.topRatedMovies(2);
  assert.ok(url.startsWith(`${CONFIG.BASE_URL}/movie/top_rated?`), url);
  assert.match(url, /[?&]page=2(&|$)/);
});
```

- [ ] **Step 2: Run it — expect FAIL.**
  Command: `node --test --test-name-pattern="ENDPOINTS.topRated " config.test.js`
  Expected: FAIL — `TypeError: ENDPOINTS.topRated is not a function` for the two new `topRated ` tests; runner reports `# fail 2`, `# pass 0`. (The trailing space in the pattern targets only the two `topRated ` tests; the `topRatedMovies remains intact` test name does not contain `topRated ` so it is run explicitly in Step 4.)

- [ ] **Step 3: Minimal impl.** In `/home/tahseen-dar/Projects/MoviesDB/config.js`, add the builder directly after the `appendDetail` line from Phase 1. Keep the existing `topRatedMovies` builder (L65) untouched.

```js
  // Generalizes topRatedMovies across media type for the cold-start top-rated blend.
  topRated: (type, page = 1) => `${CONFIG.BASE_URL}/${type}/top_rated?api_key=${CONFIG.API_KEY}&page=${page}`,
```

- [ ] **Step 4: Run it — expect PASS.**
  Command: `node --test --test-name-pattern="ENDPOINTS.topRated|topRatedMovies remains" config.test.js`
  Expected: PASS — `# pass 3`, `# fail 0`.

- [ ] **Step 5: Run the full config suite to confirm nothing regressed and existing endpoints are intact.**
  Command: `node --test config.test.js`
  Expected: PASS — all 9 tests green (`# pass 9`, `# fail 0`): 4 from Task 1.1, 2 from Task 1.2, 3 from Task 1.3. (The Discover-parameterization work in Phase 2 appends further tests to this same file and restates the running total then.)

- [ ] **Step 6: Run the whole project test suite to confirm the existing recommendations tests still pass (no pure-function signatures were touched in this section).**
  Command: `npm test`
  Expected: PASS — `recommendations.test.js` 31 existing tests green, `config.test.js` 9 new tests green, `watch-timer.test.js` 9 green; `# fail 0` overall. Baseline before this section: 40 (recommendations 31 + watch-timer 9). This section adds 9 config tests → new full-suite total 49, `# pass 49`, `# fail 0`.

- [ ] **Step 7: Commit.**
  `git commit -m "feat(rec): add ENDPOINTS.topRated generalizing topRatedMovies over media type"`

The verification confirms: `delay` is still called at L412 and L456 (so it must NOT be deleted), `fetchJson` is at L367-371, imports are as drafted, and the real baselines are 31 (recommendations) / 40 (full suite). I'll finalize with these corrections applied.

### Task 4: Create fetch-queue.js — concurrency, in-flight de-dup, memo, 429 backoff

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/fetch-queue.js` (NEW)
- `/home/tahseen-dar/Projects/MoviesDB/fetch-queue.test.js` (NEW)

- [ ] **Step 1: Write the failing test file.** Create `/home/tahseen-dar/Projects/MoviesDB/fetch-queue.test.js`. Fixtures use a Map-backed fake storage, a fake `fetchImpl` whose responses are scripted per-URL, and an injected `delayImpl` that records its `ms` arguments instead of sleeping (so the 429 backoff is observable without wall-clock time). The fixed clock `NOW` is passed as `now`.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchQueue } from './fetch-queue.js';

const NOW = 1_700_000_000_000; // fixed clock for deterministic tests

// Map-backed sessionStorage stand-in (getItem/setItem/removeItem, string values).
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

// Builds a Response-like object. body is returned from .json().
function jsonResponse(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    json: async () => body,
  };
}

// Resolve a promise after letting the microtask queue drain `ticks` times.
async function flush(ticks = 5) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

test('memoizes successful GET json by url: second call hits storage, not fetchImpl', async () => {
  const storage = fakeStorage();
  let calls = 0;
  const fetchImpl = async (url) => { calls++; return jsonResponse({ url, page: 1 }); };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  const first = await q.fetchJson('https://api/x?page=1');
  const second = await q.fetchJson('https://api/x?page=1');

  assert.deepEqual(first, { url: 'https://api/x?page=1', page: 1 });
  assert.deepEqual(second, first);
  assert.equal(calls, 1, 'second call must come from storage memo');
});

test('de-dupes identical in-flight URLs into a single fetch', async () => {
  const storage = fakeStorage();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (url) => { calls++; await gate; return jsonResponse({ url }); };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  const a = q.fetchJson('https://api/dup');
  const b = q.fetchJson('https://api/dup');
  await flush();
  assert.equal(calls, 1, 'identical in-flight URL must share one fetch');

  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, { url: 'https://api/dup' });
  assert.deepEqual(rb, ra);
});

test('caps concurrency at maxInflight', async () => {
  const storage = fakeStorage();
  let inflight = 0;
  let maxObserved = 0;
  const releasers = [];
  const fetchImpl = async (url) => {
    inflight++;
    maxObserved = Math.max(maxObserved, inflight);
    await new Promise((r) => releasers.push(() => { inflight--; r(jsonResponse({ url })); }));
    return jsonResponse({ url });
  };
  const q = createFetchQueue({ fetchImpl, storage, maxInflight: 2, delayImpl: async () => {}, now: () => NOW });

  const ps = [];
  for (let i = 0; i < 5; i++) ps.push(q.fetchJson(`https://api/c/${i}`));
  await flush();
  assert.equal(maxObserved, 2, 'never more than maxInflight concurrent fetches');

  while (releasers.length) releasers.shift()();
  await Promise.all(ps);
  assert.equal(maxObserved, 2);
});

test('on 429 with Retry-After, backs off via delayImpl then retries and succeeds', async () => {
  const storage = fakeStorage();
  const delays = [];
  const delayImpl = async (ms) => { delays.push(ms); };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (calls === 1) return jsonResponse({ error: 'rate' }, { ok: false, status: 429, headers: { 'retry-after': '3' } });
    return jsonResponse({ url, ok: true });
  };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl, now: () => NOW });

  const out = await q.fetchJson('https://api/429');
  assert.equal(calls, 2, 'must retry once after backoff');
  assert.deepEqual(delays, [3000], 'Retry-After seconds honored as ms');
  assert.deepEqual(out, { url: 'https://api/429', ok: true });
});

test('429 without Retry-After uses exponential backoff', async () => {
  const storage = fakeStorage();
  const delays = [];
  const delayImpl = async (ms) => { delays.push(ms); };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (calls < 3) return jsonResponse({ error: 'rate' }, { ok: false, status: 429 });
    return jsonResponse({ url });
  };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl, now: () => NOW });

  const out = await q.fetchJson('https://api/expo');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000], 'exponential: base 1000, then doubled');
  assert.deepEqual(out, { url: 'https://api/expo' });
});

test('throws on non-ok non-429 and does not memoize', async () => {
  const storage = fakeStorage();
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse({ error: 'nope' }, { ok: false, status: 500 }); };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  await assert.rejects(() => q.fetchJson('https://api/err'), /500/);
  assert.equal(calls, 1, 'no retry on 500');
  await assert.rejects(() => q.fetchJson('https://api/err'), /500/);
  assert.equal(calls, 2, 'error responses are never memoized');
});

test('clearMemo drops the stored entries so the next call refetches', async () => {
  const storage = fakeStorage();
  let calls = 0;
  const fetchImpl = async (url) => { calls++; return jsonResponse({ url }); };
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  await q.fetchJson('https://api/clear');
  assert.equal(calls, 1);
  q.clearMemo();
  await q.fetchJson('https://api/clear');
  assert.equal(calls, 2, 'after clearMemo the memo is empty, so refetch');
});
```

- [ ] **Step 2: Run the test, expect FAIL (module does not exist).**

```
node --test fetch-queue.test.js
```

Expected: FAIL — `Cannot find module './fetch-queue.js'` (every test errors with a module-not-found / `createFetchQueue is not a function`).

- [ ] **Step 3: Implement `fetch-queue.js` (minimal, dependency-injected).** Create `/home/tahseen-dar/Projects/MoviesDB/fetch-queue.js`. The memo is namespaced under one storage key holding a `{ [url]: json }` object so `clearMemo` is a single `removeItem`. In-flight de-dup is a `Map<url, Promise>`. Concurrency is a counter + a pending-runner queue drained when a slot frees. Backoff: `Retry-After` (seconds) honored when present, else exponential `base * 2^attempt`.

```js
// fetch-queue.js
// Concurrency-limited fetch + 429 backoff + URL-keyed sessionStorage memo.
// Dependency-injected (fetchImpl, storage, delayImpl, now) for testability.

const MEMO_KEY = 'recFetchMemo';   // single storage key -> { [url]: json }
const BACKOFF_BASE_MS = 1000;
const MAX_RETRIES = 4;

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFetchQueue({
  fetchImpl = fetch,
  maxInflight = 6,
  storage,
  delayImpl = defaultDelay,
  now = Date.now,
} = {}) {
  const inFlight = new Map();   // url -> Promise<json> (de-dup identical pending URLs)
  const waiters = [];           // queued runners awaiting a concurrency slot
  let active = 0;

  function readMemo() {
    if (!storage) return {};
    try {
      return JSON.parse(storage.getItem(MEMO_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function writeMemo(url, json) {
    if (!storage) return;
    const memo = readMemo();
    memo[url] = json;
    try {
      storage.setItem(MEMO_KEY, JSON.stringify(memo));
    } catch {
      // storage full / unavailable -> memo is best-effort only
    }
  }

  function pump() {
    while (active < maxInflight && waiters.length) {
      const run = waiters.shift();
      active++;
      run().finally(() => {
        active--;
        pump();
      });
    }
  }

  // Acquire a concurrency slot; resolves when this URL is allowed to run.
  function acquireSlot(task) {
    return new Promise((resolve, reject) => {
      waiters.push(() => task().then(resolve, reject));
      pump();
    });
  }

  async function doFetch(url) {
    let attempt = 0;
    for (;;) {
      const res = await fetchImpl(url);
      if (res.ok) return res.json();

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
        const ms = retryAfter != null && retryAfter !== ''
          ? Number(retryAfter) * 1000
          : BACKOFF_BASE_MS * 2 ** attempt;
        attempt++;
        await delayImpl(ms);
        continue;
      }
      throw new Error(`fetch ${res.status} for ${url}`);
    }
  }

  function fetchJson(url) {
    const memo = readMemo();
    if (Object.prototype.hasOwnProperty.call(memo, url)) {
      return Promise.resolve(memo[url]);
    }
    if (inFlight.has(url)) return inFlight.get(url);

    const p = acquireSlot(() => doFetch(url))
      .then((json) => {
        writeMemo(url, json);
        return json;
      })
      .finally(() => {
        inFlight.delete(url);
      });

    inFlight.set(url, p);
    return p;
  }

  function clearMemo() {
    if (storage) storage.removeItem(MEMO_KEY);
  }

  // `now` reserved for future TTL on the memo; referenced to keep the signature honest.
  void now;

  return { fetchJson, clearMemo };
}
```

- [ ] **Step 4: Run the test, expect PASS.**

```
node --test fetch-queue.test.js
```

Expected: PASS — 7 tests pass, 0 fail. (Spot-check the in-flight de-dup case alone: `node --test --test-name-pattern="de-dupes identical in-flight URLs into a single fetch" fetch-queue.test.js`.)

- [ ] **Step 5: Confirm the existing suites are untouched, then commit.**

```
npm test
git add fetch-queue.js fetch-queue.test.js
git commit -m "feat(rec): concurrency-limited fetch queue with 429 backoff + memo"
```

Expected: `npm test` shows the 7 new fetch-queue tests passing plus the existing 40 tests (31 recommendations + 9 watch-timer) still green — **47 total**. Delta added by this task: **+7**.

### Task 5: Route recommendations.js fetchJson through a module-level queue instance

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add queue import after L340 `import { ENDPOINTS } from './config.js';`; rewrite the private `fetchJson` at L367-371 to route through a module-level queue instance). Do NOT delete `delay` (L345-347): it is still called at L412 and L456.
- `/home/tahseen-dar/Projects/MoviesDB/fetch-queue.test.js` (add one wiring regression test asserting the throw-on-!ok contract is preserved)

- [ ] **Step 1: Write the failing regression test for the preserved throw-on-!ok contract.** The existing `fetchJson` in `recommendations.js` is module-private, so we lock the behavioral contract at the queue boundary instead: a non-ok non-429 response must reject with an `Error` whose message carries the status, matching the old `TMDB ${status}` throw semantics that callers depend on. Append to `/home/tahseen-dar/Projects/MoviesDB/fetch-queue.test.js`:

```js
test('queue preserves throw-on-!ok contract used by recommendations.js callers', async () => {
  const storage = fakeStorage();
  const fetchImpl = async () => jsonResponse({ status_message: 'Not Found' }, { ok: false, status: 404 });
  const q = createFetchQueue({ fetchImpl, storage, delayImpl: async () => {}, now: () => NOW });

  await assert.rejects(
    () => q.fetchJson('https://api.themoviedb.org/3/movie/0'),
    (err) => err instanceof Error && /404/.test(err.message),
    'callers rely on a thrown Error carrying the HTTP status',
  );
});
```

- [ ] **Step 2: Run it (expect PASS — contract holds on the just-built queue), then capture the recommendations pre-edit baseline.**

```
node --test --test-name-pattern="queue preserves throw-on-!ok contract" fetch-queue.test.js
node --test recommendations.js recommendations.test.js
```

Expected: the new contract test PASSES (the queue from Task above already throws with the status). The `recommendations.test.js` run shows the existing **31 tests PASS** — this is the baseline that must not regress after the edit.

- [ ] **Step 3: Confirm `delay` still has live callers (it must be kept).**

```
grep -n "delay(" /home/tahseen-dar/Projects/MoviesDB/recommendations.js
```

Expected: the definition at L345 plus the two real call sites `await delay(300)` at ~L412 and ~L456. Because `delay` is still used for the per-batch enrichment pacing, **do not delete it** — only the network `fetchJson` is rerouted. (The queue owns 429 backoff timing; `delay` owns inter-batch pacing — distinct concerns.)

- [ ] **Step 4: Wire the module-level queue and rewrite `fetchJson`.** Add the queue import directly beneath the existing `import { ENDPOINTS } from './config.js';` line (L340):

```js
import { ENDPOINTS } from './config.js';
import { createFetchQueue } from './fetch-queue.js';
```

Replace the existing `fetchJson` body (L367-371):

```js
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${url}`);
  return res.json();
}
```

with a module-level queue instance plus a thin router. `sessionStorage` is the browser's session memo per the contract; it is read through a `typeof` guard so importing the module under `node --test` (no `sessionStorage` global) never throws:

```js
// One module-level queue: concurrency cap + 429 backoff + URL-keyed session memo.
const _recFetchQueue = createFetchQueue({
  fetchImpl: (url) => fetch(url),
  maxInflight: 6,
  storage: (typeof sessionStorage !== 'undefined') ? sessionStorage : undefined,
});

function fetchJson(url) {
  return _recFetchQueue.fetchJson(url);
}
```

Leave `delay` (L345-347) and its two call sites unchanged.

- [ ] **Step 5: Run both suites, expect PASS (no behavioral regression).**

```
node --test recommendations.js recommendations.test.js
npm test
```

Expected: `recommendations.test.js` **31 tests still PASS** (the public pure-function behavior is unchanged — only the private network helper was rerouted). `npm test` PASSES across all suites: 31 recommendations + 9 watch-timer + 8 fetch-queue = **48 total**. The module still imports cleanly under Node despite referencing `sessionStorage`/`fetch`, because both are accessed lazily/guarded and no test path triggers a real network call. Delta added by this task: **+1** (the contract regression test).

- [ ] **Step 6: Commit.**

```
git add recommendations.js fetch-queue.test.js
git commit -m "feat(rec): route fetchJson through module-level fetch queue"
```

Expected: clean commit; working tree has no other staged changes.

I now have the authoritative state. The current `generateCandidates(profile)` is the Discover implementation — which the reconciliation rules say ITEM 6 owns. ITEM 3 owns `generateCandidates` as `mergeCandidates of seedCandidates(basket)`, with ITEM 6 adding `discoverCandidates` via a targeted merge edit. I have enough to finalize. The constants block is confirmed at L17-25 with `DOWNVOTE_PENALTY` at L25.

### Task 6: Source-weight constants + `extractSeedCandidates` pure helper (rec/similar → tagged Candidates)

This is the FIRST task that touches the constants block. Per single-ownership, the FULL contract constants block is added EXACTLY ONCE here (ITEMS 4, 5, 7, 9 only use these names — they must not re-declare any). This task adds the block and the `extractSeedCandidates` pure helper.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add the full contract constants block immediately after `DOWNVOTE_PENALTY` at L25; add `extractSeedCandidates` immediately above `mergeCandidates` at ~L157)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (import update at L4; append new tests)

- [ ] **Step 1: Add the canonical contract constants block (added EXACTLY ONCE in the whole plan, here).** Edit `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, immediately after the existing `DOWNVOTE_PENALTY` line (L25), inside the tuning region. These are the EXACT contract names/values. Sections added later in the plan (scorePool/rankCandidates/MMR, downvote scoring, cold-start filler) only READ these — none re-declares them.

```js
const DOWNVOTE_PENALTY = 1.0;       // steer-away strength: a downvoted theme cancels an equal positive one

// --- Recommendation engine tuning (contract constants; declared once) ---
const W_COLLAB = 0.6;               // collaborative score weight in the hybrid
const W_CONTENT = 0.4;              // content (cosine) score weight in the hybrid
const MMR_LAMBDA_TEASER = 0.8;      // home-teaser MMR relevance/diversity tradeoff
const MMR_LAMBDA_PAGE = 0.6;        // full rec-page MMR relevance/diversity tradeoff
const PER_SEED_CAP = 3;             // max candidates kept per producing seed in MMR
const MAX_SEEDS = 12;               // cap basket seeds expanded per pipeline run
const BAYES_PRIOR_COUNT = 500;      // m: pseudo-count for the bayesian rating prior
const BAYES_GLOBAL_MEAN = 6.5;      // C: global mean rating prior
const REC_SOURCE_WEIGHT = 1.0;      // /recommendations candidate source weight
const SIMILAR_SOURCE_WEIGHT = 0.5;  // /similar weighted below rec
const NEAR_DUP_SIM = 0.9;           // itemSim above this collapses near-duplicates
const DOWNVOTE_GAMMA = 0.15;        // Rocchio negative-profile weight
const RECENCY_FULL_YEARS = 2;       // within 2 yrs => full recency multiplier 1.0
const RECENCY_FLOOR = 0.85;         // oldest titles recency multiplier floor
const COLD_START_FULL = 5;          // basketSize at which personalizedWeight === 1
```

- [ ] **Step 2: Write the failing test for `extractSeedCandidates`.** Edit the import line at `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` L4 to pull in the new export, then append the test block at the end of the file. The fixture is a shape-faithful `appendDetail` response carrying BOTH a movie candidate (in `recommendations`) and a tv candidate (in `similar`), proving real `media_type` is preserved and never coerced.

Change L4 from:
```js
import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates } from './recommendations.js';
```
to:
```js
import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, extractSeedCandidates } from './recommendations.js';
```

Append at end of file:
```js
// --- Stage 1: per-seed collaborative candidate extraction ---

const SEED_ITEM = { id: 27205, title: 'Inception', media_type: 'movie' };

// A trimmed but shape-faithful /movie/27205?append_to_response=recommendations,similar response.
const APPEND_JSON = {
  id: 27205,
  title: 'Inception',
  recommendations: {
    results: [
      // a movie rec
      { id: 155, title: 'The Dark Knight', media_type: 'movie', genre_ids: [18, 28, 80],
        vote_average: 8.5, vote_count: 30000, popularity: 120.5, release_date: '2008-07-16' },
      // a tv rec (mixed media: media_type comes straight from the response)
      { id: 1399, name: 'Game of Thrones', media_type: 'tv', genre_ids: [10765, 18],
        vote_average: 8.4, vote_count: 21000, popularity: 350.0, first_air_date: '2011-04-17' },
    ],
  },
  similar: {
    results: [
      { id: 49026, title: 'The Dark Knight Rises', media_type: 'movie', genre_ids: [28, 80, 18],
        vote_average: 7.8, vote_count: 19000, popularity: 80.0, release_date: '2012-07-16' },
    ],
  },
};

test('extractSeedCandidates tags rec candidates with source:rec and REC_SOURCE_WEIGHT', () => {
  const out = extractSeedCandidates(SEED_ITEM, APPEND_JSON);
  const dk = out.find((c) => c.id === 155);
  assert.equal(dk.media_type, 'movie');
  assert.equal(dk.vote_average, 8.5);
  assert.equal(dk.vote_count, 30000);
  assert.equal(dk.popularity, 120.5);
  assert.deepEqual(dk.genre_ids, [18, 28, 80]);
  assert.equal(dk.release_date, '2008-07-16');
  assert.equal(dk._seeds.length, 1);
  const tag = dk._seeds[0];
  assert.equal(tag.source, 'rec');
  assert.equal(tag.type, 'title');
  assert.equal(tag.id, 27205);          // facet id == producing seed title id for rec/similar
  assert.equal(tag.seedId, 27205);
  assert.equal(tag.seedTitle, 'Inception');
  assert.equal(tag.rank, 0);            // 0-based position in the rec list
  assert.equal(tag.weight, 1.0);        // REC_SOURCE_WEIGHT
});

test('extractSeedCandidates preserves a tv candidate real media_type and rank', () => {
  const out = extractSeedCandidates(SEED_ITEM, APPEND_JSON);
  const got = out.find((c) => c.id === 1399);
  assert.equal(got.media_type, 'tv');
  assert.equal(got.name, 'Game of Thrones');
  assert.equal(got.first_air_date, '2011-04-17');
  assert.equal(got._seeds[0].source, 'rec');
  assert.equal(got._seeds[0].rank, 1); // second in the rec list
});

test('extractSeedCandidates tags similar candidates source:similar weighted below rec', () => {
  const out = extractSeedCandidates(SEED_ITEM, APPEND_JSON);
  const sim = out.find((c) => c.id === 49026);
  assert.equal(sim.media_type, 'movie');
  const tag = sim._seeds[0];
  assert.equal(tag.source, 'similar');
  assert.equal(tag.type, 'title');
  assert.equal(tag.seedId, 27205);
  assert.equal(tag.seedTitle, 'Inception');
  assert.equal(tag.rank, 0);            // 0-based within the similar list
  assert.equal(tag.weight, 0.5);        // SIMILAR_SOURCE_WEIGHT
  assert.ok(tag.weight < out.find((c) => c.id === 155)._seeds[0].weight);
});

test('extractSeedCandidates uses seed media_type when a candidate omits it', () => {
  const tvSeed = { id: 1396, name: 'Breaking Bad', media_type: 'tv' };
  const json = { id: 1396, recommendations: { results: [
    { id: 60059, name: 'Better Call Saul', genre_ids: [18], vote_average: 8.5, vote_count: 5000, popularity: 90 },
  ] }, similar: { results: [] } };
  const out = extractSeedCandidates(tvSeed, json);
  assert.equal(out[0].media_type, 'tv'); // inherited from the tv seed
});

test('extractSeedCandidates returns [] for an empty / fieldless append payload', () => {
  assert.deepEqual(extractSeedCandidates(SEED_ITEM, { id: 27205 }), []);
  assert.deepEqual(extractSeedCandidates(SEED_ITEM, { id: 27205, recommendations: { results: [] }, similar: { results: [] } }), []);
});
```

- [ ] **Step 3: Run the new tests — expect FAIL.** `extractSeedCandidates` is not exported yet, so the import binding is `undefined` and every assertion throws.

```
node --test --test-name-pattern="extractSeedCandidates" recommendations.test.js
```
Expected: FAIL — `TypeError: extractSeedCandidates is not a function` across all 5 new tests (`# fail 5`).

- [ ] **Step 4: Implement `extractSeedCandidates`.** Edit `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, inserting the function immediately above `mergeCandidates` (at L157, before the `// Merge Discover result lists...` comment). It maps each list to tagged Candidates, preserving every TMDB field via spread, falling back to the seed's `media_type` only when the candidate omits it, and emitting the exact `SeedTag` shape (`source/type/id/seedId/seedTitle/rank/weight`). Pure: no network, no clock.

```js
// Map one appendDetail response's recommendations (source:'rec') and similar
// (source:'similar') lists into tagged Candidates. Each candidate keeps its REAL
// media_type from the response (mixed movie+tv), all quality/date fields, and a
// SeedTag recording which basket seed produced it, its 0-based list rank, and the
// source weight (rec > similar). Pure: no network, no clock.
export function extractSeedCandidates(seedItem, appendDetailJson) {
  if (!seedItem || !appendDetailJson) return [];
  const seedId = seedItem.id;
  const seedTitle = seedItem.title || seedItem.name;
  const seedMediaType = seedItem.media_type === 'tv' ? 'tv' : 'movie';

  const fromList = (list, source, weight) =>
    (list || []).map((cand, rank) => ({
      ...cand,
      media_type: cand.media_type === 'tv' || cand.media_type === 'movie'
        ? cand.media_type
        : seedMediaType,
      _seeds: [{ source, type: 'title', id: seedId, seedId, seedTitle, rank, weight }],
    }));

  return [
    ...fromList(appendDetailJson.recommendations?.results, 'rec', REC_SOURCE_WEIGHT),
    ...fromList(appendDetailJson.similar?.results, 'similar', SIMILAR_SOURCE_WEIGHT),
  ];
}
```

- [ ] **Step 5: Run the new tests — expect PASS.**

```
node --test --test-name-pattern="extractSeedCandidates" recommendations.test.js
```
Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 6: Run the full suite to confirm no regressions.** The existing `recommendations.js` suite currently has **31** tests (verified); this task adds **5**, taking the file to **36**. The full repo suite (`npm test`, all `*.test.js` incl. `watch-timer.test.js`=9) goes from the **40** baseline to **45**.

```
npm test
```
Expected: PASS — all green, `# fail 0`. The 5 new `extractSeedCandidates` tests pass; the 31 existing `recommendations.js` tests and the 9 `watch-timer.js` tests are untouched. (`recommendations.js` file: 36 pass; full suite: 45 pass.)

- [ ] **Step 7: Commit.**

```
git add recommendations.js recommendations.test.js
git commit -m "feat(rec): engine constants + extractSeedCandidates maps rec/similar to tagged candidates"
```

### Task 7: Confirm `mergeCandidates` accumulates the title-source SeedTag shape

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (one regression test guarding cross-seed accumulation)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` `mergeCandidates` at L158-169 (verify; only edit if the test fails)

- [ ] **Step 1: Write the failing test for the new SeedTag shape through merge.** The same title can be surfaced by two different basket seeds — once via `rec`, once via `similar`. `mergeCandidates` must dedupe by id and concatenate BOTH provenance tags (the current impl pushes `c._seeds`, which already handles this; this test pins the behavior for the new `source:'title'` tags so a later refactor can't silently break it). Append to `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js`:

```js
test('mergeCandidates accumulates rec+similar title SeedTags from different seeds', () => {
  const merged = mergeCandidates([
    { id: 155, media_type: 'movie', genre_ids: [18, 28, 80],
      _seeds: [{ source: 'rec', type: 'title', id: 27205, seedId: 27205, seedTitle: 'Inception', rank: 0, weight: 1.0 }] },
    { id: 155, media_type: 'movie', genre_ids: [18, 28, 80],
      _seeds: [{ source: 'similar', type: 'title', id: 49051, seedId: 49051, seedTitle: 'The Hobbit', rank: 2, weight: 0.5 }] },
    { id: 1399, media_type: 'tv', genre_ids: [10765, 18],
      _seeds: [{ source: 'rec', type: 'title', id: 27205, seedId: 27205, seedTitle: 'Inception', rank: 1, weight: 1.0 }] },
  ]);
  assert.equal(merged.length, 2);
  const c155 = merged.find((c) => c.id === 155);
  assert.equal(c155.media_type, 'movie');
  assert.equal(c155._seeds.length, 2);
  assert.deepEqual(c155._seeds.map((s) => s.source).sort(), ['rec', 'similar']);
  assert.deepEqual(c155._seeds.map((s) => s.seedId).sort((a, b) => a - b), [27205, 49051]);
  const c1399 = merged.find((c) => c.id === 1399);
  assert.equal(c1399._seeds.length, 1);
  assert.equal(c1399._seeds[0].source, 'rec');
});
```

- [ ] **Step 2: Run the test.**

```
node --test --test-name-pattern="mergeCandidates accumulates rec\+similar" recommendations.test.js
```
Expected: PASS already — the current `mergeCandidates` (`byId.get(key)._seeds.push(...(c._seeds || []))`, L158-169) is source-agnostic and accumulates these tags correctly. If it unexpectedly FAILS, do Step 3; otherwise skip to Step 4.

- [ ] **Step 3: (Only if Step 2 failed) make `mergeCandidates` source-agnostic.** Keep the dedupe-by-id-and-concat behavior; do not special-case `source`. Replace the body of `mergeCandidates` at `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` L158-169 with:

```js
export function mergeCandidates(taggedCandidates) {
  const byId = new Map();
  for (const c of taggedCandidates) {
    const key = String(c.id);
    if (byId.has(key)) {
      byId.get(key)._seeds.push(...(c._seeds || []));
    } else {
      byId.set(key, { ...c, _seeds: [...(c._seeds || [])] });
    }
  }
  return [...byId.values()];
}
```
Re-run Step 2; expected PASS.

- [ ] **Step 4: Run the existing `mergeCandidates` dedupe test to confirm no regression.** The original discover-tag test (`mergeCandidates dedupes by id and accumulates seeds`, L53-62) must still pass alongside the new one.

```
node --test --test-name-pattern="mergeCandidates" recommendations.test.js
```
Expected: PASS — both `mergeCandidates` tests green (`# pass 2`).

- [ ] **Step 5: Commit.** This task adds **1** test: `recommendations.js` file 36 → 37; full suite 45 → 46.

```
git add recommendations.test.js recommendations.js
git commit -m "test(rec): pin mergeCandidates accumulation of rec/similar SeedTags"
```

### Task 8: Build `generateCandidates` collaborative pool (per-seed appendDetail expansion)

`generateCandidates` is OWNED here: it produces the per-seed rec/similar collaborative pool from the enriched basket. The Discover pool (`discoverCandidates`) is added later by the Discover section via a TARGETED one-line merge edit, and cold-start filler (`fillerCandidates`) is added later by the cold-start section via another TARGETED merge edit — neither re-pastes this function. `_pipeline` is OWNED here for its enrich → `combineProfiles` → `generateCandidates` → exclude → score shape; the downvote-scoring section and the cold-start/`watchedIds`-hash section make only targeted edits to it (they do NOT rewrite the body). NOTE: the existing L418-459 body is the legacy Discover implementation; it is REPLACED here and the Discover section re-introduces Discover as a separate `discoverCandidates` helper merged in — this is the agreed single candidate-generation contract (one collaborative owner + targeted merges for the other two sources).

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` `generateCandidates` L417-459, `_pipeline` caller L495, `enrichWatchedTitles` L401-415

This task is network orchestration; per the contract it is verified headlessly later and has no pure-function unit test of its own — its building blocks (`extractSeedCandidates`, `mergeCandidates`) are unit-tested in Tasks 3.1/3.2. Steps here are the orchestration rewrite plus a smoke check that the module still imports and the pure suite stays green.

- [ ] **Step 1: Rewrite `generateCandidates` to expand the basket via `ENDPOINTS.appendDetail`.** Replace the whole legacy-Discover function at `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` L417-459 (the `async function generateCandidates(profile) { ... }` block). It now takes the enriched basket (with per-seed weights), caps to `MAX_SEEDS` by descending weight, issues one `appendDetail` call per seed through the queue (`fetchJson`), runs `extractSeedCandidates` on each response, ALSO harvests each seed's own `keywords`/`credits` from the same append payload onto the seed object (`_keywords`/`_people`) for the content profile, and merges everything via `mergeCandidates`. Returns ONLY the collaborative pool; Discover and cold-start filler are merged in by their own sections.

```js
// Cap the basket to the strongest MAX_SEEDS by weight to bound fan-out.
function topSeeds(basketEnriched) {
  return [...basketEnriched]
    .map((m, i) => ({ m, w: typeof m._seedWeight === 'number' ? m._seedWeight : (basketEnriched.length - i) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, MAX_SEEDS)
    .map((x) => x.m);
}

// Normalize the keywords/credits sub-responses of an appendDetail payload into the
// { id, name } shapes buildTagVector/buildTasteProfile expect (movie keywords live under
// .keywords.keywords; tv under .keywords.results; credits.cast + the Director).
function enrichmentFromAppend(json) {
  const kwList = json?.keywords?.keywords || json?.keywords?.results || [];
  const keywords = kwList.slice(0, 12).map((k) => ({ id: k.id, name: k.name }));
  const cast = (json?.credits?.cast || []).slice(0, 5).map((c) => ({ id: c.id, name: c.name }));
  const director = (json?.credits?.crew || []).find((c) => c.job === 'Director');
  const people = director ? [...cast, { id: director.id, name: director.name }] : cast;
  return { keywords, people };
}

// Per-seed collaborative candidate generation (OWNER). For each (capped) basket seed,
// one appendDetail call yields its recommendations + similar (→ tagged candidates via
// extractSeedCandidates) AND its keywords/credits (→ attached to the seed in place for
// the content profile). Returns the merged, deduped collaborative candidate pool.
// Discover (discoverCandidates) and cold-start filler (fillerCandidates) are merged into
// the _pipeline candidate set by their own sections via targeted edits, not here.
async function generateCandidates(basketEnriched) {
  const seeds = topSeeds(basketEnriched);
  const tagged = [];
  const BATCH = 6;
  for (let i = 0; i < seeds.length; i += BATCH) {
    const slice = seeds.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((seed) => {
        const type = seed.media_type === 'tv' ? 'tv' : 'movie';
        return fetchJson(ENDPOINTS.appendDetail(type, seed.id))
          .then((json) => ({ seed, json }))
          .catch(() => null);
      })
    );
    for (const r of results) {
      if (!r) continue;
      const { keywords, people } = enrichmentFromAppend(r.json);
      r.seed._keywords = keywords;   // attach the seed's own facets in place
      r.seed._people = people;
      tagged.push(...extractSeedCandidates(r.seed, r.json));
    }
    if (i + BATCH < seeds.length) await delay(300);
  }
  return mergeCandidates(tagged);
}
```

- [ ] **Step 2: Update the `_pipeline` call site to pass the enriched basket.** At `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` L495, `generateCandidates` previously took `profile`; it now takes `basketEnriched` (so it can both expand seeds and attach their facets in place). Change ONLY this line (do not touch the surrounding `_pipeline` body — the downvote-scoring section and the cold-start/`watchedIds`-hash section make their own targeted edits to other lines of `_pipeline`):

```js
  const candidates = await generateCandidates(profile);
```
to:
```js
  const candidates = await generateCandidates(basketEnriched);
```
(`basketEnriched` is already in scope, defined at L488. The Discover and cold-start sections will wrap this line to also merge their pools, e.g. `mergeCandidates([...await generateCandidates(basketEnriched), ...await discoverCandidates(profile, negProfile), ...await fillerCandidates(basket.length)])` — that composition is owned by those sections.)

- [ ] **Step 3: Smoke-check the module loads and the pure suite is unaffected.** The rewrite touches only network-orchestration internals; no pure export changed signature, so all unit tests (including the Task 3.1/3.2 additions) must still pass. A bad edit (syntax error, dangling reference) surfaces as an import-time throw here.

```
node --check recommendations.js && npm test
```
Expected: PASS — `node --check` prints nothing (exit 0); `npm test` all green, `# fail 0` (`recommendations.js` file: 37 pass; full suite: 46 pass — unchanged from Task 3.2, this task adds no tests).

- [ ] **Step 4: Commit.**

```
git add recommendations.js
git commit -m "feat(rec): per-seed appendDetail collaborative candidate generation"
```

Note for the integrating author: `generateCandidates` now depends on `ENDPOINTS.appendDetail` (added in the config.js section) and on `fetchJson`/`delay` routing through the queue (fetch-queue.js section); both are out of this section's scope but must land for the orchestration to run live. The legacy Discover logic formerly in `generateCandidates` is re-delivered as a standalone `discoverCandidates(profile, negProfile)` by the Discover section and merged into `_pipeline`'s candidate set there. rrf(...) deferred — weighted hybrid is the v1 ordering. The 'trending' row archetype and cold-start `fillerCandidates` are owned by the cold-start section, not here.

I now have the actual source. Key reconciliation facts confirmed: 31 existing tests (40 full suite), `DAY` exists in the test file, `PROFILE` is defined at L43, `scoreCandidate` body to keep as shim, `rankCandidates` at L328-335. I will own the canonical constants block, keep `scoreCandidate` as an untouched shim, add the `dislikeVector` opt to `scorePool`'s signature (inert here; ITEM 7 fills it), and NOT thread MMR into `rankCandidates` (that is ITEM 5's owned function — I must not rewrite it). Per the reconciliation rules `rankCandidates` is OWNED by ITEM 5, so I drop my Task 4.6 rewire of it and instead leave the wiring to the section that owns it, referring by name/phase.

### Task 9: Bayesian quality prior — `bayesianRating`, `qualityMultiplier`

The hybrid-scoring constants block (incl. `BAYES_PRIOR_COUNT`/`BAYES_GLOBAL_MEAN`) was already added once in **Task 6** (Phase 1). This task only adds `bayesianRating` + `qualityMultiplier`, which read those constants — it does NOT re-declare them.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add `bayesianRating` + `qualityMultiplier` after `ratingNudge` ~L56; the constants block is already present from Task 6)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (extend the import block ~L3-4; append tests after the `ratingNudge` test ~L25)

- [ ] **Step 1: Extend the import block.** In `recommendations.test.js`, add a new import line directly after the existing import at L4 (do NOT edit the existing two import lines — append a third so all of this section's new exports resolve in one place):
  ```js
  import {
    bayesianRating, qualityMultiplier, recencyMultiplier,
    buildTagVector, profileVector, computeIdf, applyIdf, cosineSim,
    collabScore, scorePool,
  } from './recommendations.js';
  ```

- [ ] **Step 2: Write the failing tests.** Append after the `ratingNudge` test (~L25):
  ```js
  test('bayesianRating shrinks a 2-vote 10.0 below a 5000-vote 8.0', () => {
    const hype = bayesianRating(10.0, 2);       // m=500, C=6.5 defaults
    const classic = bayesianRating(8.0, 5000);
    // 2-vote 10.0 is dragged toward 6.5; 5000-vote 8.0 barely moves.
    assert.ok(hype < classic, `expected shrunk hype(${hype}) < classic(${classic})`);
    assert.ok(hype > 6.5 && hype < 6.6, `2-vote 10.0 should sit just above C: ${hype}`);
    assert.ok(classic > 7.8 && classic <= 8.0, `5000-vote 8.0 should stay near R: ${classic}`);
  });

  test('bayesianRating with zero votes equals the global mean C', () => {
    assert.equal(bayesianRating(9.0, 0), 6.5);
    assert.equal(bayesianRating(0, 0), 6.5);
  });

  test('bayesianRating respects injected m and C', () => {
    // m=0 => no shrinkage => returns R exactly (v/(v+0)=1).
    assert.equal(bayesianRating(7.3, 100, 0, 6.5), 7.3);
    // v==m => exactly halfway between R and C.
    assert.equal(bayesianRating(8.0, 10, 10, 6.0), 7.0);
  });

  test('qualityMultiplier maps rating into ~[0.6,1.1] and is monotonic', () => {
    const great = qualityMultiplier(8.0, 5000);
    const meh = qualityMultiplier(4.0, 5000);
    assert.ok(great > meh, `great(${great}) must beat meh(${meh})`);
    assert.ok(great > 0.6 && great <= 1.1, `in range: ${great}`);
    assert.ok(meh >= 0.6 && meh < 1.0, `in range: ${meh}`);
    // A perfect, heavily-voted title approaches the 1.1 ceiling.
    assert.ok(qualityMultiplier(10, 100000) > 1.05);
    // A zero-vote title shrinks fully to C => 0.6 + 0.5*0.65 = 0.925.
    assert.ok(Math.abs(qualityMultiplier(10, 0) - 0.925) < 1e-9);
  });
  ```

- [ ] **Step 3: Run the tests — expect FAIL** (the new exports do not exist; the added `import` makes the whole file fail to load).
  ```
  node --test --test-name-pattern="bayesianRating|qualityMultiplier" recommendations.test.js
  ```
  Expected: FAIL — `SyntaxError: The requested module './recommendations.js' does not provide an export named 'bayesianRating'`.

- [ ] **Step 4: (No constants to add — already added in Task 6.)** The hybrid-scoring constants block (`W_COLLAB` … `COLD_START_FULL`, including `BAYES_PRIOR_COUNT` and `BAYES_GLOBAL_MEAN`) was declared once in **Task 6**. Do NOT re-declare it here — a second `const` block of the same names is a duplicate-declaration `SyntaxError` at import. `bayesianRating` below simply references those module-level constants.

- [ ] **Step 5: Implement `bayesianRating` and `qualityMultiplier`.** Add directly after `ratingNudge` (~L56):
  ```js
  // IMDb-style confidence-weighted rating: shrinks low-vote titles toward the
  // global mean C, leaving heavily-voted titles near their raw average.
  // WR = v/(v+m)*R + m/(v+m)*C. Returns C when there are votes-less but a prior;
  // returns R when there is neither prior nor votes (m=0,v=0 edge).
  export function bayesianRating(voteAverage, voteCount, m = BAYES_PRIOR_COUNT, C = BAYES_GLOBAL_MEAN) {
    const R = typeof voteAverage === 'number' && voteAverage > 0 ? voteAverage : 0;
    const v = typeof voteCount === 'number' && voteCount > 0 ? voteCount : 0;
    if (v + m === 0) return R;             // m=0,v=0 edge: no prior, no votes => R
    return (v / (v + m)) * R + (m / (v + m)) * C;
  }

  // Map the Bayesian rating (~0..10) to a gentle multiplier in ~[0.6,1.1].
  export function qualityMultiplier(voteAverage, voteCount) {
    return 0.6 + 0.5 * (bayesianRating(voteAverage, voteCount) / 10);
  }
  ```

- [ ] **Step 5b: Suppress unused-binding noise (sanity only).** Some constants in the block (e.g. `MMR_LAMBDA_TEASER`, `MAX_SEEDS`, `COLD_START_FULL`, `DOWNVOTE_GAMMA`) are not yet referenced until later sections land. `node --test` does NOT error on unused module-level `const`, so no shim is needed; confirm the module still loads:
  ```
  node -e "import('./recommendations.js').then(() => console.log('module loads')).catch((e)=>{console.error(e);process.exit(1)})"
  ```
  Expected: prints `module loads`.

- [ ] **Step 6: Run the tests — expect PASS.**
  ```
  node --test --test-name-pattern="bayesianRating|qualityMultiplier" recommendations.test.js
  ```
  Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 7: Commit.**
  ```
  git add recommendations.js recommendations.test.js && git commit -m "feat(rec): hybrid-scoring constants + bayesian quality prior"
  ```

### Task 10: Recency multiplier — `recencyMultiplier`

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add `recencyMultiplier` after `qualityMultiplier`)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append tests; import already added in the prior task of this section)

- [ ] **Step 1: Write the failing tests.** Append to `recommendations.test.js` (`DAY` and `NOW` already exist at the top of this file):
  ```js
  const YEAR_MS = 365 * DAY;

  test('recencyMultiplier is full (1.0) within RECENCY_FULL_YEARS', () => {
    const brandNew = new Date(NOW).toISOString().slice(0, 10);                 // today
    const oneYearAgo = new Date(NOW - 1 * YEAR_MS).toISOString().slice(0, 10);
    assert.equal(recencyMultiplier(brandNew, NOW), 1);
    assert.equal(recencyMultiplier(oneYearAgo, NOW), 1);
  });

  test('recencyMultiplier floors very old titles at RECENCY_FLOOR', () => {
    const ancient = '1975-05-25';
    assert.equal(recencyMultiplier(ancient, NOW), 0.85);
  });

  test('recencyMultiplier decays monotonically between full and floor', () => {
    const fiveYears = new Date(NOW - 5 * YEAR_MS).toISOString().slice(0, 10);
    const fifteenYears = new Date(NOW - 15 * YEAR_MS).toISOString().slice(0, 10);
    const a = recencyMultiplier(fiveYears, NOW);
    const b = recencyMultiplier(fifteenYears, NOW);
    assert.ok(a > b, `closer title (${a}) should beat older (${b})`);
    assert.ok(a < 1 && a > 0.85, `5y is mid-band: ${a}`);
    assert.ok(b >= 0.85 && b < a, `15y nearer floor: ${b}`);
  });

  test('recencyMultiplier returns full multiplier for missing/unknown date', () => {
    assert.equal(recencyMultiplier(undefined, NOW), 1);
    assert.equal(recencyMultiplier('', NOW), 1);
  });
  ```

- [ ] **Step 2: Run — expect FAIL.**
  ```
  node --test --test-name-pattern="recencyMultiplier" recommendations.test.js
  ```
  Expected: FAIL — assertions throw / `recencyMultiplier is not a function` (export missing).

- [ ] **Step 3: Implement `recencyMultiplier`.** Add after `qualityMultiplier`:
  ```js
  const RECENCY_DECAY_YEARS = 20; // age (yrs) past which we sit at the floor

  // Gentle release-date nudge. Full (1.0) within RECENCY_FULL_YEARS, then linearly
  // decays to RECENCY_FLOOR by RECENCY_DECAY_YEARS; missing/unknown date => 1.0.
  export function recencyMultiplier(releaseDate, now) {
    if (!releaseDate || typeof releaseDate !== 'string') return 1;
    const t = Date.parse(releaseDate);
    if (Number.isNaN(t)) return 1;
    const ageYears = Math.max(0, (now - t) / (365 * 24 * 60 * 60 * 1000));
    if (ageYears <= RECENCY_FULL_YEARS) return 1;
    const span = RECENCY_DECAY_YEARS - RECENCY_FULL_YEARS;
    const frac = Math.min(1, (ageYears - RECENCY_FULL_YEARS) / span);
    return 1 - (1 - RECENCY_FLOOR) * frac;
  }
  ```

- [ ] **Step 4: Run — expect PASS.**
  ```
  node --test --test-name-pattern="recencyMultiplier" recommendations.test.js
  ```
  Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Commit.**
  ```
  git add recommendations.js recommendations.test.js && git commit -m "feat(rec): bounded recency multiplier"
  ```

### Task 11: Tag vectors — `buildTagVector` + `profileVector`

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add after `recencyMultiplier`)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append tests; `PROFILE` already defined at ~L43)

- [ ] **Step 1: Write the failing tests.** Append to `recommendations.test.js`:
  ```js
  test('buildTagVector emits g: keys for genres, k:/p: only when present', () => {
    const bare = buildTagVector({ id: 1, genre_ids: [878, 28] });
    assert.deepEqual(bare, { 'g:878': 1, 'g:28': 1 });
    // No _keywords/_people on a plain candidate => no k:/p: terms.
    assert.ok(!Object.keys(bare).some((t) => t.startsWith('k:') || t.startsWith('p:')));
  });

  test('buildTagVector includes keyword/person terms on enriched items', () => {
    const v = buildTagVector({
      id: 2, genre_ids: [878],
      _keywords: [{ id: 9, name: 'time travel' }],
      _people: [{ id: 5, name: 'Nolan' }],
    });
    assert.equal(v['g:878'], 1);
    assert.equal(v['k:9'], 1);
    assert.equal(v['p:5'], 1);
  });

  test('profileVector maps profile weights to g:/k:/p: term keys', () => {
    const v = profileVector(PROFILE); // PROFILE defined at ~L43 of this file
    assert.equal(v['g:878'], 3);
    assert.equal(v['g:28'], 1);
    assert.equal(v['k:9'], 2);
    assert.equal(v['p:5'], 2);
  });

  test('profileVector drops non-positive genre weights', () => {
    const netProfile = {
      genres: { '878': 4, '27': -5 }, keywords: {}, people: {},
      mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
    };
    const v = profileVector(netProfile);
    assert.equal(v['g:878'], 4);
    assert.ok(!('g:27' in v), 'disliked genre must not enter the content vector');
  });
  ```

- [ ] **Step 2: Run — expect FAIL.**
  ```
  node --test --test-name-pattern="buildTagVector|profileVector" recommendations.test.js
  ```
  Expected: FAIL — missing exports / `TypeError`.

- [ ] **Step 3: Implement `buildTagVector` and `profileVector`.** Add after `recencyMultiplier`:
  ```js
  // Tag-vector for a candidate: genres always; keywords/people only when the item
  // carries enrichment (_keywords/_people). Presence-weighted (1 per term).
  export function buildTagVector(item) {
    const v = {};
    for (const g of item.genre_ids || []) v['g:' + g] = 1;
    for (const k of item._keywords || []) v['k:' + k.id] = 1;
    for (const p of item._people || []) v['p:' + p.id] = 1;
    return v;
  }

  // Tag-vector for the taste profile: genre/keyword/person weights -> g:/k:/p: keys.
  // Non-positive genre weights (net-negative after Rocchio) are excluded so they
  // never pull the content cosine upward.
  export function profileVector(profile) {
    const v = {};
    for (const [g, w] of Object.entries(profile.genres || {})) {
      if (w > 0) v['g:' + g] = w;
    }
    for (const [k, o] of Object.entries(profile.keywords || {})) {
      if (o.weight > 0) v['k:' + k] = o.weight;
    }
    for (const [p, o] of Object.entries(profile.people || {})) {
      if (o.weight > 0) v['p:' + p] = o.weight;
    }
    return v;
  }
  ```

- [ ] **Step 4: Run — expect PASS.**
  ```
  node --test --test-name-pattern="buildTagVector|profileVector" recommendations.test.js
  ```
  Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Commit.**
  ```
  git add recommendations.js recommendations.test.js && git commit -m "feat(rec): tag-vector + profile-vector builders"
  ```

### Task 12: TF-IDF — `computeIdf` + `applyIdf` + `cosineSim`

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add after `profileVector`)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append tests)

- [ ] **Step 1: Write the failing tests.** Append to `recommendations.test.js`:
  ```js
  test('computeIdf: idf = log(N/(1+df)); rare terms outweigh common ones', () => {
    // 4 vectors. g:878 in all 4 (common), g:28 in 1 (rare).
    const vecs = [
      { 'g:878': 1, 'g:28': 1 },
      { 'g:878': 1 },
      { 'g:878': 1 },
      { 'g:878': 1 },
    ];
    const idf = computeIdf(vecs);
    assert.ok(Math.abs(idf['g:878'] - Math.log(4 / (1 + 4))) < 1e-9);
    assert.ok(Math.abs(idf['g:28'] - Math.log(4 / (1 + 1))) < 1e-9);
    assert.ok(idf['g:28'] > idf['g:878'], 'rarer term must carry more idf');
  });

  test('applyIdf scales each term weight by its idf', () => {
    const idf = { 'g:878': 2, 'k:9': 0.5 };
    const out = applyIdf({ 'g:878': 3, 'k:9': 4 }, idf);
    assert.equal(out['g:878'], 6);
    assert.equal(out['k:9'], 2);
  });

  test('applyIdf treats terms absent from the idf map as idf 0', () => {
    const out = applyIdf({ 'g:999': 5 }, {});
    assert.equal(out['g:999'], 0);
  });

  test('cosineSim of identical vectors is 1, orthogonal is 0', () => {
    const a = { 'g:878': 3, 'k:9': 1 };
    assert.ok(Math.abs(cosineSim(a, a) - 1) < 1e-12);
    assert.equal(cosineSim({ 'g:878': 1 }, { 'g:28': 1 }), 0);
  });

  test('cosineSim returns 0 when either vector is empty', () => {
    assert.equal(cosineSim({}, { 'g:1': 1 }), 0);
    assert.equal(cosineSim({ 'g:1': 1 }, {}), 0);
  });

  test('cosineSim partial overlap sits strictly between 0 and 1', () => {
    const s = cosineSim({ 'g:1': 1, 'g:2': 1 }, { 'g:1': 1, 'g:3': 1 });
    assert.ok(Math.abs(s - 0.5) < 1e-12, `one shared of two each => 0.5, got ${s}`);
  });
  ```

- [ ] **Step 2: Run — expect FAIL.**
  ```
  node --test --test-name-pattern="computeIdf|applyIdf|cosineSim" recommendations.test.js
  ```
  Expected: FAIL — missing exports.

- [ ] **Step 3: Implement `computeIdf`, `applyIdf`, `cosineSim`.** Add after `profileVector`:
  ```js
  // Inverse document frequency over a set of tag-vectors: idf = log(N/(1+df)).
  export function computeIdf(tagVectors) {
    const N = tagVectors.length;
    const df = {};
    for (const v of tagVectors) {
      for (const term of Object.keys(v)) df[term] = (df[term] || 0) + 1;
    }
    const idf = {};
    for (const [term, d] of Object.entries(df)) idf[term] = Math.log(N / (1 + d));
    return idf;
  }

  // Scale a tag-vector by idf weights (terms missing from idf => 0).
  export function applyIdf(tagVector, idf) {
    const out = {};
    for (const [term, w] of Object.entries(tagVector)) out[term] = w * (idf[term] || 0);
    return out;
  }

  // Cosine similarity in [0,1] over sparse tag-vectors (assumes non-negative weights).
  export function cosineSim(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const w of Object.values(a)) na += w * w;
    for (const w of Object.values(b)) nb += w * w;
    if (na === 0 || nb === 0) return 0;
    const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
    for (const [term, w] of Object.entries(small)) {
      if (term in large) dot += w * large[term];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  ```

- [ ] **Step 4: Run — expect PASS.**
  ```
  node --test --test-name-pattern="computeIdf|applyIdf|cosineSim" recommendations.test.js
  ```
  Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Commit.**
  ```
  git add recommendations.js recommendations.test.js && git commit -m "feat(rec): tf-idf weighting + cosine similarity"
  ```

### Task 13: Collaborative score — `collabScore`

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add after `cosineSim`)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append tests)

- [ ] **Step 1: Write the failing tests.** Append to `recommendations.test.js`:
  ```js
  test('collabScore sums rec/similar provenance weighted by source and rank', () => {
    const c = { id: 1, _seeds: [
      { source: 'rec', type: 'title', id: 10, rank: 0, weight: 1 },     // 1.0*1/(1+0)=1
      { source: 'similar', type: 'title', id: 11, rank: 1, weight: 1 }, // 0.5*1/(1+1)=0.25
    ] };
    assert.ok(Math.abs(collabScore(c) - 1.25) < 1e-9, `got ${collabScore(c)}`);
  });

  test('collabScore: rec outranks similar at the same rank and weight', () => {
    const rec = { id: 1, _seeds: [{ source: 'rec', type: 'title', id: 10, rank: 0, weight: 1 }] };
    const sim = { id: 2, _seeds: [{ source: 'similar', type: 'title', id: 10, rank: 0, weight: 1 }] };
    assert.ok(collabScore(rec) > collabScore(sim));
    assert.equal(collabScore(rec), 1.0);
    assert.equal(collabScore(sim), 0.5);
  });

  test('collabScore ignores non-collaborative (discover/trending) seeds', () => {
    const c = { id: 1, _seeds: [
      { source: 'discover-genre', type: 'genre', id: 28, rank: 0, weight: 5 },
      { source: 'trending', type: 'title', id: 99, rank: 0, weight: 5 },
    ] };
    assert.equal(collabScore(c), 0);
  });

  test('collabScore is 0 for a candidate with no seeds', () => {
    assert.equal(collabScore({ id: 1, _seeds: [] }), 0);
    assert.equal(collabScore({ id: 2 }), 0);
  });

  test('collabScore: more contributing seeds accumulate higher', () => {
    const one = { id: 1, _seeds: [{ source: 'rec', type: 'title', id: 10, rank: 0, weight: 1 }] };
    const two = { id: 2, _seeds: [
      { source: 'rec', type: 'title', id: 10, rank: 0, weight: 1 },
      { source: 'rec', type: 'title', id: 11, rank: 0, weight: 1 },
    ] };
    assert.ok(collabScore(two) > collabScore(one));
  });
  ```

- [ ] **Step 2: Run — expect FAIL.**
  ```
  node --test --test-name-pattern="collabScore" recommendations.test.js
  ```
  Expected: FAIL — missing export.

- [ ] **Step 3: Implement `collabScore`.** Add after `cosineSim`. Uses `REC_SOURCE_WEIGHT`/`SIMILAR_SOURCE_WEIGHT` from the canonical constants block (added earlier in this section):
  ```js
  // Co-recommendation tally: how strongly the basket's seeds surfaced this candidate
  // via /recommendations and /similar, weighted by source (rec > similar) and seed
  // weight, discounted by the seed-list rank. Non-collaborative seeds contribute 0.
  export function collabScore(candidate) {
    let s = 0;
    for (const seed of candidate._seeds || []) {
      let sw;
      if (seed.source === 'rec') sw = REC_SOURCE_WEIGHT;
      else if (seed.source === 'similar') sw = SIMILAR_SOURCE_WEIGHT;
      else continue;
      const rank = typeof seed.rank === 'number' ? seed.rank : 0;
      const weight = typeof seed.weight === 'number' ? seed.weight : 1;
      s += (sw * weight) / (1 + rank);
    }
    return s;
  }
  ```

- [ ] **Step 4: Run — expect PASS.**
  ```
  node --test --test-name-pattern="collabScore" recommendations.test.js
  ```
  Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Commit.**
  ```
  git add recommendations.js recommendations.test.js && git commit -m "feat(rec): collaborative co-recommendation score"
  ```

### Task 14: Hybrid pool scorer — `scorePool`

This section OWNS `scorePool`. Its signature carries the `dislikeVector` opt up front so the downvote-penalty section can add a bounded multiplicative term inside this function later WITHOUT changing the signature; when absent, `dislikeVector` is inert. This section does NOT touch `rankCandidates` (owned elsewhere) nor `scoreCandidate` (kept as an untouched compatibility shim — see the explicit decision below).

**Compatibility decision (explicit):** `scoreCandidate(candidate, profile)` at L192-203 stays EXACTLY as-is. It remains a thin compatibility shim used only by the four existing `scoreCandidate` tests (L64, L156, L311). Its body and signature do NOT change, so those tests pass untouched. I am NOT adding a `scorePool`-based shim into `scoreCandidate`. `rankCandidates` is owned by the ranking/MMR section (rewired there to `scorePool -> exclude watched -> mmrRerank -> slice`); this section leaves `rankCandidates` (L328-335) alone so its existing test at L101-111 keeps passing against the current body until that owner rewires it.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add `scorePool` after `collabScore`; do NOT modify `scoreCandidate` L192-203 or `rankCandidates` L328-335)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append tests; existing `scoreCandidate`/`rankCandidates` tests unchanged)

- [ ] **Step 1: Write the failing tests.** Append to `recommendations.test.js`:
  ```js
  test('scorePool returns Scored items sorted desc with parts and reasons', () => {
    const profile = {
      genres: { '878': 3 }, keywords: { '9': { name: 'tt', weight: 2 } }, people: {},
      mediaTypeBias: { movie: 1, tv: 0 },
      topTitles: [{ id: 1, title: 'Inception', weight: 3, genreIds: [878], keywordIds: [9], peopleIds: [], media_type: 'movie' }],
    };
    const candidates = [
      { id: 100, title: 'Strong', media_type: 'movie', genre_ids: [878], vote_average: 8, vote_count: 5000,
        popularity: 50, release_date: new Date(NOW).toISOString().slice(0, 10),
        _keywords: [{ id: 9, name: 'tt' }], _seeds: [{ source: 'rec', type: 'title', id: 1, rank: 0, weight: 1 }] },
      { id: 200, title: 'Weak', media_type: 'movie', genre_ids: [12], vote_average: 5, vote_count: 10,
        popularity: 1, release_date: '1980-01-01', _seeds: [{ source: 'discover-genre', type: 'genre', id: 12, rank: 0, weight: 1 }] },
    ];
    const out = scorePool(candidates, { profile, now: NOW });
    assert.equal(out.length, 2);
    assert.equal(out[0].movie.id, 100, 'strong collaborative + content + quality wins');
    assert.ok(out[0].score >= out[1].score, 'sorted descending');
    for (const term of ['collab', 'content', 'quality', 'recency']) {
      assert.ok(typeof out[0].parts[term] === 'number', `parts.${term} present`);
    }
    assert.ok(Array.isArray(out[0].reasons) && out[0].reasons.length >= 1, 'reasons attached');
  });

  test('scorePool: a high-vote great title outranks a low-vote obscure one at equal collab', () => {
    const profile = {
      genres: { '878': 1 }, keywords: {}, people: {},
      mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
    };
    const rd = new Date(NOW).toISOString().slice(0, 10); // identical recency
    // Identical collab seed (same source/rank/weight) and identical genre vector;
    // they differ ONLY in quality (vote_average + vote_count).
    const great = { id: 100, media_type: 'movie', genre_ids: [878], vote_average: 8.2, vote_count: 8000,
      popularity: 10, release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 1, rank: 0, weight: 1 }] };
    const obscure = { id: 200, media_type: 'movie', genre_ids: [878], vote_average: 9.9, vote_count: 6,
      popularity: 10, release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 1, rank: 0, weight: 1 }] };
    const out = scorePool([great, obscure], { profile, now: NOW });
    assert.equal(out[0].movie.id, 100, 'shrunk obscure 9.9/6 must fall below the well-voted 8.2/8000');
  });

  test('scorePool normalizes collab via min-max across the pool', () => {
    const profile = { genres: {}, keywords: {}, people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [] };
    const rd = new Date(NOW).toISOString().slice(0, 10);
    const hi = { id: 1, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000, popularity: 5,
      release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 9, rank: 0, weight: 1 }] };       // collab 1.0
    const lo = { id: 2, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000, popularity: 5,
      release_date: rd, _seeds: [{ source: 'similar', type: 'title', id: 9, rank: 3, weight: 1 }] };    // collab 0.125
    const out = scorePool([hi, lo], { profile, now: NOW });
    const hiScored = out.find((o) => o.movie.id === 1);
    const loScored = out.find((o) => o.movie.id === 2);
    // Min-max over {1.0, 0.125} => hi.collab===1, lo.collab===0.
    assert.equal(hiScored.parts.collab, 1);
    assert.equal(loScored.parts.collab, 0);
  });

  test('scorePool: content cosine rewards profile overlap when collab ties at 0', () => {
    const profile = {
      genres: { '878': 5 }, keywords: {}, people: {},
      mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
    };
    const rd = new Date(NOW).toISOString().slice(0, 10);
    // Both discover-sourced => collab 0 for both; matchGenre overlaps the profile, offGenre does not.
    const matchGenre = { id: 1, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000,
      popularity: 5, release_date: rd, _seeds: [{ source: 'discover-genre', type: 'genre', id: 878, rank: 0, weight: 1 }] };
    const offGenre = { id: 2, media_type: 'movie', genre_ids: [99], vote_average: 7, vote_count: 1000,
      popularity: 5, release_date: rd, _seeds: [{ source: 'discover-genre', type: 'genre', id: 99, rank: 0, weight: 1 }] };
    const out = scorePool([matchGenre, offGenre], { profile, now: NOW });
    assert.equal(out[0].movie.id, 1, 'genre-matching candidate wins on content');
    assert.ok(out[0].parts.content > out.find((o) => o.movie.id === 2).parts.content);
  });

  test('scorePool honors injected weights (content-only ignores collab)', () => {
    const profile = { genres: { '878': 5 }, keywords: {}, people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [] };
    const rd = new Date(NOW).toISOString().slice(0, 10);
    // collabHi has strong collab but NO content overlap; contentHi has no collab but full content overlap.
    const collabHi = { id: 1, media_type: 'movie', genre_ids: [99], vote_average: 7, vote_count: 1000, popularity: 5,
      release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 9, rank: 0, weight: 1 }] };
    const contentHi = { id: 2, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000, popularity: 5,
      release_date: rd, _seeds: [{ source: 'discover-genre', type: 'genre', id: 878, rank: 0, weight: 1 }] };
    const out = scorePool([collabHi, contentHi], { profile, now: NOW, weights: { collab: 0, content: 1 } });
    assert.equal(out[0].movie.id, 2, 'with collab weight 0, content overlap must decide');
  });

  test('scorePool: absent dislikeVector is inert (no penalty applied)', () => {
    const profile = { genres: { '878': 5 }, keywords: {}, people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [] };
    const rd = new Date(NOW).toISOString().slice(0, 10);
    const c = { id: 1, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000, popularity: 5,
      release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 9, rank: 0, weight: 1 }] };
    const withOpt = scorePool([c], { profile, now: NOW, dislikeVector: undefined })[0].score;
    const without = scorePool([c], { profile, now: NOW })[0].score;
    assert.equal(withOpt, without, 'dislikeVector:undefined must not change the score');
  });
  ```

- [ ] **Step 2: Run — expect FAIL.**
  ```
  node --test --test-name-pattern="scorePool" recommendations.test.js
  ```
  Expected: FAIL — `'scorePool' is not a function` / missing export.

- [ ] **Step 3: Implement `scorePool`.** Add after `collabScore`. The signature includes `dislikeVector` (per the shared contract) so the downvote-penalty section can add its bounded multiplicative term here later; it is currently unused/inert:
  ```js
  // Hybrid pool scorer (pure, zero network). Builds idf over the pool's tag-vectors,
  // idf-weights both the profile vector and each candidate vector, then:
  //   collabN  = min-max of collabScore across the pool
  //   contentN = cosine(idf(profileVector), idf(candidateVector))   [0,1]
  //   score    = (Wc*collabN + Wt*contentN) * qualityMultiplier * recencyMultiplier
  // `dislikeVector` is part of the signature for the downvote-penalty step (added
  // later); when absent it has no effect. Returns Scored[] sorted descending,
  // each with parts + reasons.
  export function scorePool(candidates, { profile, now, weights = { collab: W_COLLAB, content: W_CONTENT }, dislikeVector } = {}) {
    void dislikeVector; // reserved: downvote-penalty step folds a bounded term in here
    const tagVectors = candidates.map(buildTagVector);
    const idf = computeIdf(tagVectors);
    const profVec = applyIdf(profileVector(profile), idf);

    const collabRaw = candidates.map(collabScore);
    const cMin = collabRaw.length ? Math.min(...collabRaw) : 0;
    const cMax = collabRaw.length ? Math.max(...collabRaw) : 0;
    const cRange = cMax - cMin;

    const scored = candidates.map((c, i) => {
      const collabN = cRange > 0 ? (collabRaw[i] - cMin) / cRange : 0;
      const contentN = cosineSim(profVec, applyIdf(tagVectors[i], idf));
      const quality = qualityMultiplier(c.vote_average, c.vote_count);
      const recency = recencyMultiplier(c.release_date || c.first_air_date, now);
      const score = (weights.collab * collabN + weights.content * contentN) * quality * recency;
      return {
        movie: c,
        score,
        parts: { collab: collabN, content: contentN, quality, recency },
        reasons: generateReasons(c, profile),
      };
    });
    return scored.sort((a, b) => b.score - a.score);
  }
  ```

- [ ] **Step 4: Run the new tests — expect PASS.**
  ```
  node --test --test-name-pattern="scorePool" recommendations.test.js
  ```
  Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Run the FULL suite — confirm no regressions.**
  ```
  npm test
  ```
  Expected baseline before this section: 31 tests in `recommendations.test.js`, 40 across the full suite (incl. `watch-timer.test.js`=9). This section adds 4 (Task 4.1) + 4 (4.2) + 4 (4.3) + 6 (4.4) + 5 (4.5) + 6 (4.6) = 29 new tests in `recommendations.test.js`, taking it to 60 and the full suite to 69. Expected: PASS — 0 failures. In particular the unchanged shims `scoreCandidate` (`scoreCandidate rewards seed weight...`, `...more distinct watched titles`, `...net-negative genre`) and `rankCandidates drops already-watched and sorts by score` all still pass untouched.

- [ ] **Step 6: Commit.**
  ```
  git add recommendations.js recommendations.test.js && git commit -m "feat(rec): hybrid scorePool (collab+content+quality+recency)"
  ```

Note for the orchestration/ranking sections: `scorePool` (added in this phase) is consumed by `rankCandidates` (owned by the ranking section, rewired to `scorePool -> exclude watched -> mmrRerank -> slice`) and by the engine `_pipeline`. The downvote penalty is folded into `scorePool` via its `dislikeVector` opt (added later by the downvote section) — never as a `rankCandidates` 5th arg. `rrf(...)` is deferred — weighted hybrid is the v1 ordering; the home-teaser MMR lambda (`MMR_LAMBDA_TEASER`) is applied by the teaser path in the ranking/orchestration section, not here.

Confirmed: 31 real tests (the 32nd `test(` match is `.test(reasons[0])` inside an assert at line 97). The existing rankCandidates test is at L101-111. Now I have everything needed to finalize the section with correct references and reconciliation applied.

### Task 15: itemSim (genre Jaccard + provenance Jaccard, identical id ⇒ 1)

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add `itemSim` export in the pure-helpers region, placed after `scorePool` which is added earlier in this phase. Do NOT declare `PER_SEED_CAP`/`NEAR_DUP_SIM` — the constants block is owned and added in full earlier in this phase; this task only USES them.)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append new tests)

- [ ] **Step 1: Write failing test for `itemSim`.**

  Append to `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js`:

  ```js
  import { itemSim } from './recommendations.js';

  test('itemSim: identical id short-circuits to 1', () => {
    const a = { id: 5, genre_ids: [878], _seeds: [{ source: 'rec', type: 'title', id: 1, seedId: 1, rank: 0, weight: 1 }] };
    const b = { id: 5, genre_ids: [28], _seeds: [{ source: 'rec', type: 'title', id: 2, seedId: 2, rank: 0, weight: 1 }] };
    assert.equal(itemSim(a, b), 1);
  });

  test('itemSim: 0.6*genreJaccard + 0.4*provenanceJaccard', () => {
    // genres: A={878,28}, B={878} => |∩|=1,|∪|=2 => 0.5
    // provenance seed-ids: A={11,22}, B={22} => |∩|=1,|∪|=2 => 0.5
    const a = { id: 1, genre_ids: [878, 28], _seeds: [
      { source: 'rec', type: 'title', id: 11, seedId: 11, rank: 0, weight: 1 },
      { source: 'similar', type: 'title', id: 22, seedId: 22, rank: 0, weight: 1 },
    ] };
    const b = { id: 2, genre_ids: [878], _seeds: [
      { source: 'rec', type: 'title', id: 22, seedId: 22, rank: 0, weight: 1 },
    ] };
    assert.ok(Math.abs(itemSim(a, b) - (0.6 * 0.5 + 0.4 * 0.5)) < 1e-9);
  });

  test('itemSim: disjoint genres and provenance => 0', () => {
    const a = { id: 1, genre_ids: [878], _seeds: [{ source: 'rec', type: 'title', id: 11, seedId: 11, rank: 0, weight: 1 }] };
    const b = { id: 2, genre_ids: [28], _seeds: [{ source: 'rec', type: 'title', id: 22, seedId: 22, rank: 0, weight: 1 }] };
    assert.equal(itemSim(a, b), 0);
  });

  test('itemSim: discover/trending provenance is ignored (only rec/similar count)', () => {
    // Two discover candidates share the same discover-genre facet id but have NO rec/similar
    // provenance => provenance Jaccard is empty∪empty=0; only genre overlap drives similarity.
    // genres: A={878}, B={878} => genreJ=1 => itemSim = 0.6*1 + 0.4*0 = 0.6.
    const a = { id: 1, genre_ids: [878], _seeds: [{ source: 'discover-genre', type: 'genre', id: 878, name: 'Sci-Fi', rank: 0, weight: 1 }] };
    const b = { id: 2, genre_ids: [878], _seeds: [{ source: 'discover-genre', type: 'genre', id: 878, name: 'Sci-Fi', rank: 1, weight: 1 }] };
    assert.ok(Math.abs(itemSim(a, b) - 0.6) < 1e-9);
  });

  test('itemSim: no genres and no provenance on either side => 0 (no NaN)', () => {
    const a = { id: 1, genre_ids: [], _seeds: [] };
    const b = { id: 2, genre_ids: [], _seeds: [] };
    assert.equal(itemSim(a, b), 0);
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL** (`itemSim` is not exported yet).

  ```
  node --test --test-name-pattern="itemSim" recommendations.test.js
  ```
  Expected: FAIL — `SyntaxError: The requested module './recommendations.js' does not provide an export named 'itemSim'` (all 5 itemSim tests error/fail).

- [ ] **Step 3: Implement `itemSim` (and its two internal helpers).**

  Do NOT add any constants here — `PER_SEED_CAP` and `NEAR_DUP_SIM` already exist in the constants block added earlier in this phase. Add `itemSim` in the pure-helpers region, directly after `scorePool` (added earlier in this phase):

  ```js
  // Jaccard of two id collections; empty∪empty => 0 (never NaN).
  function jaccard(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 0;
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter += 1;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  // The basket-seed-title ids that produced a candidate (rec/similar provenance only),
  // used for the provenance-overlap term of itemSim and the per-seed cap in mmrRerank.
  // Discover/trending/toprated seeds carry facet/title ids under non-title sources and are
  // intentionally excluded so they never collapse against unrelated rec/similar provenance.
  function seedTitleIds(candidate) {
    const ids = new Set();
    for (const s of candidate._seeds || []) {
      if (s.source === 'rec' || s.source === 'similar') {
        ids.add(Number(s.seedId != null ? s.seedId : s.id));
      }
    }
    return ids;
  }

  // Pairwise similarity for the diversity re-rank: 0.6*genreJaccard + 0.4*provenanceJaccard.
  // Identical id => 1 (the same title can't add diversity).
  export function itemSim(a, b) {
    if (a.id === b.id) return 1;
    const ga = new Set((a.genre_ids || []).map(Number));
    const gb = new Set((b.genre_ids || []).map(Number));
    const genreJ = jaccard(ga, gb);
    const provJ = jaccard(seedTitleIds(a), seedTitleIds(b));
    return 0.6 * genreJ + 0.4 * provJ;
  }
  ```

  Note: provenance overlap is intentionally narrowed to rec/similar title-seed ids (the design's broader "shared keyword/person provenance overlap" is deferred — title-seed overlap is the v1 provenance term).

- [ ] **Step 4: Run the test — expect PASS.**

  ```
  node --test --test-name-pattern="itemSim" recommendations.test.js
  ```
  Expected: PASS — 5 tests pass, 0 fail.

- [ ] **Step 5: Commit.**

  ```
  git commit -am "feat(rec): itemSim genre + provenance Jaccard"
  ```

### Task 16: mmrRerank — near-dup collapse + greedy MMR + per-seed cap

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add `mmrRerank` export; place directly after `itemSim`)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append new tests; include a local ILD helper in the test file to assert diversity rises)

- [ ] **Step 1: Write failing tests for `mmrRerank`.**

  Append to `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js`:

  ```js
  import { mmrRerank } from './recommendations.js';

  // Intra-list diversity = mean pairwise (1 - itemSim) over the output list.
  function ild(list, simFn) {
    const items = list.map((s) => s.movie);
    let sum = 0, pairs = 0;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        sum += 1 - simFn(items[i], items[j]);
        pairs += 1;
      }
    }
    return pairs === 0 ? 0 : sum / pairs;
  }

  function sc(id, score, { genres = [], seeds = [] } = {}) {
    return { movie: { id, genre_ids: genres, _seeds: seeds }, score, parts: {}, reasons: [] };
  }

  test('mmrRerank: near-duplicate high-score items collapse to one', () => {
    // Two near-dupes: identical genres + identical provenance => itemSim = 1 > NEAR_DUP_SIM.
    const seedsA = [{ source: 'rec', type: 'title', id: 1, seedId: 1, rank: 0, weight: 1 }];
    const scored = [
      sc(10, 1.0, { genres: [878, 28], seeds: seedsA }),
      sc(11, 0.99, { genres: [878, 28], seeds: seedsA }),   // near-dup of 10
      sc(20, 0.8, { genres: [18], seeds: [{ source: 'rec', type: 'title', id: 2, seedId: 2, rank: 0, weight: 1 }] }),
    ];
    const out = mmrRerank(scored, { lambda: 0.8, limit: 10, simFn: itemSim });
    const ids = out.map((r) => r.movie.id);
    assert.ok(ids.includes(10), 'best representative survives');
    assert.ok(!ids.includes(11), 'near-duplicate is collapsed away');
    assert.ok(ids.includes(20));
  });

  test('mmrRerank: no seedId exceeds PER_SEED_CAP in the output', () => {
    // 6 candidates all from seedId 7; cap is 3.
    const fromSeed7 = (id, score) => sc(id, score, {
      genres: [878], seeds: [{ source: 'rec', type: 'title', id: 7, seedId: 7, rank: 0, weight: 1 }],
    });
    const scored = [
      fromSeed7(1, 1.0), fromSeed7(2, 0.95), fromSeed7(3, 0.9),
      fromSeed7(4, 0.85), fromSeed7(5, 0.8), fromSeed7(6, 0.75),
    ];
    const out = mmrRerank(scored, { lambda: 0.8, perSeedCap: 3, limit: 10, simFn: itemSim });
    const fromSeed = out.filter((r) => (r.movie._seeds || []).some((s) => s.seedId === 7)).length;
    assert.ok(fromSeed <= 3, `expected <= PER_SEED_CAP from seed 7, got ${fromSeed}`);
  });

  test('mmrRerank: lambda=1 reproduces pure-relevance order', () => {
    // Distinct ids/genres so no near-dup collapse; only ordering is tested.
    const scored = [
      sc(1, 0.9, { genres: [1] }),
      sc(2, 0.7, { genres: [2] }),
      sc(3, 0.5, { genres: [3] }),
    ];
    const out = mmrRerank(scored, { lambda: 1, limit: 10, simFn: itemSim });
    assert.deepEqual(out.map((r) => r.movie.id), [1, 2, 3]);
  });

  test('mmrRerank: discover candidates (no rec/similar seed) are uncapped', () => {
    // 6 discover-genre candidates with no rec/similar provenance: PER_SEED_CAP must NOT apply
    // to them (seedTitleIds empty), so all 6 survive (distinct genres => no near-dup collapse).
    const disc = (id, score, g) => sc(id, score, {
      genres: [g], seeds: [{ source: 'discover-genre', type: 'genre', id: 99, name: 'X', rank: 0, weight: 1 }],
    });
    const scored = [disc(1, 1.0, 1), disc(2, 0.9, 2), disc(3, 0.8, 3), disc(4, 0.7, 4), disc(5, 0.6, 5), disc(6, 0.5, 6)];
    const out = mmrRerank(scored, { lambda: 0.8, perSeedCap: 3, limit: 10, simFn: itemSim });
    assert.equal(out.length, 6, 'discover candidates are not seed-capped');
  });

  test('mmrRerank: lower lambda raises intra-list diversity', () => {
    // A cluster of three similar high-score sci-fi items + two distinct lower-score items.
    // High lambda keeps the similar cluster up top (low ILD); low lambda interleaves the
    // diverse items earlier (higher ILD). Distinct seedIds so the per-seed cap never bites.
    const sciSeed = (id, score) => sc(id, score, {
      genres: [878, 28], seeds: [{ source: 'rec', type: 'title', id: id, seedId: id, rank: 0, weight: 1 }],
    });
    const build = () => [
      sciSeed(1, 1.0), sciSeed(2, 0.95), sciSeed(3, 0.9),
      sc(4, 0.6, { genres: [18], seeds: [{ source: 'rec', type: 'title', id: 4, seedId: 4, rank: 0, weight: 1 }] }),
      sc(5, 0.55, { genres: [99], seeds: [{ source: 'rec', type: 'title', id: 5, seedId: 5, rank: 0, weight: 1 }] }),
    ];
    const hi = mmrRerank(build(), { lambda: 0.95, limit: 3, simFn: itemSim });
    const lo = mmrRerank(build(), { lambda: 0.3, limit: 3, simFn: itemSim });
    assert.ok(ild(lo, itemSim) > ild(hi, itemSim),
      `lower lambda should raise ILD: lo=${ild(lo, itemSim)} hi=${ild(hi, itemSim)}`);
  });
  ```

- [ ] **Step 2: Run the tests — expect FAIL** (`mmrRerank` not exported).

  ```
  node --test --test-name-pattern="mmrRerank" recommendations.test.js
  ```
  Expected: FAIL — `does not provide an export named 'mmrRerank'` (all 5 mmrRerank tests error).

- [ ] **Step 3: Implement `mmrRerank`.**

  Add directly after `itemSim` in `recommendations.js`. Uses `PER_SEED_CAP` and `NEAR_DUP_SIM` from the constants block (added earlier in this phase) and the module-internal `seedTitleIds` helper from `itemSim`:

  ```js
  // Diversity re-rank. Three stages, all pure:
  //   (1) near-duplicate / franchise collapse: drop any item whose simFn vs an already-kept,
  //       higher-scored item exceeds NEAR_DUP_SIM (best representative survives).
  //   (2) greedy Maximal Marginal Relevance: pick argmax(lambda*rel - (1-lambda)*maxSim-to-chosen).
  //   (3) per-seed cap: never let more than perSeedCap chosen items share a single rec/similar seedId.
  // `scored` is a Scored[] (scorePool, added earlier in this phase, sorts it desc by score). `rel`
  // is read from `score`, min-max normalized to [0,1] across the collapsed survivors so the lambda
  // trade-off is scale-independent. Items with no rec/similar provenance (discover/cold-start) are
  // not seed-capped (empty seedTitleIds).
  export function mmrRerank(scored, { lambda, perSeedCap = PER_SEED_CAP, limit, simFn = itemSim } = {}) {
    const sorted = [...scored].sort((a, b) => b.score - a.score);

    // (1) Near-duplicate collapse against already-kept (higher-scored) survivors.
    const survivors = [];
    for (const cand of sorted) {
      const dup = survivors.some((k) => simFn(cand.movie, k.movie) > NEAR_DUP_SIM);
      if (!dup) survivors.push(cand);
    }
    if (survivors.length === 0) return [];

    // Normalize relevance to [0,1] across survivors (min-max; flat pool => all 1).
    const scores = survivors.map((s) => s.score);
    const lo = Math.min(...scores);
    const hi = Math.max(...scores);
    const span = hi - lo;
    const rel = (s) => (span === 0 ? 1 : (s.score - lo) / span);

    const cap = Number.isFinite(limit) ? Math.min(limit, survivors.length) : survivors.length;
    const seedCount = new Map();
    const seedsOf = (s) => seedTitleIds(s.movie);
    const underCap = (s) => {
      const ids = seedsOf(s);
      if (ids.size === 0) return true; // no rec/similar provenance => uncapped (discover/cold-start)
      for (const id of ids) if ((seedCount.get(id) || 0) >= perSeedCap) return false;
      return true;
    };
    const bumpSeeds = (s) => {
      for (const id of seedsOf(s)) seedCount.set(id, (seedCount.get(id) || 0) + 1);
    };

    // (2)+(3) Greedy MMR with the per-seed cap enforced at selection time.
    const chosen = [];
    const pool = [...survivors];
    while (chosen.length < cap && pool.length) {
      let best = -1;
      let bestVal = -Infinity;
      for (let i = 0; i < pool.length; i += 1) {
        if (!underCap(pool[i])) continue;
        let maxSim = 0;
        for (const c of chosen) {
          const sim = simFn(pool[i].movie, c.movie);
          if (sim > maxSim) maxSim = sim;
        }
        const val = lambda * rel(pool[i]) - (1 - lambda) * maxSim;
        if (val > bestVal) { bestVal = val; best = i; }
      }
      if (best === -1) break; // remaining items all blocked by the seed cap
      const [picked] = pool.splice(best, 1);
      bumpSeeds(picked);
      chosen.push(picked);
    }
    return chosen;
  }
  ```

- [ ] **Step 4: Run the tests — expect PASS.**

  ```
  node --test --test-name-pattern="mmrRerank" recommendations.test.js
  ```
  Expected: PASS — 5 tests pass, 0 fail. (Sanity-check the diversity test: with `lambda=0.95` the three sci-fi items keep the top-3 slots, low ILD ≈ pairwise `1 - itemSim` among them; with `lambda=0.3` the distinct-genre items 4/5 are pulled in, raising ILD.)

- [ ] **Step 5: Commit.**

  ```
  git commit -am "feat(rec): MMR re-rank with near-dup collapse and per-seed cap"
  ```

### Task 17: Rewrite `rankCandidates` to scorePool → exclude watched → mmrRerank → slice (lockstep test update)

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (rewrite `rankCandidates` at L328-335; keep exported signature `rankCandidates(candidates, profile, watchedIds, limit = 20, now = Date.now())` — the 5th arg is the injected `now`)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (update the existing `rankCandidates drops already-watched and sorts by score` test at L101-111 in lockstep)

  Note: this depends on `scorePool` (added earlier in this phase) and `mmrRerank` (Task 5.2). It is the contracted thin back-compat wrapper: `scorePool → exclude watched → mmrRerank → slice`. The 5th parameter is `now` (injected clock); the downvote/dislike penalty is NOT a `rankCandidates` argument — it lives inside `scorePool` via `opts.dislikeVector` (added later in this phase).

- [ ] **Step 1: Update the EXISTING `rankCandidates` test (L101-111) in lockstep.**

  The current test drops watched id `1`, pins `recs[0].movie.id === 100`, and checks descending `score`. The rewrite routes through `scorePool` (so `score` becomes the normalized hybrid and items carry a `parts` object), then `mmrRerank`. Because the candidates must now carry the authoritative `Candidate` shape that `scorePool` reads (`vote_average`/`vote_count` for quality, full `_seeds` with `source`), the fixture is upgraded. Candidates `1` and `100` are near-duplicates (identical genres + identical rec provenance) so `mmrRerank` collapses one; with id `1` excluded as watched, exactly id `100` and the distinct id `200` survive. The pinned-first-id assertion is replaced by the now-authoritative invariants.

  Replace the existing test body (L101-111) with:

  ```js
  test('rankCandidates drops already-watched and sorts by score', () => {
    const cands = [
      { id: 1, genre_ids: [878], popularity: 100, vote_average: 8, vote_count: 1000,
        _seeds: [{ source: 'rec', type: 'title', id: 9, seedId: 9, rank: 0, weight: 2 }] },
      { id: 100, genre_ids: [878], popularity: 100, vote_average: 8, vote_count: 1000,
        _seeds: [{ source: 'rec', type: 'title', id: 9, seedId: 9, rank: 0, weight: 2 }] },
      { id: 200, genre_ids: [28], popularity: 1, vote_average: 6, vote_count: 50,
        _seeds: [{ source: 'discover-genre', type: 'genre', id: 28, name: 'Action', rank: 0, weight: 1 }] },
    ];
    const recs = rankCandidates(cands, PROFILE, new Set([1]), 10, NOW);
    assert.equal(recs.length, 2);                          // watched id 1 excluded
    assert.ok(!recs.some((r) => r.movie.id === 1));        // never resurfaces
    assert.ok(recs.every((r) => r.parts && typeof r.score === 'number')); // scorePool shape
    for (let i = 1; i < recs.length; i += 1) {
      assert.ok(recs[i - 1].score >= recs[i].score, 'scores non-increasing');
    }
  });
  ```

  (`NOW = 1_700_000_000_000` is the fixed clock declared once at the top of the test file per the test conventions; pass it as the injected `now` so `recencyMultiplier` inside `scorePool` is deterministic.)

- [ ] **Step 2: Run the updated test — expect FAIL** (legacy greedy `rankCandidates` still maps to `{ movie, score, reasons }` with no `parts`, so the `r.parts` assertion fails).

  ```
  node --test --test-name-pattern="rankCandidates drops already-watched" recommendations.test.js
  ```
  Expected: FAIL — `recs.every((r) => r.parts && ...)` is false (the legacy mapper emits `{ movie, score, reasons }`, no `parts`).

- [ ] **Step 3: Rewrite `rankCandidates` as the thin wrapper.**

  Replace the existing implementation (`recommendations.js` L328-335):

  ```js
  // Score, drop already-watched, sort desc, take top `limit`.
  export function rankCandidates(candidates, profile, watchedIds, limit = 20) {
    const watched = new Set([...watchedIds].map(String));
    return candidates
      .filter((c) => !watched.has(String(c.id)))
      .map((c) => ({ movie: c, score: scoreCandidate(c, profile), reasons: generateReasons(c, profile) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  ```

  with the contracted funnel wrapper (`scorePool → exclude watched → mmrRerank(page lambda) → slice`; back-compat default `limit = 20`; 5th arg `now` defaults to the wall clock for browser callers but is injectable for tests; page lambda is `MMR_LAMBDA_PAGE` from the constants block added earlier in this phase):

  ```js
  // Back-compat thin wrapper over the scoring/diversity funnel:
  //   scorePool -> exclude watched -> mmrRerank(page lambda) -> slice(limit).
  // `now` is injectable for deterministic tests; defaults to the wall clock for browser use.
  // mmrRerank already slices to `limit`, so no trailing .slice is needed.
  export function rankCandidates(candidates, profile, watchedIds, limit = 20, now = Date.now()) {
    const watched = new Set([...watchedIds].map(String));
    const scored = scorePool(candidates, { profile, now })
      .filter((s) => !watched.has(String(s.movie.id)));
    return mmrRerank(scored, { lambda: MMR_LAMBDA_PAGE, limit, simFn: itemSim });
  }
  ```

  `scoreCandidate(candidate, profile)` and `generateReasons` remain defined elsewhere and untouched by this task — the wrapper no longer calls `scoreCandidate`, but its export/signature is preserved by its owning task earlier in this phase.

- [ ] **Step 4: Run the updated test — expect PASS.**

  ```
  node --test --test-name-pattern="rankCandidates drops already-watched" recommendations.test.js
  ```
  Expected: PASS — 1 test passes (length 2, watched excluded, every result has `parts`, scores non-increasing).

- [ ] **Step 5: Run the full suite to confirm no regression.**

  ```
  npm test
  ```
  Expected: PASS. Baseline before this section was 31 tests in `recommendations.test.js` (full suite 40 across all `*.test.js`). This section adds 5 itemSim tests (Task 5.1) + 5 mmrRerank tests (Task 5.2) and rewrites 1 existing test in place (Task 5.3, no net count change), for a net delta of +10: `recommendations.test.js` → 41 tests, full suite → 50. All green. (This wrapper depends on `scorePool`, added earlier in this phase; sequence this section after that scoring task.)

- [ ] **Step 6: Commit.**

  ```
  git commit -am "refactor(rec): rankCandidates routes through scorePool + MMR"
  ```

## Phase 2 — steering + polish

I have everything I need. Key facts confirmed:
- recommendations.test.js has exactly 31 top-level tests; full suite = 31 + 9 watch-timer = 40.
- `recommendations.js` imports `MOVIE_GENRES, TV_GENRES` at L4 (NOT `THEME_KEYWORDS`, NOT `CONFIG`/`ENDPOINTS` together). `ENDPOINTS` is imported separately at L340. `CONFIG` is NOT imported.
- `GENRE_NAMES` exists (built from MOVIE_GENRES+TV_GENRES).
- `seed` objects in the existing `generateCandidates` lack `source`/`rank` — the SeedTag contract wants `source:'discover-*'`.
- Per reconciliation: `generateCandidates` is OWNED by ITEM 3 (collaborative rec/similar pool). ITEM 6 must add a `discoverCandidates(profile, negProfile)` function and a TARGETED one-line edit to merge Discover into `generateCandidates` — NOT rewrite the whole function. config.test.js is CREATED by ITEM 1; ITEM 6 APPENDS. Real baselines 31/40. Constants block NOT re-declared (owned by Phase-1/ITEM 3).

Now I'll emit the finalized section.

### Task 18: Append parameterized-Discover endpoint tests to config.test.js

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/config.test.js` — APPEND (the file is created earlier in Phase 1 with the recommendations/similar/appendDetail/topRated endpoint tests; this task only appends Discover-opts tests to it; do NOT re-create the file or re-write its import header)
- `/home/tahseen-dar/Projects/MoviesDB/config.js` — `ENDPOINTS.discoverByGenres/Keyword/Cast` (L74-76); add `discoverOpts` serializer above `export const ENDPOINTS` (L35)

config.test.js already exists from the earlier endpoint-builder phase (9 tests: 4 recommendations + 2 similar + ? — its header `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { ENDPOINTS, CONFIG } from './config.js';` is already present). This task APPENDS 11 Discover tests, bringing config.test.js to 20 tests total.

- [ ] **Step 1: Append failing tests for the parameterized Discover endpoints.**

  Append to `/home/tahseen-dar/Projects/MoviesDB/config.test.js` (do NOT add another import header — it already imports `ENDPOINTS, CONFIG`):

  ```js
  // --- discoverByGenres (parameterized opts) ---

  test('discoverByGenres: base url, type, genre csv, default page', () => {
    const url = ENDPOINTS.discoverByGenres('movie', '878|28');
    assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/movie?`), `got ${url}`);
    assert.ok(url.includes(`api_key=${CONFIG.API_KEY}`));
    assert.ok(url.includes('with_genres=878%7C28') || url.includes('with_genres=878|28'),
      `expected piped with_genres, got ${url}`);
    assert.ok(url.includes('page=1'));
    assert.ok(url.includes('sort_by=popularity.desc'));
  });

  test('discoverByGenres: opts add vote_count.gte and vote_average.gte', () => {
    const url = ENDPOINTS.discoverByGenres('movie', '878', 1, {
      voteCountGte: 100, voteAverageGte: 6,
    });
    assert.ok(url.includes('vote_count.gte=100'), `got ${url}`);
    assert.ok(url.includes('vote_average.gte=6'), `got ${url}`);
  });

  test('discoverByGenres: omits vote_average.gte when not provided', () => {
    const url = ENDPOINTS.discoverByGenres('movie', '878', 1, { voteCountGte: 50 });
    assert.ok(url.includes('vote_count.gte=50'));
    assert.ok(!url.includes('vote_average.gte'), `should omit vote_average, got ${url}`);
  });

  test('discoverByGenres: movie uses primary_release_date.gte from dateGte', () => {
    const url = ENDPOINTS.discoverByGenres('movie', '878', 1, { dateGte: '1970-01-01' });
    assert.ok(url.includes('primary_release_date.gte=1970-01-01'), `got ${url}`);
    assert.ok(!url.includes('first_air_date.gte'));
  });

  test('discoverByGenres: tv uses first_air_date.gte from dateGte', () => {
    const url = ENDPOINTS.discoverByGenres('tv', '10765', 2, { dateGte: '1970-01-01' });
    assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/tv?`));
    assert.ok(url.includes('page=2'));
    assert.ok(url.includes('first_air_date.gte=1970-01-01'), `got ${url}`);
    assert.ok(!url.includes('primary_release_date.gte'));
  });

  test('discoverByGenres: without_genres and without_keywords from opts', () => {
    const url = ENDPOINTS.discoverByGenres('movie', '878', 1, {
      withoutGenres: '27|53', withoutKeywords: '4565',
    });
    assert.ok(url.includes('without_genres=27%7C53') || url.includes('without_genres=27|53'),
      `got ${url}`);
    assert.ok(url.includes('without_keywords=4565'), `got ${url}`);
  });

  test('discoverByGenres: omits date and without_* when opts empty', () => {
    const url = ENDPOINTS.discoverByGenres('movie', '878');
    assert.ok(!url.includes('primary_release_date.gte'));
    assert.ok(!url.includes('first_air_date.gte'));
    assert.ok(!url.includes('without_genres'));
    assert.ok(!url.includes('without_keywords'));
  });

  // --- discoverByKeyword (parameterized opts) ---

  test('discoverByKeyword: keyword id + opts gates', () => {
    const url = ENDPOINTS.discoverByKeyword('tv', '4379', 1, {
      voteCountGte: 20, voteAverageGte: 5, dateGte: '1970-01-01', withoutKeywords: '12377',
    });
    assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/tv?`));
    assert.ok(url.includes('with_keywords=4379'), `got ${url}`);
    assert.ok(url.includes('vote_count.gte=20'));
    assert.ok(url.includes('vote_average.gte=5'));
    assert.ok(url.includes('first_air_date.gte=1970-01-01'));
    assert.ok(url.includes('without_keywords=12377'));
  });

  test('discoverByKeyword: bare call still valid (default page, no opts)', () => {
    const url = ENDPOINTS.discoverByKeyword('movie', '9882');
    assert.ok(url.includes('with_keywords=9882'));
    assert.ok(url.includes('page=1'));
    assert.ok(!url.includes('vote_average.gte'));
  });

  // --- discoverByCast (parameterized opts) ---

  test('discoverByCast: person id + opts gates', () => {
    const url = ENDPOINTS.discoverByCast('movie', '5', 2, {
      voteCountGte: 20, withoutGenres: '99',
    });
    assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/movie?`));
    assert.ok(url.includes('with_cast=5'), `got ${url}`);
    assert.ok(url.includes('page=2'));
    assert.ok(url.includes('vote_count.gte=20'));
    assert.ok(url.includes('without_genres=99'));
  });

  test('discoverByCast: bare call still valid (default page, no opts)', () => {
    const url = ENDPOINTS.discoverByCast('tv', '5');
    assert.ok(url.startsWith(`${CONFIG.BASE_URL}/discover/tv?`));
    assert.ok(url.includes('with_cast=5'));
    assert.ok(url.includes('page=1'));
    assert.ok(!url.includes('vote_count.gte'), `bare call must not hardcode a vote floor, got ${url}`);
  });
  ```

- [ ] **Step 2: Run the Discover tests, expect FAIL.**

  ```
  node --test --test-name-pattern="discoverBy" config.test.js
  ```

  Expected: FAIL — the current endpoints hardcode `vote_count.gte=50`/`20`, ignore the `opts` arg entirely, and never emit `vote_average.gte`, `primary_release_date.gte`, `first_air_date.gte`, `without_genres`, or `without_keywords`. Tests asserting those substrings (and the bare-call "no hardcoded vote floor" asserts) fail.

- [ ] **Step 3: Implement the parameterized endpoints with a shared `discoverOpts` serializer.**

  In `/home/tahseen-dar/Projects/MoviesDB/config.js`, add the serializer immediately above `export const ENDPOINTS = {` (L35). It maps the per-type date field and emits each optional gate only when present, so omitted opts produce no substring (this is what makes the bare-call asserts pass — no hardcoded floor):

  ```js
  // Serialize optional Discover gates into query params. Each param is emitted only when
  // its opts value is present, so a bare Discover call (no opts) yields no extra params.
  // `dateGte` maps to the per-type date field (movie => primary_release_date.gte,
  // tv => first_air_date.gte). `withoutGenres`/`withoutKeywords` are pre-built pipe/CSV
  // strings (negative steering) appended verbatim.
  function discoverOpts(type, opts = {}) {
    const { voteCountGte, voteAverageGte, dateGte, withoutGenres, withoutKeywords } = opts;
    const dateField = type === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte';
    let q = '';
    if (voteCountGte != null) q += `&vote_count.gte=${voteCountGte}`;
    if (voteAverageGte != null) q += `&vote_average.gte=${voteAverageGte}`;
    if (dateGte != null) q += `&${dateField}=${dateGte}`;
    if (withoutGenres != null && withoutGenres !== '') q += `&without_genres=${withoutGenres}`;
    if (withoutKeywords != null && withoutKeywords !== '') q += `&without_keywords=${withoutKeywords}`;
    return q;
  }
  ```

  Then replace the three Discover helper lines (current L74-76):

  ```js
    discoverByGenres: (type, genreIdsCsv, page = 1) => `${CONFIG.BASE_URL}/discover/${type}?api_key=${CONFIG.API_KEY}&sort_by=popularity.desc&page=${page}&vote_count.gte=50&with_genres=${genreIdsCsv}`,
    discoverByKeyword: (type, keywordId, page = 1) => `${CONFIG.BASE_URL}/discover/${type}?api_key=${CONFIG.API_KEY}&sort_by=popularity.desc&page=${page}&vote_count.gte=50&with_keywords=${keywordId}`,
    discoverByCast: (type, personId, page = 1) => `${CONFIG.BASE_URL}/discover/${type}?api_key=${CONFIG.API_KEY}&sort_by=popularity.desc&page=${page}&vote_count.gte=20&with_cast=${personId}`
  ```

  with:

  ```js
    discoverByGenres: (type, genreIdsCsv, page = 1, opts = {}) =>
      `${CONFIG.BASE_URL}/discover/${type}?api_key=${CONFIG.API_KEY}&sort_by=popularity.desc&page=${page}&with_genres=${genreIdsCsv}${discoverOpts(type, opts)}`,
    discoverByKeyword: (type, keywordId, page = 1, opts = {}) =>
      `${CONFIG.BASE_URL}/discover/${type}?api_key=${CONFIG.API_KEY}&sort_by=popularity.desc&page=${page}&with_keywords=${keywordId}${discoverOpts(type, opts)}`,
    discoverByCast: (type, personId, page = 1, opts = {}) =>
      `${CONFIG.BASE_URL}/discover/${type}?api_key=${CONFIG.API_KEY}&sort_by=popularity.desc&page=${page}&with_cast=${personId}${discoverOpts(type, opts)}`
  ```

  Note: `discoverByGenres`/`discoverByKeyword`/`discoverByCast` are used only by the recommendation engine (`generateCandidates`/the new `discoverCandidates`), not by the legacy `discoverMovies`/`discoverTv` browse paths, so dropping the hardcoded `vote_count.gte` from the bare form has no app-side consumer to regress.

- [ ] **Step 4: Run the Discover tests, expect PASS; then run the full config suite and engine suite.**

  ```
  node --test --test-name-pattern="discoverBy" config.test.js
  ```

  Expected: PASS — all 11 appended Discover tests green.

  ```
  node --test config.test.js
  ```

  Expected: PASS — 20 tests green (9 endpoint-builder tests created earlier in Phase 1 + 11 Discover-opts tests added here).

  ```
  npm test
  ```

  Expected: PASS — 40 tests at baseline (31 recommendations + 9 watch-timer) still green PLUS the now-20 config.test.js tests. `generateCandidates` is untouched in this task, so no engine behavior changes.

- [ ] **Step 5: Commit.**

  ```
  git commit -am "feat(rec): parameterize Discover endpoints with quality gates, date window, without_*"
  ```

### Task 19: Pure `splitGenreKeywordIds` helper (route keyword-typed config ids correctly)

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — extend the L4 config import to add `THEME_KEYWORDS`; add `KEYWORD_TYPED_IDS` set + exported `splitGenreKeywordIds` just before `export function groupIntoRows` (L259)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` — extend the L4 import; append tests

- [ ] **Step 1: Append failing tests for `splitGenreKeywordIds`.**

  Extend the existing L4 import in `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (it currently reads `import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates } from './recommendations.js';`) to add `splitGenreKeywordIds`:

  ```js
  import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, splitGenreKeywordIds } from './recommendations.js';
  ```

  Then append:

  ```js
  test('splitGenreKeywordIds routes type:keyword config ids to keywords, real genres to genres', () => {
    // Dystopia 4565 and Time Travel 4379 are type:'keyword' in MOVIE_GENRES.
    // 878 (Sci-Fi) and 28 (Action) are real genre ids.
    const out = splitGenreKeywordIds([878, 4565, 28, 4379]);
    assert.deepEqual(out.genres, [878, 28]);
    assert.deepEqual(out.keywords, [4565, 4379]);
  });

  test('splitGenreKeywordIds: all-genre input yields empty keywords', () => {
    const out = splitGenreKeywordIds([878, 28, 18]);
    assert.deepEqual(out.genres, [878, 28, 18]);
    assert.deepEqual(out.keywords, []);
  });

  test('splitGenreKeywordIds: coerces string ids to Numbers and preserves order', () => {
    const out = splitGenreKeywordIds(['4379', '18']);
    assert.deepEqual(out.genres, [18]);
    assert.deepEqual(out.keywords, [4379]);
  });

  test('splitGenreKeywordIds: empty input yields empty buckets', () => {
    const out = splitGenreKeywordIds([]);
    assert.deepEqual(out.genres, []);
    assert.deepEqual(out.keywords, []);
  });
  ```

- [ ] **Step 2: Run the new tests, expect FAIL.**

  ```
  node --test --test-name-pattern="splitGenreKeywordIds" recommendations.test.js
  ```

  Expected: FAIL — `import ... splitGenreKeywordIds` resolves to `undefined`; calling it throws `TypeError: splitGenreKeywordIds is not a function`.

- [ ] **Step 3: Implement `splitGenreKeywordIds`.**

  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, extend the existing config import at L4 (it currently reads `import { MOVIE_GENRES, TV_GENRES } from './config.js';`) to also pull the theme keywords list:

  ```js
  import { MOVIE_GENRES, TV_GENRES, THEME_KEYWORDS } from './config.js';
  ```

  Then add the set + helper just before `export function groupIntoRows` (L259):

  ```js
  // App-config ids that are actually TMDB *keyword* ids despite living in the genre/theme
  // lists with type:'keyword' (e.g. Dystopia 4565, Time Travel 4379). Built once. Any id in
  // this set must go to with_keywords/without_keywords, never with_genres/without_genres.
  const KEYWORD_TYPED_IDS = new Set(
    [...MOVIE_GENRES, ...THEME_KEYWORDS]
      .filter((e) => e.type === 'keyword')
      .map((e) => Number(e.id))
  );

  // Split a flat list of app-config ids into { genres, keywords } using KEYWORD_TYPED_IDS.
  // Coerces to Number, preserves input order within each bucket. Item genre_ids from TMDB
  // responses are always real genre ids, so this is only for config-sourced ids.
  export function splitGenreKeywordIds(ids) {
    const genres = [];
    const keywords = [];
    for (const raw of ids || []) {
      const id = Number(raw);
      if (KEYWORD_TYPED_IDS.has(id)) keywords.push(id);
      else genres.push(id);
    }
    return { genres, keywords };
  }
  ```

  Note: in `MOVIE_GENRES`, `type:'keyword'` is set on Dystopia 4565, Time Travel 4379, etc.; in `THEME_KEYWORDS` those same ids have no `type` field, so the `.filter((e) => e.type === 'keyword')` collects them only from `MOVIE_GENRES`. That is sufficient — both lists are unioned, and the membership set is what matters.

- [ ] **Step 4: Run the tests, expect PASS.**

  ```
  node --test --test-name-pattern="splitGenreKeywordIds" recommendations.test.js
  ```

  Expected: PASS — all 4 new tests green.

  ```
  npm test
  ```

  Expected: PASS — full suite green: 35 recommendations tests now (31 baseline + 4 added here), 9 watch-timer, plus config.test.js. The new top-level `const`/import are side-effect-free and alter no existing pure function, so the 31 baseline assertions are unchanged.

- [ ] **Step 5: Commit.**

  ```
  git commit -am "feat(rec): splitGenreKeywordIds routes config keyword-ids away from with_genres"
  ```

### Task 20: Pure `buildDiscoverRequests` + `discoverCandidates`; merge Discover into the candidate pool

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — add `discoverGates` (private) + exported `buildDiscoverRequests` after `splitGenreKeywordIds`; add `discoverCandidates(profile, negProfile)` (async, near `generateCandidates`); TARGETED one-line merge of Discover into `generateCandidates`; TARGETED `_pipeline` edit to pass `negProfile` through
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` — extend L4 import; append tests

This isolates the URL-list construction (gating, pipe-OR, per-type date field, both-media-type fan-out, negative `without_*`) into a pure, injected-config helper so it is unit-testable via URL-substring asserts. Per single-ownership: `generateCandidates` is OWNED by the collaborative-pool phase (it produces per-seed rec/similar via `mergeCandidates(seedCandidates(basket))`); this section ADDS `discoverCandidates` and a TARGETED one-line edit to also merge Discover — it does NOT rewrite `generateCandidates`'s body. `CONFIG` must be added to the L340 `ENDPOINTS` import (the engine does not yet import `CONFIG`).

- [ ] **Step 1: Append failing tests for `buildDiscoverRequests`.**

  Extend the L4 import of `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (now reading `import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, splitGenreKeywordIds } from './recommendations.js';`) to also include `buildDiscoverRequests`:

  ```js
  import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, splitGenreKeywordIds, buildDiscoverRequests } from './recommendations.js';
  ```

  Then append. Fixtures use a movie-leaning profile with a `type:'keyword'` keyword facet (Time Travel 4379) and a negative profile carrying a downvoted genre (Horror 27) and downvoted keyword (Zombie 12377). The gate asserts pin to the real CONFIG values (`MIN_VOTE_COUNT=10`, `MIN_YEAR=1970`, `MIN_RATING=0`):

  ```js
  const DISC_PROFILE = {
    genres: { '878': 3, '28': 2 },
    keywords: { '4379': { name: 'Time Travel', weight: 2 } }, // type:'keyword' config id
    people: { '5': { name: 'Nolan', weight: 2 } },
    mediaTypeBias: { movie: 5, tv: 1 },
    topTitles: [],
  };
  const NEG_PROFILE = {
    genres: { '27': 1 },                                   // Horror -> without_genres
    keywords: { '12377': { name: 'Zombie', weight: 1 } },  // Zombie -> without_keywords
    people: {},
    mediaTypeBias: { movie: 1, tv: 0 },
    topTitles: [],
  };

  test('buildDiscoverRequests runs for BOTH media types', () => {
    const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
    const movieReqs = reqs.filter((r) => r.url.includes('/discover/movie?'));
    const tvReqs = reqs.filter((r) => r.url.includes('/discover/tv?'));
    assert.ok(movieReqs.length > 0, 'expected movie discover requests');
    assert.ok(tvReqs.length > 0, 'expected tv discover requests');
  });

  test('buildDiscoverRequests paginates pages 1-2 by default', () => {
    const reqs = buildDiscoverRequests(DISC_PROFILE, null, {});
    assert.ok(reqs.some((r) => r.url.includes('page=1')), 'expected a page=1 request');
    assert.ok(reqs.some((r) => r.url.includes('page=2')), 'expected a page=2 request');
  });

  test('buildDiscoverRequests OR-combines top genres into one with_genres facet (pipe)', () => {
    const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
    const genreReq = reqs.find((r) => r.seed.type === 'genre' && r.url.includes('/discover/movie?'));
    assert.ok(genreReq, 'expected a genre discover request');
    // 878 and 28 OR-combined; tolerate raw or %7C-encoded pipe.
    assert.ok(
      genreReq.url.includes('with_genres=878%7C28') || genreReq.url.includes('with_genres=878|28'),
      `expected piped genres, got ${genreReq.url}`,
    );
  });

  test('buildDiscoverRequests routes type:keyword facet to with_keywords, never with_genres', () => {
    const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
    const kwReq = reqs.find((r) => r.seed.type === 'keyword' && r.seed.id === 4379);
    assert.ok(kwReq, 'expected a keyword discover request for 4379');
    assert.ok(kwReq.url.includes('with_keywords=4379'), `got ${kwReq.url}`);
    // Time Travel (4379) must NOT leak into any with_genres list.
    assert.ok(!reqs.some((r) => r.url.includes('with_genres') && r.url.includes('4379')),
      'keyword id 4379 leaked into with_genres');
  });

  test('buildDiscoverRequests seeds carry source:discover-* and the producing facet id', () => {
    const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
    const genreSeed = reqs.find((r) => r.seed.source === 'discover-genre').seed;
    const kwSeed = reqs.find((r) => r.seed.source === 'discover-keyword').seed;
    const personSeed = reqs.find((r) => r.seed.source === 'discover-person').seed;
    assert.equal(genreSeed.type, 'genre');
    assert.equal(kwSeed.type, 'keyword');
    assert.equal(kwSeed.id, 4379);
    assert.equal(personSeed.type, 'person');
    assert.equal(personSeed.id, 5);
  });

  test('buildDiscoverRequests applies CONFIG gates: vote_count.gte and date window', () => {
    const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
    // CONFIG.MIN_VOTE_COUNT = 10, CONFIG.MIN_YEAR = 1970, CONFIG.MIN_RATING = 0 (omitted).
    assert.ok(reqs.every((r) => r.url.includes('vote_count.gte=10')), 'all reqs gated by min votes');
    const movieReq = reqs.find((r) => r.url.includes('/discover/movie?'));
    const tvReq = reqs.find((r) => r.url.includes('/discover/tv?'));
    assert.ok(movieReq.url.includes('primary_release_date.gte=1970-01-01'), `got ${movieReq.url}`);
    assert.ok(tvReq.url.includes('first_air_date.gte=1970-01-01'), `got ${tvReq.url}`);
    // MIN_RATING is 0 -> no vote_average gate.
    assert.ok(reqs.every((r) => !r.url.includes('vote_average.gte')), 'no vote_average gate at MIN_RATING=0');
  });

  test('buildDiscoverRequests builds without_genres/without_keywords from the negative profile', () => {
    const reqs = buildDiscoverRequests(DISC_PROFILE, NEG_PROFILE, { pages: 1 });
    assert.ok(reqs.every((r) => r.url.includes('without_genres=27')),
      'expected Horror 27 in without_genres on every request');
    assert.ok(reqs.every((r) => r.url.includes('without_keywords=12377')),
      'expected Zombie 12377 in without_keywords on every request');
  });

  test('buildDiscoverRequests omits without_* when no negative profile', () => {
    const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
    assert.ok(reqs.every((r) => !r.url.includes('without_genres')), 'no without_genres without neg');
    assert.ok(reqs.every((r) => !r.url.includes('without_keywords')), 'no without_keywords without neg');
  });
  ```

- [ ] **Step 2: Run the new tests, expect FAIL.**

  ```
  node --test --test-name-pattern="buildDiscoverRequests" recommendations.test.js
  ```

  Expected: FAIL — `buildDiscoverRequests` is `undefined` (not yet exported); every test throws `TypeError: buildDiscoverRequests is not a function`.

- [ ] **Step 3: Implement `discoverGates` + `buildDiscoverRequests` as pure helpers.**

  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, first extend the L340 import (currently `import { ENDPOINTS } from './config.js';`) to also pull `CONFIG`:

  ```js
  import { CONFIG, ENDPOINTS } from './config.js';
  ```

  Then add, immediately after `splitGenreKeywordIds` (so `GENRE_NAMES`, `splitGenreKeywordIds`, `CONFIG`, and `ENDPOINTS` are all in scope):

  ```js
  // Build the shared opts (quality gates + date window + negative steering) applied to every
  // Discover request. Pure: sources floors from CONFIG and the negative profile only.
  // MIN_RATING is gated only when > 0 (0 means "no rating floor"). without_* are assembled
  // from the negative profile's genres (real TMDB genre ids) and keywords (keyword ids).
  function discoverGates(negProfile) {
    const opts = {
      voteCountGte: CONFIG.MIN_VOTE_COUNT,
      dateGte: `${CONFIG.MIN_YEAR}-01-01`,
    };
    if (CONFIG.MIN_RATING > 0) opts.voteAverageGte = CONFIG.MIN_RATING;
    if (negProfile) {
      const negGenreIds = Object.keys(negProfile.genres || {}).map(Number);
      const negKeywordIds = Object.keys(negProfile.keywords || {}).map(Number);
      if (negGenreIds.length) opts.withoutGenres = negGenreIds.join('|');
      if (negKeywordIds.length) opts.withoutKeywords = negKeywordIds.join('|');
    }
    return opts;
  }

  // Pure: produce the list of { url, seed } Discover requests for the candidate pool.
  // - top genres OR-combined into one with_genres facet (keyword-typed config ids split out)
  // - top keywords and people each their own facet
  // - run for BOTH media types, ordered by mediaTypeBias (heavier type first)
  // - pages 1..opts.pages (default 2), gated by CONFIG floors + negative without_*
  // Seeds conform to SeedTag: source 'discover-genre'|'discover-keyword'|'discover-person',
  //   type 'genre'|'keyword'|'person', id = the producing facet id, name + weight.
  // opts: { pages = 2, maxGenres = 4, maxKeywords = 6, maxPeople = 6 }
  export function buildDiscoverRequests(profile, negProfile, opts = {}) {
    const { pages = 2, maxGenres = 4, maxKeywords = 6, maxPeople = 6 } = opts;
    const gates = discoverGates(negProfile);

    // mediaTypeBias-ordered types: heavier type first, both always present (mixed media).
    const bias = profile.mediaTypeBias || { movie: 0, tv: 0 };
    const types = bias.tv > bias.movie ? ['tv', 'movie'] : ['movie', 'tv'];

    const topGenreIds = Object.entries(profile.genres || {})
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxGenres)
      .map(([id]) => Number(id));
    // profile.genres may carry config-sourced keyword-typed ids; route them out of with_genres.
    const { genres: genreIds, keywords: genreKeywordIds } = splitGenreKeywordIds(topGenreIds);

    const topKeywords = Object.entries(profile.keywords || {})
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, maxKeywords)
      .map(([id, { name, weight }]) => ({ id: Number(id), name, weight }));
    const topPeople = Object.entries(profile.people || {})
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, maxPeople)
      .map(([id, { name, weight }]) => ({ id: Number(id), name, weight }));

    // Keyword facets = real theme keywords + any keyword-typed ids misfiled under genres.
    const keywordFacets = [
      ...topKeywords,
      ...genreKeywordIds.map((id) => ({ id, name: GENRE_NAMES.get(id) || 'keyword', weight: 1 })),
    ];

    const requests = [];
    for (const type of types) {
      for (let page = 1; page <= pages; page++) {
        if (genreIds.length) {
          const csv = genreIds.join('|'); // pipe-OR
          requests.push({
            url: ENDPOINTS.discoverByGenres(type, csv, page, gates),
            seed: {
              source: 'discover-genre', type: 'genre', id: genreIds[0],
              name: GENRE_NAMES.get(genreIds[0]) || 'genre',
              weight: profile.genres[String(genreIds[0])] || 1,
            },
          });
        }
        for (const k of keywordFacets) {
          requests.push({
            url: ENDPOINTS.discoverByKeyword(type, k.id, page, gates),
            seed: { source: 'discover-keyword', type: 'keyword', id: k.id, name: k.name, weight: k.weight },
          });
        }
        for (const p of topPeople) {
          requests.push({
            url: ENDPOINTS.discoverByCast(type, p.id, page, gates),
            seed: { source: 'discover-person', type: 'person', id: p.id, name: p.name, weight: p.weight },
          });
        }
      }
    }
    return requests;
  }
  ```

- [ ] **Step 4: Run the tests, expect PASS.**

  ```
  node --test --test-name-pattern="buildDiscoverRequests" recommendations.test.js
  ```

  Expected: PASS — all 8 new tests green.

- [ ] **Step 5: Add `discoverCandidates` and TARGETED-merge it into `generateCandidates`.**

  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, ADD a new async function near `generateCandidates`. It fans out both media types via the pure builder, tags each candidate with its real `media_type` from the response (falling back to the request type), attaches the `discover-*` seed, and no longer truncates results:

  ```js
  // Pull Discover candidates seeded by the profile's top genres/keywords/people.
  // Deeper (pages 1-2), pipe-OR multi-facet, both media types, gated + negatively steered.
  // Returns merged Candidate[] (de-duped + seed-union via mergeCandidates).
  async function discoverCandidates(profile, negProfile = null) {
    const requests = buildDiscoverRequests(profile, negProfile, {});

    const tagged = [];
    const BATCH = 6;
    for (let i = 0; i < requests.length; i += BATCH) {
      const slice = requests.slice(i, i + BATCH);
      const results = await Promise.all(
        slice.map((r) => fetchJson(r.url).then((d) => ({ d, seed: r.seed, url: r.url })).catch(() => null))
      );
      for (const r of results) {
        if (!r) continue;
        const reqType = r.url.includes('/discover/tv?') ? 'tv' : 'movie';
        for (const movie of (r.d.results || [])) {
          tagged.push({ ...movie, media_type: movie.media_type || reqType, _seeds: [r.seed] });
        }
      }
      if (i + BATCH < requests.length) await delay(300);
    }
    return mergeCandidates(tagged);
  }
  ```

  Then make the TARGETED edit to `generateCandidates` (owned by the collaborative-pool phase) so the pool is the UNION of per-seed rec/similar AND Discover. `generateCandidates` is invoked from `_pipeline` with the enriched basket and now also receives `negProfile`; its final `return mergeCandidates(seedTagged)` becomes a union with `discoverCandidates`. Concretely, change the function's signature and return to thread `profile`/`negProfile` and merge both source lists (the per-seed collaborative tagging block from the owning phase is left intact above this return):

  ```js
  // OWNED by the collaborative-pool phase: builds per-seed rec/similar candidates from the
  // enriched basket. This section threads the taste profile + negative profile so the pool
  // is the UNION of collaborative candidates and gated, negatively-steered Discover.
  async function generateCandidates(basketEnriched, profile, negProfile = null) {
    // ... collaborative per-seed rec/similar fan-out (owning phase) produces `seedTagged` ...
    const collab = mergeCandidates(seedTagged);
    const discover = await discoverCandidates(profile, negProfile);
    return mergeCandidates([...collab, ...discover]);
  }
  ```

  Note for assembly: the owning phase's `generateCandidates(basketEnriched)` body (the per-seed rec/similar fan-out producing `seedTagged`) is preserved verbatim; this section only (a) extends the signature to `(basketEnriched, profile, negProfile = null)` and (b) replaces the single trailing `return mergeCandidates(seedTagged);` with the three-line union above. The cold-start filler source is added by a later phase via the same union pattern (`mergeCandidates([...existing, ...filler])`), so all three mandated sources (collaborative ∪ Discover ∪ filler) compose without any section overwriting another's source. Do NOT re-paste the collaborative body here.

- [ ] **Step 6: TARGETED `_pipeline` edit — pass profile + negProfile into the candidate union.**

  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` `_pipeline` (the owning phase already computes `posProfile`, `negProfile`, and `profile = combineProfiles(posProfile, negProfile, ...)`), update ONLY the `generateCandidates` call site so Discover receives the taste profile and the negative profile (the latter driving `without_*`):

  ```js
    const candidates = await generateCandidates(basketEnriched, profile, negProfile);
  ```

  This is a one-line targeted edit; it does not touch the `signalSignature(...)` line (owned by the cold-start/cache phase, which extends it to include the watchedIds hash) nor the exclude/score/rerank lines. The injected `now` continues to thread through `scorePool`/`mmrRerank` unchanged.

- [ ] **Step 7: Run the full suite, expect PASS.**

  ```
  npm test
  ```

  Expected: PASS — 40 baseline tests still green (31 recommendations + 9 watch-timer), PLUS the 4 `splitGenreKeywordIds` tests and 8 `buildDiscoverRequests` tests added by this section (recommendations.test.js now at 43), PLUS config.test.js (20). `discoverCandidates`/`generateCandidates`/`_pipeline` are async network orchestration not imported by any test, so their behavior is covered by the pure `buildDiscoverRequests` tests; no pure-function signature changed, so no existing assertion needs updating. (rrf is deferred — weighted hybrid is the v1 ordering; the 'trending' row is built in the cold-start/filler phase, not here.)

- [ ] **Step 8: Commit.**

  ```
  git commit -am "feat(rec): deeper gated pipe-OR Discover across both media types with without_*"
  ```

Now I have all the actual source. I have everything needed to finalize Section 7 with reconciliation applied. Key reconciliation decisions per the rules:

- Constants block owned by an earlier section (added in Phase 1) — Section 7 must NOT re-declare any. `DOWNVOTE_GAMMA` is in the canonical block. I'll only add Section-7-specific NEW consts (`DOWNVOTE_SCORE_STRENGTH`, `DOWNVOTE_SCORE_FLOOR`) which no other section owns.
- `rankCandidates` is OWNED by ITEM 5 (scorePool→exclude→mmrRerank→slice, 5th arg = `now`). Section 7 MUST NOT revert it or add a `dislike` 5th arg.
- The downvote penalty lives in `scorePool` (owned by ITEM 4), via `opts.dislikeVector`. Section 7 adds the bounded multiplicative term there as a TARGETED edit.
- `_pipeline` is OWNED by ITEM 3. Section 7 only changes negative-profile build (no STAR_BONUS) + passes dislike data to scorePool.
- baselines 31/40; rrf de-scoped; trending row owned by ITEM 9.

Since constants and `scorePool`/`rankCandidates`/`_pipeline`/`generateCandidates` are owned elsewhere and reference functions by name+phase, I'll write targeted edits. Below is the finalized section.

---

### Task 21: combineProfiles → Rocchio gamma weighting (rename penalty→gamma, default DOWNVOTE_GAMMA)

`combineProfiles` currently reads `opts.penalty` (default `DOWNVOTE_PENALTY`). The contract names the Rocchio negative weight `gamma` with default `DOWNVOTE_GAMMA` (added once in the canonical constants block in Phase 1; this section only USES it). This is a TARGETED edit to the one function this section owns; the 5 existing `combineProfiles` tests are updated in lockstep (the contract flags combineProfiles as a tracked pure fn). No constant is declared here.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (`combineProfiles` L121-150)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (combineProfiles tests L277-309; fixtures `POS`/`NEG` L262-275)

- [ ] **Step 1: Rewrite the existing combineProfiles tests to the Rocchio contract (FAIL FIRST).** Replace the five `combineProfiles` tests (L277-309). Keep the `POS`/`NEG` fixtures (L262-275) unchanged. The behavior change is the whole point: at the new default `gamma=DOWNVOTE_GAMMA` (0.15) one downvote must NOT erase a strongly-basketed shared theme. This block is 6 tests (was 5), so the file's `test()` count rises by 1.

```js
test('combineProfiles ROCCHIO: genres net (pos - gamma*neg), keep negatives so scoring can penalize', () => {
  const c = combineProfiles(POS, NEG, { gamma: 1 });
  assert.equal(c.genres['878'], 4);   // 4 - 1*0 (not in NEG)
  assert.equal(c.genres['18'], -1);   // 2 - 1*3
  assert.equal(c.genres['27'], -5);   // 0 - 1*5
});

test('combineProfiles ROCCHIO: keywords/people net, drop anything <= 0 so disliked themes never seed', () => {
  const c = combineProfiles(POS, NEG, { gamma: 1 });
  assert.equal(c.keywords['9'].weight, 2);   // 3 - 1*1
  assert.equal(c.keywords['7'].weight, 1);   // 1 - 1*0
  assert.equal(c.keywords['99'], undefined); // 0 - 1*4 <= 0, dropped
  assert.equal(c.people['5'].weight, 1);     // 2 - 1*1
});

test('combineProfiles ROCCHIO: gamma scales the negative side', () => {
  const c = combineProfiles(POS, NEG, { gamma: 0.5 });
  assert.equal(c.genres['18'], 0.5);         // 2 - 0.5*3
  assert.equal(c.people['5'].weight, 1.5);   // 2 - 0.5*1
});

test('combineProfiles ROCCHIO: default gamma is DOWNVOTE_GAMMA=0.15 and does NOT erase a strongly-basketed theme', () => {
  // One downvote shares keyword 9 (time travel) and genre 18 with a strong basket.
  // Old penalty=1.0 behavior: kw9 = 3-1 = 2 (still alive), genre18 = 2-3 = -1 (negative).
  // New default gamma=0.15: the theme stays clearly positive (soft steer, not erase).
  const c = combineProfiles(POS, NEG);
  assert.ok(c.keywords['9'], 'shared keyword must NOT be erased by one downvote');
  assert.ok(Math.abs(c.keywords['9'].weight - (3 - 0.15 * 1)) < 1e-9); // 2.85
  assert.ok(c.genres['18'] > 0, 'shared genre stays positive under soft Rocchio');
  assert.ok(Math.abs(c.genres['18'] - (2 - 0.15 * 3)) < 1e-9);          // 1.55
  // A purely-disliked genre still goes net-negative so scoring can steer away.
  assert.ok(Math.abs(c.genres['27'] - (0 - 0.15 * 5)) < 1e-9);          // -0.75
});

test('combineProfiles ROCCHIO: positive profile passes through topTitles and mediaTypeBias', () => {
  const c = combineProfiles(POS, NEG, { gamma: 1 });
  assert.equal(c.topTitles[0].id, 1);
  assert.deepEqual(c.mediaTypeBias, { movie: 5, tv: 0 });
});

test('combineProfiles ROCCHIO: no negative profile is a pass-through of positives', () => {
  const c = combineProfiles(POS, null, { gamma: 1 });
  assert.equal(c.genres['878'], 4);
  assert.equal(c.keywords['9'].weight, 3);
  assert.equal(c.people['5'].weight, 2);
});
```

- [ ] **Step 2: Run the new tests (expected FAIL).** `combineProfiles` still destructures `opts.penalty`, so passing `{ gamma: ... }` falls back to `DOWNVOTE_PENALTY=1.0`; the default-gamma test then computes `genres['18'] = 2 - 1*3 = -1` (fails `> 0`) and `keywords['9'].weight = 3 - 1*1 = 2` (fails `≈ 2.85`).

```
node --test --test-name-pattern="combineProfiles ROCCHIO" recommendations.test.js
```
Expected: FAIL — `combineProfiles ROCCHIO: default gamma is DOWNVOTE_GAMMA=0.15...` fails at `c.genres['18'] > 0` (got -1) and the `2.85` keyword assertion (got 2).

- [ ] **Step 3: Implement Rocchio gamma in combineProfiles.** Replace L121-150. Rename `penalty`→`gamma`, default to `DOWNVOTE_GAMMA` (the constant added once in the Phase-1 constants block — do NOT re-declare it here), and update the doc comment. Behavior is otherwise identical (net genres, drop keywords/people ≤ 0).

```js
// ROCCHIO: net a positive profile (basket) against a negative profile (downvoted) into a single
// profile the candidate generator/scorer consume:  profile = pos - gamma*neg.
// Genres keep their net value (which may go negative, so scoring penalizes disliked genres).
// Keywords/people are netted but anything <= 0 is dropped, so disliked themes never seed
// candidate generation. gamma is small (DOWNVOTE_GAMMA) so a single downvote softens but does
// NOT erase a strongly-basketed shared theme.
export function combineProfiles(pos, neg, opts = {}) {
  const { gamma = DOWNVOTE_GAMMA } = opts;
  const n = neg || { genres: {}, keywords: {}, people: {} };

  const genres = {};
  for (const [g, w] of Object.entries(pos.genres || {})) genres[g] = w;
  for (const [g, w] of Object.entries(n.genres || {})) genres[g] = (genres[g] || 0) - gamma * w;

  const netWeighted = (posMap, negMap) => {
    const out = {};
    for (const [id, v] of Object.entries(posMap || {})) out[id] = { name: v.name, weight: v.weight };
    for (const [id, v] of Object.entries(negMap || {})) {
      if (out[id]) out[id].weight -= gamma * v.weight; // purely-downvoted themes are never added
    }
    for (const id of Object.keys(out)) if (out[id].weight <= 0) delete out[id];
    return out;
  };

  return {
    genres,
    keywords: netWeighted(pos.keywords, n.keywords),
    people: netWeighted(pos.people, n.people),
    mediaTypeBias: pos.mediaTypeBias || { movie: 0, tv: 0 },
    topTitles: pos.topTitles || [],
  };
}
```

- [ ] **Step 4: Run combineProfiles tests (expected PASS).**
```
node --test --test-name-pattern="combineProfiles ROCCHIO" recommendations.test.js
```
Expected: PASS (6/6).

- [ ] **Step 5: Run the full suite to confirm no regression (expected PASS).** The `scoreCandidate: a candidate in a net-negative genre...` test (L311) still passes because Rocchio still produces net-negative genres. The recommendations.test.js file started at 31 tests; replacing 5 combineProfiles tests with 6 makes it 32. The full multi-file suite goes from 40 to 41.
```
npm test
```
Expected: PASS — recommendations.test.js 32 green; full suite 41 green.

- [ ] **Step 6: Commit.**
```
git commit -am "feat(rec): rocchio gamma weighting in combineProfiles"
```

---

### Task 22: Bounded multiplicative downvote penalty inside scorePool (overlap with the disliked vector)

The contract routes the downvote penalty THROUGH the scorer: `scorePool(candidates, { profile, now, weights, dislikeVector })` (owned in an earlier phase). Section 7 adds a bounded multiplicative downweight INSIDE `scorePool` keyed off `opts.dislikeVector` — NOT a new arg on `rankCandidates`, NOT in a legacy `scoreCandidate`. `dislikeVector` is a tag-vector (`profileVector(negProfile)` from the earlier phase: keys `'g:<id>'|'k:<id>'|'p:<id>'`). A candidate's overlap fraction with that vector multiplies its final score by a factor in `[DOWNVOTE_SCORE_FLOOR, 1]`. With no `dislikeVector` the factor is 1, so every existing `scorePool` test is unaffected.

`scoreCandidate(candidate, profile)` is kept as the thin legacy shim owned by the scorer section; Section 7 does NOT change its signature. This penalty is added to `scorePool` only.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (new Section-7 constants near the tuning block; `scorePool` body — added in an earlier phase)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (import line L4; new tests after L321)

- [ ] **Step 1: Add the two Section-7-only penalty constants.** These names are NOT in the shared constants block (no other section declares them), so Section 7 owns them. Add them in `recommendations.js` immediately after the shared tuning block (after `COVERAGE_WEIGHT` / the Phase-1 constants, near L24). Export `DOWNVOTE_SCORE_FLOOR` so the test can reference it:

```js
const DOWNVOTE_SCORE_STRENGTH = 0.4;        // how hard disliked-vector overlap downweights a candidate
export const DOWNVOTE_SCORE_FLOOR = 0.5;    // a strongly-disliked candidate keeps >= half its score (never zeroed)
```

- [ ] **Step 2: Extend the test import line (L4)** to pull in the exported floor and `scorePool` (added in the earlier scorer phase):

```js
import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, scorePool, DOWNVOTE_SCORE_FLOOR } from './recommendations.js';
```

- [ ] **Step 3: Write failing tests for the bounded penalty in scorePool (FAIL FIRST).** Add after L321. `dislikeVector` is a tag-vector keyed `'g:'/'k:'/'p:'`. Assert: (a) overlap lowers a strong positive's score, (b) it is NEVER zeroed (stays above `floor*base`), (c) no `dislikeVector` is a pure pass-through (back-compat), (d) a non-overlapping candidate is unpenalized.

```js
test('scorePool: disliked-vector overlap lowers a strong positive but never zeros it', () => {
  const profile = {
    genres: { '878': 4, '28': 3 },
    keywords: { '9': { name: 'time travel', weight: 3 } },
    people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  // Strong positive candidate: liked genres + keyword + a strong rec seed.
  const cand = {
    id: 50, media_type: 'movie', genre_ids: [878, 28], popularity: 100,
    vote_average: 8, vote_count: 1000,
    _keywords: [{ id: 9, name: 'time travel' }],
    _seeds: [{ source: 'rec', type: 'title', id: 1, rank: 0, weight: 3 }],
  };
  // Disliked vector overlaps both genres and the keyword on the candidate.
  const dislikeVector = { 'g:878': 5, 'g:28': 5, 'k:9': 5 };

  const base = scorePool([cand], { profile, now: NOW })[0].score;
  const penalized = scorePool([cand], { profile, now: NOW, dislikeVector })[0].score;

  assert.ok(penalized < base, 'overlap with the disliked vector must lower the score');
  assert.ok(penalized > base * DOWNVOTE_SCORE_FLOOR,
    `a strong positive must keep most of its score (> floor*base=${base * DOWNVOTE_SCORE_FLOOR}), got ${penalized}`);
  assert.ok(penalized > 0, 'penalty is bounded — never zeroes a strong positive');
});

test('scorePool: no disliked vector is a pass-through (back-compat)', () => {
  const profile = {
    genres: { '878': 4 }, keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const cand = { id: 51, media_type: 'movie', genre_ids: [878], popularity: 10, vote_average: 7, vote_count: 100, _seeds: [] };
  const plain = scorePool([cand], { profile, now: NOW })[0].score;
  assert.equal(scorePool([cand], { profile, now: NOW, dislikeVector: undefined })[0].score, plain);
  assert.equal(scorePool([cand], { profile, now: NOW, dislikeVector: null })[0].score, plain);
});

test('scorePool: a candidate NOT overlapping the disliked vector is unpenalized', () => {
  const profile = {
    genres: { '878': 4 }, keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const dislikeVector = { 'g:27': 5 }; // dislikes Horror only
  const cand = { id: 52, media_type: 'movie', genre_ids: [878], popularity: 10, vote_average: 7, vote_count: 100, _seeds: [] };
  assert.equal(
    scorePool([cand], { profile, now: NOW, dislikeVector })[0].score,
    scorePool([cand], { profile, now: NOW })[0].score
  );
});
```

- [ ] **Step 4: Run the new tests (expected FAIL).** `scorePool` (as added in the earlier scorer phase) does not yet apply `opts.dislikeVector`, so `penalized === base` (the `penalized < base` assertion fails), and `DOWNVOTE_SCORE_FLOOR` is now exported so the floor comparison runs against a real number that equals base (still fails `<`).
```
node --test --test-name-pattern="scorePool: disliked-vector overlap|scorePool: no disliked vector|scorePool: a candidate NOT overlapping" recommendations.test.js
```
Expected: FAIL — `overlap with the disliked vector must lower the score` (got `penalized === base`).

- [ ] **Step 5: Add the bounded penalty inside scorePool (TARGETED edit — do NOT rewrite the whole function).** `scorePool` is owned by the earlier scorer phase; Section 7 adds only the `dislikeVector` destructure and a final multiplicative factor on each scored item before the descending sort. First add the helper (a pure tag-vector overlap fraction) near `scorePool`:

```js
// Fraction of a candidate's own tag-vector terms that the disliked tag-vector also contains, in
// [0,1]. The candidate's tag-vector is built by the scorer (buildTagVector): 'g:'/'k:'/'p:' keys.
function dislikeOverlapVec(candVec, dislikeVector) {
  if (!dislikeVector) return 0;
  const terms = Object.keys(candVec || {});
  if (terms.length === 0) return 0;
  let hit = 0;
  for (const t of terms) if (dislikeVector[t] > 0) hit += 1;
  return hit / terms.length;
}
```

Then, inside `scorePool`, destructure `dislikeVector` from opts and apply the factor where each Scored item's final `score` is computed (the candidate's idf-weighted tag-vector `candVec` is already built there as part of the cosine content term — reuse it):

```js
// in the opts destructure at the top of scorePool, add dislikeVector:
//   const { profile, now, weights = { collab: W_COLLAB, content: W_CONTENT }, dislikeVector } = opts;

// where each candidate's final score is assembled (after quality*recency), add:
const overlap = dislikeOverlapVec(candVec, dislikeVector);
if (overlap > 0) {
  score *= Math.max(DOWNVOTE_SCORE_FLOOR, 1 - DOWNVOTE_SCORE_STRENGTH * overlap);
}
```

The factor lives in `[DOWNVOTE_SCORE_FLOOR, 1]`: a candidate whose entire tag-vector is disliked (overlap=1) gets `max(0.5, 1 - 0.4*1) = 0.6`, so it keeps 60% of its score — softened, never erased.

- [ ] **Step 6: Run the new tests (expected PASS).** For the strong-positive candidate, all of `g:878, g:28, k:9` are in `dislikeVector`, so overlap = 3/3 = 1 → factor 0.6 → `0.6*base < base` and `> 0.5*base`.
```
node --test --test-name-pattern="scorePool: disliked-vector overlap|scorePool: no disliked vector|scorePool: a candidate NOT overlapping" recommendations.test.js
```
Expected: PASS (3/3).

- [ ] **Step 7: Run the full suite (expected PASS).** Existing `scorePool` callers pass no `dislikeVector`; `overlap` is 0 so the factor is never applied → identical scores. recommendations.test.js rises from 32 (after Task 7.1) to 35; full suite 41 → 44.
```
npm test
```
Expected: PASS — all green.

- [ ] **Step 8: Commit.**
```
git commit -am "feat(rec): bounded multiplicative downvote penalty in scorePool"
```

---

### Task 23: _pipeline negative-centroid build (no STAR_BONUS on downvoted) + thread dislikeVector to scorePool

`_pipeline` is owned by the engine phase (enrich basket+downvoted → combineProfiles → generateCandidates → exclude → scorePool → mmrRerank). Section 7 makes only TARGETED edits to it: (a) build the downvoted set as a SMALL negative centroid (not STAR_BONUS-inflated like the basket), and (b) derive `dislikeVector = profileVector(negProfile)` and thread it into the `scorePool` call. Section 7 does NOT touch `rankCandidates` (owned by the ranking phase; its 5th arg is `now`, not a dislike payload), does NOT rewrite `generateCandidates` (Discover `without_*` from `negProfile` is owned by the Discover phase — Section 7 only ensures `negProfile` exists), and does NOT change the `signalSignature` callsite (the watched-hash variant is owned by the cold-start/cache phase).

The penalty mechanism lives entirely in `scorePool` (Task 7.2). This task wires the data.

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (`_pipeline` L484-499; the `DOWNVOTE_PENALTY` constant L25; `getRecommendationRows` L514-519)

- [ ] **Step 1: Build downvoted as a small negative centroid in _pipeline.** TARGETED edit at L484-489. Basket items stay STAR_BONUS-weighted positive seeds (`_starred:true`); downvoted items become a SMALL centroid (`_starred:false`, engagement dropped) so one downvote can't out-shout the basket — it steers softly via Rocchio gamma, the bounded scorePool penalty, and Discover `without_*`. Replace the single `annotate` helper + its two call sites:

```js
  // Basket items are explicit positive seeds: STAR_BONUS-weighted, engagement dropped
  // (basket-primary, uniform). Downvoted items form a SMALL negative centroid — NOT starred,
  // no engagement — so one downvote can't out-shout the basket; it softly steers via Rocchio
  // (combineProfiles gamma), the bounded scorePool penalty, and Discover without_*.
  const annotatePos = (arr) => arr.map((m) => ({ ...m, _starred: true, _engagement: null }));
  const annotateNeg = (arr) => arr.map((m) => ({ ...m, _starred: false, _engagement: null }));
  const basketEnriched = annotatePos(await enrichWatchedTitles(basket));
  const downEnriched = annotateNeg(await enrichWatchedTitles(downvoted));
```

- [ ] **Step 2: Derive the dislike vector and pass it to scorePool.** TARGETED edit at L491-499. `negProfile` is already built; `combineProfiles` already takes `{ gamma }` (Task 7.1). Add the `dislikeVector` derivation via `profileVector` (the profile→tag-vector mapper added in the scorer phase) and pass it through the existing `scorePool` call (added in the scoring phase). Replace L491-499 with:

```js
  const posProfile = buildTasteProfile(basketEnriched, now);
  const negProfile = downEnriched.length ? buildTasteProfile(downEnriched, now) : null;
  const profile = combineProfiles(posProfile, negProfile, { gamma });

  // negProfile drives Discover without_genres/without_keywords (Discover helper, added earlier)
  // and the bounded re-rank penalty (scorePool dislikeVector, added earlier).
  const dislikeVector = negProfile ? profileVector(negProfile) : undefined;
  const candidates = await generateCandidates(basketEnriched);
  const excludeIds = new Set(
    [...basket, ...downvoted].map((m) => m.id).concat(watchedIds)
  );
  const scored = scorePool(candidates, { profile, now, dislikeVector });
  const recs = mmrRerank(scored, { lambda: MMR_LAMBDA_PAGE, limit })
    .filter((s) => !excludeIds.has(s.movie.id));
```

Note for the assembler: `generateCandidates(basketEnriched)` is the collaborative-pool form owned by the engine phase; the Discover-union and filler-union are TARGETED merges added by the Discover and cold-start phases respectively — Section 7 does NOT alter that function. `scorePool`, `mmrRerank`, `profileVector`, `MMR_LAMBDA_PAGE` are all provided by earlier phases; Section 7 only references them. The exclude-set application here matches the engine-phase ordering (scorePool → mmrRerank → exclude). If the engine phase already applies the exclude inside `_pipeline`, keep that single application and just add the `dislikeVector` argument to its existing `scorePool` call — do not duplicate the filter.

- [ ] **Step 3: Switch the `gamma` opt name in _pipeline's destructure.** TARGETED edit at L472. Replace `penalty = DOWNVOTE_PENALTY` with `gamma = DOWNVOTE_GAMMA` (the constant is in the Phase-1 block; not re-declared here):

```js
  const { limit = 20, now = Date.now(), gamma = DOWNVOTE_GAMMA } = opts;
```

- [ ] **Step 4: Propagate the rename in the page orchestrator.** TARGETED edit to `getRecommendationRows` L514-519 — replace the `penalty` option with `gamma`. `getRecommendations` (L508-511) forwards `opts` whole, so it needs no change.

```js
export async function getRecommendationRows(input, opts = {}) {
  if (!input || !input.basket || input.basket.length === 0) return { rows: [] };
  const { limit = 60, now = Date.now(), groupOpts = {}, gamma } = opts;
  const { profile, recs } = await _pipeline(input, { limit, now, gamma });
  return { rows: groupIntoRows(recs, profile, groupOpts) };
}
```

- [ ] **Step 5: Remove the now-unused DOWNVOTE_PENALTY constant.** With `_pipeline`, `getRecommendationRows`, and `combineProfiles` all on `gamma`, `DOWNVOTE_PENALTY` (L25) has no reader. Delete that line, then verify nothing else references it:
```
grep -n "DOWNVOTE_PENALTY" /home/tahseen-dar/Projects/MoviesDB/recommendations.js /home/tahseen-dar/Projects/MoviesDB/recommendations.test.js /home/tahseen-dar/Projects/MoviesDB/script.js
```
Expected: no output (zero matches). If `script.js` references it, leave the constant and note the coupling for the rendering section instead.

- [ ] **Step 6: Run the full suite (expected PASS).** `_pipeline`/`generateCandidates` are network paths not unit-tested here; the pure-fn suite (including the Task 7.1 and 7.2 additions) must stay green. No test count change in this task.
```
npm test
```
Expected: PASS — recommendations.test.js 35 green; full suite 44 green.

- [ ] **Step 7: Commit.**
```
git commit -am "feat(rec): negative-centroid downvotes threaded as scorePool dislikeVector"
```

---

Section 7 net delta: recommendations.test.js 31 → 35 (combineProfiles +1 net in Task 7.1; +3 scorePool penalty tests in Task 7.2); full multi-file suite 40 → 44.

Reconciliation applied: constants block NOT re-declared (only the two Section-7-owned `DOWNVOTE_SCORE_*` consts added; `DOWNVOTE_GAMMA` referenced from the Phase-1 block); downvote penalty lives in `scorePool` via `dislikeVector`, NOT in `rankCandidates` and NOT reverting to legacy `scoreCandidate`; `rankCandidates` left untouched (5th arg stays `now`, owned by the ranking phase); `_pipeline` edited surgically (negative-centroid annotate + `dislikeVector` thread + `gamma` rename), leaving `generateCandidates`, the `signalSignature` watched-hash, the Discover-union and filler-union to their owning phases; `DOWNVOTE_SCORE_FLOOR_EXPORT` placeholder dropped (single real `export const DOWNVOTE_SCORE_FLOOR`); rrf de-scoped (not referenced); trending row not built here (owned by the cold-start phase); baselines stated as 31/40.

Verified: 31 `test(` calls (32nd occurrence is the import header `import { test }`). Puppeteer is genuinely installed. `index.html` exists. There is no existing `script.dom.test.js` and no DOM harness — so I'll write a real, self-contained Puppeteer harness rather than reference a nonexistent file.

Now I have all facts to finalize. Here is the reconciled ITEM 8.

### Task 24: `genreHistogram` — normalized basket genre distribution

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append new import + tests after the existing `combineProfiles` block, end of pure-fn section ~L322)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add pure helper after `generateReasons`, before `groupIntoRows`, ~L255)

`genreHistogram` is consumed by `calibrate` and `groupIntoRows` (this section) and by the engine's `groupIntoRows(recs, profile, { genreDist: genreHistogram(basketEnriched) })` call wired in a later phase. This section is its sole owner. It is a NEW pure fn — no existing test touches it.

- [ ] **Step 1: Write the failing test.** Append to `recommendations.test.js`:

```js
import { genreHistogram } from './recommendations.js';

test('genreHistogram: each item splits its genres to sum 1, averaged & normalized', () => {
  // Item A: two genres -> 0.5 each. Item B: one genre -> 1.0.
  const items = [
    { id: 1, genre_ids: [878, 28] },
    { id: 2, genre_ids: [878] },
  ];
  const h = genreHistogram(items);
  // Raw per-item contributions: 878 -> 0.5 + 1.0 = 1.5 ; 28 -> 0.5 + 0 = 0.5.
  // Averaged over 2 items: 878 -> 0.75 ; 28 -> 0.25. Already sums to 1.
  assert.ok(Math.abs(h['878'] - 0.75) < 1e-9, `878=${h['878']}`);
  assert.ok(Math.abs(h['28'] - 0.25) < 1e-9, `28=${h['28']}`);
  const total = Object.values(h).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `sum=${total}`);
});

test('genreHistogram: keys are String genre ids; empty/genreless input -> {}', () => {
  assert.deepEqual(genreHistogram([]), {});
  assert.deepEqual(genreHistogram([{ id: 9, genre_ids: [] }]), {});
  const h = genreHistogram([{ id: 1, genre_ids: [18] }]);
  assert.deepEqual(Object.keys(h), ['18']);
  assert.equal(h['18'], 1);
});
```

- [ ] **Step 2: Run it — expect FAIL** (function not exported yet):

```
node --test --test-name-pattern="genreHistogram" recommendations.test.js
```
Expected: `SyntaxError: ... does not provide an export named 'genreHistogram'` (the file fails to load; both tests reported failing). FAIL.

- [ ] **Step 3: Minimal implementation.** In `recommendations.js`, add immediately after `generateReasons` (after its closing `}` at L254, before the `groupIntoRows` comment at L256):

```js
// Normalized basket genre distribution. Each item splits its genre mass to sum 1,
// distributions are averaged over items, then renormalized. Keys are String ids.
export function genreHistogram(items) {
  const acc = {};
  let counted = 0;
  for (const it of items || []) {
    const gids = (it.genre_ids || []).map(Number).filter((n) => Number.isFinite(n));
    if (!gids.length) continue;
    counted += 1;
    const share = 1 / gids.length;
    for (const g of gids) {
      const key = String(g);
      acc[key] = (acc[key] || 0) + share;
    }
  }
  if (!counted) return {};
  let total = 0;
  for (const k of Object.keys(acc)) { acc[k] /= counted; total += acc[k]; }
  if (total > 0) for (const k of Object.keys(acc)) acc[k] /= total;
  return acc;
}
```

- [ ] **Step 4: Run it — expect PASS:**

```
node --test --test-name-pattern="genreHistogram" recommendations.test.js
```
Expected: `# pass 2  # fail 0`. PASS.

- [ ] **Step 5: Commit.**

```
git commit -am "feat(rec): genreHistogram normalized basket genre distribution"
```

---

### Task 25: `calibrate` — Steck greedy KL-minimizing genre calibration

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append after the `genreHistogram` tests)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` (add after `genreHistogram`; export)

Signature matches the contract exactly: `calibrate(scored, targetDist, { lambda = 0.5, limit, alpha = 0.01 })`, where `lambda` weights the KL term. NEW pure fn; this section owns it. It consumes `Scored[]` (the post-MMR `recs` the engine passes into `groupIntoRows`), so it tolerates the `parts` field being present or absent.

- [ ] **Step 1: Write the failing test.** Append to `recommendations.test.js`:

```js
import { calibrate } from './recommendations.js';

// Scored helper mirroring scorePool output: { movie, score, parts, reasons }.
function sc(id, genres, score) {
  return { movie: { id, genre_ids: genres, _seeds: [] }, score, parts: {}, reasons: ['r'] };
}

test('calibrate: greedy KL selection tracks the target genre mix', () => {
  // Target wants a 50/50 Sci-Fi(878)/Drama(18) mix. Pool is relevance-sorted but
  // Sci-Fi-heavy at the top; calibration must pull a Drama title up into the top 2.
  const target = { '878': 0.5, '18': 0.5 };
  const pool = [
    sc(1, [878], 0.99),
    sc(2, [878], 0.98),
    sc(3, [18], 0.50),
    sc(4, [878], 0.40),
  ];
  const out = calibrate(pool, target, { lambda: 0.5, limit: 2 });
  const ids = out.map((s) => s.movie.id);
  assert.equal(out.length, 2);
  assert.ok(ids.includes(3), `expected the Drama title pulled in, got ${ids}`);
});

test('calibrate: lambda=0 (pure relevance) keeps the top-scored prefix', () => {
  // lambda is the KL weight; lambda=0 => objective is pure relevance.
  const target = { '878': 0.5, '18': 0.5 };
  const pool = [sc(1, [878], 0.9), sc(2, [878], 0.8), sc(3, [18], 0.1)];
  const out = calibrate(pool, target, { lambda: 0, limit: 2 });
  assert.deepEqual(out.map((s) => s.movie.id), [1, 2]);
});

test('calibrate: returns the whole pool (re-ordered) when limit >= pool size', () => {
  const target = { '878': 1 };
  const pool = [sc(1, [878], 0.9), sc(2, [878], 0.8)];
  const out = calibrate(pool, target, { limit: 10 });
  assert.equal(out.length, 2);
  assert.deepEqual([...out.map((s) => s.movie.id)].sort(), [1, 2]);
});
```

- [ ] **Step 2: Run it — expect FAIL:**

```
node --test --test-name-pattern="calibrate" recommendations.test.js
```
Expected: load fails on the missing `calibrate` export / all 3 fail. FAIL.

- [ ] **Step 3: Minimal implementation.** In `recommendations.js`, add immediately after `genreHistogram`:

```js
// Steck (2018) calibrated re-ranking. Greedily picks items maximizing
//   (1-lambda)*relevance  -  lambda*KL(target || shownDistribution-with-this-item)
// where the shown distribution is genre-smoothed by alpha against the target so the
// log is finite. Pure, deterministic; relevance is the existing `score`. lambda is the
// KL weight (lambda=0 => pure relevance). Keeps gems alive (no hard relevance cutoff).
export function calibrate(scored, targetDist, { lambda = 0.5, limit, alpha = 0.01 } = {}) {
  const pool = [...scored];
  const n = limit == null ? pool.length : Math.min(limit, pool.length);
  if (n <= 0) return [];

  const targetKeys = Object.keys(targetDist || {});
  // Per-item normalized genre distribution (sums to 1; genreless => empty).
  const itemDist = (it) => {
    const gids = (it.movie.genre_ids || []).map(Number).filter(Number.isFinite);
    if (!gids.length) return {};
    const share = 1 / gids.length;
    const d = {};
    for (const g of gids) d[String(g)] = (d[String(g)] || 0) + share;
    return d;
  };
  const dists = new Map(pool.map((s) => [s, itemDist(s)]));

  // KL(target || q) with alpha-smoothing of q toward target so log is finite.
  const kl = (aggGenre, count) => {
    if (!count) return 0;
    let div = 0;
    for (const g of targetKeys) {
      const p = targetDist[g];
      if (p <= 0) continue;
      const qRaw = (aggGenre[g] || 0) / count; // mean genre mass over selected
      const q = (1 - alpha) * qRaw + alpha * p; // smoothing
      div += p * Math.log(p / q);
    }
    return div;
  };

  const selected = [];
  const agg = {};        // summed genre mass over selected items
  const used = new Set();
  for (let pos = 0; pos < n; pos++) {
    let best = null;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const s = pool[i];
      const d = dists.get(s);
      // Trial-add this item's genre mass and score the marginal objective.
      const trial = { ...agg };
      for (const g of Object.keys(d)) trial[g] = (trial[g] || 0) + d[g];
      const div = kl(trial, selected.length + 1);
      const val = (1 - lambda) * s.score - lambda * div;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    if (best == null) break;
    used.add(best);
    const chosen = pool[best];
    const d = dists.get(chosen);
    for (const g of Object.keys(d)) agg[g] = (agg[g] || 0) + d[g];
    selected.push(chosen);
  }
  return selected;
}
```

- [ ] **Step 4: Run it — expect PASS:**

```
node --test --test-name-pattern="calibrate" recommendations.test.js
```
Expected: `# pass 3  # fail 0`. PASS.

- [ ] **Step 5: Commit.**

```
git commit -am "feat(rec): Steck greedy KL calibration of genre mix"
```

---

### Task 26: Extend `generateReasons` for `rec`/`similar` SeedTags → "Because you liked ‹seedTitle›"

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (append 2 new `generateReasons:` tests after the existing pure-fn block)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` `generateReasons` ~L208-254

This changes a pure fn's behavior path. The 4 existing `generateReasons` tests (L72-99) use only person/keyword/genre seeds (`source` absent), so the new `source:'rec'|'similar'` branch never fires for them and they keep passing unchanged. No existing-test edits are needed; Step 5 re-runs the full suite to prove it. This is a TARGETED edit of a single block inside `generateReasons` — it does not rewrite the whole function.

- [ ] **Step 1: Write the failing tests.** Append to `recommendations.test.js`:

```js
test('generateReasons: rec/similar seed yields "Because you liked <seedTitle>"', () => {
  const cand = {
    genre_ids: [878],
    _seeds: [
      { source: 'rec', type: 'title', id: 1, seedId: 1, seedTitle: 'Inception', rank: 0, weight: 1 },
    ],
  };
  const reasons = generateReasons(cand, PROFILE);
  assert.equal(reasons[0], 'Because you liked Inception');
});

test('generateReasons: collaborative seed leads and dominant title still appends', () => {
  // Has a collaborative similar seed for "Interstellar" AND a person seed (5=Nolan)
  // shared by topTitle Inception -> the "esp. Inception" line still appends.
  const cand = {
    genre_ids: [878],
    _seeds: [
      { source: 'similar', type: 'title', id: 1, seedId: 1, seedTitle: 'Interstellar', rank: 2, weight: 1 },
      { source: 'discover-person', type: 'person', id: 5, name: 'Nolan', weight: 2 },
    ],
  };
  const reasons = generateReasons(cand, PROFILE);
  assert.equal(reasons[0], 'Because you liked Interstellar');
  assert.equal(reasons[1], 'esp. Inception');
});
```

- [ ] **Step 2: Run them — expect FAIL:**

```
node --test --test-name-pattern="generateReasons:" recommendations.test.js
```
Expected: the two new tests fail (`reasons[0]` is a taste theme, not `"Because you liked …"`); the 5 pre-existing `generateReasons*` tests still pass. FAIL.

- [ ] **Step 3: Minimal implementation (TARGETED edit).** In `recommendations.js`, the only change to `generateReasons` is: (a) derive `collabSeed` right after the existing `seeds` sort, and (b) make it the leading theme when present. Replace ONLY the existing block from L217 (the `// Strongest matched person/keyword seed.` comment) through L238 (the `let theme;` line) with the block below. Everything above L217 (the `matchedGenres` derivation) and the tail from the existing `if (themeParts.length >= 2)` branch onward (the `const reasons = [theme];` line and the `esp.` append) is left exactly as-is, except the `let theme;` declaration moves into the new block.

Old (L217-238):
```js
  // Strongest matched person/keyword seed.
  const seeds = [...(candidate._seeds || [])].sort((a, b) => b.weight - a.weight);
  const topSeed = seeds.find((s) => s.type === 'person' || s.type === 'keyword');

  // Dominant contributing title: a watched/starred title sharing the top seed.
  let dominantTitle = null;
  if (topSeed) {
    const shared = (profile.topTitles || []).find((t) =>
      topSeed.type === 'person'
        ? (t.peopleIds || []).includes(topSeed.id)
        : (t.keywordIds || []).includes(topSeed.id)
    );
    if (shared && shared.title) dominantTitle = shared.title;
  }

  // Build the theme.
  const themeParts = [];
  if (matchedGenres[0]) themeParts.push(matchedGenres[0]);
  if (topSeed) themeParts.push(topSeed.type === 'person' ? topSeed.name : capitalize(topSeed.name));
  else if (matchedGenres[1]) themeParts.push(matchedGenres[1]);

  let theme;
```

New:
```js
  // Strongest matched person/keyword seed.
  const seeds = [...(candidate._seeds || [])].sort((a, b) => b.weight - a.weight);
  const topSeed = seeds.find((s) => s.type === 'person' || s.type === 'keyword');

  // Collaborative provenance leads when present: TMDB rec/similar carry the producing
  // basket seed's title. Strongest such seed (by weight, then lowest rank) wins.
  const collabSeed = seeds
    .filter((s) => (s.source === 'rec' || s.source === 'similar') && s.seedTitle)
    .sort((a, b) => (b.weight - a.weight) || ((a.rank ?? 0) - (b.rank ?? 0)))[0];

  // Dominant contributing title: a watched/starred title sharing the top seed.
  let dominantTitle = null;
  if (topSeed) {
    const shared = (profile.topTitles || []).find((t) =>
      topSeed.type === 'person'
        ? (t.peopleIds || []).includes(topSeed.id)
        : (t.keywordIds || []).includes(topSeed.id)
    );
    if (shared && shared.title) dominantTitle = shared.title;
  }

  // Build the theme.
  const themeParts = [];
  if (matchedGenres[0]) themeParts.push(matchedGenres[0]);
  if (topSeed) themeParts.push(topSeed.type === 'person' ? topSeed.name : capitalize(topSeed.name));
  else if (matchedGenres[1]) themeParts.push(matchedGenres[1]);

  let theme;
  if (collabSeed) theme = `Because you liked ${collabSeed.seedTitle}`;
  else
```

The trailing `if (themeParts.length >= 2) { ... } else if (...) { ... } else { ... }` chain at L239-249 is unchanged — the inserted `else` above binds to its leading `if (themeParts.length >= 2)`, so when no collaborative seed exists the original genre/person theme logic runs verbatim. The `const reasons = [theme];` line (L251) and the `if (dominantTitle && theme !== 'Picked for your taste') reasons.push(...)` / `return reasons.slice(0, 2);` tail (L252-253) remain exactly as in the existing file.

- [ ] **Step 4: Run the new tests — expect PASS:**

```
node --test --test-name-pattern="generateReasons:" recommendations.test.js
```
Expected: the 2 new tests + all 5 pre-existing `generateReasons*` tests pass; `# fail 0`. PASS.

- [ ] **Step 5: Run the full suite to prove no regression:**

```
npm test
```
Expected: the existing 31 `recommendations.test.js` tests + watch-timer's 9 + the new pure-fn tests added by this section so far all pass; `# fail 0`. (Baseline before this section: 40 suite tests. After 8.1–8.3 this section has added genreHistogram +2, calibrate +3, generateReasons +2 = +7 → 47.)

- [ ] **Step 6: Commit.**

```
git commit -am "feat(rec): generateReasons handles rec/similar provenance"
```

---

### Task 27: Rebuild `groupIntoRows` — claim Top Picks, calibrated genre budget, cross-row dedupe, deterministic explore row, consistent `Number()` coercion

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` (4 new `groupIntoRows:` tests; one lockstep edit to an existing test — see Step 1b)
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` `groupIntoRows` ~L259-325

This section OWNS `groupIntoRows` and builds exactly the kinds `top | title | genre | explore`. The "More from ‹Person›" row uses `kind:'title'` (NOT a `'person'` kind — that is not in the contract Row.kind enum). This section does NOT build a `'trending'` row — the trending archetype is owned by the cold-start/filler phase and is appended there. Person row title stays `More from ‹Person›`.

Two existing tests reference the old `kind:'person'`:
- `groupIntoRows: "More from <Person>" groups by person seed` (L245-254) asserts `r.kind === 'person'` and `personRow.title === 'More from Villeneuve'`.

That assertion must move in lockstep to `kind === 'title'`. Step 1b shows the exact edit.

- [ ] **Step 1a: Write the failing tests.** Append to `recommendations.test.js`:

```js
// Richer scored helper that also carries quality fields the explore row reads.
function grq(id, { seeds = [], genres = [], score = 1, va = 6, vc = 100 } = {}) {
  return {
    movie: { id, genre_ids: genres, _seeds: seeds, vote_average: va, vote_count: vc },
    score, parts: {}, reasons: ['r'],
  };
}

test('groupIntoRows: no id appears in two rows (Top Picks claims its items)', () => {
  // 12 sci-fi recs all carrying a Nolan person seed; Top Picks takes the top 6,
  // themed rows must not re-list them.
  const ranked = Array.from({ length: 12 }, (_, i) =>
    grq(100 + i, { genres: [878], score: 1 - i * 0.01,
      seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 4 }] }));
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { topCount: 6, minItems: 4 });
  const seen = new Set();
  for (const row of rows) {
    for (const r of row.recs) {
      const id = String(r.movie.id);
      assert.ok(!seen.has(id), `id ${id} duplicated across rows (row kind=${row.kind})`);
      seen.add(id);
    }
  }
});

test('groupIntoRows: person row uses kind "title" and coerces string seed ids', () => {
  // Person id arrives as a STRING on the seed; the genre profile is empty so these
  // four land in the person row. A strict === on Number vs String would drop them.
  const ranked = [10, 11, 12, 13].map((id) =>
    grq(id, { seeds: [{ type: 'person', id: '7', name: 'Villeneuve', weight: 2 }] }));
  const profile = { ...GROUP_PROFILE, topTitles: [], genres: {} };
  const rows = groupIntoRows(ranked, profile, { topCount: 0, minItems: 4 });
  // Person rows are part of the 'title' kind (contract Row.kind has no 'person').
  const personRow = rows.find((r) => r.title === 'More from Villeneuve');
  assert.ok(personRow, 'expected a "More from Villeneuve" row');
  assert.equal(personRow.kind, 'title');
  assert.equal(personRow.recs.length, 4);
});

test('groupIntoRows: shown genre mix approximates the basket histogram', () => {
  // Basket histogram requests ~75% Sci-Fi(878) / 25% Drama(18).
  const genreDist = { '878': 0.75, '18': 0.25 };
  // Pool: 8 sci-fi (higher score) + 8 drama. With calibration the Top Picks of 8
  // should contain at least ONE drama title (pure greedy score would take 0).
  const ranked = [
    ...Array.from({ length: 8 }, (_, i) => grq(200 + i, { genres: [878], score: 0.9 - i * 0.01 })),
    ...Array.from({ length: 8 }, (_, i) => grq(300 + i, { genres: [18], score: 0.5 - i * 0.01 })),
  ];
  const rows = groupIntoRows(ranked, { ...GROUP_PROFILE, topTitles: [], people: {} },
    { topCount: 8, genreDist, minItems: 4 });
  const top = rows.find((r) => r.kind === 'top');
  const dramaInTop = top.recs.filter((r) => r.movie.genre_ids.includes(18)).length;
  assert.ok(dramaInTop >= 1, `expected calibration to surface >=1 drama, got ${dramaInTop}`);
});

test('groupIntoRows: exactly one deterministic explore row, stable across calls', () => {
  // High vote_average + low vote_count gems in the top basket genre (878).
  const ranked = [
    ...[40, 41, 42, 43].map((id) => grq(id, { genres: [878], score: 0.9, va: 6.5, vc: 5000 })),
    grq(50, { genres: [878], score: 0.2, va: 8.6, vc: 40 }),
    grq(51, { genres: [878], score: 0.2, va: 8.9, vc: 25 }),
    grq(52, { genres: [878], score: 0.2, va: 8.3, vc: 60 }),
    grq(53, { genres: [878], score: 0.2, va: 8.7, vc: 30 }),
  ];
  const opts = { topCount: 0, minItems: 4, genreDist: { '878': 1 } };
  const a = groupIntoRows(ranked, { ...GROUP_PROFILE, topTitles: [], people: {} }, opts);
  const b = groupIntoRows(ranked, { ...GROUP_PROFILE, topTitles: [], people: {} }, opts);
  const exploreA = a.filter((r) => r.kind === 'explore');
  const exploreB = b.filter((r) => r.kind === 'explore');
  assert.equal(exploreA.length, 1, 'exactly one explore row');
  assert.deepEqual(
    exploreA[0].recs.map((r) => r.movie.id),
    exploreB[0].recs.map((r) => r.movie.id),
    'explore row must be deterministic across calls'
  );
  // It selects the low-vote_count gems, not the popular titles.
  assert.ok(exploreA[0].recs.every((r) => r.movie.vote_count < 100));
});
```

- [ ] **Step 1b: Lockstep — update the existing person-row test.** In `recommendations.test.js`, the existing test `groupIntoRows: "More from <Person>" groups by person seed` (L245-254) asserts the obsolete `kind:'person'`. Replace its two assertion lines:

Old (L251-253):
```js
  const personRow = rows.find((r) => r.kind === 'person');
  assert.equal(personRow.title, 'More from Villeneuve');
  assert.equal(personRow.recs.length, 4);
```
New:
```js
  const personRow = rows.find((r) => r.title === 'More from Villeneuve');
  assert.ok(personRow, 'expected a "More from Villeneuve" row');
  assert.equal(personRow.kind, 'title'); // person rows are kind:'title' (contract Row.kind)
  assert.equal(personRow.recs.length, 4);
```

- [ ] **Step 2: Run them — expect FAIL:**

```
node --test --test-name-pattern="groupIntoRows:" recommendations.test.js
```
Expected: the 4 new tests fail (no `explore` row exists, Top Picks doesn't claim, no calibration, person row still emits `kind:'person'`); the edited person-row test now fails because the impl still emits `kind:'person'`; the other 5 pre-existing `groupIntoRows` tests still pass. FAIL.

- [ ] **Step 3: Minimal implementation.** Replace the entire `groupIntoRows` function (L259-325) in `recommendations.js` with the following. It builds only `top | title | genre | explore`; person rows are `kind:'title'`; no `'trending'` row is built here.

```js
export function groupIntoRows(ranked, profile, opts = {}) {
  const {
    topCount = 20,
    titleRows = 3,
    genreRows = 3,
    personRows = 2,
    minItems = 4,
    maxRows = 10,
    itemsPerRow = 20,
    genreDist = null,       // basket genreHistogram for calibration + budget
    exploreCount = 8,
    exploreMinVote = 6.5,   // vote_average floor for a "gem"
    exploreMaxCount = 2000, // vote_count ceiling for a "gem"
  } = opts;

  const rows = [];

  // One global placed-Set: a title appears in at most one row.
  const placed = new Set();
  const recId = (r) => String(r.movie.id);
  const num = (v) => Number(v);                       // consistent coercion everywhere
  const seedHas = (r, type, id) =>
    (r.movie._seeds || []).some((s) => s.type === type && num(s.id) === num(id));

  // 1. Top picks — global best-N, genre-calibrated to the basket, and CLAIMS its items.
  if (ranked.length && topCount > 0) {
    let recs;
    if (genreDist && Object.keys(genreDist).length) {
      recs = calibrate(ranked, genreDist, { lambda: 0.5, limit: topCount });
    } else {
      recs = ranked.slice(0, topCount);
    }
    recs.forEach((r) => placed.add(recId(r)));
    rows.push({ kind: 'top', title: 'Top picks for you', recs });
  }

  const take = (predicate) => ranked
    .filter((r) => !placed.has(recId(r)) && predicate(r))
    .slice(0, itemsPerRow);
  const claim = (recs) => recs.forEach((r) => placed.add(recId(r)));

  // 2. Because you watched X — strongest contributing titles by profile weight (kind 'title').
  for (const t of (profile.topTitles || []).slice(0, titleRows)) {
    const kw = new Set((t.keywordIds || []).map(num));
    const pp = new Set((t.peopleIds || []).map(num));
    const recs = take((r) => (r.movie._seeds || []).some((s) =>
      (s.type === 'keyword' && kw.has(num(s.id))) || (s.type === 'person' && pp.has(num(s.id)))));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'title', title: `Because you watched ${t.title}`, recs });
    }
  }

  // 3. More <Genre> — budget allocated by the basket genre histogram when present.
  const genreOrder = genreDist && Object.keys(genreDist).length
    ? Object.entries(genreDist).sort((a, b) => b[1] - a[1]).map(([id]) => num(id))
    : Object.entries(profile.genres || {})
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1]).map(([id]) => num(id));
  for (const gid of genreOrder.slice(0, genreRows)) {
    // Budget proportional to histogram mass (min the row floor), capped at itemsPerRow.
    const budget = genreDist
      ? Math.max(minItems, Math.round((genreDist[String(gid)] || 0) * itemsPerRow))
      : itemsPerRow;
    const recs = ranked
      .filter((r) => !placed.has(recId(r)) && (r.movie.genre_ids || []).map(num).includes(gid))
      .slice(0, Math.min(budget, itemsPerRow));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'genre', title: `More ${GENRE_NAMES.get(gid) || 'like this'}`, recs });
    }
  }

  // 4. More from <Person> — top profile people by weight. Contract Row.kind has no
  // 'person' archetype, so these are 'title' rows (a person is a "because you liked" facet).
  const topPeople = Object.entries(profile.people || {})
    .sort((a, b) => b[1].weight - a[1].weight).slice(0, personRows);
  for (const [pidStr, { name }] of topPeople) {
    const pid = num(pidStr);
    const recs = take((r) => seedHas(r, 'person', pid));
    if (recs.length >= minItems) {
      claim(recs);
      rows.push({ kind: 'title', title: `More from ${name}`, recs });
    }
  }

  // 5. Exactly one DETERMINISTIC explore row: high-rating, low-vote-count gems in the
  // top basket genre. Stable selection (sort key, no Math.random); claims its items.
  const topGenre = genreOrder[0];
  if (topGenre != null) {
    const gems = ranked
      .filter((r) => !placed.has(recId(r))
        && (r.movie.genre_ids || []).map(num).includes(topGenre)
        && num(r.movie.vote_average) >= exploreMinVote
        && num(r.movie.vote_count) > 0
        && num(r.movie.vote_count) < exploreMaxCount)
      // Deterministic: rarest first (lowest vote_count), then highest rating, then id.
      .sort((a, b) =>
        (num(a.movie.vote_count) - num(b.movie.vote_count))
        || (num(b.movie.vote_average) - num(a.movie.vote_average))
        || (num(a.movie.id) - num(b.movie.id)))
      .slice(0, exploreCount);
    if (gems.length >= minItems) {
      claim(gems);
      rows.push({
        kind: 'explore',
        title: `Hidden gems in ${GENRE_NAMES.get(topGenre) || 'your taste'}`,
        recs: gems,
      });
    }
  }

  return rows.slice(0, maxRows);
}
```

- [ ] **Step 4: Run the `groupIntoRows:` tests — expect PASS:**

```
node --test --test-name-pattern="groupIntoRows:" recommendations.test.js
```
Expected: all `groupIntoRows:` tests (5 retained existing — including the lockstep-edited person-row test — + 4 new) pass; `# fail 0`. PASS.

- [ ] **Step 5: Lockstep sanity — the existing genre/explore interaction.** The existing test `groupIntoRows: genre row labelled from config and deduped against earlier rows` passes `topCount:0` and no `genreDist`, so the genre budget falls back to `itemsPerRow` and the explore branch requires `vote_average >= 6.5`, which those fixtures lack (`gr()` sets none → `Number(undefined) = NaN`, excluded) — so no explore row appears and its `[30,31,32,33]` assertion is unchanged. No edit needed. Re-run to confirm:

```
node --test --test-name-pattern="genre row labelled from config" recommendations.test.js
```
Expected: `# pass 1  # fail 0`. PASS.

- [ ] **Step 6: Run the full suite — expect PASS:**

```
npm test
```
Expected: the 31 `recommendations.test.js` tests (one mutated in lockstep, count unchanged) + this section's new pure-fn tests + watch-timer's 9 all pass; `# fail 0`. (After 8.1–8.4: baseline 40 + genreHistogram 2 + calibrate 3 + generateReasons 2 + groupIntoRows 4 = 51.)

- [ ] **Step 7: Commit.**

```
git commit -am "feat(rec): rebuild groupIntoRows with claim/calibrate/dedupe/explore"
```

---

### Task 28: Render per-row + per-card evidence labels and the cold-start lead rail (script.js DOM)

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/script.js` `renderRecommendationsPage` ~L2047-2093, `buildRecRail` ~L1967-1999, `createRecommendationCard` ~L1869-1962
- `/home/tahseen-dar/Projects/MoviesDB/rec-dom-harness.mjs` (NEW — real Puppeteer harness; the repo already depends on `puppeteer`)

The `REC_ROW_KICKERS` map keys ONLY the kinds this section's `groupIntoRows` actually builds — `top`, `title`, `genre`, `explore`. There is intentionally NO `trending` key here: the trending row is owned by the cold-start/filler phase, which appends its own kicker when it builds that row. `buildRecRail` returns the `.rec-rail-section`; the `rec-row-<kind>` class is added to that section element (its child `.rec-rail` therefore sits under a `.rec-row-<kind>` ancestor, which the CSS in the next task relies on). The variable is named `railSection` to match what is actually returned.

- [ ] **Step 1: Add the per-row evidence kicker + cold-start lead rail to `renderRecommendationsPage`.** This is the ONLY edit to the page-build block; it folds the kicker map, the `rec-row-<kind>` class, and the cold-start relabel into one place. Edit the empty-basket guard (L2061-2066) and the page-build block (L2089-2092).

First, replace the empty-basket early return (L2061-2066) so the page knows whether it is in cold-start mode (the engine returns a filler-led row set; the lead rail is relabelled):

Old (L2061-2066):
```js
  const items = buildSignalItems();
  if (items.basket.length === 0) {
    setLoading(false);
    main.innerHTML = '<p class="no-results rec-empty">Add titles to your basket with ★ to build your recommendations.</p>';
    return;
  }
```
New:
```js
  const items = buildSignalItems();
  const coldStart = items.basket.length === 0;
```

Then replace the page-build block (L2089-2092):

Old (L2089-2092):
```js
  const page = document.createElement('div');
  page.className = 'rec-page';
  rows.forEach((row) => page.appendChild(buildRecRail(row.recs, { heading: row.title })));
  main.appendChild(page);
```
New:
```js
  const page = document.createElement('div');
  page.className = 'rec-page';
  if (coldStart) page.classList.add('rec-cold-start');
  // Kickers only for the row kinds groupIntoRows builds; the filler phase supplies
  // the 'trending' kicker when it appends that row.
  const REC_ROW_KICKERS = {
    top: 'Calibrated to your basket',
    title: 'Because you liked it',
    genre: 'More of this genre',
    explore: 'A little different',
  };
  rows.forEach((row, i) => {
    // Cold start: the engine returns a filler-led path; relabel the lead rail.
    const heading = coldStart && i === 0 ? 'Trending to get started' : row.title;
    const kicker = coldStart && i === 0 ? 'Popular right now' : (REC_ROW_KICKERS[row.kind] || null);
    const railSection = buildRecRail(row.recs, { kicker, heading });
    railSection.classList.add(`rec-row-${row.kind}`);
    railSection.setAttribute('data-rec-kind', row.kind);
    if (row.kind === 'explore') railSection.classList.add('rec-explore');
    page.appendChild(railSection);
  });
  main.appendChild(page);
```

(No `rows.length === 0` guard change is needed: when `coldStart` is true the engine still returns rows via the filler path; if it genuinely returns none, the existing `rows.length === 0` block at L2084-2087 handles it.)

- [ ] **Step 2: Per-card collaborative provenance hook in `createRecommendationCard`.** The card already renders `rec.reasons[0]` into `.rec-because`; with the `generateReasons` change earlier in this section, `reasons[0]` is already `"Because you liked ‹Seed›"` for collaborative candidates, so the text needs no change. Add a `data-rec-source` attribute so the headless harness can assert provenance. Edit the `.rec-because` text creation (L1945-1946):

Old (L1945-1946):
```js
  const theme = rec.reasons[0] || 'Picked for your taste';
  because.appendChild(document.createTextNode(theme));
```
New:
```js
  const theme = rec.reasons[0] || 'Picked for your taste';
  because.appendChild(document.createTextNode(theme));
  const collab = (movie._seeds || []).find((s) => s.source === 'rec' || s.source === 'similar');
  if (collab) because.setAttribute('data-rec-source', collab.source);
```

- [ ] **Step 3: Write the headless harness.** Create `/home/tahseen-dar/Projects/MoviesDB/rec-dom-harness.mjs`. It launches headless Chrome via the already-installed `puppeteer`, builds a fixed rows fixture (no network — TMDB is never hit), injects the real `buildRecRail` / `createRecommendationCard` DOM by loading `index.html` and stubbing `getRecommendationRows`, then asserts the DOM contract and a real `$eval` click. To keep it self-contained and deterministic, the harness renders the rec DOM directly from the production functions exported for test via a tiny inline page rather than driving the full app boot:

```js
// rec-dom-harness.mjs — runnable headless verification of the rec-page DOM contract.
// Uses the installed puppeteer. No network: a fixed rows fixture is rendered by the
// SAME buildRecRail/createRecommendationCard code pulled from script.js into the page.
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const scriptSrc = readFileSync(new URL('./script.js', import.meta.url), 'utf8');

// Extract the two pure-DOM builders from script.js by name so we exercise the REAL code.
function slice(name) {
  const start = scriptSrc.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in script.js`);
  // Balance braces from the first '{' after the signature.
  let i = scriptSrc.indexOf('{', start);
  let depth = 0;
  for (; i < scriptSrc.length; i++) {
    if (scriptSrc[i] === '{') depth++;
    else if (scriptSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return scriptSrc.slice(start, i);
}

const createCardSrc = slice('createRecommendationCard');
const buildRailSrc = slice('buildRecRail');

// Minimal page that defines the globals those two functions reference, then renders
// a fixed fixture using the SAME page-build logic as renderRecommendationsPage.
const html = `<!doctype html><html><head><meta charset="utf8"></head><body>
<main id="main"></main>
<script>
  const CONFIG = { IMAGE_URL: '' };
  function createStarButton() { const b = document.createElement('button'); b.className='star-btn'; return b; }
  function createDownvoteButton() { const b = document.createElement('button'); b.className='dv-btn'; return b; }
  let played = null;
  function openPlayer(movie) { played = movie.id; window.__played = movie.id; }
  ${createCardSrc}
  ${buildRailSrc}

  // Fixture mirrors groupIntoRows output: one collaborative card + an explore row.
  const rows = [
    { kind: 'top', title: 'Top picks for you', recs: [
      { movie: { id: 1, title: 'Inception', media_type: 'movie', vote_average: 8.8, vote_count: 30000,
                 _seeds: [{ source: 'rec', type: 'title', seedTitle: 'Interstellar', weight: 1 }] },
        score: 1, reasons: ['Because you liked Interstellar'] },
      { movie: { id: 2, title: 'Arrival', media_type: 'movie', vote_average: 7.9, vote_count: 20000, _seeds: [] },
        score: 0.9, reasons: ['Matches your love of Sci-Fi'] },
    ] },
    { kind: 'explore', title: 'Hidden gems in Sci-Fi', recs: [
      { movie: { id: 3, title: 'Coherence', media_type: 'movie', vote_average: 8.6, vote_count: 40, _seeds: [] },
        score: 0.3, reasons: ['A rarer pick'] },
    ] },
  ];

  const REC_ROW_KICKERS = {
    top: 'Calibrated to your basket',
    title: 'Because you liked it',
    genre: 'More of this genre',
    explore: 'A little different',
  };
  const page = document.createElement('div');
  page.className = 'rec-page';
  rows.forEach((row, i) => {
    const kicker = REC_ROW_KICKERS[row.kind] || null;
    const railSection = buildRecRail(row.recs, { kicker, heading: row.title });
    railSection.classList.add('rec-row-' + row.kind);
    railSection.setAttribute('data-rec-kind', row.kind);
    if (row.kind === 'explore') railSection.classList.add('rec-explore');
    page.appendChild(railSection);
  });
  document.getElementById('main').appendChild(page);
</script>
</body></html>`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });

  // (a) every rail-section carries a rec-row-<kind> class AND a non-empty .rec-kicker.
  const railInfo = await page.$$eval('.rec-rail-section', (els) =>
    els.map((el) => ({
      kind: el.getAttribute('data-rec-kind'),
      hasKindClass: [...el.classList].some((c) => c.startsWith('rec-row-')),
      kicker: el.querySelector('.rec-kicker')?.textContent || '',
    })));
  assert.ok(railInfo.length >= 1, 'expected at least one rail');
  for (const r of railInfo) {
    assert.ok(r.hasKindClass, `rail kind=${r.kind} missing rec-row-* class`);
    assert.ok(r.kicker.length > 0, `rail kind=${r.kind} has empty kicker`);
  }

  // (b) exactly one explore rail.
  const exploreCount = await page.$$eval('.rec-explore', (els) => els.length);
  assert.equal(exploreCount, 1, 'exactly one .rec-explore rail');

  // (c) the collaborative card exposes data-rec-source="rec".
  const src = await page.$eval('.rec-card[data-rec-source]', (el) => el.getAttribute('data-rec-source'));
  assert.equal(src, 'rec', 'collaborative card must carry data-rec-source');

  // (d) clicking a card via $eval (not coordinate click) opens the player.
  await page.$eval('.rec-card', (el) => el.click());
  const played = await page.evaluate(() => window.__played);
  assert.equal(played, 1, 'clicking the first card opens its player');

  console.log('rec-dom-harness: PASS');
} finally {
  await browser.close();
}
```

- [ ] **Step 4: Run the headless harness — expect PASS:**

```
node rec-dom-harness.mjs
```
Expected: prints `rec-dom-harness: PASS` and exits 0. If Chrome cannot launch sandboxed in the CI container, it already passes `--no-sandbox`; on a still-restricted host run `PUPPETEER_EXECUTABLE_PATH=$(command -v chromium || command -v google-chrome) node rec-dom-harness.mjs`. PASS.

- [ ] **Step 5: Commit.**

```
git commit -am "feat(rec): evidence labels, explore-row class & cold-start lead rail rendering"
```

---

### Task 29: Minimal `style.css` for the explore row and evidence label

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/style.css` (append immediately before the `@media (max-width: 640px)` block at L1413)
- `/home/tahseen-dar/Projects/MoviesDB/rec-css-harness.mjs` (NEW — real Puppeteer check that the accent computes)

The explore accent targets `.rec-row-explore .rec-rail::after`. `buildRecRail` returns the `.rec-rail-section`, and Task 8.5 adds `rec-row-explore` to that section, so `.rec-rail` (its child) sits under a `.rec-row-explore` ancestor — the descendant selector resolves correctly. `--rec-gold` / `--rec-gold-soft` are already defined (L1142-1143, L1240-1241).

- [ ] **Step 1: Add the styles.** Insert before the `@media (max-width: 640px)` block (L1413):

```css
/* Per-row evidence kicker reuses .rec-kicker; explore row gets a distinct accent. */
.rec-explore .rec-kicker {
  color: var(--rec-gold);
}
.rec-explore .rec-heading::before {
  content: '✦ ';
  color: var(--rec-gold-soft);
  font-size: 0.85em;
}
.rec-row-explore { position: relative; }
.rec-row-explore .rec-rail::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: 16px;
  box-shadow: inset 0 0 0 1px rgba(214, 178, 92, 0.18);
}

/* Per-card collaborative evidence label emphasis. */
.rec-because[data-rec-source] {
  color: var(--rec-gold-soft);
}
.rec-because[data-rec-source] .rec-spark {
  color: var(--rec-gold);
}

/* Cold-start "Trending to get started" page tint. */
.rec-cold-start .rec-row-top .rec-heading {
  letter-spacing: 0.01em;
}
```

- [ ] **Step 2: Write the CSS verification harness.** Create `/home/tahseen-dar/Projects/MoviesDB/rec-css-harness.mjs`. It loads the real `style.css`, builds a minimal `.rec-row-explore > .rec-rail` element, and asserts the `::after` inset box-shadow resolves to a non-`none` value (proving the rule loaded and applies):

```js
// rec-css-harness.mjs — confirms style.css loads and the explore accent computes.
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf8"><style>${css}</style></head>
<body>
  <section class="rec-rail-section rec-row-explore rec-explore">
    <div class="rec-header"><span class="rec-kicker">A little different</span>
      <h2 class="rec-heading">Hidden gems</h2></div>
    <div class="rec-rail"><div class="rec-scroller"></div></div>
  </section>
  <p class="rec-because" data-rec-source="rec">Because you liked X</p>
</body></html>`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });

  const shadow = await page.$eval('.rec-row-explore .rec-rail',
    (el) => getComputedStyle(el, '::after').boxShadow);
  assert.notEqual(shadow, 'none', `explore rail ::after box-shadow should be set, got "${shadow}"`);

  const becauseColor = await page.$eval('.rec-because[data-rec-source]',
    (el) => getComputedStyle(el).color);
  assert.ok(/^rgb/.test(becauseColor), `evidence label color should resolve, got "${becauseColor}"`);

  console.log('rec-css-harness: PASS');
} finally {
  await browser.close();
}
```

- [ ] **Step 3: Run the CSS harness — expect PASS:**

```
node rec-css-harness.mjs
```
Expected: prints `rec-css-harness: PASS` and exits 0 (the `::after` box-shadow is a non-`none` inset string; the evidence-label color resolves to an `rgb(...)`). PASS.

- [ ] **Step 4: Commit.**

```
git commit -am "style(rec): explore row accent & collaborative evidence label"
```

I now have full context. Key facts confirmed: 31 tests currently; `signalSignature` is 2-arg private at L463; `generateCandidates(profile)` at L418/L495; `combineProfiles(posProfile, negProfile, { penalty })` at L493; META cache at L342-398; `ENDPOINTS.topRated` does NOT exist yet (only `topRatedMovies` at L65), `trending` exists at L36.

Now I apply the reconciliation rules. Critical fixes for my section: drop the `COLD_START_FULL` const declaration (owned earlier in Phase 1), use real baselines (31/40), make ENDPOINTS.topRated reference (not re-add — owned by config section), use the agreed `signalSignature(basket, downvoted, watchedIds)` and merge with the agreed `_pipeline` shape, own the trending row in `groupIntoRows`, and de-scope rrf (already not referenced here).

I also need to align `generateCandidates` with the reconciled single-signature-with-coordinated-set contract. Per the reconciliation, ITEM 9 adds `fillerCandidates(basketSize)` + a TARGETED merge edit and the empty-basket path — it must NOT re-paste the whole function. And the candidate-generation in `_pipeline` is owned earlier; ITEM 9 does a targeted edit to blend filler.

Here is the finalized section.

---

### Task 30: Pure `coldStartBlend` helper

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — new export in the pure-helpers block (directly after `mergeCandidates`). Uses `COLD_START_FULL` (declared earlier in the canonical constants block in Phase 1; do NOT re-declare it here).
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` — extend the second import line + append tests.

- [ ] **Step 1: Write the failing test for `coldStartBlend`.**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js`, change the second import line (currently `import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates } from './recommendations.js';` at L4) to add `coldStartBlend`:
  ```js
  import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, coldStartBlend } from './recommendations.js';
  ```
  Append these tests. The blend is pure and order-deterministic: it keeps **all** personalized candidates (deduped by id) first as the `personalizedWeight = min(1, basketSize / COLD_START_FULL)` share, then appends filler (deduped, skipping ids already present) so filler makes up the `(1 - personalizedWeight)` share of the pool. Empty basket (p=0) yields filler only; a full basket (size ≥ `COLD_START_FULL`=5, p=1) yields personalized only.
  ```js
  const mkBlendC = (id) => ({ id, media_type: 'movie', genre_ids: [], vote_average: 7, vote_count: 100, popularity: 1, _seeds: [] });

  test('coldStartBlend: empty basket returns filler only (100% filler)', () => {
    const filler = [mkBlendC(10), mkBlendC(11), mkBlendC(12)];
    const out = coldStartBlend([mkBlendC(1), mkBlendC(2)], filler, 0);
    assert.deepEqual(out.map((c) => c.id), [10, 11, 12]);
  });

  test('coldStartBlend: full basket (size >= COLD_START_FULL) returns personalized only', () => {
    const personal = [mkBlendC(1), mkBlendC(2), mkBlendC(3)];
    const filler = [mkBlendC(10), mkBlendC(11)];
    const out = coldStartBlend(personal, filler, 5);
    assert.deepEqual(out.map((c) => c.id), [1, 2, 3]);
  });

  test('coldStartBlend: half-full basket keeps all personalized, fills filler to (1-p) of pool', () => {
    // basketSize 2 -> p = 2/5 = 0.4 ; keep 3 personalized as the 0.4 share
    // poolSize = round(personalCount / p) = round(3 / 0.4) = round(7.5) = 8 ; filler slots = 8 - 3 = 5
    const personal = [mkBlendC(1), mkBlendC(2), mkBlendC(3)];
    const filler = [mkBlendC(10), mkBlendC(11), mkBlendC(12), mkBlendC(13), mkBlendC(14), mkBlendC(15), mkBlendC(16)];
    const out = coldStartBlend(personal, filler, 2);
    assert.deepEqual(out.map((c) => c.id), [1, 2, 3, 10, 11, 12, 13, 14]);
  });

  test('coldStartBlend: dedupes filler ids already present in personalized', () => {
    const personal = [mkBlendC(1), mkBlendC(2)];
    const filler = [mkBlendC(2), mkBlendC(20), mkBlendC(21)];   // id 2 is a dup -> skipped
    // p = 1/5 = 0.2 ; poolSize = round(2/0.2) = 10 ; filler slots = 8 (only 2 unique filler available)
    const out = coldStartBlend(personal, filler, 1);
    assert.deepEqual(out.map((c) => c.id), [1, 2, 20, 21]);
  });

  test('coldStartBlend: filler shortfall is fine (returns what it has)', () => {
    const out = coldStartBlend([mkBlendC(1)], [], 0); // p=0 -> filler-only path, no filler -> empty
    assert.deepEqual(out.map((c) => c.id), []);
  });
  ```
  Run it:
  ```
  node --test --test-name-pattern="coldStartBlend" recommendations.test.js
  ```
  Expected: **FAIL** — `TypeError: coldStartBlend is not a function` (not exported yet), 0 passing.

- [ ] **Step 2: Implement `coldStartBlend` (minimal).**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, add this export in the pure-helpers block, directly after `mergeCandidates`. `COLD_START_FULL` is already declared in the canonical constants block (Phase 1) — do NOT add it here.
  ```js
  // Blend personalized candidates with cold-start filler. personalizedWeight rises with basket
  // size: min(1, basketSize / COLD_START_FULL). Empty basket => filler only; a full basket =>
  // personalized only. Deterministic order: personalized first, then filler to fill the
  // (1 - personalizedWeight) share of the pool. Both sides deduped by id.
  export function coldStartBlend(personalCandidates, fillerCandidates, basketSize) {
    const personal = personalCandidates || [];
    const filler = fillerCandidates || [];
    const p = Math.min(1, (basketSize || 0) / COLD_START_FULL);

    // Empty/zero-weight basket: filler-only (deduped).
    if (p <= 0) {
      const out = [];
      const seen = new Set();
      for (const c of filler) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
      }
      return out;
    }

    // Keep all personalized (deduped); they represent the personalizedWeight share.
    const out = [];
    const seen = new Set();
    for (const c of personal) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    if (p >= 1) return out; // full basket: personalized only.

    // Size the pool so filler makes up the (1 - p) share.
    const poolSize = Math.round(out.length / p);
    const fillerSlots = Math.max(0, poolSize - out.length);
    let added = 0;
    for (const c of filler) {
      if (added >= fillerSlots) break;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      added += 1;
    }
    return out;
  }
  ```
  Run it:
  ```
  node --test --test-name-pattern="coldStartBlend" recommendations.test.js
  ```
  Expected: **5 passing**, 0 failing.

- [ ] **Step 3: Full suite regression + commit.**
  ```
  npm test
  ```
  Expected: baseline 31 tests in recommendations.test.js + 5 new `coldStartBlend` tests = **36 in this file**; full suite (was 40) is now **45 passing**, 0 failing. (No existing pure-fn behavior changed.)
  ```
  git add recommendations.js recommendations.test.js
  git commit -m "feat(rec): pure coldStartBlend filler blend"
  ```

### Task 31: `signalSignature` includes a stable hash of sorted watchedIds (canonical 3-arg owner)

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — `signalSignature` at L461-466 (export + add `watchedIds`); add pure `hashIds` helper alongside it.
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` — extend the first import line + append tests.

This task is the SINGLE owner of the `signalSignature(basket, downvoted, watchedIds)` signature. The `_pipeline` sig callsite is updated here in Step 3; the engine's canonical `_pipeline` (built earlier in Phase 1) MUST call this 3-arg form — no later edit may revert it to the 2-arg call.

- [ ] **Step 1: Write the failing test.**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js`, change the first recommendations import (currently `import { recencyWeight, ratingNudge, buildTasteProfile } from './recommendations.js';` at L3) to add `signalSignature`:
  ```js
  import { recencyWeight, ratingNudge, buildTasteProfile, signalSignature } from './recommendations.js';
  ```
  Append these tests:
  ```js
  const mkSigM = (id) => ({ id, media_type: 'movie' });

  test('signalSignature: same basket + a newly-watched id changes the signature', () => {
    const basket = [mkSigM(1), mkSigM(2)];
    const down = [mkSigM(9)];
    const before = signalSignature(basket, down, [100, 101]);
    const after = signalSignature(basket, down, [100, 101, 102]); // watched one more
    assert.notEqual(before, after);
  });

  test('signalSignature: watchedIds hash is order-independent', () => {
    const basket = [mkSigM(1)];
    const a = signalSignature(basket, [], [3, 1, 2]);
    const b = signalSignature(basket, [], [2, 3, 1]);
    assert.equal(a, b);
  });

  test('signalSignature: identical signals produce an identical signature', () => {
    const a = signalSignature([mkSigM(2), mkSigM(1)], [mkSigM(5)], [7, 8]);
    const b = signalSignature([mkSigM(1), mkSigM(2)], [mkSigM(5)], [8, 7]);
    assert.equal(a, b);
  });

  test('signalSignature: empty watchedIds is stable and distinct from non-empty', () => {
    const empty = signalSignature([mkSigM(1)], [], []);
    const nonEmpty = signalSignature([mkSigM(1)], [], [1]);
    assert.equal(empty, signalSignature([mkSigM(1)], [], undefined));
    assert.notEqual(empty, nonEmpty);
  });
  ```
  Run it:
  ```
  node --test --test-name-pattern="signalSignature" recommendations.test.js
  ```
  Expected: **FAIL** — `TypeError: signalSignature is not a function` (currently private, 2-arg), 0 passing.

- [ ] **Step 2: Implement — export `signalSignature` with a watchedIds hash.**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, replace the existing private `signalSignature` (L461-466):
  ```js
  // Stable signature of the explicit signal set (basket + downvoted) for session caching.
  // Toggling a star or a downvote changes this, busting the cache.
  function signalSignature(basket, downvoted) {
    const ids = (arr) => (arr || []).map((m) => m.id).sort().join(',');
    return `b:${ids(basket)}|d:${ids(downvoted)}`;
  }
  ```
  with the exported, watched-aware version plus a pure `hashIds` helper:
  ```js
  // Order-independent FNV-1a hash of a sorted numeric id list. Deterministic, no clock.
  function hashIds(ids) {
    const sorted = (ids || []).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    let h = 0x811c9dc5;
    const s = sorted.join(',');
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  // Stable signature of the full signal set (basket + downvoted + watchedIds) for session
  // caching. Toggling a star/downvote OR watching a new title changes this, busting the cache.
  export function signalSignature(basket, downvoted, watchedIds) {
    const ids = (arr) => (arr || []).map((m) => m.id).sort().join(',');
    return `b:${ids(basket)}|d:${ids(downvoted)}|w:${hashIds(watchedIds)}`;
  }
  ```
  Run it:
  ```
  node --test --test-name-pattern="signalSignature" recommendations.test.js
  ```
  Expected: **4 passing**, 0 failing.

- [ ] **Step 3: Update the `_pipeline` sig callsite to the 3-arg form (targeted one-line edit).**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, in `_pipeline` change the sig line (L477). The canonical `_pipeline` (built earlier in Phase 1) already binds `const watchedIds = input.watchedIds || [];`. Change:
  ```js
  const sig = signalSignature(basket, downvoted);
  ```
  to:
  ```js
  const sig = signalSignature(basket, downvoted, watchedIds);
  ```
  The `cacheKey`/read/write block (gating on `cached.sig === sig`) stays as-is — the watched-aware `sig` now correctly invalidates a same-basket cache when a title is watched. This is the ONLY edit to this line; no later task re-pastes `_pipeline`.
  Run the full suite (no regression):
  ```
  npm test
  ```
  Expected: prior total (45 after Phase tasks so far) + 4 new `signalSignature` tests = **49 passing**, 0 failing.

- [ ] **Step 4: Commit.**
  ```
  git add recommendations.js recommendations.test.js
  git commit -m "feat(rec): watched-aware signalSignature cache key"
  ```

### Task 32: Versioned + TTL + size-bounded META cache prune helper

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — META cache: add version/TTL/size constants near `META_CACHE_KEY` (L342); add pure `pruneMetaCache`; rewrite `readMetaCache` (L349-355), `writeMetaEntry` (L357-365), and the two cache touch-points in `fetchTitleMeta` (L374-398).
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` — extend the second import line + append tests.

The meta cache is currently a flat `{ [cacheKey]: meta }` map, persisted permanently and unbounded. We harden it to a versioned envelope `{ version, entries: { [cacheKey]: { meta, savedAt } } }`, prune entries older than the TTL, and cap the entry count (LRU-by-`savedAt`, keeping newest). The prune is a **pure** function taking injected `now`.

- [ ] **Step 1: Write the failing test for `pruneMetaCache`.**
  `pruneMetaCache(cache, now, { version, ttlMs, maxEntries })` returns a fresh versioned cache:
  - `cache.version !== version` (or malformed/legacy flat map) → `{ version, entries: {} }`.
  - Drop any entry whose `savedAt < now - ttlMs`.
  - If more than `maxEntries` survive, keep the `maxEntries` newest by `savedAt`.

  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js`, extend the second import line (now `import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, coldStartBlend } from './recommendations.js';` after Task 9.1) to add `pruneMetaCache`:
  ```js
  import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, coldStartBlend, pruneMetaCache } from './recommendations.js';
  ```
  Append these tests (`NOW` and `DAY` already exist at L6-7):
  ```js
  const META_V = 2;                               // mirrors META_CACHE_VERSION in recommendations.js
  const META_TTL = 7 * 24 * 60 * 60 * 1000;       // mirrors META_CACHE_TTL_MS (7 days)
  const mkMetaEntry = (savedAt) => ({ meta: { keywords: [], people: [] }, savedAt });

  test('pruneMetaCache: wrong/missing version is discarded to an empty versioned cache', () => {
    const legacyFlat = { 'movie:1': { keywords: [], people: [] } }; // no version envelope
    const out = pruneMetaCache(legacyFlat, NOW, { version: META_V, ttlMs: META_TTL, maxEntries: 50 });
    assert.deepEqual(out, { version: META_V, entries: {} });

    const wrongVer = { version: 1, entries: { 'movie:1': mkMetaEntry(NOW) } };
    const out2 = pruneMetaCache(wrongVer, NOW, { version: META_V, ttlMs: META_TTL, maxEntries: 50 });
    assert.deepEqual(out2, { version: META_V, entries: {} });
  });

  test('pruneMetaCache: drops entries older than TTL, keeps fresh ones', () => {
    const cache = {
      version: META_V,
      entries: {
        fresh: mkMetaEntry(NOW - DAY),            // 1 day old -> keep
        edge: mkMetaEntry(NOW - META_TTL + 1),    // just inside TTL -> keep
        stale: mkMetaEntry(NOW - META_TTL - 1),   // just past TTL -> drop
      },
    };
    const out = pruneMetaCache(cache, NOW, { version: META_V, ttlMs: META_TTL, maxEntries: 50 });
    assert.equal(out.version, META_V);
    assert.deepEqual(Object.keys(out.entries).sort(), ['edge', 'fresh']);
  });

  test('pruneMetaCache: caps entry count, keeping the newest by savedAt', () => {
    const cache = {
      version: META_V,
      entries: {
        a: mkMetaEntry(NOW - 4),
        b: mkMetaEntry(NOW - 3),
        c: mkMetaEntry(NOW - 2),
        d: mkMetaEntry(NOW - 1),
      },
    };
    const out = pruneMetaCache(cache, NOW, { version: META_V, ttlMs: META_TTL, maxEntries: 2 });
    assert.deepEqual(Object.keys(out.entries).sort(), ['c', 'd']); // two newest survive
  });

  test('pruneMetaCache: a clean in-version cache within bounds passes through unchanged', () => {
    const cache = {
      version: META_V,
      entries: { 'movie:1': mkMetaEntry(NOW - DAY), 'tv:2': mkMetaEntry(NOW - 2 * DAY) },
    };
    const out = pruneMetaCache(cache, NOW, { version: META_V, ttlMs: META_TTL, maxEntries: 50 });
    assert.deepEqual(out, cache);
  });
  ```
  Run it:
  ```
  node --test --test-name-pattern="pruneMetaCache" recommendations.test.js
  ```
  Expected: **FAIL** — `TypeError: pruneMetaCache is not a function`, 0 passing.

- [ ] **Step 2: Implement constants + `pruneMetaCache` (pure).**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, after `META_CACHE_KEY` (L342) add the versioning/TTL/size constants (these are cache-layer constants, NOT part of the shared tuning constants block; safe to add here):
  ```js
  const META_CACHE_VERSION = 2;                      // bump to discard stale-schema entries
  const META_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7-day TTL on per-title enrichment
  const META_CACHE_MAX_ENTRIES = 500;                // size bound (LRU-by-savedAt)
  ```
  Then add the pure prune helper (export it; place it just above `readMetaCache`):
  ```js
  // Pure: normalize + prune a versioned meta cache. Discards a wrong/legacy version wholesale,
  // drops entries older than ttlMs, and caps to the newest maxEntries by savedAt. Injected now.
  export function pruneMetaCache(cache, now, opts = {}) {
    const version = opts.version ?? META_CACHE_VERSION;
    const ttlMs = opts.ttlMs ?? META_CACHE_TTL_MS;
    const maxEntries = opts.maxEntries ?? META_CACHE_MAX_ENTRIES;

    if (!cache || typeof cache !== 'object' || cache.version !== version || !cache.entries) {
      return { version, entries: {} };
    }

    const cutoff = now - ttlMs;
    let kept = Object.entries(cache.entries).filter(
      ([, e]) => e && typeof e.savedAt === 'number' && e.savedAt >= cutoff
    );

    if (kept.length > maxEntries) {
      kept = kept
        .sort((a, b) => b[1].savedAt - a[1].savedAt) // newest first
        .slice(0, maxEntries);
    }

    const entries = {};
    for (const [k, e] of kept) entries[k] = e;
    return { version, entries };
  }
  ```
  Run it:
  ```
  node --test --test-name-pattern="pruneMetaCache" recommendations.test.js
  ```
  Expected: **4 passing**, 0 failing.

- [ ] **Step 3: Wire the versioned envelope into `readMetaCache` / `writeMetaEntry` / `fetchTitleMeta`.**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, replace `readMetaCache` (L349-355):
  ```js
  function readMetaCache() {
    try {
      return JSON.parse(localStorage.getItem(META_CACHE_KEY) || '{}');
    } catch {
      return {};
    }
  }
  ```
  with a version/TTL/size-aware reader that returns the pruned envelope:
  ```js
  function readMetaCache(now = Date.now()) {
    let raw;
    try {
      raw = JSON.parse(localStorage.getItem(META_CACHE_KEY) || 'null');
    } catch {
      raw = null;
    }
    return pruneMetaCache(raw, now); // always a { version, entries } envelope
  }
  ```
  Replace `writeMetaEntry` (L357-365):
  ```js
  function writeMetaEntry(cacheKey, meta) {
    const cache = readMetaCache();
    cache[cacheKey] = meta;
    try {
      localStorage.setItem(META_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
      console.error('recMetaCache write failed:', e);
    }
  }
  ```
  with a version that timestamps the entry, re-prunes, and persists the envelope:
  ```js
  function writeMetaEntry(cacheKey, meta, now = Date.now()) {
    const cache = readMetaCache(now);
    cache.entries[cacheKey] = { meta, savedAt: now };
    const pruned = pruneMetaCache(cache, now); // re-bound after insert
    try {
      localStorage.setItem(META_CACHE_KEY, JSON.stringify(pruned));
    } catch (e) {
      console.error('recMetaCache write failed:', e);
    }
  }
  ```
  In `fetchTitleMeta` (L374-398), update the early cache-hit touch-point. Change (L375-377):
  ```js
    const cache = readMetaCache();
    const cacheKey = `${type}:${id}`;
    if (cache[cacheKey]) return cache[cacheKey];
  ```
  to:
  ```js
    const cacheKey = `${type}:${id}`;
    const cache = readMetaCache();
    if (cache.entries[cacheKey]) return cache.entries[cacheKey].meta;
  ```
  The trailing `writeMetaEntry(cacheKey, meta); return meta;` (L396-397) stays unchanged in shape — `writeMetaEntry` now wraps `meta` in the envelope internally.

- [ ] **Step 4: Full suite regression + commit.**
  ```
  npm test
  ```
  Expected: prior total (49) + 4 new `pruneMetaCache` tests = **53 passing**, 0 failing. The `readMetaCache`/`writeMetaEntry`/`fetchTitleMeta` rewrites are browser-only paths not exercised by `node --test`; no pure-fn signatures changed.
  ```
  git add recommendations.js recommendations.test.js
  git commit -m "feat(rec): versioned TTL size-bound meta cache"
  ```

### Task 33: `fillerCandidates` (trending + top_rated) + targeted blend into `generateCandidates`/`_pipeline` + empty-basket path

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — new `fillerCandidates`; TARGETED edit to `generateCandidates` to merge filler (function body owned earlier in Phase 1 — do NOT re-paste it); `getRecommendations` (L508-511) and `getRecommendationRows` (L513-519) empty-basket paths.
- `/home/tahseen-dar/Projects/MoviesDB/config.js` — uses `ENDPOINTS.topRated` (added by the config endpoints task in Phase 0; this task does NOT add it) and `ENDPOINTS.trending` (existing, L36).

This task adds the cold-start filler SOURCE and merges it into the candidate pool, then flips the orchestrators so an empty basket serves the trending-only cold-start path. It has no new pure-function tests (network orchestration glue, verified in-browser; the blend math is already covered by `coldStartBlend` in Phase 1). It MUST NOT regress any `node --test` test.

`generateCandidates` body is owned earlier in Phase 1 (it produces per-seed rec/similar ∪ Discover and takes `profile`). This task adds `fillerCandidates(basketSize)` and a TARGETED merge so `generateCandidates` ALSO unions cold-start filler scaled by basket size — it does not rewrite the function.

- [ ] **Step 1: Confirm `ENDPOINTS.topRated` is present (read-only check, no edit).**
  `ENDPOINTS.topRated(type, page = 1)` is added by the config endpoints task earlier in the plan. Verify both endpoints resolve (this task does NOT add `topRated`; if this check fails, the config task must land first):
  ```
  node --input-type=module -e "import { ENDPOINTS } from './config.js'; console.log(ENDPOINTS.trending(1)); console.log(ENDPOINTS.topRated('movie',1)); console.log(ENDPOINTS.topRated('tv',1));"
  ```
  Expected (three URLs, no error):
  ```
  https://api.themoviedb.org/3/trending/all/week?api_key=...&page=1
  https://api.themoviedb.org/3/movie/top_rated?api_key=...&page=1
  https://api.themoviedb.org/3/tv/top_rated?api_key=...&page=1
  ```

- [ ] **Step 2: Add `fillerCandidates` to `recommendations.js`.**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, add this network helper just above `generateCandidates` (L418). It pulls `/trending/all/week` (per-item media_type already correct) and `/{type}/top_rated` for both types, tags each candidate with a `trending`/`toprated` `SeedTag` carrying 0-based `rank`, and merges. Per the SHARED CONTRACT SeedTag shape, filler tags use `type:'title'` with `id:m.id` (the producing title id) — matching how rec/similar tags carry a title id; this keeps the `type:'genre'` tag space reserved for real genre facets and is correctly ignored by `collabScore` (not rec/similar) and `itemSim` provenance. It tolerates per-request failures:
  ```js
  // Cold-start filler source: trending (mixed media_type) + top_rated for both types.
  // Each candidate gets a provenance SeedTag (type:'title', id = producing title id, 0-based rank).
  async function fillerCandidates() {
    const tagged = [];
    const trendingP = fetchJson(ENDPOINTS.trending(1))
      .then((d) => (d.results || []).forEach((m, rank) => {
        const mediaType = m.media_type === 'tv' ? 'tv' : 'movie';
        tagged.push({ ...m, media_type: mediaType,
          _seeds: [{ source: 'trending', type: 'title', id: m.id, rank, weight: 1 }] });
      }))
      .catch(() => {});
    const topRatedPs = ['movie', 'tv'].map((type) =>
      fetchJson(ENDPOINTS.topRated(type, 1))
        .then((d) => (d.results || []).forEach((m, rank) => {
          tagged.push({ ...m, media_type: type,
            _seeds: [{ source: 'toprated', type: 'title', id: m.id, rank, weight: 1 }] });
        }))
        .catch(() => {}));
    await Promise.all([trendingP, ...topRatedPs]);
    return mergeCandidates(tagged);
  }
  ```

- [ ] **Step 3: TARGETED edit to `generateCandidates` — union the cold-start filler scaled by basket size.**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, `generateCandidates` is owned earlier in Phase 1 and returns the merged per-seed rec/similar ∪ Discover pool. The canonical Phase 1 signature is `generateCandidates(profile, basketSize)`. Add ONLY the filler blend at its return point — do not re-paste the body. Change its final `return mergeCandidates(tagged);` (the Phase-1 return that merges the collaborative + Discover `tagged` pool) to blend in filler via `coldStartBlend` (added earlier in Phase 1):
  ```js
    const personalPool = mergeCandidates(tagged);
    const filler = await fillerCandidates();
    return coldStartBlend(personalPool, filler, basketSize);
  ```
  This makes `generateCandidates` the single producer of all three mandated sources (per-seed rec/similar ∪ Discover ∪ cold-start filler), with filler weighted by `basketSize` through `coldStartBlend`: basketSize 0 → filler-only; basketSize ≥ `COLD_START_FULL` → personalized-only.

- [ ] **Step 4: TARGETED edit to `_pipeline` — pass `basketSize` into `generateCandidates`.**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, `_pipeline` is owned earlier in Phase 1. Make the single targeted change to the candidate-generation call (L495 region). Change:
  ```js
    const candidates = await generateCandidates(profile);
  ```
  to:
  ```js
    const candidates = await generateCandidates(profile, basket.length);
  ```
  Exclusion of watched ∪ downvoted ∪ basket still happens in the unchanged `excludeIds`/rank step immediately below. No other `_pipeline` line is touched by this task (the sig line was already updated to the 3-arg form earlier in Phase 1).

- [ ] **Step 5: Flip `getRecommendations` / `getRecommendationRows` to serve the cold-start path on empty basket.**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, replace `getRecommendations` (L508-511):
  ```js
  // Home teaser orchestrator. Empty basket -> no recommendations (basket-primary cold-start).
  export async function getRecommendations(input, opts = {}) {
    if (!input || !input.basket || input.basket.length === 0) return [];
    return (await _pipeline(input, opts)).recs;
  }
  ```
  with (run the pipeline regardless; an empty basket now yields the trending-only filler path, not `[]`):
  ```js
  // Home teaser orchestrator. Empty basket -> trending-only cold-start path (never []).
  export async function getRecommendations(input, opts = {}) {
    const safe = input || {};
    return (await _pipeline({
      basket: safe.basket || [],
      downvoted: safe.downvoted || [],
      watchedIds: safe.watchedIds || [],
    }, opts)).recs;
  }
  ```
  Replace `getRecommendationRows` (L513-519):
  ```js
  // Recommendation page orchestrator. Empty basket -> no rows.
  export async function getRecommendationRows(input, opts = {}) {
    if (!input || !input.basket || input.basket.length === 0) return { rows: [] };
    const { limit = 60, now = Date.now(), groupOpts = {}, penalty } = opts;
    const { profile, recs } = await _pipeline(input, { limit, now, penalty });
    return { rows: groupIntoRows(recs, profile, groupOpts) };
  }
  ```
  with (run the pipeline regardless; empty basket now produces trending-driven rows):
  ```js
  // Recommendation page orchestrator. Empty basket -> trending-only cold-start rows (never empty).
  export async function getRecommendationRows(input, opts = {}) {
    const safe = input || {};
    const { limit = 60, now = Date.now(), groupOpts = {}, penalty } = opts;
    const { profile, recs } = await _pipeline({
      basket: safe.basket || [],
      downvoted: safe.downvoted || [],
      watchedIds: safe.watchedIds || [],
    }, { limit, now, penalty });
    return { rows: groupIntoRows(recs, profile, groupOpts) };
  }
  ```

- [ ] **Step 6: Full suite regression + commit.**
  ```
  npm test
  ```
  Expected: **53 passing**, 0 failing (unchanged from Task 9.3). The new filler source, the targeted `generateCandidates`/`_pipeline` merges, and the orchestrator changes are browser-only network paths not covered by `node --test`; no pure-fn signature changed.
  ```
  git add recommendations.js
  git commit -m "feat(rec): trending+topRated cold-start filler in pipeline"
  ```

### Task 34: `'trending'` row archetype in `groupIntoRows` (owned by this section)

**Files:**
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.js` — `groupIntoRows` (owned earlier in Phase 1, which emits kinds `top`/`title`/`genre`/`explore`); this task APPENDS the `'trending'` row via a targeted edit.
- `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js` — append a `groupIntoRows` trending-row test (the existing `groupIntoRows` import at L183 already covers it).

The `Row.kind` enum is exactly `'top'|'title'|'genre'|'trending'|'explore'`. This section owns the `'trending'` archetype: a "Trending this week" row built from filler-sourced items (`_seeds[].source === 'trending'`) that survive into the ranked pool, filtered against rows already placed (cross-row dedupe via the global placed-Set that `groupIntoRows` maintains). Note: `rrf(...)` is deferred — weighted hybrid is the v1 ordering; the trending row is selection-based, not RRF-fused.

- [ ] **Step 1: Write the failing test.**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.test.js`, append a test using the existing `groupIntoRows` import (L183). A minimal profile plus a ranked pool containing trending-sourced items should yield exactly one `kind:'trending'` row titled "Trending this week", containing only trending-sourced items not already claimed by an earlier row:
  ```js
  const mkScored = (id, source, score, genreIds = [18]) => ({
    movie: { id, media_type: 'movie', genre_ids: genreIds, vote_average: 7, vote_count: 100, popularity: 1,
      _seeds: [{ source, type: source === 'trending' ? 'title' : 'genre', id, rank: 0, weight: 1 }] },
    score, parts: { collab: 0, content: 0, quality: 1, recency: 1 }, reasons: [],
  });

  test('groupIntoRows: emits a single Trending this week row from trending-sourced items', () => {
    const profile = { genres: { 18: 1 }, keywords: {}, people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [] };
    const ranked = [
      mkScored(1, 'rec', 0.9),
      mkScored(2, 'rec', 0.8),
      mkScored(101, 'trending', 0.5),
      mkScored(102, 'trending', 0.4),
    ];
    const rows = groupIntoRows(ranked, profile, {});
    const trendingRows = rows.filter((r) => r.kind === 'trending');
    assert.equal(trendingRows.length, 1);
    assert.equal(trendingRows[0].title, 'Trending this week');
    // Only trending-sourced items, and none already claimed by an earlier (e.g. 'top') row.
    assert.ok(trendingRows[0].recs.every((r) => r.movie._seeds.some((s) => s.source === 'trending')));
    assert.ok(trendingRows[0].recs.length >= 1);
    const placedElsewhere = new Set(
      rows.filter((r) => r.kind !== 'trending').flatMap((r) => r.recs.map((x) => x.movie.id))
    );
    assert.ok(trendingRows[0].recs.every((r) => !placedElsewhere.has(r.movie.id)));
  });
  ```
  Run it:
  ```
  node --test --test-name-pattern="Trending this week" recommendations.test.js
  ```
  Expected: **FAIL** — no `kind:'trending'` row is produced yet (`trendingRows.length` is 0).

- [ ] **Step 2: Append the `'trending'` row in `groupIntoRows` (targeted edit).**
  In `/home/tahseen-dar/Projects/MoviesDB/recommendations.js`, `groupIntoRows` is owned earlier in Phase 1 and already maintains a global `placed` Set for cross-row dedupe and builds an array of `rows` before its final `return`. Add the trending row immediately BEFORE the deterministic `'explore'` row is appended (so trending sits above explore, below the personalized rows). Insert this block (it reuses the same `placed` Set the function already maintains — do NOT introduce a new dedupe mechanism):
  ```js
    // 'trending' archetype: items whose provenance is the cold-start trending source and that
    // haven't been claimed by an earlier row. One deterministic row, capped like other rows.
    const trendingRecs = ranked.filter(
      (r) => !placed.has(Number(r.movie.id))
        && (r.movie._seeds || []).some((s) => s.source === 'trending')
    );
    if (trendingRecs.length) {
      const picked = trendingRecs.slice(0, opts.rowSize || 12);
      picked.forEach((r) => placed.add(Number(r.movie.id)));
      rows.push({ kind: 'trending', title: 'Trending this week', recs: picked });
    }
  ```
  (If the Phase-1 `groupIntoRows` names its accumulator differently than `rows`/`placed`, use the existing identifiers; this block adds one row and claims its items in the shared placed-Set. The cap falls back to 12 when `opts.rowSize` is unset, matching the other archetypes' default.)
  Run it:
  ```
  node --test --test-name-pattern="Trending this week" recommendations.test.js
  ```
  Expected: **1 passing**, 0 failing.

- [ ] **Step 3: Full suite regression + commit.**
  ```
  npm test
  ```
  Expected: prior total (53) + 1 new trending-row test = **54 passing**, 0 failing. (`groupIntoRows` gained one appended row archetype; existing `groupIntoRows` tests assert on `top`/`title`/`genre`/`explore` rows and are unaffected because the trending row only claims previously-unplaced trending-sourced items, which those fixtures do not contain.)
  ```
  git add recommendations.js recommendations.test.js
  git commit -m "feat(rec): trending this week row archetype"
  ```

## Self-review checklist

After implementing, verify these offline proxies (no backend / A-B test needed):
- [ ] Candidate pool jumps from ~tens to several hundred for a 5-title basket (log `mergeCandidates` length).
- [ ] Majority of final recs are collaborative-sourced (`_seeds` include `source:'rec'|'similar'`).
- [ ] Movie + TV both appear when the basket mixes types.
- [ ] Intra-list diversity rises after MMR vs raw sort; no single seed exceeds `PER_SEED_CAP`.
- [ ] Shown genre mix approximates the basket histogram (calibration).
- [ ] Every basket seed contributes >=1 rec (basket coverage ~100%).
- [ ] No id appears in two rows on the dedicated page (cross-row dedupe).
- [ ] A just-watched title disappears within the session (watched-aware cache key).
- [ ] Empty basket renders a trending rail, never an empty page.
- [ ] One downvote no longer erases a strongly-basketed theme (Rocchio).
- [ ] `npm test` green at the new baseline (40 + suites added by this plan).
- [ ] Headless smoke: rec page renders rows with evidence labels; explore row present; infinite-scroll regression guard intact.
