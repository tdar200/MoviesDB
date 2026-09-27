# Live Football Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Live" section to the MoviesDB TV app that lists today's football matches (ESPN fixtures joined to free Nuvio streams) and a grid of free 24/7 sports channels, and plays them through a helper-side HLS relay with hls.js.

**Architecture:** The Node helper (`stream-server.mjs`) gains six key-gated `/live/*` routes backed by small pure modules: an ESPN fixtures feed, a source-adapter registry (Nuvio first), a fixture/source joiner, an iptv-org channel feed with liveness probing, and an HLS relay that rewrites playlists and proxies segments with the Referer/Origin headers upstream CDNs demand. The client gains a fourth kind tab ("Live") whose home is built from `/live/matches` and `/live/channels`, a live details overlay with a stream picker, and a live player that drives hls.js (native HLS fallback) with a stall/403 recover cascade.

**Tech Stack:** Node 24 ES modules, `node --test` + `node:assert/strict`, esbuild (`--target=es2019`) bundle for webOS Chromium 79, hls.js 1.7.3, Playwright for gated e2e, ffmpeg for synthetic HLS fixtures.

**Spec:** `docs/superpowers/specs/2026-09-27-live-football-design.md`

## Global Constraints

- Free sources only; no keys, no paid tiers, no debrid.
- Never contact a Sky-blocked host: only `site.api.espn.com`, `nuviosports.xyz`, `iptv-org.github.io`, and whatever CDN a Nuvio stream points at.
- TV target is webOS Chromium 79: client code is bundled with `esbuild --target=es2019`; no iframe players; hls.js primary, native `<video src>` fallback.
- Every `/live/*` route requires the helper key (`?key=`), the relay accepts only HMAC-signed upstream URLs, and the client never receives raw upstream URLs, referers or origins.
- Upstream requests send both `Referer` and `Origin` (and a Chrome User-Agent); relay responses carry `access-control-allow-origin: *` and `cache-control: no-store`.
- All new helper modules take injectable `fetchImpl` and `now`; unit tests hit no network.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Working directory for every command: `/home/tahseen-dar/Projects/MoviesDB`. Run `npm test` before each commit; it must stay at 0 failures.
- Do NOT run `npm run build:web` or deploy to Vercel inside this plan; the owner deploys.

## Review Focus

1. Nuvio team names carry invisible Unicode tag characters (U+E0000..U+E007F flag tags) and emoji. `normaliseTeam` must strip them or nothing ever joins to ESPN. Pinned in Task 4.
2. A master playlist (`#EXT-X-STREAM-INF` then a variant URI) must route the variant to `/live/hls`, not `/live/seg`, or hls.js gets a playlist served as a segment. Pinned in Task 6.
3. ESPN's `dates=` day is US Eastern; a UK 20:00 kick-off is fine but a 01:00 BST match sits on the previous ET day. `/live/matches` fetches two dates and windows by kick-off. Pinned in Task 7.
4. iptv-org's playlist uses CRLF and tags `[Geo-blocked]` in the channel name; a naive split leaves `\r` on every URL and geo-blocked channels in the grid. Pinned in Task 5.
5. The Live home re-renders every 60 s; if the focused card is dropped, the remote loses focus to `<body>`. The re-render must restore focus by card id. Pinned in Task 13 (e2e).

---

### Task 1: Gate `/live/*` behind the helper key

**Files:**
- Modify: `helper-auth.js:14-18`
- Test: `helper-auth.test.js`

**Interfaces:**
- Produces: `isHelperApiPath(pathname)` returns true for any path starting with `/live/`.

- [ ] **Step 1: Write the failing test**

Append to `helper-auth.test.js`:

```js
test('every /live/* path needs the key, other static paths stay open', () => {
  assert.equal(isHelperApiPath('/live/matches'), true);
  assert.equal(isHelperApiPath('/live/hls'), true);
  assert.equal(isHelperApiPath('/live/seg'), true);
  assert.equal(isHelperApiPath('/liveness.html'), false);
  assert.equal(helperRequestAllowed({ pathname: '/live/seg', searchParams: new URLSearchParams(''), requiredKey: 'k' }), false);
  assert.equal(helperRequestAllowed({ pathname: '/live/seg', searchParams: new URLSearchParams('key=k'), requiredKey: 'k' }), true);
});
```

Make sure the file imports `isHelperApiPath` and `helperRequestAllowed` from `./helper-auth.js` (add to the existing import if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test helper-auth.test.js`
Expected: FAIL, `/live/matches` -> false.

- [ ] **Step 3: Implement**

In `helper-auth.js` replace `isHelperApiPath`:

```js
export function isHelperApiPath(pathname) {
  return HELPER_API_PATHS.includes(pathname) || pathname.startsWith('/hls/') || pathname.startsWith('/live/');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test helper-auth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add helper-auth.js helper-auth.test.js
git commit -m "helper: gate /live/* routes behind the access key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: ESPN fixtures feed (`live-fixtures.mjs`)

**Files:**
- Create: `live-fixtures.mjs`
- Test: `live-fixtures.test.js`
- Fixture (already saved): `test-fixtures/live/espn-scoreboard.json` (three real events: `pre`, `post`, `in`; league ids in `event.uid` like `s:600~l:2395~e:401861067`)

**Interfaces:**
- Produces:
  - `ESPN_LEAGUES: { [id: number]: { slug: string, name: string } }`
  - `leagueFromUid(uid: string) -> { id: number|null, slug: string|null, name: string }` (`name: 'Other'` when unknown)
  - `normaliseEspnEvent(event) -> Fixture` where `Fixture = { id: string, league: {id, slug, name}, kickoff: string /* ISO UTC */, state: 'pre'|'in'|'post', clock: string|null, home: {name, shortName, logo, score: number|null}, away: {…}, broadcasters: string[] }`
  - `espnScoreboardUrl(date: 'YYYY-MM-DD') -> string`
  - `createFixturesFeed({ fetchImpl = fetch, now = Date.now, userAgent = CHROME_UA }) -> { fetchFixtures(date) -> Promise<Fixture[]> }` (cached per date: 60 s while any fixture is `in`, else 600 s)
  - `CHROME_UA: string`

- [ ] **Step 1: Write the failing tests**

Create `live-fixtures.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normaliseEspnEvent, leagueFromUid, espnScoreboardUrl, createFixturesFeed, ESPN_LEAGUES } from './live-fixtures.mjs';

const sample = JSON.parse(readFileSync(new URL('./test-fixtures/live/espn-scoreboard.json', import.meta.url), 'utf8'));
const byState = state => sample.events.find(e => e.status.type.state === state);

test('leagueFromUid maps known ESPN league ids and falls back to Other', () => {
  assert.deepEqual(leagueFromUid('s:600~l:700~e:1'), { id: 700, slug: 'eng.1', name: 'Premier League' });
  assert.deepEqual(leagueFromUid('s:600~l:2395~e:1'), { id: 2395, slug: 'uefa.nations', name: 'UEFA Nations League' });
  assert.deepEqual(leagueFromUid('s:600~l:99999999~e:1'), { id: 99999999, slug: null, name: 'Other' });
  assert.deepEqual(leagueFromUid(undefined), { id: null, slug: null, name: 'Other' });
  assert.equal(ESPN_LEAGUES[775].name, 'UEFA Champions League');
});

test('normaliseEspnEvent: scheduled match has no clock or scores', () => {
  const f = normaliseEspnEvent(byState('pre'));
  assert.equal(f.state, 'pre');
  assert.equal(f.clock, null);
  assert.equal(f.home.score, null);
  assert.equal(f.away.score, null);
  assert.equal(f.home.name, 'Lithuania');
  assert.equal(f.away.name, 'Azerbaijan');
  assert.match(f.kickoff, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/);
  assert.equal(f.league.name, 'UEFA Nations League');
  assert.deepEqual(f.broadcasters, ['FS2']);
  assert.match(f.home.logo, /^https:\/\/a\.espncdn\.com\//);
  assert.equal(f.id, 'espn:401861067');
});

test('normaliseEspnEvent: live match carries the clock and scores', () => {
  const f = normaliseEspnEvent(byState('in'));
  assert.equal(f.state, 'in');
  assert.equal(f.clock, "60'");
  assert.equal(f.home.score, 0);
  assert.equal(f.away.score, 2);
});

test('normaliseEspnEvent: finished match reads FT', () => {
  const f = normaliseEspnEvent(byState('post'));
  assert.equal(f.state, 'post');
  assert.equal(f.clock, 'FT');
  assert.equal(f.home.score, 1);
  assert.equal(f.away.score, 3);
});

test('normaliseEspnEvent survives missing competitors, broadcasts and logos', () => {
  const f = normaliseEspnEvent({ id: '7', uid: 's:600~l:700~e:7', date: '2026-10-10T11:30Z', status: { type: { state: 'pre' } }, competitions: [{ competitors: [] }] });
  assert.equal(f.home.name, '');
  assert.equal(f.away.name, '');
  assert.equal(f.home.logo, null);
  assert.deepEqual(f.broadcasters, []);
});

test('espnScoreboardUrl builds the all-soccer URL for a date', () => {
  assert.equal(espnScoreboardUrl('2026-09-27'), 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=20260927&limit=300');
});

test('createFixturesFeed sends a browser UA, caches per date, and shortens the TTL while a match is live', async () => {
  const calls = [];
  let clock = 1_000_000;
  const fetchImpl = async (url, opts) => { calls.push({ url, ua: opts.headers['User-Agent'] }); return { ok: true, status: 200, json: async () => sample }; };
  const feed = createFixturesFeed({ fetchImpl, now: () => clock });
  const a = await feed.fetchFixtures('2026-09-27');
  assert.equal(a.length, 3);
  assert.match(calls[0].ua, /Chrome/);
  clock += 30_000;
  await feed.fetchFixtures('2026-09-27');
  assert.equal(calls.length, 1, 'served from cache inside 60 s');
  clock += 31_000;
  await feed.fetchFixtures('2026-09-27');
  assert.equal(calls.length, 2, 'refetched after 60 s because one fixture is in play');
  await feed.fetchFixtures('2026-09-28');
  assert.equal(calls.length, 3, 'a different date is a different cache key');
});

test('createFixturesFeed uses the 10 minute TTL when nothing is live and throws on HTTP errors', async () => {
  const quiet = { events: sample.events.filter(e => e.status.type.state !== 'in') };
  let clock = 0; let n = 0;
  const feed = createFixturesFeed({ fetchImpl: async () => { n++; return { ok: true, status: 200, json: async () => quiet }; }, now: () => clock });
  await feed.fetchFixtures('2026-09-27'); clock += 500_000; await feed.fetchFixtures('2026-09-27');
  assert.equal(n, 1);
  clock += 200_000; await feed.fetchFixtures('2026-09-27');
  assert.equal(n, 2);
  const bad = createFixturesFeed({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  await assert.rejects(() => bad.fetchFixtures('2026-09-27'), /ESPN 403/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test live-fixtures.test.js`
Expected: FAIL, cannot find module `./live-fixtures.mjs`.

- [ ] **Step 3: Implement `live-fixtures.mjs`**

```js
// live-fixtures.mjs — today's football fixtures from ESPN's public scoreboard.
//
// One call per date returns every league ESPN covers with UTC kick-off, live
// clock, scores, team logos and broadcaster names. No key, but the Akamai front
// answers 403 to curl-like user agents, so we always send a browser UA.
// Pure mapper + a small cache; fetch and clock are injectable for tests.

export const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// ESPN numeric league id (from event.uid "s:600~l:<id>~e:<event>") -> slug/name.
// Verified 2026-09-27 against each league's own scoreboard endpoint.
export const ESPN_LEAGUES = {
  700: { slug: 'eng.1', name: 'Premier League' },
  775: { slug: 'uefa.champions', name: 'UEFA Champions League' },
  776: { slug: 'uefa.europa', name: 'UEFA Europa League' },
  20296: { slug: 'uefa.europa.conf', name: 'UEFA Conference League' },
  740: { slug: 'esp.1', name: 'LaLiga' },
  730: { slug: 'ita.1', name: 'Serie A' },
  720: { slug: 'ger.1', name: 'Bundesliga' },
  710: { slug: 'fra.1', name: 'Ligue 1' },
  3918: { slug: 'eng.fa', name: 'FA Cup' },
  3920: { slug: 'eng.league_cup', name: 'Carabao Cup' },
  2395: { slug: 'uefa.nations', name: 'UEFA Nations League' },
  606: { slug: 'fifa.world', name: 'FIFA World Cup' },
  786: { slug: 'fifa.worldq.uefa', name: 'World Cup Qualifying (UEFA)' },
  781: { slug: 'uefa.euro', name: 'UEFA European Championship' },
  3922: { slug: 'fifa.friendly', name: 'International Friendly' },
  3914: { slug: 'eng.2', name: 'EFL Championship' },
  725: { slug: 'ned.1', name: 'Eredivisie' },
  715: { slug: 'por.1', name: 'Primeira Liga' },
  735: { slug: 'sco.1', name: 'Scottish Premiership' },
  770: { slug: 'usa.1', name: 'MLS' },
  3946: { slug: 'tur.1', name: 'Süper Lig' },
  21231: { slug: 'ksa.1', name: 'Saudi Pro League' },
  8097: { slug: 'eng.w.1', name: "Women's Super League" },
};

export function leagueFromUid(uid) {
  const m = /~l:(\d+)/.exec(uid || '');
  if (!m) return { id: null, slug: null, name: 'Other' };
  const id = Number(m[1]);
  const known = ESPN_LEAGUES[id];
  return { id, slug: known ? known.slug : null, name: known ? known.name : 'Other' };
}

export function espnScoreboardUrl(date) {
  return `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${date.replace(/-/g, '')}&limit=300`;
}

function team(competitor, state) {
  const t = (competitor && competitor.team) || {};
  const score = state === 'pre' || competitor?.score == null || competitor.score === '' ? null : Number(competitor.score);
  return {
    name: t.displayName || t.name || '',
    shortName: t.shortDisplayName || t.abbreviation || t.displayName || '',
    logo: t.logo || null,
    score: Number.isFinite(score) ? score : null,
  };
}

export function normaliseEspnEvent(event) {
  const comp = (event.competitions && event.competitions[0]) || {};
  const competitors = comp.competitors || [];
  const status = (event.status && event.status.type) || {};
  const state = ['pre', 'in', 'post'].includes(status.state) ? status.state : 'pre';
  let clock = null;
  if (state === 'in') clock = status.shortDetail || (event.status && event.status.displayClock) || null;
  if (state === 'post') clock = 'FT';
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0];
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1];
  const names = new Set();
  for (const b of comp.broadcasts || []) for (const n of b.names || []) if (n) names.add(n);
  for (const g of comp.geoBroadcasts || []) { const n = g.media && g.media.shortName; if (n) names.add(n); }
  const kickoff = event.date ? new Date(event.date).toISOString().replace(/\.000Z$/, 'Z') : null;
  return {
    id: `espn:${event.id}`,
    league: leagueFromUid(event.uid),
    kickoff,
    state,
    clock,
    home: team(home, state),
    away: team(away, state),
    broadcasters: Array.from(names),
  };
}

const LIVE_TTL_MS = 60_000;
const IDLE_TTL_MS = 600_000;

export function createFixturesFeed({ fetchImpl = fetch, now = Date.now, userAgent = CHROME_UA } = {}) {
  const cache = new Map(); // date -> { at, fixtures }
  async function fetchFixtures(date) {
    const hit = cache.get(date);
    if (hit) {
      const ttl = hit.fixtures.some(f => f.state === 'in') ? LIVE_TTL_MS : IDLE_TTL_MS;
      if (now() - hit.at < ttl) return hit.fixtures;
    }
    const res = await fetchImpl(espnScoreboardUrl(date), { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    const data = await res.json();
    const fixtures = (data.events || []).map(normaliseEspnEvent).filter(f => f.kickoff);
    cache.set(date, { at: now(), fixtures });
    return fixtures;
  }
  return { fetchFixtures };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test live-fixtures.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add live-fixtures.mjs live-fixtures.test.js test-fixtures/live/espn-scoreboard.json
git commit -m "live: ESPN fixtures feed with league map and cache

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Source adapters: registry, host failover, Nuvio (`live-sources.mjs`, `live-source-nuvio.mjs`)

**Files:**
- Create: `live-sources.mjs`, `live-source-nuvio.mjs`
- Test: `live-sources.test.js`, `live-source-nuvio.test.js`
- Fixtures (already saved): `test-fixtures/live/nuvio-catalog-football.json`, `test-fixtures/live/nuvio-streams.json`

**Interfaces:**
- Consumes: `isNetworkError(err)` from `dns-fetch.js`.
- Produces:
  - `createSourceRegistry(adapters) -> { list() -> Adapter[], get(name) -> Adapter|null }`
  - `withHostFailover(hosts, fn) -> Promise` (calls `fn(host)`, moves to the next host on a network error, remembers the last host that worked on the closure's `hosts` order)
  - `Adapter = { name, hosts: string[], listMatches() -> Promise<SourceMatch[]>, streamsFor(sourceId) -> Promise<Stream[]> }`
  - `SourceMatch = { sourceId, title, league: string|null, kickoff: string|null, home: string, away: string, poster: string|null, status: 'in'|null }`
  - `Stream = { url, referer, origin, userAgent, label, language, quality, rank }`
  - `parseNuvioCatalog(json) -> SourceMatch[]`, `parseNuvioStreams(json) -> Stream[]`, `stripDecorations(text) -> string`
  - `createNuvioAdapter({ fetchImpl = fetch, hosts = NUVIO_HOSTS }) -> Adapter`
  - `NUVIO_HOSTS = ['https://nuviosports.xyz']`

- [ ] **Step 1: Write the failing tests**

Create `live-sources.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceRegistry, withHostFailover } from './live-sources.mjs';

test('registry lists adapters in order and finds them by name', () => {
  const a = { name: 'a' }, b = { name: 'b' };
  const reg = createSourceRegistry([a, b]);
  assert.deepEqual(reg.list(), [a, b]);
  assert.equal(reg.get('b'), b);
  assert.equal(reg.get('zzz'), null);
});

test('withHostFailover moves to the next host on a network error and remembers the winner', async () => {
  const hosts = ['https://dead.example', 'https://alive.example'];
  const tried = [];
  const fn = async host => { tried.push(host); if (host.includes('dead')) { const e = new Error('getaddrinfo ENOTFOUND dead.example'); e.code = 'ENOTFOUND'; throw e; } return 'ok'; };
  const failover = withHostFailover(hosts);
  assert.equal(await failover(fn), 'ok');
  assert.deepEqual(tried, ['https://dead.example', 'https://alive.example']);
  tried.length = 0;
  assert.equal(await failover(fn), 'ok');
  assert.deepEqual(tried, ['https://alive.example'], 'the good host is tried first next time');
});

test('withHostFailover rethrows non-network errors immediately and the last network error when all hosts fail', async () => {
  const failover = withHostFailover(['https://a.example', 'https://b.example']);
  await assert.rejects(() => failover(async () => { throw new Error('Nuvio 500'); }), /Nuvio 500/);
  let n = 0;
  await assert.rejects(() => failover(async () => { n++; throw new TypeError('fetch failed'); }), /fetch failed/);
  assert.equal(n, 2);
});
```

Create `live-source-nuvio.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNuvioCatalog, parseNuvioStreams, stripDecorations, createNuvioAdapter, NUVIO_HOSTS } from './live-source-nuvio.mjs';

const catalog = JSON.parse(readFileSync(new URL('./test-fixtures/live/nuvio-catalog-football.json', import.meta.url), 'utf8'));
const streams = JSON.parse(readFileSync(new URL('./test-fixtures/live/nuvio-streams.json', import.meta.url), 'utf8'));

