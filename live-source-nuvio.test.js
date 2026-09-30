import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNuvioCatalog, parseNuvioStreams, stripDecorations, createNuvioAdapter, NUVIO_HOSTS } from './live-source-nuvio.mjs';

const catalog = JSON.parse(readFileSync(new URL('./test-fixtures/live/nuvio-catalog-football.json', import.meta.url), 'utf8'));
const streams = JSON.parse(readFileSync(new URL('./test-fixtures/live/nuvio-streams.json', import.meta.url), 'utf8'));

test('stripDecorations removes emoji, flag tag characters and variation selectors', () => {
  assert.equal(stripDecorations('🔴 LIVE: Manchester United \u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} vs West Ham United'), 'LIVE: Manchester United vs West Ham United');
  assert.equal(stripDecorations('🏆 League: \u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} England - Women\'s Super League'), 'League: England - Women\'s Super League');
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
  assert.deepEqual(list[0], { sourceId: 'x', title: 'A vs B', league: null, kickoff: null, home: 'A', away: 'B', poster: null, status: null, sport: 'football' });
  assert.equal(parseNuvioCatalog({ metas: [{ id: 'y', name: 'India vs Pakistan' }] }, 'cricket')[0].sport, 'cricket');
  assert.deepEqual(parseNuvioCatalog({}), []);
});

test('parseNuvioStreams keeps the /api/manifest wrapper as the playlist URL and pulls headers from behaviorHints', () => {
  const list = parseNuvioStreams(streams);
  assert.ok(list.length >= 2);
  const s = list[0];
  assert.match(s.url, /^https:\/\/nuviosports\.xyz\/api\/manifest\?url=/);
  assert.match(new URL(s.url).searchParams.get('url'), /^https:\/\/643t8a\.7odxv0l067ka\.net:8443\/hls\/.+\.m3u8\?s=.+&e=\d+$/);
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
  assert.equal(list[0].url, 'https://nuviosports.xyz/api/manifest?url=https%3A%2F%2Fcdn.example%2Fa.m3u8&referer=https%3A%2F%2Fr.example%2F&origin=https%3A%2F%2Fr.example');
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
  assert.ok(urls.includes('https://dead.example/catalog/tv/nuvio_sports_live/genre=Football.json'), 'tried the dead host first');
  assert.ok(urls.includes('https://nuviosports.xyz/catalog/tv/nuvio_sports_live/genre=Football.json'), 'then failed over');
  const list = await adapter.streamsFor('nuvio_sport_dlv_308_manchester-united-vs-west-ham-united');
  assert.ok(list.length >= 2);
  assert.equal(urls[urls.length - 1], 'https://nuviosports.xyz/stream/tv/nuvio_sport_dlv_308_manchester-united-vs-west-ham-united.json');
  await assert.rejects(() => adapter.streamsFor('nope'), /Nuvio 404/);
  assert.deepEqual(NUVIO_HOSTS, ['https://nuviosports.xyz']);
});

test('listMatches caches the catalog for 60 s and serves the last good list when Nuvio fails or stalls', async () => {
  let clock = 0; let calls = 0; let mode = 'ok';
  const fetchImpl = async (url, opts) => {
    calls++;
    if (mode === 'fail') throw new TypeError('fetch failed');
    if (mode === 'http') return { ok: false, status: 502, json: async () => ({}) };
    if (mode === 'hang') return new Promise((_, reject) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'TimeoutError'; reject(e); }));
    return { ok: true, status: 200, json: async () => catalog };
  };
  const adapter = createNuvioAdapter({ fetchImpl, now: () => clock, catalogTimeoutMs: 30 });
  const first = await adapter.listMatches();
  assert.ok(first.length >= 2);
  clock = 30_000; await adapter.listMatches();
  assert.equal(calls, 3, 'football + cricket + upcoming cricket, then served from cache inside 60 s');
  clock = 61_000; mode = 'fail';
  assert.deepEqual(await adapter.listMatches(), first, 'network error -> last good list');
  mode = 'http'; clock = 130_000;
  assert.deepEqual(await adapter.listMatches(), first, 'HTTP error -> last good list');
  mode = 'hang'; clock = 200_000;
  const t0 = Date.now();
  assert.deepEqual(await adapter.listMatches(), first, 'stalled catalog -> last good list after the timeout');
  assert.ok(Date.now() - t0 < 1000);
  clock = 200_000 + 31 * 60_000; mode = 'fail';
  await assert.rejects(() => adapter.listMatches(), /fetch failed/, 'a list older than 30 min is not served');
});

