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

test('buildLiveRows keeps streamed matches, keeps stream-less ones only for top leagues, and caps match rows at 60', () => {
  const noPriority = match('np', 'pre', '2026-09-27T15:00:00Z', { hasStream: false });
  delete noPriority.priority;
  const rows = buildLiveRows([
    match('top', 'pre', '2026-09-27T15:00:00Z', { hasStream: false, priority: 1 }),
    match('minor', 'pre', '2026-09-27T15:00:00Z', { hasStream: false, priority: 50 }),
    noPriority,
    match('streamed', 'pre', '2026-09-27T15:00:00Z', { hasStream: true, priority: 50 }),
    match('live-minor', 'in', '2026-09-27T13:00:00Z', { hasStream: false, priority: 40 }),
  ], [], now);
  assert.deepEqual(rows.map(r => [r.key, r.items.map(i => i.id)]), [['today', ['top', 'streamed']]]);

  const many = Array.from({ length: 70 }, (_, i) => match(`m${i}`, 'pre', '2026-09-27T15:00:00Z', { priority: 50 }));
  const [today] = buildLiveRows(many, [], now);
  assert.equal(today.key, 'today');
  assert.deepEqual(today.items.map(i => i.id), many.slice(0, 60).map(m => m.id));
});