test('stripDecorations removes emoji, flag tag characters and variation selectors', () => {
  assert.equal(stripDecorations('🔴 LIVE: Manchester United \u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} vs West Ham United'), 'LIVE: Manchester United vs West Ham United');
  assert.equal(stripDecorations('🏆 League: 󠁧󠁢󠁥󠁮󠁧󠁿 England - Women\'s Super League'), 'League: England - Women\'s Super League');
  assert.equal(stripDecorations('plain'), 'plain');
});

test('parseNuvioCatalog maps metas to source matches with clean team names', () => {
  const list = parseNuvioCatalog(catalog);
  assert.ok(list.length >= 2);
  const mu = list.find(m => m.sourceId === 'nuvio_sport_dlv_308_manchester-united-vs-west-ham-united');
  assert.equal(mu.title, 'Manchester United vs West Ham United');
  assert.equal(mu.home, 'Manchester United');
  assert.equal(mu.away, 'West Ham United');
  assert.equal(mu.league, "England - Women's Super League");
  assert.equal(mu.kickoff, '2026-09-27T12:00:00Z');
  assert.equal(mu.status, 'in');
  assert.match(mu.poster, /^https:\/\//);
});

test('parseNuvioCatalog tolerates metas without cast, description or released', () => {
  const list = parseNuvioCatalog({ metas: [{ id: 'x', name: 'A vs B' }] });
  assert.deepEqual(list[0], { sourceId: 'x', title: 'A vs B', league: null, kickoff: null, home: 'A', away: 'B', poster: null, status: null });
  assert.deepEqual(parseNuvioCatalog({}), []);
});

test('parseNuvioStreams unwraps the /api/manifest proxy URL and pulls headers from behaviorHints', () => {
  const list = parseNuvioStreams(streams);
  assert.ok(list.length >= 2);
  const s = list[0];
  assert.match(s.url, /^https:\/\/643t8a\.7odxv0l067ka\.net:8443\/hls\/.+\.m3u8\?s=.+&e=\d+$/);
  assert.equal(s.referer, 'https://assetrage.net/');
  assert.equal(s.origin, 'https://assetrage.net');
  assert.match(s.userAgent, /Chrome/);
  assert.equal(s.label, 'DaddyLive | Sportsnet One [CA • English]');
  assert.equal(s.language, 'English');
  assert.equal(s.quality, 'HD');
  assert.equal(s.rank, 97);
});

test('parseNuvioStreams falls back to query params and a plain url when hints are missing', () => {
  const list = parseNuvioStreams({ streams: [
    { title: 'X', url: 'https://nuviosports.xyz/api/manifest?url=https%3A%2F%2Fcdn.example%2Fa.m3u8&referer=https%3A%2F%2Fr.example%2F&origin=https%3A%2F%2Fr.example' },
    { title: 'Y\nQuality: 720p', url: 'https://cdn.example/b.m3u8', speedScore: 5 },
  ] });
  assert.equal(list[0].url, 'https://cdn.example/a.m3u8');
  assert.equal(list[0].referer, 'https://r.example/');
  assert.equal(list[0].origin, 'https://r.example');
  assert.equal(list[1].url, 'https://cdn.example/b.m3u8');
  assert.equal(list[1].referer, '');
  assert.equal(list[1].quality, '720p');
  assert.equal(list[1].rank, 5);
  assert.deepEqual(parseNuvioStreams({}), []);
});

test('createNuvioAdapter hits the football catalog and the per-id stream list, failing over hosts', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (url.startsWith('https://dead.example')) { const e = new TypeError('fetch failed'); throw e; }
    if (url.endsWith('/catalog/tv/nuvio_sports_live/genre=Football.json')) return { ok: true, status: 200, json: async () => catalog };
    if (/\/stream\/tv\/nuvio_sport_dlv_308_manchester-united-vs-west-ham-united\.json$/.test(url)) return { ok: true, status: 200, json: async () => streams };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const adapter = createNuvioAdapter({ fetchImpl, hosts: ['https://dead.example', 'https://nuviosports.xyz'] });
  assert.equal(adapter.name, 'nuvio');
  const matches = await adapter.listMatches();
  assert.ok(matches.length >= 2);
  assert.equal(urls[0], 'https://dead.example/catalog/tv/nuvio_sports_live/genre=Football.json');
  assert.equal(urls[1], 'https://nuviosports.xyz/catalog/tv/nuvio_sports_live/genre=Football.json');
  const list = await adapter.streamsFor('nuvio_sport_dlv_308_manchester-united-vs-west-ham-united');
  assert.ok(list.length >= 2);
  assert.equal(urls[2], 'https://nuviosports.xyz/stream/tv/nuvio_sport_dlv_308_manchester-united-vs-west-ham-united.json');
  await assert.rejects(() => adapter.streamsFor('nope'), /Nuvio 404/);
  assert.deepEqual(NUVIO_HOSTS, ['https://nuviosports.xyz']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test live-sources.test.js live-source-nuvio.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `live-sources.mjs`**

```js
// live-sources.mjs — the live-stream source adapter registry.
//
// An adapter = { name, hosts, listMatches(), streamsFor(sourceId) }. The helper
// treats every adapter alike, so a new source (streamed.pk, another add-on) is
// one new module dropped into the registry. Hosts are tried in order on network
// errors because these domains move; the host that answered is tried first next.
import { isNetworkError } from './dns-fetch.js';

export function createSourceRegistry(adapters) {
  const list = adapters.slice();
  return {
    list: () => list.slice(),
    get: name => list.find(a => a.name === name) || null,
  };
}

// Returns an async function `run(fn)` that calls fn(host) over `hosts`, moving on
// only for network errors (DNS, refused, reset); HTTP errors are the caller's.
export function withHostFailover(hosts) {
  let preferred = 0;
  return async function run(fn) {
    const order = hosts.map((_, i) => hosts[(preferred + i) % hosts.length]);
    let lastError = null;
    for (const host of order) {
      try {
        const out = await fn(host);
        preferred = hosts.indexOf(host);
        return out;
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        lastError = err;
      }
    }
    throw lastError || new Error('no hosts configured');
  };
}
```

- [ ] **Step 4: Implement `live-source-nuvio.mjs`**

```js
// live-source-nuvio.mjs — Nuvio Live Sports (a public Stremio add-on wrapping
// DaddyLive) as a live-football source. Reachable from Sky, JSON, CORS-open.
//
// Catalog:  GET {host}/catalog/tv/nuvio_sports_live/genre=Football.json
// Streams:  GET {host}/stream/tv/{id}.json
// Their stream `url` is their own /api/manifest proxy, which does NOT rewrite
// segment URLs, so we unwrap the upstream m3u8 and relay it ourselves with the
// Referer/Origin from behaviorHints.proxyHeaders (see live-relay.mjs).
import { withHostFailover } from './live-sources.mjs';
import { CHROME_UA } from './live-fixtures.mjs';

export const NUVIO_HOSTS = ['https://nuviosports.xyz'];

// Names and descriptions are decorated with emoji, flag "tag" characters
// (U+E0000..U+E007F) and variation selectors. Strip all of it.
export function stripDecorations(text) {
  return String(text || '')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[️‍]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTeams(title) {
  const m = /^(.*?)\s+vs\.?\s+(.*)$/i.exec(title);
  return m ? [m[1].trim(), m[2].trim()] : [title, ''];
}

export function parseNuvioCatalog(json) {
  const metas = (json && json.metas) || [];
  return metas.map(meta => {
    const title = stripDecorations(meta.name).replace(/^LIVE:\s*/i, '');
    const desc = stripDecorations(meta.description);
    const leagueMatch = /League:\s*([^\n]+?)(?:\s+Category:|\s+Status:|$)/.exec(desc);
    const cast = Array.isArray(meta.cast) ? meta.cast.map(stripDecorations) : [];
    const [h, a] = cast.length >= 2 ? [cast[0], cast[1]] : splitTeams(title);
    let kickoff = null;
    if (meta.released) { const d = new Date(meta.released); if (!Number.isNaN(d.getTime())) kickoff = d.toISOString().replace(/\.000Z$/, 'Z'); }
    return {
      sourceId: meta.id,
      title,
      league: leagueMatch ? leagueMatch[1].trim() : null,
      kickoff,
      home: h || '',
      away: a || '',
      poster: meta.poster || null,
      status: /LIVE NOW/i.test(desc) ? 'in' : null,
    };
  });
}

export function parseNuvioStreams(json) {
  const list = (json && json.streams) || [];
  return list.map(s => {
    let url = s.url || '';
    let referer = '', origin = '';
    try {
      const u = new URL(url);
      if (u.pathname.endsWith('/api/manifest') && u.searchParams.get('url')) {
        referer = u.searchParams.get('referer') || '';
        origin = u.searchParams.get('origin') || '';
        url = u.searchParams.get('url');
      }
    } catch { /* keep as-is */ }
    const hints = (s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) || {};
    const lines = String(s.title || '').split('\n').map(stripDecorations).filter(Boolean);
    const q = /Quality:\s*(\S+)/i.exec(lines.join(' '));
    return {
      url,
      referer: hints.Referer || referer,
      origin: hints.Origin || origin,
      userAgent: hints['User-Agent'] || CHROME_UA,
      label: lines[0] || 'Stream',
      language: s.language || '',
      quality: s.resolution || (q ? q[1] : ''),
      rank: Number.isFinite(Number(s.speedScore)) ? Number(s.speedScore) : (Number(s.score) || 0),
    };
  }).filter(s => /^https?:\/\//.test(s.url));
}

export function createNuvioAdapter({ fetchImpl = fetch, hosts = NUVIO_HOSTS } = {}) {
  const run = withHostFailover(hosts);
  const getJson = path => run(async host => {
    const res = await fetchImpl(host + path, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA } });
    if (!res.ok) throw new Error(`Nuvio ${res.status}`);
    return res.json();
  });
  return {
    name: 'nuvio',
    hosts,
    listMatches: () => getJson('/catalog/tv/nuvio_sports_live/genre=Football.json').then(parseNuvioCatalog),
    streamsFor: id => getJson(`/stream/tv/${encodeURIComponent(id)}.json`).then(parseNuvioStreams),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test live-sources.test.js live-source-nuvio.test.js`
Expected: PASS (9 tests). If the `stripDecorations` league test fails on the flag tags, confirm the test string was saved as real U+E00xx characters (the fixture file has them; copy from `nuvio-catalog-football.json` if the editor mangled them).

- [ ] **Step 6: Commit**

```bash
git add live-sources.mjs live-sources.test.js live-source-nuvio.mjs live-source-nuvio.test.js test-fixtures/live/nuvio-catalog-football.json test-fixtures/live/nuvio-streams.json
git commit -m "live: source adapter registry with host failover; Nuvio adapter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---


### Task 4: Join fixtures to source matches (`live-match.mjs`)

**Files:**
- Create: `live-match.mjs`
- Test: `live-match.test.js`

**Interfaces:**
- Consumes: `Fixture` (Task 2), `SourceMatch` with an added `adapter: string` field (Task 3; the route in Task 7 stamps it).
- Produces:
  - `normaliseTeam(name) -> string`
  - `leaguePriority(name) -> number` (1 = Premier League … 50 = unknown)
  - `deriveState(kickoffIso, nowMs) -> 'pre'|'in'|'post'` (`in` from kick-off to kick-off + 130 min)
  - `selectTodayFixtures(fixtureLists: Fixture[][], nowMs) -> Fixture[]` (merge by id, keep kick-off in `[now - 3h, now + 26h]`)
  - `joinFixtures(fixtures, sourceMatches, { now }) -> LiveMatch[]`
  - `sortMatches(list) -> LiveMatch[]`
  - `LiveMatch = { id, title, league: string, kickoff, state, clock, home: {name, logo, score}, away: {…}, broadcasters: string[], sources: [{adapter, sourceId}], hasStream: boolean, priority: number, poster: string|null }`

- [ ] **Step 1: Write the failing tests**

Create `live-match.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTeam, leaguePriority, deriveState, selectTodayFixtures, joinFixtures, sortMatches } from './live-match.mjs';

const H = 3_600_000;
const fixture = (id, home, away, kickoff, extra = {}) => ({
  id: `espn:${id}`, league: { id: 700, slug: 'eng.1', name: 'Premier League' }, kickoff, state: 'pre', clock: null,
  home: { name: home, shortName: home, logo: `https://a.espncdn.com/${id}h.png`, score: null },
  away: { name: away, shortName: away, logo: `https://a.espncdn.com/${id}a.png`, score: null },
  broadcasters: ['Sky Sports'], ...extra,
});
const source = (sourceId, home, away, kickoff, extra = {}) => ({ adapter: 'nuvio', sourceId, title: `${home} vs ${away}`, league: 'England - Premier League', kickoff, home, away, poster: null, status: null, ...extra });

test('normaliseTeam strips decorations, suffixes and applies aliases', () => {
  // Real Nuvio string: flag tag characters after the club name.
  assert.equal(normaliseTeam('Manchester United \u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'), 'manchester united');
  assert.equal(normaliseTeam('Man Utd'), 'manchester united');
  assert.equal(normaliseTeam('Manchester Utd'), 'manchester united');
  assert.equal(normaliseTeam('Wolves'), 'wolverhampton wanderers');
  assert.equal(normaliseTeam('Wolverhampton Wanderers FC'), 'wolverhampton wanderers');
  assert.equal(normaliseTeam('Inter'), 'inter milan');
  assert.equal(normaliseTeam('Internazionale'), 'inter milan');
  assert.equal(normaliseTeam('Spurs'), 'tottenham hotspur');
  assert.equal(normaliseTeam('PSG'), 'paris saint germain');
  assert.equal(normaliseTeam('Paris Saint-Germain'), 'paris saint germain');
  assert.equal(normaliseTeam('Atlético de Madrid'), 'atletico madrid');
  assert.equal(normaliseTeam('Manchester United Women'), 'manchester united');
  assert.equal(normaliseTeam('AFC Bournemouth'), 'bournemouth');
  assert.equal(normaliseTeam(''), '');
});

test('leaguePriority ranks the big competitions first and unknown leagues last', () => {
  assert.equal(leaguePriority('Premier League'), 1);
  assert.equal(leaguePriority('England - Premier League'), 1);
  assert.equal(leaguePriority('UEFA Champions League'), 2);
  assert.equal(leaguePriority('LaLiga'), 5);
  assert.equal(leaguePriority('Spain - La Liga'), 5);
  assert.equal(leaguePriority('UEFA Nations League'), 11);
  assert.equal(leaguePriority('International Friendly'), 12);
  assert.equal(leaguePriority("Women's Super League"), 50);
  assert.equal(leaguePriority(null), 50);
});

test('deriveState uses a 130 minute live window', () => {
  const k = Date.parse('2026-09-27T15:00:00Z');
  assert.equal(deriveState('2026-09-27T15:00:00Z', k - 1000), 'pre');
  assert.equal(deriveState('2026-09-27T15:00:00Z', k), 'in');
  assert.equal(deriveState('2026-09-27T15:00:00Z', k + 129 * 60_000), 'in');
  assert.equal(deriveState('2026-09-27T15:00:00Z', k + 131 * 60_000), 'post');
  assert.equal(deriveState(null, k), 'pre');
});

test('selectTodayFixtures merges two ESPN days by id and windows by kick-off', () => {
  const now = Date.parse('2026-09-27T23:30:00Z');
  const early = fixture(1, 'A', 'B', '2026-09-27T19:00:00Z');      // 4.5 h ago -> dropped
  const recent = fixture(2, 'C', 'D', '2026-09-27T21:00:00Z');     // 2.5 h ago -> kept
  const lateNight = fixture(3, 'E', 'F', '2026-09-28T00:30:00Z');  // next ET day, kept
  const tomorrowEve = fixture(4, 'G', 'H', '2026-09-28T19:00:00Z'); // +19.5 h kept
  const farOff = fixture(5, 'I', 'J', '2026-09-29T02:00:00Z');     // +26.5 h dropped
  const out = selectTodayFixtures([[early, recent, lateNight], [lateNight, tomorrowEve, farOff]], now);
  assert.deepEqual(out.map(f => f.id), ['espn:2', 'espn:3', 'espn:4']);
});

test('joinFixtures matches by normalised names in either order within 30 minutes', () => {
  const now = Date.parse('2026-09-27T14:00:00Z');
  const fixtures = [fixture(1, 'Manchester United', 'West Ham United', '2026-09-27T15:00:00Z'), fixture(2, 'Wolverhampton Wanderers', 'Arsenal', '2026-09-27T17:30:00Z')];
  const sources = [
    source('s1', 'West Ham United \u{E0067}\u{E007F}', 'Man Utd', '2026-09-27T15:10:00Z'),   // swapped order, 10 min off
    source('s2', 'Wolves', 'Arsenal', '2026-09-27T18:30:00Z'),                                // 60 min off -> no join
    source('s3', 'Inter', 'Napoli', '2026-09-27T18:45:00Z', { league: 'Italy - Serie A' }),  // no fixture at all
  ];
  const out = joinFixtures(fixtures, sources, { now });
  const mu = out.find(m => m.id === 'espn:1');
  assert.deepEqual(mu.sources, [{ adapter: 'nuvio', sourceId: 's1' }]);
  assert.equal(mu.hasStream, true);
  assert.equal(mu.title, 'Manchester United vs West Ham United');
  assert.equal(mu.priority, 1);
  const wolves = out.find(m => m.id === 'espn:2');
  assert.deepEqual(wolves.sources, []);
  assert.equal(wolves.hasStream, false);
  const s2 = out.find(m => m.id === 'src:nuvio:s2');
  assert.equal(s2.hasStream, true, 'an unmatched source match is kept as its own entry');
  const inter = out.find(m => m.id === 'src:nuvio:s3');
  assert.equal(inter.league, 'Italy - Serie A');
  assert.equal(inter.priority, 6);
  assert.equal(inter.state, 'pre');
  assert.equal(inter.clock, null);
  assert.equal(inter.home.name, 'Inter');
  assert.equal(inter.home.logo, null);
  assert.equal(out.length, 4);
});

test('joinFixtures: a source marked live overrides a derived pre state, and fixture state wins when joined', () => {
  const now = Date.parse('2026-09-27T14:00:00Z');
  const live = source('s9', 'A', 'B', '2026-09-27T14:05:00Z', { status: 'in' });
  const [only] = joinFixtures([], [live], { now });
  assert.equal(only.state, 'in');
  const fx = fixture(1, 'A', 'B', '2026-09-27T14:05:00Z', { state: 'in', clock: "12'" });
  const [joined] = joinFixtures([fx], [{ ...live, status: null }], { now });
  assert.equal(joined.state, 'in');
  assert.equal(joined.clock, "12'");
});

test('sortMatches: live first, then upcoming by kick-off, then finished; priority breaks ties', () => {
  const m = (id, state, kickoff, priority) => ({ id, state, kickoff, priority });
  const out = sortMatches([
    m('post-pl', 'post', '2026-09-27T12:00:00Z', 1),
    m('pre-friendly', 'pre', '2026-09-27T18:00:00Z', 12),
    m('pre-ucl-late', 'pre', '2026-09-27T20:00:00Z', 2),
    m('pre-pl-late', 'pre', '2026-09-27T20:00:00Z', 1),
    m('in-friendly', 'in', '2026-09-27T14:00:00Z', 12),
    m('in-pl', 'in', '2026-09-27T14:30:00Z', 1),
  ]);
  assert.deepEqual(out.map(x => x.id), ['in-pl', 'in-friendly', 'pre-friendly', 'pre-pl-late', 'pre-ucl-late', 'post-pl']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test live-match.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `live-match.mjs`**

```js
// live-match.mjs — join ESPN fixtures to source-adapter matches and order them.
//
// Sources name teams loosely ("Man Utd", "Wolves", "Inter", flag emoji, tag
// characters), so both sides are normalised before comparing, and kick-offs
// only need to agree to within 30 minutes. Fixtures with no stream are kept
// (greyed on the TV) so the schedule is complete; source matches ESPN does not
// know are kept too, with their state derived from kick-off.

const ALIASES = {
  'man utd': 'manchester united', 'manchester utd': 'manchester united', 'man united': 'manchester united',
  'man city': 'manchester city',
  'wolves': 'wolverhampton wanderers', 'wolverhampton': 'wolverhampton wanderers',
  'inter': 'inter milan', 'internazionale': 'inter milan', 'inter milano': 'inter milan',
  'spurs': 'tottenham hotspur', 'tottenham': 'tottenham hotspur',
  'psg': 'paris saint germain', 'paris sg': 'paris saint germain',
  'atletico de madrid': 'atletico madrid', 'atletico': 'atletico madrid',
  'newcastle': 'newcastle united', 'west ham': 'west ham united', 'leeds': 'leeds united',
  'nottm forest': 'nottingham forest', "nott'm forest": 'nottingham forest',
  'brighton': 'brighton and hove albion', 'brighton hove albion': 'brighton and hove albion',
  'bayern': 'bayern munich', 'fc bayern munchen': 'bayern munich', 'bayern munchen': 'bayern munich',
  'barca': 'barcelona', 'fc barcelona': 'barcelona',
  'real': 'real madrid', 'juve': 'juventus',
};
// Club-name furniture that differs between feeds. Single letters are NOT stripped
// (a team literally named "B" in tests, "W" in women's feeds would vanish).
const SUFFIXES = /\b(fc|cf|afc|sc|ac|as|ss|us|sv|bk|if|fk|cd|sd|ud|women|u21|u23)\b/g;

export function normaliseTeam(name) {
  let s = String(name || '')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[️‍]/g, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[s] || s;
}

const LEAGUE_PRIORITY = [
  [/premier league/i, 1], [/champions league/i, 2], [/europa league/i, 3], [/conference league/i, 4],
  [/la ?liga/i, 5], [/serie a\b/i, 6], [/bundesliga/i, 7], [/ligue 1/i, 8],
  [/fa cup/i, 9], [/carabao|league cup|efl cup/i, 10],
  [/nations league|world cup|european championship|\beuro\b/i, 11], [/friendl/i, 12],
];
export function leaguePriority(name) {
  const s = String(name || '');
  if (/women|wsl|feminin|femenina/i.test(s)) return 50;
  for (const [re, p] of LEAGUE_PRIORITY) if (re.test(s)) return p;
  return 50;
}

const LIVE_WINDOW_MS = 130 * 60_000;
export function deriveState(kickoffIso, nowMs) {
  const k = Date.parse(kickoffIso || '');
  if (!Number.isFinite(k) || nowMs < k) return 'pre';
  return nowMs - k < LIVE_WINDOW_MS ? 'in' : 'post';
}

export function selectTodayFixtures(fixtureLists, nowMs) {
  const byId = new Map();
  for (const list of fixtureLists) for (const f of list || []) byId.set(f.id, f);
  const lo = nowMs - 3 * 3_600_000, hi = nowMs + 26 * 3_600_000;
  return Array.from(byId.values()).filter(f => { const k = Date.parse(f.kickoff); return k >= lo && k <= hi; });
}

const JOIN_WINDOW_MS = 30 * 60_000;
function sameTeams(fx, sm) {
  const fh = normaliseTeam(fx.home.name), fa = normaliseTeam(fx.away.name);
  const sh = normaliseTeam(sm.home), sa = normaliseTeam(sm.away);
  if (!fh || !fa || !sh || !sa) return false;
  return (fh === sh && fa === sa) || (fh === sa && fa === sh);
}
function closeKickoff(a, b) {
  const x = Date.parse(a || ''), y = Date.parse(b || '');
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= JOIN_WINDOW_MS;
}

export function joinFixtures(fixtures, sourceMatches, { now = Date.now() } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const out = [];
  const claimed = new Set();
  for (const fx of fixtures) {
    const sources = [];
    for (const sm of sourceMatches) {
      if (claimed.has(sm) || !sameTeams(fx, sm) || !closeKickoff(fx.kickoff, sm.kickoff)) continue;
      claimed.add(sm);
      sources.push({ adapter: sm.adapter, sourceId: sm.sourceId });
    }
    out.push({
      id: fx.id,
      title: `${fx.home.name} vs ${fx.away.name}`,
      league: fx.league.name,
      kickoff: fx.kickoff,
      state: fx.state,
      clock: fx.clock,
      home: { name: fx.home.name, logo: fx.home.logo, score: fx.home.score },
      away: { name: fx.away.name, logo: fx.away.logo, score: fx.away.score },
      broadcasters: fx.broadcasters || [],
      sources,
      hasStream: sources.length > 0,
      priority: leaguePriority(fx.league.name),
      poster: null,
    });
  }
  for (const sm of sourceMatches) {
    if (claimed.has(sm)) continue;
    out.push({
      id: `src:${sm.adapter}:${sm.sourceId}`,
      title: sm.title || `${sm.home} vs ${sm.away}`,
      league: sm.league || 'Other',
      kickoff: sm.kickoff,
      state: sm.status === 'in' ? 'in' : deriveState(sm.kickoff, nowMs),
      clock: null,
      home: { name: sm.home, logo: null, score: null },
      away: { name: sm.away, logo: null, score: null },
      broadcasters: [],
      sources: [{ adapter: sm.adapter, sourceId: sm.sourceId }],
      hasStream: true,
      priority: leaguePriority(sm.league),
      poster: sm.poster || null,
    });
  }
  return out;
}

const STATE_RANK = { in: 0, pre: 1, post: 2 };
export function sortMatches(list) {
  return list.slice().sort((a, b) => {
    const s = (STATE_RANK[a.state] ?? 1) - (STATE_RANK[b.state] ?? 1);
    if (s) return s;
    if (a.state === 'pre') {
      const k = Date.parse(a.kickoff || '') - Date.parse(b.kickoff || '');
      if (k) return k;
    }
    const p = (a.priority ?? 50) - (b.priority ?? 50);
    if (p) return p;
    return Date.parse(a.kickoff || '') - Date.parse(b.kickoff || '');
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test live-match.test.js`
Expected: PASS (7 tests). Note `'Inter'` in the join test normalises to `inter milan` on both sides only because both go through `normaliseTeam`; `inter.home.name` keeps the raw source string.

- [ ] **Step 5: Commit**

```bash
git add live-match.mjs live-match.test.js
git commit -m "live: join fixtures to source matches, derive state, sort

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Free 24/7 channel feed (`live-channels.mjs`)

**Files:**
- Create: `live-channels.mjs`
- Test: `live-channels.test.js`

**Interfaces:**
- Produces:
  - `SPORTS_M3U_URL = 'https://iptv-org.github.io/iptv/categories/sports.m3u'`
  - `CHANNEL_ALLOWLIST: RegExp[]`
  - `parseM3u(text) -> [{ name, url, tvgId, logo, group, geoBlocked, not247 }]`
  - `filterFootballChannels(list) -> list` (allowlist match on name or tvgId, drops `geoBlocked`)
  - `probeHls(url, fetchImpl, timeoutMs = 4000) -> Promise<boolean>`
  - `mapLimit(items, limit, fn) -> Promise<any[]>`
  - `channelId(ch) -> string`
  - `createChannelFeed({ fetchImpl = fetch, probe = probeHls, now = Date.now, ttlMs = 900_000 }) -> { fetchChannels() -> Promise<{ channels: [{id, name, logo, url}], stale: boolean, fetchedAt: string }> }`

- [ ] **Step 1: Write the failing tests**

Create `live-channels.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, filterFootballChannels, probeHls, mapLimit, channelId, createChannelFeed, SPORTS_M3U_URL } from './live-channels.mjs';

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="beINSPORTSXTRA.us@SD" tvg-logo="https://i.ibb.co/HT49GPmB/XTRA-2.png" group-title="Sports",beIN SPORTS XTRA (1080p)',
  'https://bein-xtra-bein.amagi.tv/playlist.m3u8',
  '#EXTINF:-1 tvg-id="SetantaSports1.ge" tvg-logo="" group-title="Sports",Setanta Sports 1 HD (1080p) [Geo-blocked]',
  'https://fs.uplink.kz/setanta_sports_1_hd/mono.m3u8?token=onlinetv',
  '#EXTINF:-1 tvg-id="" tvg-logo="https://x/y.png" group-title="Sports",Digi Sport 2 (720p) [Not 24/7]',
  'http://89.1.2.3:8080/digi2/index.m3u8',
  '#EXTINF:-1 tvg-id="Golf.us" tvg-logo="" group-title="Sports",Golf Channel',
  'https://golf.example/index.m3u8',
  '',
].join('\r\n');

test('parseM3u handles CRLF, attributes and name tags', () => {
  const list = parseM3u(M3U);
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], { name: 'beIN SPORTS XTRA (1080p)', url: 'https://bein-xtra-bein.amagi.tv/playlist.m3u8', tvgId: 'beINSPORTSXTRA.us@SD', logo: 'https://i.ibb.co/HT49GPmB/XTRA-2.png', group: 'Sports', geoBlocked: false, not247: false });
  assert.equal(list[1].geoBlocked, true);
  assert.equal(list[1].name, 'Setanta Sports 1 HD (1080p)');
  assert.equal(list[2].not247, true);
  assert.equal(list[2].url, 'http://89.1.2.3:8080/digi2/index.m3u8');
  assert.ok(!list.some(c => c.url.endsWith('\r')), 'no carriage returns leak into URLs');
  assert.deepEqual(parseM3u(''), []);
});

test('filterFootballChannels keeps allowlisted football channels and drops geo-blocked ones', () => {
  const names = filterFootballChannels(parseM3u(M3U)).map(c => c.name);
  assert.deepEqual(names, ['beIN SPORTS XTRA (1080p)', 'Digi Sport 2 (720p)']);
});

test('channelId prefers tvg-id and otherwise hashes the url stably', () => {
  assert.equal(channelId({ tvgId: 'Golf.us', url: 'x' }), 'Golf.us');
  const a = channelId({ tvgId: '', url: 'http://89.1.2.3:8080/digi2/index.m3u8' });
  assert.match(a, /^u[0-9a-f]{12}$/);
  assert.equal(a, channelId({ tvgId: '', url: 'http://89.1.2.3:8080/digi2/index.m3u8' }));
});

test('probeHls accepts an HLS content-type or an #EXTM3U body, rejects everything else, and times out', async () => {
  const ok1 = await probeHls('https://a', async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }), text: async () => '' }));
  const ok2 = await probeHls('https://b', async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/plain' }), text: async () => '#EXTM3U\n#EXT-X-VERSION:3' }));
  const no1 = await probeHls('https://c', async () => ({ ok: false, status: 403, headers: new Headers(), text: async () => '' }));
  const no2 = await probeHls('https://d', async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<html>' }));
  const no3 = await probeHls('https://e', async () => { throw new TypeError('fetch failed'); });
  const slow = await probeHls('https://f', (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), 20);
  assert.deepEqual([ok1, ok2, no1, no2, no3, slow], [true, true, false, false, false, false]);
});

