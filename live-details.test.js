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
    const streams = [{ label: 'DaddyLive | Sportsnet One', language: 'English', quality: 'HD', rank: 97, health: 'ok', play: '/live/hls?u=1' }, { label: 'DaddyLive | beIN 3', language: 'English', quality: 'HD', rank: 80, health: 'ok', play: '/live/hls?u=2' }, { label: 'Slow | TNT 1', rank: 99, health: 'timeout', play: '/live/hls?u=3' }];
    const details = createLiveDetails({ fetchStreams: async () => streams, onPlay: (m, s, i) => played.push([m.id, s.length, i]) });
    assert.equal(details.el.hidden, true);
    assert.ok(details.el.classList.contains('tv-details') && details.el.classList.contains('tv-details-live'));
    assert.ok(doc.body.children.includes(details.el));
    const opening = details.open(match);
    // Focus is inside the overlay from the first frame, before streams arrive.
    const loading = details.el.querySelector('#tv-live-loading');
    assert.ok(loading, 'loading placeholder rendered');
    assert.equal(loading.tag, 'button');
    assert.equal(doc.activeElement, loading);
    await opening;
    assert.equal(details.el.querySelector('#tv-live-loading'), null);
    assert.equal(details.isOpen(), true);
    assert.equal(details.el.querySelector('.tv-details-title').textContent, 'Arsenal vs Chelsea');
    assert.match(details.el.querySelector('.tv-details-meta').textContent, /Premier League/);
    assert.match(details.el.querySelector('.tv-details-meta').textContent, /67'/);
    assert.equal(details.el.querySelector('.tv-live-details-score').textContent, '2 - 1');
    assert.match(details.el.querySelector('.tv-live-broadcasters').textContent, /Sky Sports, FS2/);
    const play = details.el.querySelector('#tv-live-play');
    assert.equal(doc.activeElement, play);
    const buttons = details.el.querySelectorAll('.tv-live-stream');
    assert.equal(buttons.length, 3);
    assert.match(buttons[1].textContent, /beIN 3/);
    // A timeout stream stays below every ok stream even with a higher rank, and is flagged.
    assert.match(buttons[2].textContent, /TNT 1/);
    assert.match(buttons[2].textContent, / · may not work$/);
    assert.doesNotMatch(buttons[0].textContent, /may not work/);
    play.listeners.click();
    assert.deepEqual(played, [['espn:1', 3, 0]]);
    buttons[1].listeners.click();
    assert.deepEqual(played[1], ['espn:1', 3, 1]);
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
    const refreshing = refresh.listeners.click();
    assert.equal(refresh.disabled, true, 'Refresh is disabled while its fetch is in flight');
    assert.equal(doc.activeElement, details.el.querySelector('#tv-live-loading'));
    await refreshing;
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

test('live details lists working streams sharpest first, then by speed rank', async () => {
  const prev = globalThis.document; const doc = fakeDocument(); globalThis.document = doc;
  try {
    const { createLiveDetails } = await import('./live-details.mjs');
    const streams = [
      { label: 'Fast SD', quality: '480p', height: 480, rank: 99, health: 'ok', play: '/1' },
      { label: 'Sharp', quality: '1080p', height: 1080, rank: 10, health: 'ok', play: '/2' },
      { label: 'Dead 4K', quality: '2160p', height: 2160, rank: 100, health: 'timeout', play: '/3' },
      { label: 'HD fast', quality: '720p', height: 720, rank: 60, health: 'ok', play: '/4' },
    ];
    const details = createLiveDetails({ fetchStreams: async () => streams, onPlay: () => {} });
    await details.open(match);
    const labels = details.el.querySelectorAll('.tv-live-stream').map(b => b.textContent);
    assert.match(labels[0], /^Sharp/);
    assert.match(labels[1], /^HD fast/);
    assert.match(labels[2], /^Fast SD/);
    assert.match(labels[3], /^Dead 4K.*may not work/);
  } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
});