test('listMatches also reads the upcoming cricket catalog, de-duplicating and surviving its failure', async () => {
  const meta = (id, name, released, status) => ({ id, name, released, description: `League: ODI Category: CRICKET Status: ${status}` });
  const live = { metas: [meta('sa-aus', 'LIVE: South Africa vs Australia', '2026-09-30T11:30:00.000Z', 'LIVE NOW')] };
  const upcoming = { metas: [
    meta('sa-aus', 'South Africa vs Australia', '2026-09-30T11:30:00.000Z', 'Kickoff at 11:30'),
    meta('pak-ban', 'Pakistan vs Bangladesh', '2026-10-01T00:00:00.000Z', 'Kickoff at 12:00'),
  ] };
  const urls = []; let upcomingDown = false;
  const fetchImpl = async url => {
    urls.push(url);
    if (url.endsWith('/nuvio_sports_live/genre=Cricket.json')) return { ok: true, status: 200, json: async () => live };
    if (url.endsWith('/nuvio_sports_upcoming/genre=Cricket.json')) {
      if (upcomingDown) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => upcoming };
    }
    return { ok: true, status: 200, json: async () => ({ metas: [] }) };
  };
  let clock = 0;
  const adapter = createNuvioAdapter({ fetchImpl, now: () => clock });
  const list = (await adapter.listMatches()).filter(m => m.sport === 'cricket');
  assert.deepEqual(list.map(m => m.sourceId).sort(), ['pak-ban', 'sa-aus'], 'upcoming fixture added, duplicate collapsed');
  assert.equal(list.find(m => m.sourceId === 'sa-aus').status, 'in', 'the live entry wins over the upcoming copy');
  assert.equal(list.find(m => m.sourceId === 'pak-ban').kickoff, '2026-10-01T00:00:00Z');
  assert.ok(!urls.some(u => u.includes('nuvio_sports_upcoming/genre=Football')), 'football behaviour unchanged');
  clock = 61_000; upcomingDown = true;
  const after = (await adapter.listMatches()).filter(m => m.sport === 'cricket');
  assert.deepEqual(after.map(m => m.sourceId), ['sa-aus'], 'a failing upcoming catalog does not hide live matches');
});

test('stripDecorations drops the stopwatch symbol Nuvio puts before upcoming fixtures', async () => {
  const { stripDecorations } = await import('./live-source-nuvio.mjs');
  assert.equal(stripDecorations('\u23F1\uFE0F Pakistan vs Bangladesh'), 'Pakistan vs Bangladesh');
});

test('listMatches with no cached list propagates the failure', async () => {
  const adapter = createNuvioAdapter({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(() => adapter.listMatches(), /fetch failed/);
});

test('qualityHeight reads resolutions, p-labels and HD/SD words', async () => {
  const { qualityHeight } = await import('./live-source-nuvio.mjs');
  assert.equal(qualityHeight('1920x1080'), 1080);
  assert.equal(qualityHeight('1280x720'), 720);
  assert.equal(qualityHeight('720p'), 720);
  assert.equal(qualityHeight('4K'), 2160);
  assert.equal(qualityHeight('FHD'), 1080);
  assert.equal(qualityHeight('Full HD'), 1080);
  assert.equal(qualityHeight('HD'), 720);
  assert.equal(qualityHeight('SD'), 480);
  assert.equal(qualityHeight(''), 0);
  assert.equal(qualityHeight(null), 0);
});

test('parseNuvioStreams reports a height per stream from resolution or the title', () => {
  const list = parseNuvioStreams({ streams: [
    { title: 'A', url: 'https://cdn.example/a.m3u8', resolution: '1920x1080' },
    { title: 'B\nQuality: 720p', url: 'https://cdn.example/b.m3u8' },
    { title: 'C', url: 'https://cdn.example/c.m3u8', resolution: 'SD' },
    { title: 'D', url: 'https://cdn.example/d.m3u8' },
  ] });
  assert.deepEqual(list.map(s => s.height), [1080, 720, 480, 0]);
});