test('mapLimit runs at most `limit` calls at once and preserves order', async () => {
  let active = 0, peak = 0;
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async n => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, n)); active--; return n * 10; });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
});

test('createChannelFeed downloads, filters, probes, caches for the TTL and serves stale on failure', async () => {
  let clock = 0; let downloads = 0; let fail = false;
  const probed = [];
  const fetchImpl = async url => {
    assert.equal(url, SPORTS_M3U_URL);
    downloads++;
    if (fail) throw new TypeError('fetch failed');
    return { ok: true, status: 200, text: async () => M3U };
  };
  const probe = async url => { probed.push(url); return !url.startsWith('http://89.'); };
  const feed = createChannelFeed({ fetchImpl, probe, now: () => clock });
  const a = await feed.fetchChannels();
  assert.deepEqual(a.channels.map(c => c.name), ['beIN SPORTS XTRA (1080p)']);
  assert.equal(a.channels[0].id, 'beINSPORTSXTRA.us@SD');
  assert.equal(a.channels[0].logo, 'https://i.ibb.co/HT49GPmB/XTRA-2.png');
  assert.equal(a.stale, false);
  assert.equal(a.fetchedAt, new Date(0).toISOString());
  assert.deepEqual(probed.sort(), ['http://89.1.2.3:8080/digi2/index.m3u8', 'https://bein-xtra-bein.amagi.tv/playlist.m3u8']);
  clock = 600_000;
  await feed.fetchChannels();
  assert.equal(downloads, 1, 'cached inside the 15 minute TTL');
  clock = 1_000_000; fail = true;
  const b = await feed.fetchChannels();
  assert.equal(downloads, 2);
  assert.equal(b.stale, true);
  assert.deepEqual(b.channels.map(c => c.name), ['beIN SPORTS XTRA (1080p)']);
  const empty = createChannelFeed({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, probe, now: () => 0 });
  const c = await empty.fetchChannels();
  assert.deepEqual(c, { channels: [], stale: true, fetchedAt: null });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test live-channels.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `live-channels.mjs`**

```js
// live-channels.mjs — free 24/7 sports channels from the iptv-org playlist.
//
// The playlist is CC0, rebuilt hourly, ~430 sports channels; a football
// allowlist plus a liveness probe at fetch time leaves the ones worth showing.
// Streams rot weekly, so nothing is trusted without a probe, and the last good
// list is served (marked stale) when the download itself fails.
import { createHash } from 'node:crypto';
import { CHROME_UA } from './live-fixtures.mjs';

export const SPORTS_M3U_URL = 'https://iptv-org.github.io/iptv/categories/sports.m3u';

export const CHANNEL_ALLOWLIST = [
  /setanta sports/i, /digi ?sport/i, /bein/i, /golazo/i, /premier sports/i, /sportitalia/i,
  /\bmutv\b/i, /real madrid tv/i, /inter tv/i, /\bespn/i, /fox soccer/i, /sky sport/i, /tnt sport/i,
  /\bdazn\b/i, /\beleven\b/i, /\bsport ?tv\b/i, /futbol/i, /\bfoot\b/i, /la ?liga tv/i, /bundesliga/i,
  /premier league/i, /fifa/i, /uefa/i, /soccer/i,
];

const ATTR = /([a-zA-Z0-9-]+)="([^"]*)"/g;

export function parseM3u(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\r$/, '').trim());
  const out = [];
  let pending = null;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const comma = line.lastIndexOf(',');
      const head = comma >= 0 ? line.slice(0, comma) : line;
      let rawName = comma >= 0 ? line.slice(comma + 1).trim() : '';
      for (const m of head.matchAll(ATTR)) attrs[m[1]] = m[2];
      const geoBlocked = /\[Geo-blocked\]/i.test(rawName);
      const not247 = /\[Not 24\/7\]/i.test(rawName);
      const name = rawName.replace(/\s*\[(Geo-blocked|Not 24\/7)\]/gi, '').trim();
      pending = { name, url: '', tvgId: attrs['tvg-id'] || '', logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || '', geoBlocked, not247 };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending) { pending.url = line; out.push(pending); pending = null; }
  }
  return out;
}

export function filterFootballChannels(list) {
  return list.filter(c => !c.geoBlocked && CHANNEL_ALLOWLIST.some(re => re.test(c.name) || re.test(c.tvgId)));
}

export function channelId(ch) {
  if (ch.tvgId) return ch.tvgId;
  return 'u' + createHash('sha1').update(ch.url).digest('hex').slice(0, 12);
}

// Many of these servers reject HEAD, so GET the playlist and read a little of it.
export async function probeHls(url, fetchImpl = fetch, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { 'User-Agent': CHROME_UA }, redirect: 'follow' });
    if (!res.ok) return false;
    const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (/mpegurl|x-mpegURL|vnd\.apple/i.test(type)) return true;
    const body = await res.text();
    return body.trimStart().startsWith('#EXTM3U');
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createChannelFeed({ fetchImpl = fetch, probe = probeHls, now = Date.now, ttlMs = 900_000 } = {}) {
  let cache = null; // { at, channels }
  async function fetchChannels() {
    if (cache && now() - cache.at < ttlMs) return { channels: cache.channels, stale: false, fetchedAt: new Date(cache.at).toISOString() };
    try {
      const res = await fetchImpl(SPORTS_M3U_URL, { headers: { 'User-Agent': CHROME_UA } });
      if (!res.ok) throw new Error(`iptv-org ${res.status}`);
      const candidates = filterFootballChannels(parseM3u(await res.text()));
      const alive = await mapLimit(candidates, 8, async ch => (await probe(ch.url, fetchImpl)) ? ch : null);
      const channels = alive.filter(Boolean).map(ch => ({ id: channelId(ch), name: ch.name, logo: ch.logo || null, url: ch.url }));
      cache = { at: now(), channels };
      return { channels, stale: false, fetchedAt: new Date(cache.at).toISOString() };
    } catch (err) {
      if (cache) return { channels: cache.channels, stale: true, fetchedAt: new Date(cache.at).toISOString() };
      return { channels: [], stale: true, fetchedAt: null };
    }
  }
  return { fetchChannels };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test live-channels.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add live-channels.mjs live-channels.test.js
git commit -m "live: iptv-org football channel feed with liveness probing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: HLS relay, pure parts (`live-relay.mjs`)

**Files:**
- Create: `live-relay.mjs`
- Test: `live-relay.test.js`

**Interfaces:**
- Produces:
  - `signUpstream({ u, ref, org }, secret) -> string` (HMAC-SHA256 hex, first 32 chars)
  - `verifyUpstream({ u, ref, org, s }, secret) -> boolean` (timing-safe)
  - `isPublicHttpUrl(raw, protocols = ['http:', 'https:']) -> boolean`
  - `relayPath(kind: 'hls'|'seg', { u, ref, org }, secret, key = '') -> string` e.g. `/live/hls?u=…&s=…&ref=…&org=…[&key=…]`
  - `rewritePlaylist(text, { playlistUrl, relayBase = '', ref, org, secret, key }) -> string`
  - `upstreamHeaders(ref, org, userAgent = CHROME_UA) -> object`

- [ ] **Step 1: Write the failing tests**

Create `live-relay.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { signUpstream, verifyUpstream, isPublicHttpUrl, relayPath, rewritePlaylist, upstreamHeaders } from './live-relay.mjs';

const S = 'secret-1';
const P = { u: 'https://cdn.example/hls/a.m3u8?s=x&e=1', ref: 'https://ref.example/', org: 'https://ref.example' };

test('signatures verify only for the exact url/referer/origin triple and secret', () => {
  const s = signUpstream(P, S);
  assert.match(s, /^[0-9a-f]{32}$/);
  assert.equal(verifyUpstream({ ...P, s }, S), true);
  assert.equal(verifyUpstream({ ...P, s }, 'other'), false);
  assert.equal(verifyUpstream({ ...P, u: P.u + '&x=1', s }, S), false);
  assert.equal(verifyUpstream({ ...P, ref: '', s }, S), false);
  assert.equal(verifyUpstream({ ...P, s: '' }, S), false);
  assert.equal(verifyUpstream({ ...P, s: s.slice(0, 31) }, S), false);
});

test('isPublicHttpUrl refuses private, loopback, link-local and non-http targets', () => {
  assert.equal(isPublicHttpUrl('https://cdn.example/a.m3u8'), true);
  assert.equal(isPublicHttpUrl('http://89.1.2.3:8080/x.m3u8'), true);
  assert.equal(isPublicHttpUrl('http://89.1.2.3:8080/x.m3u8', ['https:']), false);
  for (const bad of ['http://127.0.0.1/x', 'http://localhost/x', 'http://10.0.0.5/x', 'http://192.168.0.189:8123/x', 'http://172.16.0.1/x', 'http://169.254.1.1/x', 'http://[::1]/x', 'http://[fe80::1]/x', 'http://[fd00::1]/x', 'http://[::ffff:127.0.0.1]/x', 'ftp://cdn.example/x', 'not a url', '']) {
    assert.equal(isPublicHttpUrl(bad), false, bad);
  }
});

test('relayPath encodes the triple, signs it, and appends the key only when given', () => {
  const p = relayPath('hls', P, S);
  const url = new URL('http://h' + p);
  assert.equal(url.pathname, '/live/hls');
  assert.equal(url.searchParams.get('u'), P.u);
  assert.equal(url.searchParams.get('ref'), P.ref);
  assert.equal(url.searchParams.get('org'), P.org);
  assert.equal(url.searchParams.get('s'), signUpstream(P, S));
  assert.equal(url.searchParams.get('key'), null);
  assert.equal(new URL('http://h' + relayPath('seg', P, S, 'k1')).searchParams.get('key'), 'k1');
  assert.equal(new URL('http://h' + relayPath('seg', P, S)).pathname, '/live/seg');
});

const seg = (p, u) => { const q = new URL('http://h' + p); return { path: q.pathname, u: q.searchParams.get('u'), ok: verifyUpstream({ u: q.searchParams.get('u'), ref: q.searchParams.get('ref'), org: q.searchParams.get('org'), s: q.searchParams.get('s') }, S), key: q.searchParams.get('key') }; };

test('rewritePlaylist routes segments to /live/seg, resolving relative URLs, keeping tags and adding the key', () => {
  const text = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:117', '#EXTINF:5.000,', 'seg117.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:5.000,', '/abs/seg118.ts?t=1', '#EXTINF:5.000,', 'https://other.example/seg119.ts', ''].join('\n');
  const out = rewritePlaylist(text, { playlistUrl: 'https://cdn.example/hls/live/index.m3u8?s=x', ref: P.ref, org: P.org, secret: S, key: 'k1' }).split('\n');
  assert.equal(out[0], '#EXTM3U');
  assert.equal(out[3], '#EXT-X-MEDIA-SEQUENCE:117');
  assert.equal(out[6], '#EXT-X-DISCONTINUITY');
  const a = seg(out[5]); assert.equal(a.path, '/live/seg'); assert.equal(a.u, 'https://cdn.example/hls/live/seg117.ts'); assert.equal(a.ok, true); assert.equal(a.key, 'k1');
  assert.equal(seg(out[8]).u, 'https://cdn.example/abs/seg118.ts?t=1');
  assert.equal(seg(out[10]).u, 'https://other.example/seg119.ts');
  assert.equal(out[out.length - 1], '');
});

test('rewritePlaylist sends master-playlist variants and .m3u8 lines to /live/hls', () => {
  const text = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720', 'high/mono.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'https://cdn.example/low/index.m3u8?e=1', 'chunklist.m3u8'].join('\n');
  const out = rewritePlaylist(text, { playlistUrl: 'https://cdn.example/hls/master.m3u8', ref: P.ref, org: P.org, secret: S, key: '' }).split('\n');
  assert.equal(out[1], '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720');
  const v = seg(out[2]); assert.equal(v.path, '/live/hls'); assert.equal(v.u, 'https://cdn.example/hls/high/mono.m3u8'); assert.equal(v.key, null);
  assert.equal(seg(out[4]).u, 'https://cdn.example/low/index.m3u8?e=1');
  assert.equal(seg(out[5]).path, '/live/hls');
});

test('rewritePlaylist rewrites URI= in KEY/MAP (segments) and MEDIA/I-FRAME (playlists), leaving other attributes alone', () => {
  const text = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="keys/k1.key",IV=0x0123', '#EXT-X-MAP:URI="init.mp4"', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"', '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframes.m3u8"', '#EXTINF:4,', 'f1.m4s'].join('\n');
  const out = rewritePlaylist(text, { playlistUrl: 'https://cdn.example/p/index.m3u8', ref: '', org: '', secret: S, key: 'k' }).split('\n');
  const uri = line => /URI="([^"]+)"/.exec(line)[1];
  assert.match(out[1], /^#EXT-X-KEY:METHOD=AES-128,URI=".+",IV=0x0123$/);
  assert.equal(seg(uri(out[1])).path, '/live/seg'); assert.equal(seg(uri(out[1])).u, 'https://cdn.example/p/keys/k1.key');
  assert.equal(seg(uri(out[2])).u, 'https://cdn.example/p/init.mp4');
  assert.equal(seg(uri(out[3])).path, '/live/hls'); assert.equal(seg(uri(out[3])).u, 'https://cdn.example/p/audio/en.m3u8');
  assert.equal(seg(uri(out[4])).path, '/live/hls');
  assert.equal(seg(out[6]).u, 'https://cdn.example/p/f1.m4s');
});

