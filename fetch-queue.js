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
        // Honor a numeric Retry-After (seconds); fall back to exponential backoff for
        // a missing/empty/non-numeric header (a bad header must not yield setTimeout(NaN)).
        const retryAfter = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
        const parsed = Number(retryAfter);
        const ms = (retryAfter != null && retryAfter !== '' && !Number.isNaN(parsed))
          ? parsed * 1000
          : BACKOFF_BASE_MS * 2 ** attempt;
        attempt++;
        // NOTE: the retry holds its concurrency slot for the full backoff (deliberate
        // trade-off — simple, fine for the ~dozens of URLs per recommendations run).
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
