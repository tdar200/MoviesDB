import test from 'node:test';
import assert from 'node:assert/strict';
import { rankTrailerVideos, youtubeTrailerEvent } from './tv-trailers.js';

const v = (key, type, extra = {}) => ({ site: 'YouTube', key, type, official: false, ...extra });

test('trailers and teasers lead, official first, then the YouTube clips a long-running show falls back to', () => {
  const ranked = rankTrailerVideos([
    v('clip', 'Clip'), v('teaser', 'Teaser'), v('credits', 'Opening Credits'), v('offTrailer', 'Trailer', { official: true }),
    v('trailer', 'Trailer'), v('vimeo', 'Trailer', { site: 'Vimeo' }), v('feat', 'Featurette'),
  ], 10);
  assert.deepEqual(ranked, ['offTrailer', 'trailer', 'teaser', 'clip', 'feat', 'credits']);
});

test('only a few candidates are kept, each key once, YouTube only', () => {
  const many = Array.from({ length: 8 }, (_, i) => v(`k${i % 5}`, 'Trailer'));
  assert.equal(rankTrailerVideos(many, 3).length, 3);
  assert.equal(new Set(rankTrailerVideos(many, 10)).size, rankTrailerVideos(many, 10).length);
  assert.deepEqual(rankTrailerVideos([{ site: 'Vimeo', key: 'x', type: 'Trailer' }, { type: 'Trailer' }]), []);
  assert.deepEqual(rankTrailerVideos(undefined), []);
});

test('Grey\'s Anatomy case: a single Clip is better than no trailer at all', () => {
  assert.deepEqual(rankTrailerVideos([v('onlyClip', 'Clip')]), ['onlyClip']);
});

test('youtubeTrailerEvent reads the player state / error out of the embed\'s postMessage traffic', () => {
  assert.deepEqual(youtubeTrailerEvent(JSON.stringify({ event: 'onStateChange', info: 1 })), { kind: 'state', value: 1 });
  assert.deepEqual(youtubeTrailerEvent(JSON.stringify({ event: 'infoDelivery', info: { playerState: 3 } })), { kind: 'state', value: 3 });
  assert.deepEqual(youtubeTrailerEvent({ event: 'onError', info: 101 }), { kind: 'error', value: 101 });
  assert.equal(youtubeTrailerEvent(JSON.stringify({ event: 'infoDelivery', info: { currentTime: 4 } })), null);
  assert.equal(youtubeTrailerEvent('not json'), null);
  assert.equal(youtubeTrailerEvent(undefined), null);
});