test('rewritePlaylist honours relayBase for absolute relay URLs', () => {
  const out = rewritePlaylist('#EXTM3U\n#EXTINF:4,\na.ts', { playlistUrl: 'https://cdn.example/x/i.m3u8', relayBase: 'http://192.168.0.189:8123', ref: '', org: '', secret: S, key: '' }).split('\n');
  assert.match(out[2], /^http:\/\/192\.168\.0\.189:8123\/live\/seg\?u=/);
});

test('upstreamHeaders sends Referer and Origin only when given, always a Chrome UA', () => {
  assert.deepEqual(upstreamHeaders('https://r/', 'https://r'), { Referer: 'https://r/', Origin: 'https://r', 'User-Agent': upstreamHeaders('', '')['User-Agent'], Accept: '*/*' });
  const h = upstreamHeaders('', '');
  assert.equal('Referer' in h, false);
  assert.equal('Origin' in h, false);
  assert.match(h['User-Agent'], /Chrome/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test live-relay.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `live-relay.mjs`**

```js
// live-relay.mjs — pure pieces of the live HLS relay.
//
// Upstream sports CDNs demand Referer AND Origin (verified: 403 with either
// alone) and browsers cannot set those, so the helper fetches the playlist,
// rewrites every URI to point back at itself, and proxies segments. To keep the
// relay from being an open proxy on the funnel, every upstream URL it accepts
// carries an HMAC signature the helper minted (relayPath / rewritePlaylist).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CHROME_UA } from './live-fixtures.mjs';

export function signUpstream({ u, ref, org }, secret) {
  return createHmac('sha256', String(secret)).update(`${u || ''}\n${ref || ''}\n${org || ''}`).digest('hex').slice(0, 32);
}

export function verifyUpstream({ u, ref, org, s }, secret) {
  if (typeof s !== 'string' || s.length !== 32) return false;
  const want = Buffer.from(signUpstream({ u, ref, org }, secret), 'utf8');
  const got = Buffer.from(s, 'utf8');
  return want.length === got.length && timingSafeEqual(want, got);
}

// Public hosts only: the URL is fetched server-side, so block SSRF targets.
export function isPublicHttpUrl(raw, protocols = ['http:', 'https:']) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!protocols.includes(u.protocol)) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return false;
  if (/^(127\.|10\.|169\.254\.|0\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^192\.168\./.test(h)) return false;
  if (h === '::1' || h === '::' || /^fe80:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return false;
  if (/^::ffff:/.test(h)) {
    // URL.hostname normalises ::ffff:127.0.0.1 to ::ffff:7f00:1, so undo the hex form.
    let v4 = h.slice(7);
    if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v4)) { const [a, b] = v4.split(':').map(x => parseInt(x, 16)); v4 = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
    if (/^(127\.|10\.|169\.254\.|0\.|192\.168\.)/.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return false;
  }
  return true;
}

export function relayPath(kind, { u, ref, org }, secret, key = '') {
  const q = new URLSearchParams();
  q.set('u', u || '');
  q.set('s', signUpstream({ u, ref, org }, secret));
  q.set('ref', ref || '');
  q.set('org', org || '');
  if (key) q.set('key', key);
  return `/live/${kind === 'hls' ? 'hls' : 'seg'}?${q.toString()}`;
}

export function upstreamHeaders(ref, org, userAgent = CHROME_UA) {
  const h = { 'User-Agent': userAgent, Accept: '*/*' };
  if (ref) h.Referer = ref;
  if (org) h.Origin = org;
  return h;
}

const PLAYLIST_URI_TAGS = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/;
const SEGMENT_URI_TAGS = /^#EXT-X-(KEY|MAP|SESSION-KEY):/;

export function rewritePlaylist(text, { playlistUrl, relayBase = '', ref, org, secret, key }) {
  const base = relayBase.replace(/\/+$/, '');
  const relay = (kind, target) => base + relayPath(kind, { u: new URL(target, playlistUrl).toString(), ref, org }, secret, key);
  const lines = String(text || '').split('\n');
  let variantNext = false;
  return lines.map(rawLine => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) variantNext = true;
      if (PLAYLIST_URI_TAGS.test(line)) return line.replace(/URI="([^"]+)"/, (_, t) => `URI="${relay('hls', t)}"`);
      if (SEGMENT_URI_TAGS.test(line)) return line.replace(/URI="([^"]+)"/, (_, t) => `URI="${relay('seg', t)}"`);
      return line;
    }
    const isPlaylist = variantNext || /\.m3u8?(\?|$)/i.test(line);
    variantNext = false;
    return relay(isPlaylist ? 'hls' : 'seg', line.trim());
  }).join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test live-relay.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add live-relay.mjs live-relay.test.js
git commit -m "live: signed HLS relay helpers (playlist rewrite, SSRF guard)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Helper routes in `stream-server.mjs` + relay integration test

**Files:**
- Modify: `stream-server.mjs` (imports near line 38; `isSafeDebridUrl` at ~92-113; server callback at ~1117; route chain at ~1225-1240)
- Test: `live-relay.integration.test.js` (gated `CHECK_LIVE_RELAY=1`)
- Modify: `package.json` scripts (add `check-live-relay`)

**Interfaces:**
- Consumes: everything from Tasks 2-6, `resolvingFetch` (already defined at ~line 88), `HELPER_KEY`, `helperRequestAllowed`.
- Produces HTTP routes (all key-gated by Task 1):
  - `OPTIONS /live/*` -> 204 with CORS allow headers
  - `GET /live/fixtures?date=YYYY-MM-DD` -> `{ fixtures: Fixture[] }`
  - `GET /live/matches` -> `{ matches: LiveMatch[], status: { fixtures: 'ok'|'error: …', sources: { [name]: 'ok'|'error: …' } }, generatedAt }`
  - `GET /live/streams?adapter=&id=` -> `{ streams: [{ label, language, quality, rank, play }] }` where `play` is a relay path WITHOUT key
  - `GET /live/channels` -> `{ channels: [{ id, name, logo, play }], stale, fetchedAt }`
  - `GET /live/hls?u=&s=&ref=&org=&key=` -> rewritten playlist (segments carry the same key)
  - `GET /live/seg?u=&s=&ref=&org=&key=` -> upstream bytes

- [ ] **Step 1: Write the failing integration test**

Create `live-relay.integration.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signUpstream } from './live-relay.mjs';

const exec = promisify(execFile);
const KEY = 'testkey';
const PORT = 18123;
const REF = 'https://ref.example/';
const ORG = 'https://ref.example';

// Origin server that mimics a sports CDN: 403 unless BOTH Referer and Origin match.
function originServer(dir) {
  return http.createServer(async (req, res) => {
    if (req.headers.referer !== REF || req.headers.origin !== ORG) { res.writeHead(403); return res.end('forbidden'); }
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    try {
      const body = await readFile(join(dir, name));
      res.writeHead(200, { 'content-type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'content-length': body.length });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
}

function startHelper() {
  return new Promise((resolve, reject) => {
    // LIVE_RELAY_ALLOW_PRIVATE lets the relay reach the 127.0.0.1 origin below; it is a test-only escape hatch.
    const child = spawn(process.execPath, ['stream-server.mjs'], { env: { ...process.env, PORT: String(PORT), HELPER_KEY: KEY, LIVE_RELAY_ALLOW_PRIVATE: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; if (out.includes('running')) resolve(child); });
    child.on('exit', code => reject(new Error(`helper exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error('helper did not start')), 20000).unref();
  });
}

test('relay: rewritten playlist plays through the helper with Referer+Origin added upstream', { skip: !process.env.CHECK_LIVE_RELAY }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-relay-'));
  const src = join(dir, 'src.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-y', src]);
  await exec('ffmpeg', ['-v', 'error', '-i', src, '-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', join(dir, 'index.m3u8')]);
  const origin = originServer(dir);
  await new Promise(r => origin.listen(0, '127.0.0.1', r));
  const originPort = origin.address().port;
  const child = await startHelper();
  try {
    const u = `http://127.0.0.1:${originPort}/index.m3u8`;
    // Direct fetch without headers must be refused by the origin (proves the test origin enforces).
    assert.equal((await fetch(u)).status, 403);
    const s = signUpstream({ u, ref: REF, org: ORG }, KEY);
    const q = new URLSearchParams({ u, s, ref: REF, org: ORG, key: KEY });
    const playlistRes = await fetch(`http://127.0.0.1:${PORT}/live/hls?${q}`);
    assert.equal(playlistRes.status, 200);
    assert.equal(playlistRes.headers.get('access-control-allow-origin'), '*');
    assert.match(playlistRes.headers.get('content-type'), /mpegurl/);
    const playlist = await playlistRes.text();
    const segLines = playlist.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(segLines.length >= 2);
    for (const l of segLines) assert.match(l, /^\/live\/seg\?u=.+&key=testkey/);
    const segRes = await fetch(`http://127.0.0.1:${PORT}${segLines[0]}`);
    assert.equal(segRes.status, 200);
    assert.match(segRes.headers.get('content-type'), /mp2t/);
    const bytes = Buffer.from(await segRes.arrayBuffer());
    assert.equal(bytes[0], 0x47, 'MPEG-TS sync byte');
    // Tampered signature and missing key are both refused.
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/live/hls?${new URLSearchParams({ u, s: s.replace(/^./, c => c === 'a' ? 'b' : 'a'), ref: REF, org: ORG, key: KEY })}`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/live/hls?${new URLSearchParams({ u, s, ref: REF, org: ORG })}`)).status, 401);
    // Preflight.
    const pre = await fetch(`http://127.0.0.1:${PORT}/live/seg?x=1`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  } finally {
    child.kill('SIGTERM');
    origin.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

The relay's SSRF guard would refuse `127.0.0.1`, so the helper honours `LIVE_RELAY_ALLOW_PRIVATE=1` (test-only escape hatch, off by default); the test sets it in `startHelper`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `CHECK_LIVE_RELAY=1 node --test live-relay.integration.test.js`
Expected: FAIL: `/live/hls` falls through to `serveStatic` and returns 404 (or 401 before that because the path is now gated but the route is missing; either way not 200).

- [ ] **Step 3: Add imports and live instances to `stream-server.mjs`**

After the existing `import { lanBaseUrl } from './lan-info.mjs';` line add:

```js
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createFixturesFeed } from './live-fixtures.mjs';
import { createSourceRegistry } from './live-sources.mjs';
import { createNuvioAdapter } from './live-source-nuvio.mjs';
import { selectTodayFixtures, joinFixtures, sortMatches } from './live-match.mjs';
import { createChannelFeed } from './live-channels.mjs';
import { verifyUpstream, isPublicHttpUrl, relayPath, rewritePlaylist, upstreamHeaders } from './live-relay.mjs';
```

Immediately after `const resolvingFetch = createResolvingFetch();` (~line 88) add:

```js
// Live football (see docs/superpowers/specs/2026-09-27-live-football-design.md).
// The relay only accepts upstream URLs signed with this secret; with no HELPER_KEY
// (local npm start) a per-process random secret still prevents open-proxy use.
const LIVE_SECRET = HELPER_KEY || randomBytes(16).toString('hex');
const LIVE_ALLOW_PRIVATE = process.env.LIVE_RELAY_ALLOW_PRIVATE === '1'; // integration test only
const liveFixtures = createFixturesFeed({ fetchImpl: resolvingFetch });
const liveSources = createSourceRegistry([createNuvioAdapter({ fetchImpl: resolvingFetch })]);
const liveChannels = createChannelFeed({ fetchImpl: resolvingFetch });
const LIVE_JSON = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
const liveJson = (res, status, body) => { res.writeHead(status, LIVE_JSON); res.end(JSON.stringify(body)); };
const localDate = (ms, dayOffset = 0) => { const d = new Date(ms + dayOffset * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
```

Replace the body of `isSafeDebridUrl` so it delegates (keep the name; other code calls it):

```js
function isSafeDebridUrl(raw) {
  return isPublicHttpUrl(raw, ['https:']);
}
```

- [ ] **Step 4: Add the live handlers**

Place these after `handleDebridProxy` (before `handleTranscode` is fine):

```js
async function handleLiveFixtures(res, url) {
  const date = url.searchParams.get('date') || localDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return liveJson(res, 400, { error: 'date must be YYYY-MM-DD' });
  try { liveJson(res, 200, { fixtures: await liveFixtures.fetchFixtures(date) }); }
  catch (err) { liveJson(res, 502, { error: String(err.message || err) }); }
}

async function handleLiveMatches(res) {
  const now = Date.now();
  const status = { fixtures: 'ok', sources: {} };
  const fixturesP = Promise.all([localDate(now), localDate(now, 1)].map(d => liveFixtures.fetchFixtures(d)))
    .then(lists => selectTodayFixtures(lists, now))
    .catch(err => { status.fixtures = 'error: ' + String(err.message || err); return []; });
  const sourcesP = Promise.all(liveSources.list().map(a => a.listMatches()
    .then(list => { status.sources[a.name] = 'ok'; return list.map(m => ({ ...m, adapter: a.name })); })
    .catch(err => { status.sources[a.name] = 'error: ' + String(err.message || err); return []; })))
    .then(r => r.flat());
  const [fixtures, sourceMatches] = await Promise.all([fixturesP, sourcesP]);
  const matches = sortMatches(joinFixtures(fixtures, sourceMatches, { now }));
  console.log(`[live] fixtures=${status.fixtures} ${Object.entries(status.sources).map(([k, v]) => `${k}=${v}`).join(' ')} matches=${matches.length} withStream=${matches.filter(m => m.hasStream).length}`);
  liveJson(res, 200, { matches, status, generatedAt: new Date(now).toISOString() });
}

async function handleLiveStreams(res, url) {
  const adapter = liveSources.get(url.searchParams.get('adapter') || '');
  const id = url.searchParams.get('id') || '';
  if (!adapter || !id) return liveJson(res, 404, { error: 'unknown adapter or id' });
  try {
    const streams = await adapter.streamsFor(id);
    // The client never sees upstream URLs or headers; only signed relay paths.
    liveJson(res, 200, { streams: streams.sort((a, b) => (b.rank || 0) - (a.rank || 0)).map(s => ({
      label: s.label, language: s.language, quality: s.quality, rank: s.rank,
      play: relayPath('hls', { u: s.url, ref: s.referer, org: s.origin }, LIVE_SECRET),
    })) });
  } catch (err) { liveJson(res, 502, { error: String(err.message || err) }); }
}

async function handleLiveChannels(res) {
  const { channels, stale, fetchedAt } = await liveChannels.fetchChannels();
  console.log(`[live] channels=${channels.length} stale=${stale}`);
  liveJson(res, 200, { channels: channels.map(c => ({ id: c.id, name: c.name, logo: c.logo, play: relayPath('hls', { u: c.url, ref: '', org: '' }, LIVE_SECRET) })), stale, fetchedAt });
}

function liveRelayParams(url) {
  const p = { u: url.searchParams.get('u') || '', ref: url.searchParams.get('ref') || '', org: url.searchParams.get('org') || '', s: url.searchParams.get('s') || '' };
  if (!verifyUpstream(p, LIVE_SECRET)) return { error: 'bad relay signature' };
  if (!LIVE_ALLOW_PRIVATE && !isPublicHttpUrl(p.u)) return { error: 'upstream not allowed' };
  return p;
}

async function handleLiveHls(req, res, url) {
  const p = liveRelayParams(url);
  if (p.error) { console.log(`[live] 403 ${p.error}`); return liveJson(res, 403, { error: p.error }); }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let upstream;
  try { upstream = await resolvingFetch(p.u, { headers: upstreamHeaders(p.ref, p.org), redirect: 'follow', signal: ac.signal }); }
  catch (err) { clearTimeout(t); return liveJson(res, 502, { error: String(err.message || err) }); }
  clearTimeout(t);
  if (!upstream.ok) { res.writeHead(upstream.status, LIVE_JSON); return res.end(JSON.stringify({ error: `upstream ${upstream.status}` })); }
  const text = await upstream.text();
  const body = rewritePlaylist(text, { playlistUrl: upstream.url || p.u, relayBase: '', ref: p.ref, org: p.org, secret: LIVE_SECRET, key: url.searchParams.get('key') || '' });
  res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(body);
}

async function handleLiveSeg(req, res, url) {
  const p = liveRelayParams(url);
  if (p.error) return liveJson(res, 403, { error: p.error });
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  let upstream;
  try { upstream = await resolvingFetch(p.u, { headers: upstreamHeaders(p.ref, p.org), redirect: 'follow', signal: ac.signal }); }
  catch (err) { if (!res.headersSent) liveJson(res, 502, { error: String(err.message || err) }); return; }
  if (!upstream.ok) { res.writeHead(upstream.status, LIVE_JSON); return res.end(); }
  const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-type': (upstream.headers && upstream.headers.get && upstream.headers.get('content-type')) || 'video/mp2t' };
  const len = upstream.headers && upstream.headers.get && upstream.headers.get('content-length');
  if (len) headers['content-length'] = len;
  res.writeHead(200, headers);
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res).catch(() => { try { res.destroy(); } catch { /* closed */ } });
  else res.end(Buffer.from(await upstream.arrayBuffer())); // DNS-fallback fetch buffers the body
}
```

- [ ] **Step 5: Wire the routes**

At the very top of the `http.createServer(async (req, res) => {` callback, before the key gate:

```js
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/live/')) {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*', 'access-control-max-age': '600' });
    return res.end();
  }
