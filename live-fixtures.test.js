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
  assert.equal(f.clock, "61'");
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

test('an unparseable event date yields kickoff null and is filtered out without dropping the day', async () => {
  const bad = { ...byState('pre'), id: 'bad1', date: 'not-a-date' };
  assert.equal(normaliseEspnEvent(bad).kickoff, null);
  const feed = createFixturesFeed({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ events: [...sample.events, bad] }) }), now: () => 0 });
  const list = await feed.fetchFixtures('2026-09-27');
  assert.equal(list.length, sample.events.length);
  assert.equal(list.some(f => f.id === 'espn:bad1'), false);
});
