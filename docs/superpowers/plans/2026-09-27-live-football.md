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

## STATUS: PLAN INCOMPLETE. Tasks 1-3 above are fully written. Tasks 4-14 below are an outline only and must be expanded to full TDD steps (test code, run, implement, run, commit) before execution. Do not execute past Task 3 from this outline.

### Task 4 (outline): `live-match.mjs`
`normaliseTeam(name)` (strip U+E0000..E007F tags, emoji, diacritics, `FC|CF|AFC|SC|Women`, punctuation; alias table: man utd, wolves, inter, spurs, psg), `LEAGUE_PRIORITY` regex list (Premier League 1, Champions League 2, Europa 3, Conference 4, LaLiga 5, Serie A 6, Bundesliga 7, Ligue 1 8, FA Cup 9, Carabao 10, Nations/World Cup/Euro 11, Friendly 12, default 50), `deriveState(kickoffIso, now)` (pre / in for 130 min / post), `joinFixtures(fixtures, sourceMatches, {now})` -> `LiveMatch[]` (match by both normalised names either order AND kick-off within 30 min; keep unmatched fixtures with `sources: []` and unmatched source matches as `src:<adapter>:<sourceId>`), `sortMatches(list)` (in, pre by kickoff, post; then priority, then kickoff). Pin Review Focus 1 with the real Nuvio name string from the fixture.

### Task 5 (outline): `live-channels.mjs`
`parseM3u(text)` (CRLF-safe; tvg-id, tvg-logo, group-title; `[Geo-blocked]` / `[Not 24/7]` flags), `CHANNEL_ALLOWLIST` regexes (setanta, digi sport, bein, golazo, premier sports, sportitalia, mutv, real madrid tv, inter tv, espn, fox soccer, sky sport, tnt sport, dazn, eleven, sport tv, futbol, foot, la liga tv, bundesliga, premier league), `filterFootballChannels(list)` (drop geo-blocked), `probeHls(url, fetchImpl, 4000)` (GET, accept 200 + mpegurl content-type or body starting `#EXTM3U`), `mapLimit(items, 8, fn)`, `createChannelFeed({fetchImpl, probe, now, ttlMs = 900000})` -> `{ fetchChannels() -> { channels: [{id, name, logo, url}], stale, fetchedAt } }` with last-good fallback. Playlist URL `https://iptv-org.github.io/iptv/categories/sports.m3u`. Pin Review Focus 4.

