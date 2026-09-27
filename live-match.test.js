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
