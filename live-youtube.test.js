import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYoutubeLivePage, probeYoutubeLive, youtubeEmbedUrl, youtubeLiveUrl } from './live-youtube.mjs';

const page = response => `<html><head><title>x</title></head><body><script nonce="a">var ytInitialPlayerResponse = ${JSON.stringify(response)};var meta = document.createElement('div');</script></body></html>`;
const LIVE = { playabilityStatus: { status: 'OK', playableInEmbed: true }, videoDetails: { videoId: 'abcdefghijk', isLive: true, title: 'News LIVE' } };
const NO_EMBED = { playabilityStatus: { status: 'UNPLAYABLE', playableInEmbed: false }, videoDetails: { videoId: 'abcdefghijk', isLive: true } };
const OFFLINE = { playabilityStatus: { status: 'LIVE_STREAM_OFFLINE', playableInEmbed: true }, videoDetails: { videoId: 'abcdefghijk', isLive: false } };
const ok = html => async () => ({ ok: true, status: 200, text: async () => html });

test('parseYoutubeLivePage: live and embeddable', () => {
  assert.deepEqual(parseYoutubeLivePage(page(LIVE)), { live: true, embeddable: true, videoId: 'abcdefghijk' });
});

test('parseYoutubeLivePage: live but the broadcaster disabled embedding (ARY Digital)', () => {
  assert.deepEqual(parseYoutubeLivePage(page(NO_EMBED)), { live: true, embeddable: false, videoId: 'abcdefghijk' });
});

test('parseYoutubeLivePage: a channel that is not streaming right now', () => {
  assert.equal(parseYoutubeLivePage(page(OFFLINE)).live, false);
  // A channel with no live stream serves its channel page: there is no player response at all.
  assert.equal(parseYoutubeLivePage('<html><body>channel page</body></html>').live, false);
  assert.equal(parseYoutubeLivePage('').live, false);
  assert.equal(parseYoutubeLivePage('var ytInitialPlayerResponse = {not json};var x').live, false);
});

test('probeYoutubeLive asks for the channel live page with a consent cookie, and reports ok only for live + embeddable', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => page(LIVE) }; };
  assert.deepEqual(await probeYoutubeLive({ youtube: 'UC_vt34wimdCzdkrzVejwX9g', height: 0 }, { fetchImpl }), { status: 'ok', height: 0 });
  assert.equal(seen.url, 'https://www.youtube.com/channel/UC_vt34wimdCzdkrzVejwX9g/live');
  assert.match(seen.init.headers.cookie, /CONSENT=/, 'the EU consent wall would otherwise replace the page');
  assert.equal((await probeYoutubeLive({ youtube: 'UC1234567890123456789012' }, { fetchImpl: ok(page(NO_EMBED)) })).status, 'no-embed');
  assert.equal((await probeYoutubeLive({ youtube: 'UC1234567890123456789012' }, { fetchImpl: ok(page(OFFLINE)) })).status, 'offline');
  assert.equal((await probeYoutubeLive({ youtube: 'UC1234567890123456789012' }, { fetchImpl: async () => { throw new TypeError('fetch failed'); } })).status, 'error');
  assert.equal((await probeYoutubeLive({ youtube: 'UC1234567890123456789012' }, { fetchImpl: async () => ({ ok: false, status: 429, text: async () => '' }) })).status, 'error');
});

test('probeYoutubeLive rejects anything that is not a channel id (nothing else is ever fetched)', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200, text: async () => page(LIVE) }; };
  for (const bad of [undefined, '', 'geonews', 'UC123', '../../etc', 'UC_vt34wimdCzdkrzVejwX9g/../x']) {
    assert.equal((await probeYoutubeLive({ youtube: bad }, { fetchImpl })).status, 'error');
  }
  assert.equal(called, false);
});

test('embed and live URLs are built from the channel id only', () => {
  assert.equal(youtubeLiveUrl('UC_vt34wimdCzdkrzVejwX9g'), 'https://www.youtube.com/channel/UC_vt34wimdCzdkrzVejwX9g/live');
  const u = new URL(youtubeEmbedUrl('UC_vt34wimdCzdkrzVejwX9g'));
  assert.equal(u.origin + u.pathname, 'https://www.youtube.com/embed/live_stream');
  assert.equal(u.searchParams.get('channel'), 'UC_vt34wimdCzdkrzVejwX9g');
  assert.equal(u.searchParams.get('autoplay'), '1');
  assert.throws(() => youtubeEmbedUrl('not-a-channel'));
});

import { resolveYoutubeLiveVideo } from './live-youtube.mjs';

test('a channel that is opened in the YouTube app only needs to be live: blocked embedding does not hide it', async () => {
  assert.equal((await probeYoutubeLive({ youtube: 'UC1234567890123456789012', via: 'app' }, { fetchImpl: ok(page(NO_EMBED)) })).status, 'ok');
  assert.equal((await probeYoutubeLive({ youtube: 'UC1234567890123456789012', via: 'app' }, { fetchImpl: ok(page(OFFLINE)) })).status, 'offline', 'but it still has to be live');
  assert.equal((await probeYoutubeLive({ youtube: 'UC1234567890123456789012', via: 'embed' }, { fetchImpl: ok(page(NO_EMBED)) })).status, 'no-embed');
});

test('resolveYoutubeLiveVideo returns the id of the stream that is live now, or null', async () => {
  assert.deepEqual(await resolveYoutubeLiveVideo('UC_vt34wimdCzdkrzVejwX9g', { fetchImpl: ok(page(NO_EMBED)) }), { videoId: 'abcdefghijk' });
  assert.equal(await resolveYoutubeLiveVideo('UC_vt34wimdCzdkrzVejwX9g', { fetchImpl: ok(page(OFFLINE)) }), null);
  assert.equal(await resolveYoutubeLiveVideo('UC_vt34wimdCzdkrzVejwX9g', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), null);
  await assert.rejects(() => resolveYoutubeLiveVideo('not-a-channel', { fetchImpl: ok(page(LIVE)) }), /channel id/);
});
