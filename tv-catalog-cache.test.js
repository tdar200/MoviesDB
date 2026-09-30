import test from 'node:test';
import assert from 'node:assert/strict';
import { createTvCatalogCache, categorySnapshot, categoryCacheIdentity, CATALOG_FRESH_MS } from './tv-catalog-cache.mjs';
const def = { url: 'https://tmdb.test/discover/movie?api_key=secret&page=1&with_genres=18', mediaType: 'movie' };
const row = { items: [{ id: 3, media_type: 'movie', title: 'Late page winner', vote_average: 9, vote_count: 100000 }, { id: 1, media_type: 'movie', title: 'First page', vote_average: 7, vote_count: 5000 }], loadedPages: 3, totalPages: 3, limited: false };
const flush = () => new Promise(resolve => setImmediate(resolve));
function persistentStore() { const data = new Map(); return { data, get: async k => data.get(k), set: async (k,v) => data.set(k,v) }; }

test('complete sorted rows persist across cache instances with no TMDB refetch', async () => {
 const store = persistentStore(); let calls = 0;
 const create = () => createTvCatalogCache({ store, fetchRow: async () => { calls++; return row; } });
 const first = await create().getRow(def);
 await flush();
 const second = await create().getRow(def);
 assert.deepEqual(second.items, first.items);
 assert.equal(second.cached, true);
 assert.equal(second.loadedPages, 3);
 assert.equal(calls, 1);
});

test('hosted complete snapshot gives a cold start without any page fetches', async () => {
 let loads = 0;
 const cache = createTvCatalogCache({ loadSnapshot: async () => { loads++; return categorySnapshot(def,row); }, fetchRow: async () => { throw Error('should not fetch'); } });
 assert.deepEqual((await cache.getRow(def)).items, row.items);
 await cache.getRow(def);
 assert.equal(loads, 1);
});

test('cache identities ignore API credentials and query order but preserve category and ranking inputs', () => {
 const a = categoryCacheIdentity(def);
 const b = categoryCacheIdentity({ ...def, url: 'https://tmdb.test/discover/movie?with_genres=18&page=5&api_key=another' });
 assert.deepEqual(a, b);
 assert.ok(!a.signature.includes('secret'));
 assert.notEqual(a.key, categoryCacheIdentity({ ...def, mediaType:'tv' }).key);
 assert.notEqual(a.key, categoryCacheIdentity({ ...def, url:def.url.replace('genres=18','genres=35') }).key);
});

test('stale complete snapshot returns immediately while one refresh updates the next visit', async () => {
 let completeRefresh, calls = 0;
 const cache = createTvCatalogCache({ now: () => CATALOG_FRESH_MS+100, loadSnapshot: async () => categorySnapshot(def,row,1), fetchRow: () => {calls++; return new Promise(resolve => { completeRefresh = resolve; });} });
 const shown = await cache.getRow(def);
 assert.deepEqual(shown.items, row.items);
 await cache.getRow(def);
 assert.equal(calls, 1);
 completeRefresh({ ...row, items:[{...row.items[0],title:'Refreshed winner'}] });
 await cache.whenRefreshed();
 assert.equal((await cache.getRow(def)).items[0].title,'Refreshed winner');
 assert.equal(shown.items[0].title,'Late page winner','visible snapshot never mutates');
});

test('failed stale refresh keeps full last-good membership and backs off retries', async () => {
 let calls = 0;
 const cache = createTvCatalogCache({ now: () => CATALOG_FRESH_MS+100, loadSnapshot: async () => categorySnapshot(def,row,1), fetchRow: async () => {calls++; throw Error('offline');} });
 await cache.getRow(def); await cache.whenRefreshed();
 assert.deepEqual((await cache.getRow(def)).items,row.items);
 await cache.whenRefreshed();
 assert.equal(calls,1);
});

test('partial or mismatched hosted caches are rejected and full data fetched', async () => {
 for (const bad of [{ ...categorySnapshot(def,row), row:{...row,loadedPages:1} }, categorySnapshot({...def,url:def.url.replace('genres=18','genres=35')},row)]) {
  let calls = 0;
  const cache = createTvCatalogCache({ loadSnapshot: async () => bad, fetchRow: async () => {calls++; return row;} });
  assert.deepEqual((await cache.getRow(def)).items,row.items);
  assert.equal(calls,1);
 }
});

test('overlapping renders share one category fetch; cancelled views cannot cancel another view or cache fill', async () => {
 let finish, calls=0;
 const cache=createTvCatalogCache({fetchRow:()=>{calls++;return new Promise(r=>{finish=r;});}});
 const cancelled=cache.getRow(def,{isCurrent:()=>false});
 const current=cache.getRow(def,{isCurrent:()=>true});
 await flush(); finish(row);
 await assert.rejects(cancelled,{name:'AbortError'});
 assert.deepEqual((await current).items,row.items);
 assert.equal(calls,1);
});

test('storage and quota failures preserve correct full results and memory acceleration', async () => {
 let calls=0;
 const cache=createTvCatalogCache({store:{get:async()=>{throw Error('blocked');},set:async()=>{throw Error('quota');}},fetchRow:async()=>{calls++;return row;}});
 assert.deepEqual((await cache.getRow(def)).items,row.items);
 await flush(); await cache.getRow(def);
 assert.equal(calls,1);
});

test('memory retention is bounded by LRU without changing persisted category membership', async () => {
 const store=persistentStore();
 const cache=createTvCatalogCache({store,maxMemoryRows:2,fetchRow:async()=>row});
 const defs=[18,35,28].map(genre=>({...def,url:def.url.replace('genres=18',`genres=${genre}`)}));
 for(const d of defs) await cache.getRow(d);
 await flush();
 assert.equal(cache.memory.size,2);
 assert.equal(store.data.size,3);
 assert.equal(cache.memory.has(categoryCacheIdentity(defs[0]).key),false);
 assert.deepEqual((await cache.getRow(defs[0])).items,row.items);
});

test('stale category refreshes are serialized so background work leaves interactive capacity', async () => {
 const pending=[], started=[];
 const cache=createTvCatalogCache({now:()=>CATALOG_FRESH_MS+100,loadSnapshot:async key=>{
   const d=key===categoryCacheIdentity(def).key?def:{...def,url:def.url.replace('genres=18','genres=35')};
   return categorySnapshot(d,row,1);
 },fetchRow:(d,options)=>{started.push(options.pageBatch);return new Promise(resolve=>pending.push(resolve));}});
 await cache.getRow(def);
 await cache.getRow({...def,url:def.url.replace('genres=18','genres=35')});
 assert.equal(started.length,1);
 pending.shift()(row);await flush();
 assert.deepEqual(started,[2,2]);
 pending.shift()(row);await cache.whenRefreshed();
});

test('a temporary empty category is not cached over subsequently recovered titles', async () => {
 let calls=0;
 const cache=createTvCatalogCache({fetchRow:async()=>++calls===1?{...row,items:[]}:row});
 assert.equal((await cache.getRow(def)).items.length,0);
 assert.deepEqual((await cache.getRow(def)).items,row.items);
 assert.equal(calls,2);
});
