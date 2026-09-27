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
    assert.equal(ch.querySelector('.tv-card-overview').textContent, 'Live channel');
    const news = createLiveCard({ id: 'ch:n', title: 'CBS News', kind: 'channel', image_url: null, live: { state: 'channel', height: 720, category: 'News' }, raw: {} }, () => {});
    assert.equal(news.querySelector('.tv-card-overview').textContent, '720p  ·  News');
  } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
});