```

(`const url = …` is the first line of the callback; put the block right after it.)

In the route chain, directly after the `/debrid-proxy` line:

```js
    if (url.pathname === '/live/fixtures') return await handleLiveFixtures(res, url);
    if (url.pathname === '/live/matches') return await handleLiveMatches(res);
    if (url.pathname === '/live/streams') return await handleLiveStreams(res, url);
    if (url.pathname === '/live/channels') return await handleLiveChannels(res);
    if (url.pathname === '/live/hls') return await handleLiveHls(req, res, url);
    if (url.pathname === '/live/seg') return await handleLiveSeg(req, res, url);
```

Add to `package.json` scripts:

```json
"check-live-relay": "CHECK_LIVE_RELAY=1 node --test live-relay.integration.test.js",
```

- [ ] **Step 6: Run the integration test and the whole suite**

Run: `npm run check-live-relay`
Expected: PASS. If the helper fails to start on 18123 because it is in use, change `PORT` in the test to another free port.

Run: `npm test`
Expected: 0 fail (the integration test is skipped without its env).

Also check the running helper still parses: `node --check stream-server.mjs`.

- [ ] **Step 7: Smoke the live routes against the real internet (manual, 1 minute)**

```bash
PORT=18124 HELPER_KEY=k node stream-server.mjs &
sleep 3
curl -s 'http://127.0.0.1:18124/live/matches?key=k' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.status, j.matches.length, j.matches.slice(0,3).map(m=>[m.title,m.state,m.hasStream]))})'
curl -s 'http://127.0.0.1:18124/live/channels?key=k' | head -c 400; echo
kill %1
```

Expected: `status.fixtures === 'ok'`, `status.sources.nuvio === 'ok'`, a non-empty match list, and a channel list (may take ~10 s the first time because of probing). Paste the output into the commit message body.

- [ ] **Step 8: Commit**

```bash
git add stream-server.mjs live-relay.integration.test.js package.json
git commit -m "helper: /live/* routes (fixtures, matches, streams, channels, signed HLS relay)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `check-live` rot check

**Files:**
- Create: `check-live.mjs`, `check-live.test.js`
- Modify: `package.json` scripts

**Interfaces:**
- Produces: `runLiveCheck({ fetchImpl = fetch, log = console.log }) -> Promise<{ ok: boolean, sources: { [name]: { ok, matches, streams, error } }, channels: { ok, count, error } }>`; CLI exit code 1 when the primary adapter (`nuvio`) fails.

- [ ] **Step 1: Write the failing test**

Create `check-live.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveCheck } from './check-live.mjs';

test('runLiveCheck reports per-source status from injected fetch', async () => {
  const fetchImpl = async url => {
    if (url.includes('/catalog/tv/')) return { ok: true, status: 200, json: async () => ({ metas: [{ id: 'm1', name: 'A vs B', cast: ['A', 'B'] }] }) };
    if (url.includes('/stream/tv/m1')) return { ok: true, status: 200, json: async () => ({ streams: [{ title: 'X', url: 'https://cdn.example/a.m3u8' }] }) };
    if (url.endsWith('sports.m3u')) return { ok: true, status: 200, text: async () => '#EXTM3U\r\n#EXTINF:-1 tvg-id="x",beIN Sports 1\r\nhttps://cdn.example/b.m3u8\r\n' };
    if (url === 'https://cdn.example/b.m3u8') return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }), text: async () => '#EXTM3U' };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const lines = [];
  const r = await runLiveCheck({ fetchImpl, log: l => lines.push(l) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sources.nuvio, { ok: true, matches: 1, streams: 1, error: null });
  assert.deepEqual(r.channels, { ok: true, count: 1, error: null });
  assert.ok(lines.some(l => /nuvio/.test(l) && /ok/.test(l)));
});

test('runLiveCheck flags a dead primary adapter', async () => {
  const r = await runLiveCheck({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.sources.nuvio.ok, false);
  assert.match(r.sources.nuvio.error, /fetch failed/);
  assert.equal(r.channels.ok, false);
});

test('live check against the real internet', { skip: !process.env.CHECK_LIVE }, async () => {
  const r = await runLiveCheck({});
  assert.equal(r.sources.nuvio.ok, true, JSON.stringify(r));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test check-live.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `check-live.mjs`**

```js
#!/usr/bin/env node
// check-live.mjs — which live-football source rotted? One line per source.
//   npm run check-live
// Exit 1 when the primary adapter (nuvio) cannot list matches or streams.
import { createNuvioAdapter } from './live-source-nuvio.mjs';
import { createSourceRegistry } from './live-sources.mjs';
import { createChannelFeed } from './live-channels.mjs';

export async function runLiveCheck({ fetchImpl = fetch, log = console.log } = {}) {
  const registry = createSourceRegistry([createNuvioAdapter({ fetchImpl })]);
  const sources = {};
  for (const adapter of registry.list()) {
    const r = { ok: false, matches: 0, streams: 0, error: null };
    try {
      const matches = await adapter.listMatches();
      r.matches = matches.length;
      if (matches.length) r.streams = (await adapter.streamsFor(matches[0].sourceId)).length;
      r.ok = matches.length > 0 && r.streams > 0;
      if (!r.ok) r.error = matches.length ? 'first match has no streams' : 'no matches listed';
    } catch (err) { r.error = String(err.message || err); }
    sources[adapter.name] = r;
    log(`${adapter.name.padEnd(8)} ${r.ok ? 'ok ' : 'BAD'} matches=${r.matches} streams=${r.streams}${r.error ? ' error=' + r.error : ''}`);
  }
  const channels = { ok: false, count: 0, error: null };
  try {
    const { channels: list, stale } = await createChannelFeed({ fetchImpl }).fetchChannels();
    channels.count = list.length;
    channels.ok = list.length > 0 && !stale;
    if (!channels.ok) channels.error = stale ? 'download failed' : 'no channel alive';
  } catch (err) { channels.error = String(err.message || err); }
  log(`channels ${channels.ok ? 'ok ' : 'BAD'} alive=${channels.count}${channels.error ? ' error=' + channels.error : ''}`);
  const primary = sources.nuvio;
  return { ok: !!(primary && primary.ok), sources, channels };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  runLiveCheck({}).then(r => process.exit(r.ok ? 0 : 1)).catch(err => { console.error(err); process.exit(1); });
}
```

Add to `package.json` scripts:

```json
"check-live": "node check-live.mjs",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test check-live.test.js && npm run check-live`
Expected: unit tests PASS; the CLI prints `nuvio    ok …` and `channels ok …` and exits 0 (network permitting).

- [ ] **Step 5: Commit**

```bash
git add check-live.mjs check-live.test.js package.json
git commit -m "live: check-live rot check for sources and channels

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Client row model and live cards (`live-home.mjs`, `live-ui.js`, `tv-ui.js`, `tv-rows.mjs`, CSS)

**Files:**
- Create: `live-home.mjs` (pure), `live-ui.js` (DOM)
- Modify: `tv-ui.js:26-61` (`createTvCard`), `tv-rows.mjs:105-108` (`orderRowItems`)
- Modify: `tv.css`, `style.css` (append)
- Test: `live-home.test.js`, `live-ui.test.js`, `tv-rows.test.js` (append one test)

**Interfaces:**
- Consumes: `LiveMatch` and channel items as returned by `/live/matches` and `/live/channels` (Task 7).
- Produces:
  - `kickoffLabel(kickoffIso, nowMs) -> { time: 'HH:MM' (local), relative: 'in 1h 20m' | 'in 12m' | 'started 8m ago' | '' }`
  - `matchToCard(match, nowMs) -> Card`, `channelToCard(channel) -> Card`
  - `Card = { id, title, image_url: string|null, kind: 'match'|'channel', live: { state, clock, kickoff, league, homeName, awayName, homeScore, awayScore, homeBadge, awayBadge, hasStream, broadcasters }, raw }` (matches) / `live: { state: 'channel' }` (channels)
  - `buildLiveRows(matches, channels, nowMs) -> [{ key: 'live-now'|'today'|'channels', title, items, noSort: true }]` (rows with no items omitted)
  - `createLiveCard(card, onSelect) -> HTMLButtonElement` (in `live-ui.js`; class `tv-card tv-card-live`, `data-movie-id`, `.tv-card-nostream` when `hasStream === false`)
  - `createTvCard` delegates to `createLiveCard` when `movie.live` is present and uses `movie.image_url` verbatim when present.
  - `orderRowItems` returns items untouched when `row.noSort === true`.

- [ ] **Step 1: Write the failing tests**

Create `live-home.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { kickoffLabel, matchToCard, channelToCard, buildLiveRows } from './live-home.mjs';

const now = Date.parse('2026-09-27T14:00:00Z');
const match = (id, state, kickoff, extra = {}) => ({
  id, title: 'Arsenal vs Chelsea', league: 'Premier League', kickoff, state, clock: state === 'in' ? "67'" : null,
  home: { name: 'Arsenal', logo: 'https://a/ars.png', score: state === 'pre' ? null : 2 },
  away: { name: 'Chelsea', logo: 'https://a/che.png', score: state === 'pre' ? null : 1 },
  broadcasters: ['Sky Sports'], sources: [{ adapter: 'nuvio', sourceId: 's1' }], hasStream: true, priority: 1, poster: null, ...extra,
});

test('kickoffLabel gives a local time and a relative phrase', () => {
  const k = new Date(now + 80 * 60_000).toISOString();
  const l = kickoffLabel(k, now);
  assert.match(l.time, /^\d{2}:\d{2}$/);
  assert.equal(l.relative, 'in 1h 20m');
  assert.equal(kickoffLabel(new Date(now + 12 * 60_000).toISOString(), now).relative, 'in 12m');
  assert.equal(kickoffLabel(new Date(now - 8 * 60_000).toISOString(), now).relative, 'started 8m ago');
  assert.deepEqual(kickoffLabel(null, now), { time: '', relative: '' });
});

test('matchToCard flattens a LiveMatch into a card the rail can render', () => {
  const c = matchToCard(match('espn:1', 'in', '2026-09-27T13:00:00Z'), now);
  assert.equal(c.id, 'espn:1');
  assert.equal(c.title, 'Arsenal vs Chelsea');
  assert.equal(c.kind, 'match');
  assert.equal(c.image_url, null);
  assert.equal(c.live.state, 'in');
  assert.equal(c.live.clock, "67'");
  assert.equal(c.live.homeScore, 2);
  assert.equal(c.live.awayBadge, 'https://a/che.png');
  assert.equal(c.live.league, 'Premier League');
  assert.equal(c.live.hasStream, true);
  assert.deepEqual(c.live.broadcasters, ['Sky Sports']);
  assert.equal(c.raw.id, 'espn:1');
  const p = matchToCard(match('src:nuvio:x', 'pre', '2026-09-27T15:00:00Z', { poster: 'https://p/x.png', hasStream: false }), now);
  assert.equal(p.image_url, 'https://p/x.png');
  assert.equal(p.live.hasStream, false);
});

test('channelToCard uses the logo as the card art', () => {
  const c = channelToCard({ id: 'beIN.us', name: 'beIN SPORTS XTRA', logo: 'https://l/x.png', play: '/live/hls?u=a' });
  assert.equal(c.id, 'ch:beIN.us');
  assert.equal(c.title, 'beIN SPORTS XTRA');
  assert.equal(c.kind, 'channel');
  assert.equal(c.image_url, 'https://l/x.png');
  assert.equal(c.live.state, 'channel');
  assert.equal(c.raw.play, '/live/hls?u=a');
});

test('buildLiveRows splits live / today / channels, keeps order, drops empty rows and marks noSort', () => {
  const rows = buildLiveRows([
    match('a', 'in', '2026-09-27T13:00:00Z'),
    match('b', 'pre', '2026-09-27T15:00:00Z'),
    match('c', 'post', '2026-09-27T11:00:00Z'),          // finished 1h ago (kick-off + 2h) -> today
    match('d', 'post', '2026-09-27T08:00:00Z'),          // finished long ago -> dropped
  ], [{ id: 'x', name: 'X', logo: null, play: '/p' }], now);
  assert.deepEqual(rows.map(r => [r.key, r.title, r.items.map(i => i.id), r.noSort]), [
    ['live-now', 'Live now', ['a'], true],
    ['today', 'Today', ['b', 'c'], true],
    ['channels', 'Channels', ['ch:x'], true],
  ]);
  assert.deepEqual(buildLiveRows([], [], now), []);
});
```