### Task 6 (outline): `live-relay.mjs` (pure)
`signUpstream({u, ref, org}, secret)` HMAC-SHA256 hex[0:32], `verifyUpstream({u, ref, org, s}, secret)` timing-safe, `isPublicHttpUrl(raw, protocols = ['http:', 'https:'])` (port `isSafeDebridUrl` logic here; stream-server's `isSafeDebridUrl` becomes `raw => isPublicHttpUrl(raw, ['https:'])`), `relayPath(kind 'hls'|'seg', {u, ref, org}, secret, key = '')`, `rewritePlaylist(text, {playlistUrl, relayBase, ref, org, secret, key})`: non-comment lines -> `/live/seg` (or `/live/hls` after `#EXT-X-STREAM-INF` or when ending `.m3u8`); `URI="…"` in `#EXT-X-KEY`/`#EXT-X-MAP` -> seg, in `#EXT-X-MEDIA`/`#EXT-X-I-FRAME-STREAM-INF` -> hls; all other tags untouched; relative URIs resolved against playlistUrl. Pin Review Focus 2.

### Task 7 (outline): helper routes in `stream-server.mjs` + relay integration test
Imports for the five modules plus `randomBytes` (`node:crypto`), `Readable` (`node:stream`), `pipeline` (`node:stream/promises`). `liveSecret = HELPER_KEY || randomBytes(16).toString('hex')`. Instances: `createFixturesFeed({fetchImpl: resolvingFetch})`, `createNuvioAdapter({fetchImpl: resolvingFetch})`, `createSourceRegistry([nuvio])`, `createChannelFeed({fetchImpl: resolvingFetch})`. Handlers: `OPTIONS /live/*` (204, allow GET, before the key gate); `/live/fixtures?date=`; `/live/matches` (fetch local today AND tomorrow, merge by id, window kick-off to [now-3h, now+26h], join, sort, `status: {fixtures, sources}`, one journal line); `/live/streams?adapter=&id=` (response items are `{label, language, quality, rank, play}` only, `play = relayPath('hls', …, liveSecret)` without key); `/live/channels` (`{id, name, logo, play}`, stale, fetchedAt); `/live/hls` (verify sig + isPublicHttpUrl, 8 s timeout, headers Referer/Origin/CHROME_UA, pass upstream non-2xx status through, rewrite with the request's own `key`); `/live/seg` (verify, stream body via `Readable.fromWeb` + `pipeline`, fall back to `arrayBuffer()` when the DNS-fallback fetch returns no body, abort upstream on client close). Integration test `live-relay.integration.test.js` gated `CHECK_LIVE_RELAY=1`: ffmpeg 12 s testsrc2 -> HLS dir; local origin server that 403s unless `referer === 'https://ref.example/' && origin === 'https://ref.example'`; spawn `HELPER_KEY=testkey PORT=18123 node stream-server.mjs`; sign with `signUpstream(..., 'testkey')`; assert rewritten playlist lines start with `/live/seg?`, first segment via relay is 200 and begins 0x47, direct upstream segment without headers is 403. Pin Review Focus 3 with a unit test of the two-date merge/window (extract `selectTodayFixtures(fixturesByDate, now)` into `live-match.mjs`).

### Task 8 (outline): `check-live.mjs` + `npm run check-live` (+ gated `check-live.test.js`, `CHECK_LIVE=1`)
For each adapter: listMatches, streamsFor(first); probe channel feed; one status line per source; exit 1 if the primary adapter fails. Mirror `check-links.mjs`.

### Task 9 (outline): client `live-home.mjs` (pure) + `live-ui.js` (DOM card) + `tv-ui.js` + `tv-rows.mjs` + CSS
`kickoffLabel(iso, now)`, `matchToCard`, `channelToCard`, `buildLiveRows(matches, channels, now)` -> rows `live-now`, `today`, `channels` with `noSort: true`; `orderRowItems` honours `row.noSort`; `createTvCard` uses `movie.image_url` verbatim when present and delegates to `createLiveCard(movie, onSelect)` when `movie.live` (badges + score visual, LIVE pill, `.tv-card-nostream` when `hasStream === false`, channel logos `object-fit: contain`). Styles in `tv.css` and `style.css`.

### Task 10 (outline): Live kind + `renderLiveHome` in `script.js`, `tv-remote.js`, `index.html`
Add `['live', 'Live']` to the kind nav; `setTvMediaKind` accepts `'live'` and calls `renderLiveHome()`; `effectiveMediaType` treats `'live'` like `'all'`; `renderLiveHome` fetches `/live/matches` + `/live/channels` via `helperUrl` with a 15 s AbortController, uses the `tvHomeToken` guard, appends rows with `appendTvRow`, empty-state line, status line naming failed sources, 60 s refresh timer skipped while player/details are open, restores focus by `data-movie-id` after re-render, exposes `window.__renderLiveHome` for the e2e. Web: `<button id="tab-live" class="app-tab" data-tab="live">Live</button>` calling `setTvMediaKind('live')`.

### Task 11 (outline): `live-details.mjs` + Back handling
`createLiveDetails({fetchStreams, onPlay, now})` -> `{el, open(match), close(), isOpen()}`; overlay class `tv-details tv-details-live` (hidden attr); title, meta, badges, broadcasters, Play (focused) + one `.tv-live-stream` button per stream, "No stream yet" + Refresh when empty. `tv-remote.js`: `detailsOpen()` = any `.tv-details:not([hidden])`, candidates scope uses that element, MutationObserver installed on every `.tv-details`; `tv-close-details` closes whichever is open.

### Task 12 (outline): `live-player.mjs` + `tv-player.js` live HUD + wiring
`npm i hls.js@1.7.3`; `tv-entry.js`: `import Hls from 'hls.js'; window.Hls = Hls;` before `./script.js`; `index.html` adds `<script src="node_modules/hls.js/dist/hls.min.js"></script>`. `createLivePlayer({video, modal, helperUrl, setStatus, getHls = () => globalThis.Hls, now})` -> `{play({title, streams, refresh}), stop(), isActive(), retry()}`: tried-set cascade, hls.js config `{maxBufferLength: 10, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, manifestLoadingTimeOut: 8000, fragLoadingTimeOut: 10000}`, fatal network 403/404 or second media error -> next stream, `playbackHealth` watchdog 30 s startup / 20 s stall, native fallback when `!Hls.isSupported()`, refresh once when exhausted then "No working stream yet". `script.js`: `openLivePlayer`, `closePlayer` calls `livePlayer.stop()` and clears `playerModal.dataset.live`, `tv-seek`/`tv-seek-to`/`publishTvPlaybackTime` early-return when live, `tv-retry-playback` -> `livePlayer.retry()`. `tv-player.js`: observe `data-live`; when set hide `#tv-progress`, rewind/forward, time text = `LIVE`, help text without seek, arrow keys only reveal.

### Task 13 (outline): `tv-live-e2e.test.js` (gated `TV_E2E`)
Stub `/live/matches`, `/live/channels`, `/live/streams`, `/live/hls` (synthetic playlist pointing at `/live/seg?…`), `/live/seg` (ffmpeg segments). Keyboard-only: Live tab -> card -> details -> Play -> video advancing, `#tv-progress` hidden, Escape back to card, Escape to Live tab; force `window.__renderLiveHome()` while a card is focused and assert the same `data-movie-id` is focused after (Review Focus 5). Add to `npm run test:tv`.

### Task 14 (outline): docs + verification
`TV-README.md` "Live football" section (sources, relay, env, `check-live`, rot playbook); `npm test`, `npm run build:tv`; owner then runs `npm run build:web`, deploys, restarts `moviesdb-helper`, and validates on the TV via direct CDP during a match window, writing `docs/playback-validation/<date>-live-football.md`.
