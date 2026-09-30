import { rowSources, WEIGHT_MEAN, WEIGHT_VOTES } from './tv-rows.mjs';

export const CATALOG_CACHE_VERSION = 1;
export const CATALOG_FRESH_MS = 24 * 60 * 60 * 1000;
const CARD_FIELDS = ['id', 'media_type', 'title', 'name', 'original_title', 'original_name', 'overview', 'poster_path', 'backdrop_path', 'release_date', 'first_air_date', 'vote_average', 'vote_count', 'popularity', 'genre_ids', 'original_language', 'origin_country', 'adult'];

export function categoryCacheIdentity(def) {
  const parts = [CATALOG_CACHE_VERSION, WEIGHT_VOTES, WEIGHT_MEAN, rowSources(def).map(src => {
    const url = new URL(src.url);
    url.searchParams.delete('api_key');
    url.searchParams.delete('page');
    url.searchParams.sort();
    return [url.toString(), src.mediaType || '', !!src.list];
  })];
  // A row that is not rating-ranked (feed / popularity / recent, with its page cap) is a
  // different collection than the same URL rated by stars, so it must not reuse that
  // snapshot. Rating rows append nothing, which keeps their existing keys (and every
  // stored / hosted snapshot of a many-page category) valid.
  const order = def.order || 'rating';
  if (order !== 'rating' || Number(def.maxPages) > 0) parts.push([order, Number(def.maxPages) || 0]);
  const signature = JSON.stringify(parts);
  // Two independent 32-bit hashes keep URLs short; stored signatures are also
  // checked, so even a collision cannot return another category's membership.
  const hash = seed => {
    let value = seed;
    for (let i = 0; i < signature.length; i++) value = Math.imul(value ^ signature.charCodeAt(i), 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  return { key: `v${CATALOG_CACHE_VERSION}-${hash(2166136261)}${hash(3339675911)}`, signature };
}

export function categorySnapshot(def, row, savedAt = Date.now()) {
  const identity = categoryCacheIdentity(def);
  return {
    ...identity, version: CATALOG_CACHE_VERSION, savedAt,
    row: { items: row.items.filter(item => !item.media_type || item.media_type === 'movie' || item.media_type === 'tv').map(item => {
      const card = {};
      for (const field of CARD_FIELDS) if (item[field] !== undefined) card[field] = item[field];
      card.media_type ||= item.name && !item.title ? 'tv' : 'movie';
      return card;
    }), loadedPages: row.loadedPages, totalPages: row.totalPages, limited: row.limited },
  };
}

export function validCategorySnapshot(snapshot, identity) {
  return !!snapshot && snapshot.version === CATALOG_CACHE_VERSION && snapshot.signature === identity.signature && snapshot.key === identity.key
    && Number.isFinite(snapshot.savedAt) && snapshot.savedAt > 0
    && snapshot.row && Array.isArray(snapshot.row.items)
    && snapshot.row.loadedPages === snapshot.row.totalPages && snapshot.row.totalPages >= 1
    && snapshot.row.items.every(item => item && item.id != null && (item.media_type === 'movie' || item.media_type === 'tv'));
}

// Full sorted rows, not thousands of page-sized blobs. The injected persistent
// store is asynchronous (IndexedDB); memory and in-flight work are bounded.
export function createTvCatalogCache({ store, loadSnapshot = async () => null, fetchRow, now = Date.now, freshMs = CATALOG_FRESH_MS, maxMemoryRows = 12, onRefreshError = () => {} } = {}) {
  const memory = new Map();
  const loading = new Map();
  const refreshing = new Map();
  const retryAfter = new Map();
  const refreshQueue = [];
  let activeRefresh = false;
  const remember = snapshot => {
    memory.delete(snapshot.key);
    memory.set(snapshot.key, snapshot);
    while (memory.size > maxMemoryRows) memory.delete(memory.keys().next().value);
    return snapshot;
  };
  const persist = snapshot => {
    // Storage/quota failures affect only acceleration, never category correctness.
    if (store) Promise.resolve().then(() => store.set(snapshot.key, snapshot)).catch(() => {});
  };
  const fetchAndSave = async (def, options) => {
    const row = await fetchRow(def, options);
    const snapshot = categorySnapshot(def, row, now());
    // A temporary empty response must not hide a recovered category all day.
    if (snapshot.row.items.length) { remember(snapshot); persist(snapshot); }
    return snapshot;
  };
  const pumpRefresh = () => {
    if (activeRefresh || !refreshQueue.length) return;
    activeRefresh = true;
    const { def, identity, resolve } = refreshQueue.shift();
    // One category, two pages per source: background freshness leaves room for
    // interactive details and playback lookups in the shared network queue.
    fetchAndSave(def, { pageBatch: 2 }).catch(error => {
      retryAfter.set(identity.key, now() + 5 * 60 * 1000);
      onRefreshError(error);
    }).finally(() => {
      refreshing.delete(identity.key);
      activeRefresh = false;
      resolve();
      pumpRefresh();
    });
  };
  const refresh = (def, identity) => {
    if (refreshing.has(identity.key) || (retryAfter.get(identity.key) || 0) > now()) return;
    const task = new Promise(resolve => refreshQueue.push({ def, identity, resolve }));
    refreshing.set(identity.key, task);
    pumpRefresh();
  };
  const findSnapshot = async identity => {
    const cached = memory.get(identity.key);
    if (cached) return remember(cached);
    if (store) {
      try {
        const saved = await store.get(identity.key);
        if (validCategorySnapshot(saved, identity) && saved.row.items.length) return remember(saved);
      } catch { /* unavailable storage: try the hosted snapshot */ }
    }
    try {
      const hosted = await loadSnapshot(identity.key);
      if (validCategorySnapshot(hosted, identity) && hosted.row.items.length) {
        remember(hosted);
        persist(hosted);
        return hosted;
      }
    } catch { /* offline or missing snapshot: fetch the complete source */ }
    return null;
  };
  const getRow = async (def, options = {}) => {
    const identity = categoryCacheIdentity(def);
    let task = loading.get(identity.key);
    if (!task) {
      // Category work belongs to the cache, not to a particular screen render.
      // Tab switches share it; only the caller's paint is cancelled.
      task = (async () => {
        const saved = await findSnapshot(identity);
        if (saved) {
          // Hot/new rows go stale in hours, not a day.
          if (now() - saved.savedAt > (Number(def.freshMs) > 0 ? Number(def.freshMs) : freshMs)) refresh(def, identity);
          return { ...saved.row, cached: true, savedAt: saved.savedAt };
        }
        const snapshot = await fetchAndSave(def, { onProgress: options.onProgress });
        return { ...snapshot.row, cached: false, savedAt: snapshot.savedAt };
      })().finally(() => loading.delete(identity.key));
      loading.set(identity.key, task);
    }
    const row = await task;
    if (options.isCurrent && !options.isCurrent()) {
      const error = new Error('Category view changed');
      error.name = 'AbortError';
      throw error;
    }
    return row;
  };
  return { getRow, memory, whenRefreshed: () => Promise.all([...refreshing.values()]) };
}