Create `live-ui.test.js` (fake document, same pattern as `tv-ui-focus.test.js`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeDocument() {
  const make = tag => {
    const node = { tag, className: '', textContent: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {},
      classList: { add(...n) { node.className = (node.className + ' ' + n.join(' ')).trim(); }, contains(n) { return node.className.split(/\s+/).includes(n); } },
      setAttribute(k, v) { node.attrs[k] = v; }, append(...c) { node.children.push(...c); },
      addEventListener(t, fn) { node.listeners[t] = fn; }, querySelector(sel) { const cls = sel.replace(/^\./, ''); const walk = n => n.children.find(ch => ch.classList.contains(cls)) || n.children.map(walk).find(Boolean); return walk(node) || null; },
    };
    return node;
  };
  return { createElement: make };
}

test('createLiveCard renders score, clock, league and marks stream-less matches', async () => {
  const prev = globalThis.document; globalThis.document = fakeDocument();
  try {
    const { createLiveCard } = await import('./live-ui.js');
    let clicked = null;
    const card = createLiveCard({ id: 'espn:1', title: 'Arsenal vs Chelsea', kind: 'match', image_url: null, live: { state: 'in', clock: "67'", kickoff: '2026-09-27T13:00:00Z', league: 'Premier League', homeName: 'Arsenal', awayName: 'Chelsea', homeScore: 2, awayScore: 1, homeBadge: 'https://a/h.png', awayBadge: 'https://a/a.png', hasStream: true, broadcasters: ['Sky Sports'] }, raw: {} }, c => { clicked = c; });
    assert.equal(card.tag, 'button');
    assert.ok(card.classList.contains('tv-card') && card.classList.contains('tv-card-live'));
    assert.equal(card.dataset.movieId, 'espn:1');
    assert.equal(card.querySelector('.tv-live-score').textContent, '2 - 1');
    assert.equal(card.querySelector('.tv-card-badge').textContent, "LIVE 67'");
    assert.equal(card.querySelector('.tv-card-kicker').textContent, 'Premier League');
    assert.equal(card.querySelector('.tv-card-title').textContent, 'Arsenal vs Chelsea');
    assert.equal(card.querySelector('.tv-card-cta').textContent, 'Watch  ›');
    assert.ok(!card.classList.contains('tv-card-nostream'));
    card.listeners.click();
    assert.equal(clicked.id, 'espn:1');
    const pre = createLiveCard({ id: 'b', title: 'A vs B', kind: 'match', image_url: null, live: { state: 'pre', clock: null, kickoff: new Date(Date.now() + 3_600_000).toISOString(), league: 'LaLiga', homeName: 'A', awayName: 'B', homeScore: null, awayScore: null, homeBadge: null, awayBadge: null, hasStream: false, broadcasters: [] }, raw: {} }, () => {});
    assert.ok(pre.classList.contains('tv-card-nostream'));
    assert.equal(pre.querySelector('.tv-live-score').textContent, 'vs');
    assert.match(pre.querySelector('.tv-card-badge').textContent, /^\d{2}:\d{2}$/);
    assert.equal(pre.querySelector('.tv-card-cta').textContent, 'No stream yet');
    const ch = createLiveCard({ id: 'ch:x', title: 'beIN', kind: 'channel', image_url: 'https://l/x.png', live: { state: 'channel' }, raw: {} }, () => {});
    assert.ok(ch.classList.contains('tv-card-channel'));
    assert.equal(ch.querySelector('.tv-card-art').src, 'https://l/x.png');
    assert.equal(ch.querySelector('.tv-card-cta').textContent, 'Watch  ›');
  } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
});
```

Append to `tv-rows.test.js`:

```js
test('orderRowItems leaves rows flagged noSort in their given order', () => {
  const items = [{ id: 1, vote_average: 1 }, { id: 2, vote_average: 9 }];
  assert.deepEqual(orderRowItems({ key: 'today', noSort: true, items }).map(i => i.id), [1, 2]);
  assert.deepEqual(orderRowItems({ key: 'today', items }).map(i => i.id), [2, 1]);
});
```

(Ensure `orderRowItems` is in that file's import from `./tv-rows.mjs`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test live-home.test.js live-ui.test.js tv-rows.test.js`
Expected: FAIL (modules missing; noSort test fails).

- [ ] **Step 3: Implement `live-home.mjs`**

```js
// live-home.mjs — pure row model for the Live home. Turns /live/matches and
// /live/channels payloads into card objects the TV rail already knows how to
// lay out (id, title, image_url) plus a `live` block the live card renders.

function pad(n) { return String(n).padStart(2, '0'); }

export function kickoffLabel(kickoffIso, nowMs) {
  const k = Date.parse(kickoffIso || '');
  if (!Number.isFinite(k)) return { time: '', relative: '' };
  const d = new Date(k);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const mins = Math.round((k - nowMs) / 60_000);
  let relative = '';
  if (mins > 0) {
    if (mins < 60) relative = `in ${mins}m`;
    else relative = mins % 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `in ${mins / 60}h`;
  } else if (mins < 0) relative = `started ${-mins}m ago`;
  return { time, relative };
}

export function matchToCard(m, nowMs) {
  return {
    id: m.id,
    title: m.title,
    image_url: m.poster || null,
    kind: 'match',
    vote_average: 0,
    live: {
      state: m.state, clock: m.clock || null, kickoff: m.kickoff || null, league: m.league || 'Other',
      homeName: m.home.name, awayName: m.away.name, homeScore: m.home.score, awayScore: m.away.score,
      homeBadge: m.home.logo || null, awayBadge: m.away.logo || null,
      hasStream: m.hasStream !== false, broadcasters: m.broadcasters || [],
    },
    raw: m,
  };
}

export function channelToCard(c) {
  return { id: `ch:${c.id}`, title: c.name, image_url: c.logo || null, kind: 'channel', vote_average: 0, live: { state: 'channel' }, raw: c };
}

const RECENT_POST_MS = 2 * 3_600_000 + 130 * 60_000; // finished within the last ~2 h

export function buildLiveRows(matches, channels, nowMs) {
  const live = [], today = [];
  for (const m of matches || []) {
    if (m.state === 'in') live.push(matchToCard(m, nowMs));
    else if (m.state === 'pre') today.push(matchToCard(m, nowMs));
    else if (m.state === 'post' && nowMs - Date.parse(m.kickoff || '') < RECENT_POST_MS) today.push(matchToCard(m, nowMs));
  }
  const rows = [
    { key: 'live-now', title: 'Live now', items: live, noSort: true },
    { key: 'today', title: 'Today', items: today, noSort: true },
    { key: 'channels', title: 'Channels', items: (channels || []).map(channelToCard), noSort: true },
  ];
  return rows.filter(r => r.items.length);
}
```

- [ ] **Step 4: Implement `live-ui.js`**

```js
// live-ui.js — the live match / channel card. Same shell as the film card
// (button.tv-card with data-movie-id so the remote's row/column navigation and
// focus restore work unchanged), different visual: two badges and a score.
import { kickoffLabel } from './live-home.mjs';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function badgeText(live) {
  if (live.state === 'in') return live.clock ? `LIVE ${live.clock}` : 'LIVE';
  if (live.state === 'post') return 'FT';
  return kickoffLabel(live.kickoff, Date.now()).time || 'Soon';
}

export function createLiveCard(card, onSelect) {
  const live = card.live || {};
  const isChannel = card.kind === 'channel';
  const button = element('button', 'tv-card tv-card-live' + (isChannel ? ' tv-card-channel' : ''));
  button.type = 'button';
  button.dataset.movieId = card.id;
  button.dataset.rating = '0';
  const noStream = !isChannel && live.hasStream === false;
  if (noStream) button.classList.add('tv-card-nostream');
  if (live.state === 'in') button.classList.add('tv-card-onair');

  const visual = element('span', 'tv-card-visual');
  if (isChannel) {
    const image = element('img', 'tv-card-art tv-card-logo');
    image.alt = '';
    image.loading = 'lazy';
    if (card.image_url) image.src = card.image_url;
    image.onerror = () => { button.classList.add('tv-card-noart'); };
    visual.append(image);
  } else {
    const teams = element('span', 'tv-live-teams');
    const badge = (url, name) => {
      const img = element('img', 'tv-live-badge');
      img.alt = name || '';
      img.loading = 'lazy';
      if (url) img.src = url; else img.classList.add('tv-live-badge-missing');
      return img;
    };
    const score = live.state === 'pre' || live.homeScore == null || live.awayScore == null ? 'vs' : `${live.homeScore} - ${live.awayScore}`;
    teams.append(badge(live.homeBadge, live.homeName), element('span', 'tv-live-score', score), badge(live.awayBadge, live.awayName));
    visual.append(teams);
    visual.append(element('span', 'tv-card-badge', badgeText(live)));
  }
  button.append(visual);

  const caption = element('div', 'tv-card-caption');
  const kicker = isChannel ? 'Channel' : (live.league || 'Football');
  const label = isChannel ? '' : kickoffLabel(live.kickoff, Date.now()).relative;
  const details = isChannel ? '24/7 sports channel' : [label, (live.broadcasters || []).slice(0, 2).join(', ')].filter(Boolean).join('  ·  ') || 'Football';
  const footer = element('span', 'tv-card-footer');
  footer.append(
    element('span', 'tv-card-year', isChannel ? 'Live' : live.state === 'in' ? 'In play' : live.state === 'post' ? 'Finished' : 'Upcoming'),
    element('span', 'tv-card-cta', noStream ? 'No stream yet' : 'Watch  ›'),
  );
  caption.append(element('span', 'tv-card-kicker', kicker), element('span', 'tv-card-title', card.title), element('span', 'tv-card-overview', details), footer);
  button.append(caption);
  button.setAttribute('aria-label', [card.title, kicker, details].filter(Boolean).join(', '));
  button.addEventListener('click', () => onSelect(card));
  return button;
}
```

- [ ] **Step 5: Hook `tv-ui.js` and `tv-rows.mjs`**

In `tv-ui.js` add `import { createLiveCard } from './live-ui.js';` at the top, and make the first line of `createTvCard`:

```js
export function createTvCard(movie, onSelect) {
  if (movie.live) return createLiveCard(movie, onSelect);
  const card = element('button', 'tv-card');
```

and change the art line to:

```js
  if (movie.image_url) image.src = movie.image_url;
  else if (movie.backdrop_path || movie.poster_path) image.src = art + 'w500' + (movie.backdrop_path || movie.poster_path);
```

In `tv-rows.mjs`:

```js
export function orderRowItems(row = {}) {
  const items = Array.isArray(row.items) ? row.items : [];
  return row.key === 'continue' || row.noSort === true ? items : sortItemsByRating(items);
}
```

- [ ] **Step 6: Styles**

Append to `tv.css`:

```css
/* Live football cards */
.tv-card-live .tv-card-visual { height: 12vw; min-height: 150px; max-height: 235px; display: flex; align-items: center; justify-content: center; background: radial-gradient(ellipse at top, #24304a, #141826 70%); }
.tv-live-teams { display: flex; align-items: center; justify-content: center; gap: 22px; width: 100%; padding: 0 16px; }
.tv-live-badge { width: 72px; height: 72px; object-fit: contain; filter: drop-shadow(0 4px 10px rgba(0,0,0,.5)); }
.tv-live-badge-missing { width: 72px; height: 72px; border-radius: 50%; background: rgba(255,255,255,.08); }
.tv-live-score { font-size: 34px; font-weight: 800; letter-spacing: 1px; color: #fff; min-width: 90px; text-align: center; }
.tv-card-onair .tv-card-badge { background: #d81f26; color: #fff; }
.tv-card-nostream { opacity: .55; }
.tv-card-nostream .tv-card-cta { color: #aeb2c8; }
.tv-card-channel .tv-card-logo { object-fit: contain; padding: 24px; background: #202634; }
.tv-live-empty { margin: 24px 4vw 8px; color: #d3d5df; font-size: 20px; }
.tv-live-status { margin: 8px 4vw 24px; color: #8d93a8; font-size: 15px; }
```

Append the same block to `style.css` (desktop) with `.tv-live-badge` at 48px and `.tv-live-score` at 24px.

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test live-home.test.js live-ui.test.js tv-rows.test.js tv-ui-focus.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add live-home.mjs live-home.test.js live-ui.js live-ui.test.js tv-ui.js tv-rows.mjs tv-rows.test.js tv.css style.css
git commit -m "live: row model and live match/channel cards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The Live kind tab and `renderLiveHome` (`tv-remote.js`, `script.js`, `index.html`, `tv.html`)

**Files:**
- Modify: `tv-remote.js:37-49` (kind nav array)
- Modify: `script.js` (`setTvMediaKind` ~3977-3983, `effectiveMediaType` ~3990, imports ~1-15, add `renderLiveHome` after `renderTvHome`)
- Modify: `index.html:14-20`, `tv.html:15-17` (add a Live tab button)
- Test: `live-home.test.js` (append `restoreFocusById` test), e2e coverage comes in Task 13

**Interfaces:**
- Consumes: `buildLiveRows` (Task 9), `appendTvRow` (existing), `helperUrl`, `helperBaseReady`, `tvHomeToken`, `tvHomeIsCurrent`, `playerModalOpen`.
- Produces:
  - `setTvMediaKind('live')` renders the Live home; `tvMediaKind === 'live'`.
  - `renderLiveHome()` (module-private) and `window.__renderLiveHome` (for the e2e).
  - `fetchLiveJson(path, ms = 15000) -> Promise<object>` (module-private).
  - `onLiveSelect(card)`: channels -> `openLivePlayer` (Task 12); matches -> `liveDetails.open(card.raw)` (Task 11). Until Tasks 11/12 land, both branches call a stub that `console.log`s; the stub is replaced in those tasks.
  - `restoreFocusById(id)` exported from `live-home.mjs`: focuses `.tv-card[data-movie-id="<id>"]` if present, returns boolean.

- [ ] **Step 1: Write the failing test**

Append to `live-home.test.js`:

```js
test('restoreFocusById focuses the card with that id and reports whether it found one', async () => {
  const { restoreFocusById } = await import('./live-home.mjs');
  const prev = globalThis.document;
  let focused = null;
  globalThis.document = { querySelector: sel => sel === '.tv-card[data-movie-id="espn:1"]' ? { focus(o) { focused = o; } } : null };
  try {
    assert.equal(restoreFocusById('espn:1'), true);
    assert.deepEqual(focused, { preventScroll: true });
    assert.equal(restoreFocusById('missing'), false);
    assert.equal(restoreFocusById(''), false);
  } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test live-home.test.js`
Expected: FAIL, `restoreFocusById` is not exported.

- [ ] **Step 3: Add `restoreFocusById` to `live-home.mjs`**

```js
// After a 60 s refresh re-renders the rows, put focus back on the same card so
// the remote does not fall to <body>. Ids come from data-movie-id.
export function restoreFocusById(id) {
  if (!id || typeof document === 'undefined') return false;
  const safe = String(id).replace(/["\\]/g, '\\$&');
  const card = document.querySelector(`.tv-card[data-movie-id="${safe}"]`);
  if (!card) return false;
  card.focus({ preventScroll: true });
  return true;
}
```

- [ ] **Step 4: Add the tab**

`tv-remote.js` line 39: change the array to `[['all', 'All'], ['movie', 'Movies'], ['tv', 'TV'], ['live', 'Live']]`.

`index.html` and `tv.html`: after the `tab-movies` button add

```html
          <button id="tab-live" class="app-tab" data-tab="live">Live</button>
```

(On TV the old tabs are hidden and the kind nav is used; on desktop this button is the entry point.)

- [ ] **Step 5: Wire the kind in `script.js`**

Add to the imports at the top:

```js
import { buildLiveRows, restoreFocusById } from './live-home.mjs';
```

Replace `setTvMediaKind` and `effectiveMediaType`:

```js
// Live home refresh state lives up here so setTvMediaKind/renderTvHome can call
// stopLiveHomeRefresh() before the live block below has been evaluated.
const LIVE_HOME_REFRESH_MS = 60_000;
let liveHomeTimer = null;
function stopLiveHomeRefresh() { clearTimeout(liveHomeTimer); liveHomeTimer = null; }

let tvMediaKind = 'all';
function setTvMediaKind(kind) {
  tvMediaKind = (kind === 'movie' || kind === 'tv' || kind === 'live') ? kind : 'all';
  document.querySelectorAll('.tv-kind-tab').forEach(b => b.classList.toggle('active', b.dataset.kind === tvMediaKind));
  window.scrollTo(0, 0);
  if (tvMediaKind === 'live') renderLiveHome();
  else { stopLiveHomeRefresh(); renderTvHome(lastTrendingSeed); }
}
if (TV_MODE) window.__setTvMediaKind = setTvMediaKind; // called by the injected top nav in tv-remote.js
document.getElementById('tab-live')?.addEventListener('click', () => setTvMediaKind('live'));

function effectiveMediaType() {
  if (currentFilters.mediaType && currentFilters.mediaType !== 'all') return currentFilters.mediaType;
  return TV_MODE && tvMediaKind !== 'all' && tvMediaKind !== 'live' ? tvMediaKind : 'all';
}
```

Immediately after `renderTvHome` (after its closing brace) add:

```js
// ---- Live football home -------------------------------------------------------
// Rows come from the helper (/live/matches joins ESPN fixtures to free streams;
// /live/channels is the probed iptv-org list). Re-rendered every 60 s while the
// Live home is on screen and nothing is open on top of it; focus is restored to
// the same card by id so the remote never drops to <body>.
const liveHomeCurrent = () => tvMediaKind === 'live' && (!TV_MODE || tvHomeIsCurrent());

async function fetchLiveJson(path, ms = 15000) {
  await helperBaseReady;
  const res = await fetchWithTimeout(helperUrl(path), ms);
  if (!res.ok) throw new Error(`helper ${res.status}`);
  return res.json();
}

function liveStatusText(matchesRes, channelsRes) {
  const parts = [];
  if (matchesRes.error) parts.push(`Matches unavailable: ${matchesRes.error.message || matchesRes.error}`);
  else {
    const st = matchesRes.status || {};
    if (st.fixtures && st.fixtures !== 'ok') parts.push(`Fixtures (ESPN): ${st.fixtures}`);
    for (const [name, v] of Object.entries(st.sources || {})) if (v !== 'ok') parts.push(`Match streams (${name}): ${v}`);
  }
  if (channelsRes.error) parts.push(`Channels unavailable: ${channelsRes.error.message || channelsRes.error}`);
  else if (channelsRes.stale) parts.push('Channel list may be out of date');
  return parts.join('   ·   ');
}

// Replaced by Tasks 11 and 12; kept here so the home is testable on its own.
let onLiveSelect = card => { console.log('[live] select', card.kind, card.id); };

async function renderLiveHome() {
  stopLiveHomeRefresh();
  const token = ++tvHomeToken;
  const focusedId = document.activeElement?.closest?.('.tv-card')?.dataset.movieId || '';
  if (!main.querySelector('.tv-row')) { main.textContent = ''; main.append(Object.assign(document.createElement('p'), { className: 'tv-live-empty', textContent: 'Loading live football…' })); }
  const [matchesRes, channelsRes] = await Promise.all([
    fetchLiveJson('/live/matches').catch(error => ({ error })),
    fetchLiveJson('/live/channels').catch(error => ({ error })),
  ]);
  if (token !== tvHomeToken || !liveHomeCurrent()) return;
  const now = Date.now();
  const rows = buildLiveRows(matchesRes.matches || [], channelsRes.channels || [], now);
  main.textContent = '';
  if (!rows.some(r => r.key === 'live-now' || r.key === 'today')) {
    main.append(Object.assign(document.createElement('p'), { className: 'tv-live-empty', textContent: matchesRes.error ? 'Could not reach the stream helper.' : 'No football with a free stream right now.' }));
  }
  for (const row of rows) appendTvRow(main, row, card => onLiveSelect(card));
  const status = liveStatusText(matchesRes, channelsRes);
  if (status) main.append(Object.assign(document.createElement('p'), { className: 'tv-live-status', textContent: status }));
  if (focusedId) restoreFocusById(focusedId);
  liveHomeTimer = setTimeout(() => {
    if (!liveHomeCurrent() || token !== tvHomeToken) return;
    if (playerModalOpen || document.querySelector('.tv-details:not([hidden])')) { liveHomeTimer = setTimeout(() => renderLiveHome(), LIVE_HOME_REFRESH_MS); return; }
    renderLiveHome();
  }, LIVE_HOME_REFRESH_MS);
}
window.__renderLiveHome = renderLiveHome; // e2e hook
```

`renderTvHome` must also stop the live refresh: add `stopLiveHomeRefresh();` as the first line of `renderTvHome`.

- [ ] **Step 6: Verify manually in headless Chrome**

Run: `npm test` (0 fail) and `npm run build:tv`, then with the helper on 8123:

```bash
node -e '
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on("pageerror", e => console.log("PAGEERROR", e.message));
  await p.goto("http://127.0.0.1:8123/tv.html?helperkey=" + (process.env.HELPER_KEY || ""));
  await p.waitForSelector(".tv-kind-tab[data-kind=live]");
  await p.click(".tv-kind-tab[data-kind=live]");
  await p.waitForSelector(".tv-card-live, .tv-live-empty", { timeout: 30000 });
  console.log(await p.evaluate(() => Array.from(document.querySelectorAll("#main .tv-row h2")).map(h => h.textContent + ":" + h.parentElement.querySelectorAll(".tv-card").length)));
  console.log(await p.evaluate(() => (document.querySelector(".tv-live-status") || {}).textContent || "(no status line)"));
  await b.close();
})();'
```

Expected: no PAGEERROR lines, rows like `["Live now:2","Today:9","Channels:14"]` (numbers vary with the day). Press the Live tab, then All, and confirm the TMDB home comes back.

- [ ] **Step 7: Commit**

```bash
git add live-home.mjs live-home.test.js script.js tv-remote.js index.html tv.html
git commit -m "live: Live kind tab and the live home (matches + channels rows, 60 s refresh)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Live details overlay with stream picker (`live-details.mjs`)

**Files:**
- Create: `live-details.mjs`
- Modify: `tv-remote.js:11-12` (`detailsOverlay`/`detailsOpen`), `:163-172` (focus-restore observer), `:244-248` (`candidates` scope)
- Modify: `script.js` (create the instance next to `tvDetails` ~3943; `tv-close-details` listener ~3956; `onLiveSelect`)
- Modify: `tv.css`, `style.css`
- Test: `live-details.test.js`

**Interfaces:**
- Consumes: `LiveMatch` (`card.raw`), `fetchLiveJson` (Task 10), `openLivePlayer` (Task 12; until then a stub).
- Produces: `createLiveDetails({ fetchStreams, onPlay, now = Date.now }) -> { el, open(match), close(), isOpen() }`
  - `fetchStreams(match) -> Promise<[{ label, language, quality, rank, play }]>` (caller aggregates over `match.sources`)
  - `onPlay(match, streams, startIndex)`
  - overlay `div.tv-details.tv-details-live[hidden]`; Play button `#tv-live-play`; stream buttons `.tv-live-stream[data-index]`; Refresh button `#tv-live-refresh`.

- [ ] **Step 1: Write the failing test**

Create `live-details.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeDocument() {
  const make = tag => {
    const node = { tag, className: '', textContent: '', hidden: false, dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, scrollTop: 0, id: '',
      classList: { add(...n) { node.className = (node.className + ' ' + n.join(' ')).trim(); }, remove() {}, toggle() {}, contains(n) { return node.className.split(/\s+/).includes(n); } },
      setAttribute(k, v) { node.attrs[k] = v; }, append(...c) { node.children.push(...c); },
      addEventListener(t, fn) { node.listeners[t] = fn; }, focus() { doc.activeElement = node; },
      querySelector(sel) { return all(node).find(n => matches(n, sel)) || null; },
      querySelectorAll(sel) { return all(node).filter(n => matches(n, sel)); },
    };
    Object.defineProperty(node, 'textContent', { get() { return node._t || ''; }, set(v) { node._t = v; if (v === '') node.children.length = 0; } });
    return node;
  };
  const all = n => n.children.flatMap(c => [c, ...all(c)]);
  const matches = (n, sel) => sel.startsWith('#') ? n.id === sel.slice(1) : sel.startsWith('.') ? n.classList.contains(sel.slice(1)) : n.tag === sel;
  const doc = { createElement: make, body: make('body'), activeElement: null };
  return doc;
}

const match = { id: 'espn:1', title: 'Arsenal vs Chelsea', league: 'Premier League', kickoff: '2026-09-27T15:00:00Z', state: 'in', clock: "67'", home: { name: 'Arsenal', logo: 'https://a/h.png', score: 2 }, away: { name: 'Chelsea', logo: 'https://a/a.png', score: 1 }, broadcasters: ['Sky Sports', 'FS2'], sources: [{ adapter: 'nuvio', sourceId: 's1' }], hasStream: true, priority: 1, poster: null };

test('live details renders the match, lists streams, focuses Play, and plays the picked stream', async () => {
  const prev = globalThis.document; const doc = fakeDocument(); globalThis.document = doc;
  try {
    const { createLiveDetails } = await import('./live-details.mjs');
    const played = [];
    const streams = [{ label: 'DaddyLive | Sportsnet One', language: 'English', quality: 'HD', rank: 97, play: '/live/hls?u=1' }, { label: 'DaddyLive | beIN 3', language: 'English', quality: 'HD', rank: 80, play: '/live/hls?u=2' }];
    const details = createLiveDetails({ fetchStreams: async () => streams, onPlay: (m, s, i) => played.push([m.id, s.length, i]) });
    assert.equal(details.el.hidden, true);
    assert.ok(details.el.classList.contains('tv-details') && details.el.classList.contains('tv-details-live'));
    assert.ok(doc.body.children.includes(details.el));
    await details.open(match);
    assert.equal(details.isOpen(), true);
    assert.equal(details.el.querySelector('.tv-details-title').textContent, 'Arsenal vs Chelsea');
    assert.match(details.el.querySelector('.tv-details-meta').textContent, /Premier League/);
    assert.match(details.el.querySelector('.tv-details-meta').textContent, /67'/);
    assert.equal(details.el.querySelector('.tv-live-details-score').textContent, '2 - 1');
    assert.match(details.el.querySelector('.tv-live-broadcasters').textContent, /Sky Sports, FS2/);
    const play = details.el.querySelector('#tv-live-play');
    assert.equal(doc.activeElement, play);
    const buttons = details.el.querySelectorAll('.tv-live-stream');
    assert.equal(buttons.length, 2);
    assert.match(buttons[1].textContent, /beIN 3/);
    play.listeners.click();
    assert.deepEqual(played, [['espn:1', 2, 0]]);
    buttons[1].listeners.click();
    assert.deepEqual(played[1], ['espn:1', 2, 1]);
    details.close();
    assert.equal(details.isOpen(), false);
  } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
});

test('live details with no streams shows the wait message and a Refresh that re-queries', async () => {
  const prev = globalThis.document; const doc = fakeDocument(); globalThis.document = doc;
  try {
    const { createLiveDetails } = await import('./live-details.mjs');
    let calls = 0;
    const details = createLiveDetails({ fetchStreams: async () => (++calls === 1 ? [] : [{ label: 'X', play: '/live/hls?u=9' }]), onPlay: () => {} });
    await details.open({ ...match, state: 'pre', clock: null, hasStream: false, sources: [] });
    assert.equal(details.el.querySelector('#tv-live-play'), null);
    assert.match(details.el.querySelector('.tv-live-nostream').textContent, /No stream yet/);
    const refresh = details.el.querySelector('#tv-live-refresh');
    assert.equal(doc.activeElement, refresh);
    await refresh.listeners.click();
    assert.equal(calls, 2);
    assert.ok(details.el.querySelector('#tv-live-play'));
  } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
});

test('live details ignores a stale stream response after close or a newer open', async () => {
  const prev = globalThis.document; const doc = fakeDocument(); globalThis.document = doc;
  try {
    const { createLiveDetails } = await import('./live-details.mjs');
    let resolveFirst;
    const details = createLiveDetails({ fetchStreams: () => new Promise(r => { resolveFirst = r; }), onPlay: () => {} });
    const p = details.open(match);
    details.close();
    resolveFirst([{ label: 'late', play: '/x' }]);
    await p;
    assert.equal(details.el.querySelector('.tv-live-stream'), null);
  } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test live-details.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `live-details.mjs`**

```js
// live-details.mjs — the details screen for a live match: badges, score or
// kick-off, league, broadcasters, and a stream picker. Same overlay shell as
// tv-details.js (class tv-details + hidden attribute) so the remote's Back
// handling and focus restore treat it identically.
import { kickoffLabel } from './live-home.mjs';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createLiveDetails({ fetchStreams, onPlay, now = Date.now }) {
  const overlay = el('div', 'tv-details tv-details-live');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const body = el('div', 'tv-details-body');
  overlay.append(el('div', 'tv-details-backdrop tv-live-details-backdrop'), el('div', 'tv-details-scrim'), body);
  document.body.append(overlay);

  let current = null;
  let token = 0;
  const isOpen = () => !overlay.hidden;
  const close = () => { overlay.hidden = true; current = null; token++; };

  function renderStreams(match, streams, t) {
    if (t !== token) return;
    const host = body.querySelector('.tv-live-streams');
    host.textContent = '';
    if (!streams.length) {
      host.append(el('p', 'tv-live-nostream', match.state === 'post' ? 'No stream for this match.' : 'No stream yet. Streams usually appear about ten minutes before kick-off.'));
      const refresh = el('button', 'tv-details-play', '↻  Refresh');
      refresh.id = 'tv-live-refresh';
      refresh.type = 'button';
      refresh.addEventListener('click', () => load(match, t));
      host.append(refresh);
      refresh.focus();
      return;
    }
    const play = el('button', 'tv-details-play', '▶  Play');
    play.id = 'tv-live-play';
    play.type = 'button';
    play.addEventListener('click', () => onPlay(match, streams, 0));
    host.append(play);
    const list = el('div', 'tv-live-stream-list');
    streams.forEach((s, i) => {
      const b = el('button', 'tv-live-stream', [s.label, s.language, s.quality].filter(Boolean).join('  ·  '));
      b.type = 'button';
      b.dataset.index = String(i);
      b.addEventListener('click', () => onPlay(match, streams, i));
      list.append(b);
    });
    host.append(el('h3', 'tv-live-streams-title', `${streams.length} stream${streams.length === 1 ? '' : 's'}`), list);
    play.focus();
  }

  async function load(match, t) {
    const host = body.querySelector('.tv-live-streams');
    host.textContent = '';
    host.append(el('p', 'tv-live-nostream', 'Finding streams…'));
    let streams = [];
    try { streams = (await fetchStreams(match)) || []; } catch { streams = []; }
    renderStreams(match, streams.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0)), t);
  }

  async function open(match) {
    current = match;
    const t = ++token;
    overlay.hidden = false;
    overlay.scrollTop = 0;
    body.textContent = '';
    body.append(el('h1', 'tv-details-title', match.title));
    const { time, relative } = kickoffLabel(match.kickoff, now());
    const bits = [match.league];
    if (match.state === 'in') bits.push(match.clock ? `LIVE ${match.clock}` : 'LIVE');
    else if (match.state === 'post') bits.push('Full time');
    else bits.push([time, relative].filter(Boolean).join(' · '));
    body.append(el('div', 'tv-details-meta', bits.filter(Boolean).join('   ·   ')));
    const teams = el('div', 'tv-live-details-teams');
    const side = (t2, cls) => {
      const wrap = el('div', 'tv-live-details-team ' + cls);
      const img = el('img', 'tv-live-details-badge'); img.alt = ''; if (t2.logo) img.src = t2.logo;
      wrap.append(img, el('span', 'tv-live-details-name', t2.name));
      return wrap;
    };
    const score = match.state === 'pre' || match.home.score == null || match.away.score == null ? 'vs' : `${match.home.score} - ${match.away.score}`;
    teams.append(side(match.home, 'home'), el('span', 'tv-live-details-score', score), side(match.away, 'away'));
    body.append(teams);
    if (match.broadcasters && match.broadcasters.length) body.append(el('p', 'tv-live-broadcasters', 'On TV: ' + match.broadcasters.join(', ')));
    body.append(el('div', 'tv-live-streams'));
    await load(match, t);
  }

  return { el: overlay, open, close, isOpen };
}
```

- [ ] **Step 4: Make Back and focus handling see both overlays (`tv-remote.js`)**

Replace lines 11-12:

```js
  const detailsOverlays = () => Array.from(document.querySelectorAll('.tv-details'));
  const openDetailsOverlay = () => detailsOverlays().find(o => !o.hidden) || null;
  const detailsOpen = () => !!openDetailsOverlay();
