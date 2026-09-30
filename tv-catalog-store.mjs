// IndexedDB survives TV app launches without blocking on localStorage JSON or its
// small quota. LRU metadata is separate so eviction never scans title payloads.
export function createTvCatalogStore({ indexedDB = globalThis.indexedDB, maxRows = 64, maxItems = 120000, timeoutMs = 5000 } = {}) {
  let opening;
  const bounded = promise => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Category storage timed out')), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const open = () => {
    if (!indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    if (!opening) opening = bounded(new Promise((resolve, reject) => {
      const request = indexedDB.open('moviesdb-category-cache', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('rows');
        db.createObjectStore('meta');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Category storage blocked'));
    })).catch(error => { opening = null; throw error; });
    return opening;
  };
  const get = async key => {
    const db = await open();
    return bounded(new Promise((resolve, reject) => {
      const tx = db.transaction(['rows', 'meta'], 'readwrite');
      let snapshot;
      const request = tx.objectStore('rows').get(key);
      request.onsuccess = () => {
        snapshot = request.result;
        if (snapshot) tx.objectStore('meta').put({ key, usedAt: Date.now(), count: snapshot.row.items.length }, key);
      };
      tx.oncomplete = () => resolve(snapshot);
      tx.onabort = () => reject(tx.error || new Error('Category read aborted'));
      tx.onerror = () => {};
    }));
  };
  const set = async (key, snapshot) => {
    const db = await open();
    return bounded(new Promise((resolve, reject) => {
      const tx = db.transaction(['rows', 'meta'], 'readwrite');
      const rows = tx.objectStore('rows'), meta = tx.objectStore('meta');
      const request = meta.getAll();
      request.onsuccess = () => {
        const entries = request.result.filter(entry => entry.key !== key).sort((a, b) => a.usedAt - b.usedAt);
        let count = entries.reduce((sum, entry) => sum + entry.count, snapshot.row.items.length);
        while (entries.length && (entries.length + 1 > maxRows || count > maxItems)) {
          const oldest = entries.shift();
          count -= oldest.count;
          rows.delete(oldest.key);
          meta.delete(oldest.key);
        }
        rows.put(snapshot, key);
        meta.put({ key, usedAt: Date.now(), count: snapshot.row.items.length }, key);
      };
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('Category write aborted'));
      tx.onerror = () => {};
    }));
  };
  return { get, set };
}
