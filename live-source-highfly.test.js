import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHighflyCatalog, parseHighflyStreams, parseReleaseInfo, createHighflyAdapter, HIGHFLY_HOSTS } from './live-source-highfly.mjs';

const catalog = JSON.parse(readFileSync(new URL('./test-fixtures/live/highfly-catalog-football.json', import.meta.url), 'utf8'));
const streams = JSON.parse(readFileSync(new URL('./test-fixtures/live/highfly-streams.json', import.meta.url), 'utf8'));

test('parseReleaseInfo reads LIVE and "27 Sep 2026 · 18:45 UTC"', () => {
  assert.deepEqual(parseReleaseInfo('LIVE'), { status: 'in', kickoff: null });
  assert.deepEqual(parseReleaseInfo('27 Sep 2026 · 18:45 UTC'), { status: null, kickoff: '2026-09-27T18:45:00Z' });
  assert.deepEqual(parseReleaseInfo('28 Sep 2026 · 01:00 UTC'), { status: null, kickoff: '2026-09-28T01:00:00Z' });
  assert.deepEqual(parseReleaseInfo(''), { status: null, kickoff: null });
  assert.deepEqual(parseReleaseInfo('Starts soon'), { status: null, kickoff: null });
});

test('parseHighflyCatalog keeps matches (A vs B), drops 24/7 channel entries, splits teams', () => {
  const list = parseHighflyCatalog(catalog);
  assert.ok(!list.some(m => m.sourceId.startsWith('leaf:')), '24/7 channel entries are not matches');
  const dw = list.find(m => m.sourceId === 'streamed:denmark-vs-wales-2442761');
  assert.deepEqual(dw, { sourceId: 'streamed:denmark-vs-wales-2442761', title: 'Denmark vs Wales', league: null, kickoff: null, home: 'Denmark', away: 'Wales', poster: null, status: 'in', sport: 'football' });
  assert.equal(parseHighflyCatalog({ metas: [{ id: 'streamed:ind-v-pak', name: 'India vs Pakistan', releaseInfo: 'LIVE' }] }, 'cricket')[0].sport, 'cricket');
  const ger = list.find(m => m.home === 'Germany');
  assert.equal(ger.kickoff, '2026-09-27T18:45:00Z');
  assert.equal(ger.status, null);
  assert.deepEqual(parseHighflyCatalog({}), []);
});

test('parseHighflyStreams reads resolution and bitrate from the title and drops locked or non-HLS entries', () => {
  const list = parseHighflyStreams(streams);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { url: 'https://papacito.cfd/m3u/162178/live.m3u8', referer: '', origin: '', userAgent: list[0].userAgent, label: 'Leaf · UK: BBC ONE EAST W', language: '', quality: '1080p', height: 1080, rank: 6100 });
  assert.match(list[0].userAgent, /Chrome/);
  assert.equal(list[2].rank, 10400);
  const extra = parseHighflyStreams({ streams: [
    { name: '🔒 Premium', title: 'Upgrade to Premium', url: 'https://www.google.com' },
    { name: 'Note: Starts in 20 min', title: 'Starts in 20 min', url: 'https://sports.highfly.dev/' },
    { name: 'Leaf · X', title: '1280x720 · ~3 Mbps', url: 'https://papacito.cfd/m3u/1/live.m3u8' },
    { name: 'Leaf · Y', title: 'no numbers here', url: 'https://papacito.cfd/m3u/2/live.m3u8' },
  ] });
  assert.deepEqual(extra.map(s => [s.label, s.height, s.rank]), [['Leaf · X', 720, 3000], ['Leaf · Y', 0, 0]]);
});

test('createHighflyAdapter lists matches (cached 60 s, stale on failure) and fetches streams', async () => {
  let clock = 0; const urls = []; let fail = false;
  const fetchImpl = async url => {
    urls.push(url);
    if (fail) throw new TypeError('fetch failed');
    if (url.endsWith('/catalog/sport/sports_football.json')) return { ok: true, status: 200, json: async () => catalog };
    if (url.endsWith('/catalog/sport/sports_cricket.json')) return { ok: true, status: 200, json: async () => ({ metas: [{ id: 'streamed:ind-v-pak', name: 'India vs Pakistan', releaseInfo: 'LIVE' }] }) };
    if (url.endsWith('/stream/sport/streamed%3Adenmark-vs-wales-2442761.json')) return { ok: true, status: 200, json: async () => streams };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const a = createHighflyAdapter({ fetchImpl, now: () => clock });
  assert.equal(a.name, 'highfly');
  const m1 = await a.listMatches();
  assert.ok(m1.length > 5);
  assert.ok(urls.includes('https://sports.highfly.dev/catalog/sport/sports_football.json'));
  assert.ok(urls.includes('https://sports.highfly.dev/catalog/sport/sports_cricket.json'));
  assert.equal(m1.find(m => m.home === 'India').sport, 'cricket');
  assert.equal(m1.find(m => m.home === 'Denmark').sport, 'football');
  clock = 30_000; await a.listMatches(); assert.equal(urls.length, 2);
  clock = 90_000; fail = true;
  assert.deepEqual(await a.listMatches(), m1);
  fail = false;
  const s = await a.streamsFor('streamed:denmark-vs-wales-2442761');
  assert.equal(s.length, 3);
  await assert.rejects(() => a.streamsFor('nope'), /Highfly 404/);
  assert.deepEqual(HIGHFLY_HOSTS, ['https://sports.highfly.dev']);
});
