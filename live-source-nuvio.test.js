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
  assert.deepEqual(list[0], { sourceId: 'x', title: 'A vs B', league: null, kickoff: null, home: 'A', away: 'B', poster: null, status: null });
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
  assert.equal(urls[0], 'https://dead.example/catalog/tv/nuvio_sports_live/genre=Football.json');
  assert.equal(urls[1], 'https://nuviosports.xyz/catalog/tv/nuvio_sports_live/genre=Football.json');
  const list = await adapter.streamsFor('nuvio_sport_dlv_308_manchester-united-vs-west-ham-united');
  assert.ok(list.length >= 2);
  assert.equal(urls[2], 'https://nuviosports.xyz/stream/tv/nuvio_sport_dlv_308_manchester-united-vs-west-ham-united.json');
  await assert.rejects(() => adapter.streamsFor('nope'), /Nuvio 404/);
  assert.deepEqual(NUVIO_HOSTS, ['https://nuviosports.xyz']);
});
