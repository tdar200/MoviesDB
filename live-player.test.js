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
    static ErrorDetails = { FRAG_LOAD_ERROR: 'fragLoadError', FRAG_LOAD_TIMEOUT: 'fragLoadTimeOut' };
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
  const frag = LIVE_HLS_CONFIG.fragLoadPolicy.default;
  assert.equal(frag.maxTimeToFirstByteMs, 8000);
  assert.equal(frag.maxLoadTimeMs, 15000);
  assert.equal(frag.timeoutRetry.maxNumRetry, 1);
  assert.equal(frag.errorRetry.maxNumRetry, 1);
  assert.equal('fragLoadingTimeOut' in LIVE_HLS_CONFIG, false, 'legacy option would be ignored next to fragLoadPolicy');
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
  h.video.currentTime = 5; h.video.paused = false; h.tick(1000); // playing: teardown paused the fake and it has no play-state model
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

const loads = h => h.log.filter(e => e[0] === 'load').map(e => e[1]);
const settle = () => new Promise(r => setTimeout(r, 0));

test('stop on a player that never played leaves the shared video alone', () => {
  const h = harness();
  h.video.src = 'blob:movie';
  h.video.currentTime = 1234;
  const modal = { dataset: { live: '1' } };
  const player = createLivePlayer({ video: h.video, modal, helperUrl: p => p, setStatus: () => {}, getHls: () => h.Hls, now: () => 0, setInterval: () => 1, clearInterval: () => {} });
  player.stop();
  assert.equal(h.video.src, 'blob:movie');
  assert.equal(h.video.loaded, 0);
  assert.equal(h.video.paused, false);
  assert.equal(h.video.currentTime, 1234);
});

function deferredRefresh() {
  const pending = [];
  const refresh = () => new Promise(resolve => pending.push(resolve));
  return { refresh, pending };
}

test('a refresh that resolves after stop + a new play does not hijack the new session', async () => {
  const h = harness();
  const d = deferredRefresh();
  await h.player.play({ title: 'old', streams: [{ label: 'o1', play: '/old1' }], refresh: d.refresh });
  h.Hls.last.emit('err', { fatal: true, type: 'networkError', response: { code: 403 } });
  await settle();
  assert.equal(d.pending.length, 1, 'refresh in flight');
  h.player.stop();
  await h.player.play({ title: 'new', streams: [{ label: 'n1', play: '/new1' }], refresh: async () => [] });
  d.pending[0]([{ label: 'o2', play: '/old2' }]);
  await settle(); await settle();
  assert.deepEqual(loads(h), ['http://h/old1?key=k', 'http://h/new1?key=k']);
  assert.equal(h.player.isActive(), true);
  assert.equal(h.statuses.at(-1)[0], 'Connecting to n1…');
});

test('retry during a pending refresh wins over the stale continuation', async () => {
  const h = harness();
  const d = deferredRefresh();
  await h.player.play({ title: 't', streams: [{ label: 's1', play: '/a' }], refresh: d.refresh });
  h.Hls.last.emit('err', { fatal: true, type: 'networkError', response: { code: 403 } });
  await settle();
  assert.equal(d.pending.length, 1);
  await h.player.retry();
  assert.deepEqual(loads(h), ['http://h/a?key=k', 'http://h/a?key=k'], 'retry restarts from the first stream');
  d.pending[0]([{ label: 'stale', play: '/stale' }]);
  await settle(); await settle();
  assert.equal(loads(h).includes('http://h/stale?key=k'), false);
  assert.equal(loads(h).length, 2);
});

test('two non-fatal fragment failures before the first frame move to the next stream', async () => {
  const h = harness();
  await h.player.play({ title: 't', streams: [{ label: 's1', play: '/a' }, { label: 's2', play: '/b' }], refresh: async () => [] });
  const first = h.Hls.last;
  first.emit('err', { fatal: false, type: 'networkError', details: 'fragLoadTimeOut' });
  assert.equal(loads(h).length, 1, 'one strike is tolerated');
  first.emit('err', { fatal: false, type: 'networkError', details: 'fragLoadTimeOut' });
  await settle();
  assert.deepEqual(loads(h), ['http://h/a?key=k', 'http://h/b?key=k']);
  assert.ok(h.log.findIndex(e => e[0] === 'destroy') < h.log.findIndex(e => e[1] === 'http://h/b?key=k'), 'failed instance destroyed first');
  first.emit('mp');
  assert.equal(h.video.played, 0, 'an abandoned instance cannot start playback');
});

test('fragment failures after the first frame are left to hls.js and the stall watchdog', async () => {
  const h = harness();
  await h.player.play({ title: 't', streams: [{ label: 's1', play: '/a' }, { label: 's2', play: '/b' }], refresh: async () => [] });
  h.video.currentTime = 4;
  h.Hls.last.emit('err', { fatal: false, type: 'networkError', details: 'fragLoadError' });
  h.Hls.last.emit('err', { fatal: false, type: 'networkError', details: 'fragLoadError' });
  await settle();
  assert.equal(loads(h).length, 1);
});