```

In `candidates()` (~line 247) replace `detailsOverlay` with `openDetailsOverlay()`.

Replace the focus-restore observer block (~163-172) so it observes every overlay:

```js
  let detailsWasOpen = false;
  const detailsObserver = new MutationObserver(() => {
    const open = detailsOpen();
    if (open === detailsWasOpen) return;
    detailsWasOpen = open;
    if (!open) setTimeout(() => {
      if (modalOpen() || detailsOpen()) return;
      focus(lastCardFocus && lastCardFocus.isConnected ? lastCardFocus : homeAnchor());
    }, 0);
  });
  detailsOverlays().forEach(o => detailsObserver.observe(o, { attributes: true, attributeFilter: ['hidden'] }));
```

Grep for any remaining `detailsOverlay` identifier (`grep -n 'detailsOverlay\b' tv-remote.js`) and replace each with `openDetailsOverlay()`.

- [ ] **Step 5: Wire it in `script.js`**

Add the import: `import { createLiveDetails } from './live-details.mjs';`

Right after the `tvDetails` creation add:

```js
async function fetchStreamsForMatch(match) {
  const lists = await Promise.all((match.sources || []).map(s =>
    fetchLiveJson(`/live/streams?adapter=${encodeURIComponent(s.adapter)}&id=${encodeURIComponent(s.sourceId)}`)
      .then(r => (r.streams || []).map(st => ({ ...st, adapter: s.adapter })))
      .catch(() => [])));
  return lists.flat();
}
const liveDetails = createLiveDetails({
  fetchStreams: fetchStreamsForMatch,
  onPlay: (match, streams, index) => { liveDetails.close(); openLivePlayer({ title: match.title, streams, startIndex: index, refresh: () => fetchStreamsForMatch(match) }); },
});
```

Until Task 12 lands, add directly below it a temporary stub so the file loads: `function openLivePlayer(session) { console.log('[live] play', session.title, session.streams.length); }` (Task 12 replaces it).

Change the `tv-close-details` listener to close both:

```js
if (TV_MODE) document.addEventListener('tv-close-details', () => { if (tvDetails) tvDetails.close(); liveDetails.close(); });
```

Replace the `onLiveSelect` stub from Task 10 with:

```js
let onLiveSelect = card => {
  if (card.kind === 'channel') openLivePlayer({ title: card.title, streams: [{ label: card.title, play: card.raw.play }], startIndex: 0, refresh: async () => [{ label: card.title, play: card.raw.play }] });
  else liveDetails.open(card.raw);
};
```

- [ ] **Step 6: Styles**

Append to `tv.css` (and `style.css` with smaller sizes):

```css
.tv-live-details-backdrop { background: radial-gradient(ellipse at top, #24304a, #0e111b 70%); }
.tv-live-details-teams { display: flex; align-items: center; gap: 40px; margin: 18px 0 10px; }
.tv-live-details-team { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 180px; }
.tv-live-details-badge { width: 110px; height: 110px; object-fit: contain; }
.tv-live-details-name { font-size: 20px; font-weight: bold; text-align: center; }
.tv-live-details-score { font-size: 56px; font-weight: 800; min-width: 160px; text-align: center; }
.tv-live-broadcasters { color: #aeb2c8; font-size: 18px; }
.tv-live-streams { margin-top: 18px; }
.tv-live-streams-title { font-size: 18px; color: #8ab8ff; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
.tv-live-stream-list { display: flex; flex-wrap: wrap; gap: 10px; }
.tv-live-stream { background: #262b3a; color: #fff; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 12px 16px; font-size: 18px; cursor: pointer; }
.tv-live-stream:focus { outline: 3px solid #8ab8ff; }
.tv-live-nostream { color: #d3d5df; font-size: 20px; margin: 8px 0 14px; }
```

- [ ] **Step 7: Run tests**

Run: `node --test live-details.test.js && npm test`
Expected: PASS, 0 fail overall.

- [ ] **Step 8: Commit**

```bash
git add live-details.mjs live-details.test.js tv-remote.js script.js tv.css style.css
git commit -m "live: match details overlay with stream picker; Back closes either details screen

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Live player with hls.js and recover cascade (`live-player.mjs`, `tv-player.js`, `tv-entry.js`, `script.js`)

**Files:**
- Modify: `package.json` (dependency `hls.js@1.7.3`)
- Modify: `tv-entry.js:1-5`, `index.html` (script tag), `tv-player.js` (~10-13 HUD markup, ~58-66 `update`, ~74-81 time listener, ~84-100 `handleKey`)
- Create: `live-player.mjs`
- Modify: `script.js` (replace the `openLivePlayer` stub; `closePlayer` ~2862; `tv-seek`/`tv-seek-to`/`publishTvPlaybackTime`/`tv-retry-playback` ~5232-5256)
- Test: `live-player.test.js`, `tv-player.test.js` (new, fake DOM)

**Interfaces:**
- Consumes: `playbackHealth` (`playback-health.js`), `helperUrl`, `setYtsStatus(msg, isError)`, `showPlayerVideo(on)`, `stopYtsStream()`, `playerModal`, `playerVideo`, `playerTitle`, `playerModalOpen`.
- Produces:
  - `createLivePlayer({ video, modal, helperUrl, setStatus, getHls = () => globalThis.Hls, now = Date.now, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) -> { play(session), stop(), isActive(), retry() }`
  - `session = { title, streams: [{ label, play }], startIndex = 0, refresh: () => Promise<streams> }`
  - `LIVE_HLS_CONFIG` (exported constant)
  - `openLivePlayer(session)` in `script.js`; `playerModal.dataset.live === '1'` while live.
  - `tv-player.js` live HUD: `#tv-progress`, `#tv-rewind`, `#tv-forward` hidden, time text `LIVE`, arrow keys only reveal the HUD.

- [ ] **Step 1: Install hls.js and expose it**

```bash
npm install hls.js@1.7.3
```

`tv-entry.js` becomes:

```js
import './tv-polyfills.js'; // must load before the app code (webOS Chromium ~79)
import Hls from 'hls.js';
window.Hls = Hls; // live-player.mjs reads it lazily; esbuild downlevels hls.js to ES2019 for webOS
import './script.js';
import './youtube.js';
import { installTvRemote } from './tv-remote.js';
installTvRemote();
```

`index.html` (desktop, served unbundled from the repo root by the helper): before the `<script type="module" src="script.js">` tag add

```html
    <script src="node_modules/hls.js/dist/hls.min.js"></script>
```

Run `npm run build:tv` and confirm `grep -c 'Hls' tv-bundle.js` is greater than 0.

- [ ] **Step 2: Write the failing tests**

Create `live-player.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivePlayer, LIVE_HLS_CONFIG } from './live-player.mjs';

function fakeVideo() {
  const v = { currentTime: 0, paused: false, readyState: 0, src: '', listeners: {}, loaded: 0, played: 0,
    addEventListener(t, fn) { (v.listeners[t] ||= []).push(fn); }, removeEventListener(t, fn) { v.listeners[t] = (v.listeners[t] || []).filter(f => f !== fn); },
    load() { v.loaded++; }, play() { v.played++; return Promise.resolve(); }, removeAttribute(a) { if (a === 'src') v.src = ''; }, pause() { v.paused = true; } };
  return v;
}
function fakeHlsClass(log) {
  class FakeHls {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: 'mp', ERROR: 'err' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    constructor(config) { this.config = config; this.handlers = {}; log.push(['new']); FakeHls.last = this; }
    on(ev, fn) { this.handlers[ev] = fn; }
    loadSource(url) { log.push(['load', url]); }
    attachMedia(video) { this.video = video; }
    recoverMediaError() { log.push(['recoverMedia']); }
    destroy() { log.push(['destroy']); }
    emit(ev, data) { this.handlers[ev]?.(ev, data); }
  }
  return FakeHls;
}
function harness() {
  const log = [], statuses = [], timers = [];
  const Hls = fakeHlsClass(log);
  const video = fakeVideo();
  let clock = 0;
  const player = createLivePlayer({
    video, modal: { dataset: {} }, helperUrl: p => 'http://h' + p + (p.includes('?') ? '&' : '?') + 'key=k',
    setStatus: (msg, err) => statuses.push([msg, !!err]), getHls: () => Hls, now: () => clock,
    setInterval: (fn, ms) => { timers.push(fn); return timers.length; }, clearInterval: () => { timers.length = 0; },
  });
  const tick = (ms) => { clock += ms; timers.slice().forEach(fn => fn()); };
  return { log, statuses, Hls, video, player, tick, setClock: v => { clock = v; } };
}

test('LIVE_HLS_CONFIG keeps a small live buffer', () => {
  assert.equal(LIVE_HLS_CONFIG.maxBufferLength, 10);
  assert.equal(LIVE_HLS_CONFIG.liveSyncDurationCount, 3);
  assert.equal(LIVE_HLS_CONFIG.liveMaxLatencyDurationCount, 8);
});

test('play loads the first stream through helperUrl with hls.js and marks the modal live', async () => {
  const h = harness();
  const refresh = async () => [];
  await h.player.play({ title: 'A vs B', streams: [{ label: 's1', play: '/live/hls?u=1' }, { label: 's2', play: '/live/hls?u=2' }], refresh });
  assert.equal(h.player.isActive(), true);
  assert.deepEqual(h.log, [['new'], ['load', 'http://h/live/hls?u=1&key=k']]);
  assert.deepEqual(h.Hls.last.config.maxBufferLength, 10);
  h.Hls.last.emit('mp');
  assert.equal(h.video.played, 1);
  assert.deepEqual(h.statuses[0], ['Connecting to s1…', false]);
});

test('a fatal 403 moves to the next stream; when all fail it refreshes once then reports', async () => {
  const h = harness();
  let refreshes = 0;
  const refresh = async () => { refreshes++; return [{ label: 's3', play: '/live/hls?u=3' }]; };
  await h.player.play({ title: 'A vs B', streams: [{ label: 's1', play: '/live/hls?u=1' }, { label: 's2', play: '/live/hls?u=2' }], refresh });
  h.Hls.last.emit('err', { fatal: true, type: 'networkError', response: { code: 403 } });
  await Promise.resolve();
  assert.deepEqual(h.log.filter(e => e[0] === 'load').map(e => e[1]), ['http://h/live/hls?u=1&key=k', 'http://h/live/hls?u=2&key=k']);
  h.Hls.last.emit('err', { fatal: true, type: 'networkError', response: { code: 404 } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(refreshes, 1);
  assert.equal(h.log.filter(e => e[0] === 'load').at(-1)[1], 'http://h/live/hls?u=3&key=k');
  h.Hls.last.emit('err', { fatal: true, type: 'networkError', response: { code: 403 } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(refreshes, 2, 'refresh is retried when the refreshed list is exhausted too');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(h.statuses.at(-1), ['No working stream yet. Press Retry, or pick a channel.', true]);
  assert.equal(h.player.isActive(), true, 'stays active so Retry works');
});

test('a media error is recovered once, then treated as a failure', async () => {
  const h = harness();
  await h.player.play({ title: 't', streams: [{ label: 's1', play: '/a' }, { label: 's2', play: '/b' }], refresh: async () => [] });
  h.Hls.last.emit('err', { fatal: true, type: 'mediaError' });
  assert.ok(h.log.some(e => e[0] === 'recoverMedia'));
  const loadsBefore = h.log.filter(e => e[0] === 'load').length;
  h.Hls.last.emit('err', { fatal: true, type: 'mediaError' });
  await Promise.resolve();
  assert.equal(h.log.filter(e => e[0] === 'load').length, loadsBefore + 1);
});

test('the watchdog gives 30 s before first frame and 20 s once playing', async () => {
  const h = harness();
  await h.player.play({ title: 't', streams: [{ label: 's1', play: '/a' }, { label: 's2', play: '/b' }], refresh: async () => [] });
  for (let i = 0; i < 30; i++) h.tick(1000); // 30 s since the first sample at t=1 s: not yet
  assert.equal(h.log.filter(e => e[0] === 'load').length, 1);
  h.tick(1000); await Promise.resolve();
  assert.equal(h.log.filter(e => e[0] === 'load').length, 2, 'startup stall -> next stream');
  h.video.currentTime = 5; h.tick(1000);
  for (let i = 0; i < 19; i++) h.tick(1000);
  assert.equal(h.log.filter(e => e[0] === 'load').length, 2);
  h.tick(1000); await Promise.resolve();
  assert.equal(h.log.filter(e => e[0] === 'load').length, 2, 'both streams tried; nothing left to load without refresh results');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.statuses.at(-1)[1], true, 'the failure is reported');
});

test('stop destroys hls, clears the video source and the interval', async () => {
  const h = harness();
  await h.player.play({ title: 't', streams: [{ label: 's1', play: '/a' }], refresh: async () => [] });
  h.player.stop();
  assert.equal(h.player.isActive(), false);
  assert.ok(h.log.some(e => e[0] === 'destroy'));
  assert.equal(h.video.src, '');
  assert.ok(h.video.loaded >= 1);
});

test('falls back to native src when hls.js is unsupported or absent', async () => {
  const h = harness();
  const player = createLivePlayer({ video: h.video, modal: { dataset: {} }, helperUrl: p => 'http://h' + p, setStatus: () => {}, getHls: () => null, now: () => 0, setInterval: () => 1, clearInterval: () => {} });
  await player.play({ title: 't', streams: [{ label: 'n', play: '/live/hls?u=9' }], refresh: async () => [] });
  assert.equal(h.video.src, 'http://h/live/hls?u=9');
  assert.equal(h.video.played, 1);
});

test('retry clears the tried set and starts over from the first stream', async () => {
  const h = harness();
  await h.player.play({ title: 't', streams: [{ label: 's1', play: '/a' }], refresh: async () => [] });
  h.Hls.last.emit('err', { fatal: true, type: 'networkError', response: { code: 403 } });
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  const loads = h.log.filter(e => e[0] === 'load').length;
  await h.player.retry();
  assert.equal(h.log.filter(e => e[0] === 'load').length, loads + 1);
});
```

Create `tv-player.test.js` covering only the live HUD switch (the rest of `tv-player.js` is exercised by the e2e):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveHudState } from './tv-player.js';

test('liveHudState decides what the HUD shows for live vs on-demand', () => {
  assert.deepEqual(liveHudState(true), { showProgress: false, showSeekButtons: false, timeText: 'LIVE', help: 'OK Play / pause · Back Return' });
  assert.deepEqual(liveHudState(false), { showProgress: true, showSeekButtons: true, timeText: null, help: '← → Seek · OK Play / pause · Back Return' });
});
```

`tv-player.js` imports `./tv-subtitles.js` which touches `document` at call time only, so importing the module in Node is safe. If it is not (import error), move `liveHudState` to a new `tv-player-live.js` and import it from both.

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test live-player.test.js tv-player.test.js`
Expected: FAIL, module / export missing.

- [ ] **Step 4: Implement `live-player.mjs`**

```js
// live-player.mjs — plays a live HLS relay URL through hls.js (native <video src>
// fallback) with a recover cascade: a fatal network error, a second media error,
// or a stall moves to the next untried stream; when every stream has failed the
// list is refreshed once (tokens expire in minutes) before giving up with a
// Retry. No seeking, no resume, no watch-time: live is not on-demand.
import { playbackHealth } from './playback-health.js';

export const LIVE_HLS_CONFIG = {
  maxBufferLength: 10,
  maxMaxBufferLength: 20,
  liveSyncDurationCount: 3,
  liveMaxLatencyDurationCount: 8,
  manifestLoadingTimeOut: 8000,
  fragLoadingTimeOut: 10000,
  enableWorker: false, // webOS: keep it on the main thread
};

const STARTUP_MS = 30000;
const STALL_MS = 20000;

export function createLivePlayer({ video, modal, helperUrl, setStatus, getHls = () => globalThis.Hls, now = Date.now, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  let session = null;
  let hls = null;
  let current = null;
  let tried = new Set();
  let refreshed = 0;
  let timer = null;
  let generation = 0;
  let nativeErrorHandler = null;

  function teardownMedia() {
    if (hls) { try { hls.destroy(); } catch { /* already gone */ } hls = null; }
    if (nativeErrorHandler) { video.removeEventListener('error', nativeErrorHandler); nativeErrorHandler = null; }
    if (timer) { clearInterval(timer); timer = null; }
    try { video.pause(); } catch { /* not playing */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* jsdom-less */ }
  }

  function watchdog(gen) {
    let health = null;
    let started = false;
    timer = setInterval(() => {
      if (gen !== generation) return;
      if (video.currentTime > 0.25) started = true;
      health = playbackHealth(health, { now: now(), time: video.currentTime, paused: video.paused, started, timeoutMs: started ? STALL_MS : STARTUP_MS });
      if (health.stalled) { health = null; fail(gen, 'stalled'); }
    }, 1000);
  }

  function start(stream) {
    const gen = ++generation;
    teardownMedia();
    current = stream;
    tried.add(stream.play);
    if (modal && modal.dataset) modal.dataset.live = '1';
    setStatus(`Connecting to ${stream.label || 'stream'}…`, false);
    const url = helperUrl(stream.play);
    const Hls = getHls();
    let mediaRecovered = false;
    if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
      hls = new Hls(LIVE_HLS_CONFIG);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { setStatus(null); video.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data || !data.fatal || gen !== generation) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) { mediaRecovered = true; hls.recoverMediaError(); return; }
        const code = data.response && data.response.code;
        fail(gen, data.type === Hls.ErrorTypes.NETWORK_ERROR ? `network ${code || ''}`.trim() : data.type);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      nativeErrorHandler = () => fail(gen, 'media element error');
      video.addEventListener('error', nativeErrorHandler);
      video.src = url;
      video.load();
      video.play().then(() => setStatus(null)).catch(() => {});
    }
    watchdog(gen);
  }

  function nextUntried(list) { return (list || []).find(s => s && s.play && !tried.has(s.play)) || null; }

  async function startNext() {
    if (!session) return;
    const next = nextUntried(session.streams);
    if (next) { start(next); return; }
    if (refreshed < 2 && session.refresh) {
      refreshed++;
      setStatus('Looking for another stream…', false);
      let fresh = [];
      try { fresh = (await session.refresh()) || []; } catch { fresh = []; }
      if (!session) return;
      session.streams = fresh.length ? fresh : session.streams;
      const again = nextUntried(session.streams);
      if (again) { start(again); return; }
    }
    generation++;
    teardownMedia();
    current = null;
    setStatus('No working stream yet. Press Retry, or pick a channel.', true);
  }

  function fail(gen, reason) {
    if (gen !== generation || !session) return;
    console.log(`[live] stream failed (${reason}): ${current && current.label}`);
    generation++;
    startNext();
  }

  return {
    async play(next) {
      session = { title: next.title, streams: (next.streams || []).slice(), refresh: next.refresh || null };
      tried = new Set();
      refreshed = 0;
      const first = session.streams[next.startIndex || 0] || session.streams[0];
      if (first) start(first); else await startNext();
    },
    stop() {
      generation++;
      teardownMedia();
      session = null; current = null; tried = new Set();
      if (modal && modal.dataset) delete modal.dataset.live;
    },
    isActive: () => !!session,
    async retry() {
      if (!session) return;
      tried = new Set();
      refreshed = 0;
      await startNext();
    },
  };
}
```

- [ ] **Step 5: Live HUD mode in `tv-player.js`**

Add the export near the top of the file (after `timeText`):

```js
// What the HUD shows in live mode: no progress bar, no seek, a LIVE label.
export function liveHudState(live) {
  return live
    ? { showProgress: false, showSeekButtons: false, timeText: 'LIVE', help: 'OK Play / pause · Back Return' }
    : { showProgress: true, showSeekButtons: true, timeText: null, help: '← → Seek · OK Play / pause · Back Return' };
}
```

Inside `createTvPlayer`, keep references to the seek buttons: change the two `add(...)` lines to `const rewind = add('tv-rewind', …)` and `const forward = add('tv-forward', …)`. Add a helper and call it from `update()`:

```js
  const isLive = () => modal.dataset.live === '1';
  function applyLiveHud() {
    const s = liveHudState(isLive());
    progress.style.display = s.showProgress ? '' : 'none';
    rewind.style.display = s.showSeekButtons ? '' : 'none';
    forward.style.display = s.showSeekButtons ? '' : 'none';
    hud.querySelector('.tv-player-help').textContent = s.help;
    if (s.timeText) hud.querySelector('.tv-player-time').textContent = s.timeText;
    modal.classList.toggle('tv-live', isLive());
  }
```

Call `applyLiveHud();` as the first line of `update()`, and extend the modal observer: `new MutationObserver(update).observe(modal, { attributes: true, attributeFilter: ['style', 'data-live'] });`. In the `tv-playback-time` listener, return early when `isLive()` so the LIVE text is not overwritten. In `handleKey`, right after the `if (back) return false;` line add:

```js
      if (isLive() && ([412, 417].includes(event.keyCode) || ['MediaRewind', 'MediaFastForward', 'ArrowLeft', 'ArrowRight'].includes(key))) { reveal(); playButton.focus(); return true; }
```

- [ ] **Step 6: Wire `script.js`**

Import: `import { createLivePlayer } from './live-player.mjs';`

Replace the Task 11 `openLivePlayer` stub with:

```js
const livePlayer = createLivePlayer({
  video: playerVideo, modal: playerModal, helperUrl,
  setStatus: (msg, isError) => setYtsStatus(msg, !!isError),
});
function openLivePlayer(session) {
  stopYtsStream();
  currentPlayingMovie = null;
  currentTvData = null;
  showPlayerVideo(true);
  playerTitle.textContent = session.title || 'Live';
  playerModal.dataset.live = '1';
  playerModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  playerModalOpen = true;
  livePlayer.play(session);
}
```

In `closePlayer()`, add as the first two lines: `livePlayer.stop(); delete playerModal.dataset.live;`.

In the `tv-seek` and `tv-seek-to` listeners add `if (livePlayer.isActive()) return;` as the first statement. In `publishTvPlaybackTime` add `if (livePlayer.isActive()) return;` after the existing guard. In the `tv-retry-playback` listener add `if (livePlayer.isActive()) { livePlayer.retry(); return; }` as the first statement.

`showPlayerVideo(true)` leaves `qualitySelect`/`subtitleSelect` visibility to the torrent path; after `showPlayerVideo(true)` in `openLivePlayer`, hide them explicitly: `if (qualitySelect) qualitySelect.style.display = 'none'; if (subtitleSelect) subtitleSelect.style.display = 'none';`.

- [ ] **Step 7: Run tests and the bundle**

Run: `node --test live-player.test.js tv-player.test.js && npm test && npm run build:tv`
Expected: PASS, 0 fail, bundle builds. Confirm no ES2020 syntax leaked: `grep -cE '\?\?|\?\.' tv-bundle.js` should be `0` (esbuild downlevels hls.js and our code; if the count is non-zero, the esbuild target regressed).

- [ ] **Step 8: Manual check in headless Chrome against the real helper (match window or a channel)**

With the helper running on 8123, open `http://127.0.0.1:8123/tv.html?helperkey=<key>` in headless Playwright as in Task 10 Step 6, click the Live tab, click the first channel card, wait 15 s and print `document.getElementById('player-video').currentTime` plus `document.getElementById('yts-status').textContent`. Expected: currentTime advancing past 5 and an empty status. Record the channel name and the number in the commit body.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tv-entry.js index.html live-player.mjs live-player.test.js tv-player.js tv-player.test.js script.js
git commit -m "live: hls.js live player with recover cascade and live HUD

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: TV e2e for the whole Live flow (`tv-live-e2e.test.js`)

**Files:**
- Create: `tv-live-e2e.test.js`
- Modify: `package.json` `test:tv` script

**Interfaces:**
- Consumes: the running helper at `TV_TEST_URL` (default `http://127.0.0.1:8123`) for static files only; every `/live/*` call is stubbed; `window.__renderLiveHome`.

- [ ] **Step 1: Write the test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

// TV_E2E=1 node --test tv-live-e2e.test.js   (helper serving tv.html on TV_TEST_URL)
test('Live tab: rows, details, stream picker, hls.js playback, Back, focus survives a refresh', { skip: !process.env.TV_E2E }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-live-'));
  const src = join(dir, 'src.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-y', src]);
  await exec('ffmpeg', ['-v', 'error', '-i', src, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', join(dir, 'index.m3u8')]);
  const playlist = (await readFile(join(dir, 'index.m3u8'), 'utf8')).split('\n').map(l => (l && !l.startsWith('#')) ? `/live/seg?u=${encodeURIComponent(l)}&s=sig&ref=&org=&key=k` : l).join('\n');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const now = Date.now();
    const kick = new Date(now + 90 * 60_000).toISOString();
    const matches = [
      { id: 'espn:1', title: 'Arsenal vs Chelsea', league: 'Premier League', kickoff: new Date(now - 40 * 60_000).toISOString(), state: 'in', clock: "40'", home: { name: 'Arsenal', logo: null, score: 1 }, away: { name: 'Chelsea', logo: null, score: 0 }, broadcasters: ['Sky Sports'], sources: [{ adapter: 'nuvio', sourceId: 's1' }], hasStream: true, priority: 1, poster: null },
      { id: 'espn:2', title: 'Inter vs Napoli', league: 'Serie A', kickoff: kick, state: 'pre', clock: null, home: { name: 'Inter', logo: null, score: null }, away: { name: 'Napoli', logo: null, score: null }, broadcasters: [], sources: [], hasStream: false, priority: 6, poster: null },
    ];
    await page.route('**/live/matches**', r => r.fulfill({ json: { matches, status: { fixtures: 'ok', sources: { nuvio: 'ok' } }, generatedAt: new Date(now).toISOString() } }));
    await page.route('**/live/channels**', r => r.fulfill({ json: { channels: [{ id: 'c1', name: 'Test Channel', logo: null, play: '/live/hls?u=ch&s=sig&ref=&org=' }], stale: false, fetchedAt: new Date(now).toISOString() } }));
    await page.route('**/live/streams**', r => r.fulfill({ json: { streams: [{ label: 'Stream One', language: 'English', quality: 'HD', rank: 9, play: '/live/hls?u=one&s=sig&ref=&org=' }, { label: 'Stream Two', language: 'English', quality: 'SD', rank: 5, play: '/live/hls?u=two&s=sig&ref=&org=' }] } }));
    await page.route('**/live/hls**', r => r.fulfill({ contentType: 'application/vnd.apple.mpegurl', headers: { 'access-control-allow-origin': '*' }, body: playlist }));
    await page.route('**/live/seg**', async r => {
      const name = decodeURIComponent(new URL(r.request().url()).searchParams.get('u'));
      r.fulfill({ contentType: 'video/mp2t', headers: { 'access-control-allow-origin': '*' }, body: await readFile(join(dir, name)) });
    });
    await page.route('https://api.themoviedb.org/**', r => r.fulfill({ json: { results: [], page: 1, total_pages: 1, total_results: 0 } }));
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?helperkey=k&helper=${encodeURIComponent(process.env.TV_TEST_URL || 'http://127.0.0.1:8123')}`);
    await page.waitForSelector('.tv-kind-tab[data-kind="live"]');
    // Keyboard only: the kind nav is focused first; ArrowRight x3 lands on Live.
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator(':focus').getAttribute('data-kind'), 'live');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-tv-row="Live now"] .tv-card-live');
    assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#main .tv-row')).map(s => s.dataset.tvRow)), ['Live now', 'Today', 'Channels']);
    assert.equal(await page.locator('[data-tv-row="Today"] .tv-card-nostream').count(), 1);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'espn:1');
    // Review Focus 5: a refresh while a card is focused keeps that card focused.
    await page.evaluate(() => window.__renderLiveHome());
    await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.movieId === 'espn:1');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details-live:not([hidden])');
    await page.waitForSelector('#tv-live-play');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'tv-live-play');
    assert.equal(await page.locator('.tv-live-stream').count(), 2);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#player-modal', { state: 'visible' });
    assert.equal(await page.locator('#player-modal').getAttribute('data-live'), '1');
    await page.waitForFunction(() => document.getElementById('player-video').currentTime > 1.5, null, { timeout: 30000 });
    assert.equal(await page.locator('#tv-progress').isVisible(), false);
    assert.equal(await page.locator('.tv-player-time').textContent(), 'LIVE');
    assert.equal(await page.locator('#player-title').textContent(), 'Arsenal vs Chelsea');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#player-modal', { state: 'hidden' });
    assert.equal(await page.evaluate(() => document.getElementById('player-modal').dataset.live), undefined);
    // Back from the player returns to the card (details was closed on Play).
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'espn:1');
    // Channel card plays directly, no details.
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'ch:c1');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#player-modal', { state: 'visible' });
    assert.equal(await page.locator('.tv-details-live').getAttribute('hidden'), '');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#player-modal', { state: 'hidden' });
    // Back from the home goes to the Live tab anchor.
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(':focus').getAttribute('data-kind'), 'live');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

Add `tv-live-e2e.test.js` to the `test:tv` script list in `package.json`.

- [ ] **Step 2: Run it**

Run (helper on 8123, bundle fresh): `npm run build:tv && TV_E2E=1 node --test tv-live-e2e.test.js`
Expected: PASS. Typical fixes if it fails: `ArrowRight` count if the kind nav gained a tab elsewhere; autoplay (the `--autoplay-policy` flag is set); `helper=` param so `helperUrl` points at the stubbed origin.

- [ ] **Step 3: Commit**

```bash
git add tv-live-e2e.test.js package.json
git commit -m "live: TV e2e for the Live tab, details, hls.js playback and focus

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Documentation and final verification

**Files:**
- Modify: `TV-README.md` (new section)
- No code changes.

- [ ] **Step 1: Add a "Live football" section to `TV-README.md`**

```markdown
## Live football

The Live tab lists today's football and a grid of free 24/7 sports channels.

- Fixtures: ESPN's public scoreboard (`site.api.espn.com`, no key), every league, UTC kick-off, live clock and score.
- Match streams: the Nuvio Live Sports add-on (`nuviosports.xyz`), which wraps DaddyLive. Free, no key, reachable from Sky. Streams appear roughly ten minutes before kick-off.
- Channels: iptv-org `categories/sports.m3u`, filtered to football broadcasters and probed for liveness at fetch time (15 minute cache).
- Playback: upstream CDNs require both `Referer` and `Origin`, which browsers cannot set, so the helper relays playlists and segments (`/live/hls`, `/live/seg`). Every relayed URL is HMAC-signed with the helper key; the relay refuses unsigned or private-address targets. The TV plays through hls.js (bundled) with native HLS as fallback.
- Not touched: streamed.pk, DaddyLive's own site, Sportsurge, TotalSportek. Sky court-blocks them on this line and this feature does not route around that.

Rot playbook: `npm run check-live` prints one line per source. If `nuvio` is BAD, check `NUVIO_HOSTS` in `live-source-nuvio.mjs` for a domain move; if `channels` is BAD, iptv-org changed its layout or every football channel died that hour. `journalctl --user -u moviesdb-helper | grep '\[live\]'` shows the same status per request. Env: none required; `LIVE_RELAY_ALLOW_PRIVATE=1` is for the integration test only.

Tests: `npm test` (unit), `npm run check-live-relay` (relay through a header-enforcing origin, needs ffmpeg), `npm run test:tv` (Playwright, includes `tv-live-e2e.test.js`).
```

- [ ] **Step 2: Full verification**

```bash
npm test
npm run check-live-relay
npm run check-live
npm run build:tv && TV_E2E=1 node --test --test-concurrency=1 tv-live-e2e.test.js
git status --short
```

Expected: all green; `git status` shows only the pre-existing uncommitted files from before this plan (the owner's 33-file working tree) and nothing new.

- [ ] **Step 3: Commit**

```bash
git add TV-README.md
git commit -m "docs: live football section (sources, relay, rot playbook)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand-off note for the owner (not automated)**

Deploy is the owner's step: `npm run build:web`, `npx vercel deploy --prod --yes` (re-run until `Aliased`), `systemctl --user restart moviesdb-helper`, then validate on the LG during a match window via direct CDP (`192.168.0.112:9998`) and write `docs/playback-validation/<date>-live-football.md` in the style of the Mayday note.
