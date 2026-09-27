import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, filterFootballChannels, probeHls, mapLimit, channelId, createChannelFeed, SPORTS_M3U_URL, UK_M3U_URL, CHANNEL_IDS, isDeniedHost } from './live-channels.mjs';

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="beINSPORTSXTRA.us@SD" tvg-logo="https://i.ibb.co/HT49GPmB/XTRA-2.png" group-title="Sports",beIN SPORTS XTRA (1080p)',
  'https://bein-xtra-bein.amagi.tv/playlist.m3u8',
  '#EXTINF:-1 tvg-id="SetantaSports1.ge" tvg-logo="" group-title="Sports",Setanta Sports 1 HD (1080p) [Geo-blocked]',
  'https://fs.uplink.kz/setanta_sports_1_hd/mono.m3u8?token=onlinetv',
  '#EXTINF:-1 tvg-id="" tvg-logo="https://x/y.png" group-title="Sports",Digi Sport 2 (720p) [Not 24/7]',
  'http://89.1.2.3:8080/digi2/index.m3u8',
  '#EXTINF:-1 tvg-id="Golf.us" tvg-logo="" group-title="Sports",Golf Channel',
  'https://golf.example/index.m3u8',
  '',
].join('\r\n');

test('parseM3u handles CRLF, attributes and name tags', () => {
  const list = parseM3u(M3U);
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], { name: 'beIN SPORTS XTRA (1080p)', url: 'https://bein-xtra-bein.amagi.tv/playlist.m3u8', tvgId: 'beINSPORTSXTRA.us@SD', logo: 'https://i.ibb.co/HT49GPmB/XTRA-2.png', group: 'Sports', geoBlocked: false, not247: false });
  assert.equal(list[1].geoBlocked, true);
  assert.equal(list[1].name, 'Setanta Sports 1 HD (1080p)');
  assert.equal(list[2].not247, true);
  assert.equal(list[2].url, 'http://89.1.2.3:8080/digi2/index.m3u8');
  assert.ok(!list.some(c => c.url.endsWith('\r')), 'no carriage returns leak into URLs');
  assert.deepEqual(parseM3u(''), []);
});

test('filterFootballChannels keeps only listed official channel ids, never geo-blocked or restream hosts', () => {
  const names = filterFootballChannels(parseM3u(M3U)).map(c => c.name);
  assert.deepEqual(names, ['beIN SPORTS XTRA (1080p)'], 'Digi Sport 2 has no listed id and a bare-IP host');
  const listed = parseM3u([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="Teledeporte.es@SD",Teledeporte (1080p)', 'https://rtve01p.origin.c21livecloud.com/tdp/main.m3u8',
    '#EXTINF:-1 tvg-id="Sportitalia.it@SD",Sportitalia (1080p)', 'http://1.2.3.4:8080/sportitalia.m3u8',
    '#EXTINF:-1 tvg-id="SkySportsMainEvent.uk@HD",Sky Sports Main Event', 'https://stream.mcquack.net/sky/index.m3u8',
  ].join('\n'));
  assert.deepEqual(filterFootballChannels(listed).map(c => c.tvgId), ['Teledeporte.es@SD']);
  assert.ok(CHANNEL_IDS.has('FIFAPlus.uk@English'));
  assert.ok(!CHANNEL_IDS.has('DigiSport2.ro@SD'));
});

test('isDeniedHost refuses bare IPs and known restream hosts', () => {
  for (const u of ['http://89.1.2.3:8080/x.m3u8', 'https://stream.mcquack.net/a.m3u8', 'https://forever.megogo.xyz/a', 'https://abc.workers.dev/a', 'https://leaf.highfly.dev/a', 'https://fs.uplink.kz/a', 'not a url']) assert.equal(isDeniedHost(u), true, u);
  for (const u of ['https://bein-xtra-bein.amagi.tv/playlist.m3u8', 'https://d3k8wzt41aflvx.cloudfront.net/INTERTV/Live.m3u8', 'https://tvr-sport.lg.mncdn.com/x.m3u8']) assert.equal(isDeniedHost(u), false, u);
});

test('createChannelFeed ranks alive channels by probed height, sharpest first', async () => {
  const m3u = ['#EXTM3U',
    '#EXTINF:-1 tvg-id="RealMadridTV.es@SD",Real Madrid TV', 'https://rmtv.akamaized.net/a.m3u8',
    '#EXTINF:-1 tvg-id="TVRSport.ro@SD",TVR Sport', 'https://tvr-sport.lg.mncdn.com/b.m3u8',
    '#EXTINF:-1 tvg-id="InterTV.it@SD",Inter TV', 'https://d3k8wzt41aflvx.cloudfront.net/c.m3u8',
    '#EXTINF:-1 tvg-id="talkSPORT.uk@SD",talkSPORT', 'https://talk.wurl.com/d.m3u8',
  ].join('\r\n');
  const heights = { 'https://rmtv.akamaized.net/a.m3u8': 720, 'https://tvr-sport.lg.mncdn.com/b.m3u8': 1440, 'https://d3k8wzt41aflvx.cloudfront.net/c.m3u8': 1080 };
  const probe = async url => (url in heights ? { status: 'ok', height: heights[url] } : { status: 'timeout' });
  const feed = createChannelFeed({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => m3u }), probe });
  const { channels } = await feed.fetchChannels();
  assert.deepEqual(channels.map(c => [c.name, c.height]), [['TVR Sport', 1440], ['Inter TV', 1080], ['Real Madrid TV', 720]]);
});

test('channelId prefers tvg-id and otherwise hashes the url stably', () => {
  assert.equal(channelId({ tvgId: 'Golf.us', url: 'x' }), 'Golf.us');
  const a = channelId({ tvgId: '', url: 'http://89.1.2.3:8080/digi2/index.m3u8' });
  assert.match(a, /^u[0-9a-f]{12}$/);
  assert.equal(a, channelId({ tvgId: '', url: 'http://89.1.2.3:8080/digi2/index.m3u8' }));
});

test('probeHls accepts an HLS content-type or an #EXTM3U body, rejects everything else, and times out', async () => {
  const ok1 = await probeHls('https://a', async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/vnd.apple.mpegurl' }), text: async () => '' }));
  const ok2 = await probeHls('https://b', async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/plain' }), text: async () => '#EXTM3U\n#EXT-X-VERSION:3' }));
  const no1 = await probeHls('https://c', async () => ({ ok: false, status: 403, headers: new Headers(), text: async () => '' }));
  const no2 = await probeHls('https://d', async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<html>' }));
  const no3 = await probeHls('https://e', async () => { throw new TypeError('fetch failed'); });
  const slow = await probeHls('https://f', (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), 20);
  assert.deepEqual([ok1, ok2, no1, no2, no3, slow], [true, true, false, false, false, false]);
});

test('mapLimit runs at most `limit` calls at once and preserves order', async () => {
  let active = 0, peak = 0;
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async n => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, n)); active--; return n * 10; });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
});

test('createChannelFeed downloads, filters, probes, caches for the TTL and serves stale on failure', async () => {
  let clock = 0; let downloads = 0; let fail = false;
  const probed = [];
  const fetchImpl = async url => {
    assert.ok(url === SPORTS_M3U_URL || url === UK_M3U_URL, url);
    if (url === UK_M3U_URL) return { ok: true, status: 200, text: async () => '#EXTM3U' };
    downloads++;
    if (fail) throw new TypeError('fetch failed');
    return { ok: true, status: 200, text: async () => M3U };
  };
  const probe = async url => { probed.push(url); return !url.startsWith('http://89.'); };
  const feed = createChannelFeed({ fetchImpl, probe, now: () => clock });
  const a = await feed.fetchChannels();
  assert.deepEqual(a.channels.map(c => c.name), ['beIN SPORTS XTRA (1080p)']);
  assert.equal(a.channels[0].id, 'beINSPORTSXTRA.us@SD');
  assert.equal(a.channels[0].logo, 'https://i.ibb.co/HT49GPmB/XTRA-2.png');
  assert.equal(a.stale, false);
  assert.equal(a.fetchedAt, new Date(0).toISOString());
  assert.deepEqual(probed.sort(), ['https://bein-xtra-bein.amagi.tv/playlist.m3u8'], 'unlisted and bare-IP channels are never probed');
  clock = 600_000;
  await feed.fetchChannels();
  assert.equal(downloads, 1, 'cached inside the 15 minute TTL');
  clock = 1_000_000; fail = true;
  const b = await feed.fetchChannels();
  assert.equal(downloads, 2);
  assert.equal(b.stale, true);
  assert.deepEqual(b.channels.map(c => c.name), ['beIN SPORTS XTRA (1080p)']);
  const empty = createChannelFeed({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, probe, now: () => 0 });
  const c = await empty.fetchChannels();
  assert.deepEqual(c, { channels: [], stale: true, fetchedAt: null });
});

test('createChannelFeed treats private, loopback and multicast channel URLs as dead without probing them', async () => {
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="beINSPORTSXTRA.us@SD",beIN Sports 1', 'https://bein.example/a.m3u8',
    '#EXTINF:-1 tvg-id="InterTV.it@SD",beIN Sports 2', 'http://192.168.0.1/b.m3u8',
    '#EXTINF:-1 tvg-id="talkSPORT.uk@SD",beIN Sports 3', 'http://127.0.0.1:8123/c.m3u8',
    '#EXTINF:-1 tvg-id="MUTV.uk@SD",beIN Sports 4', 'http://239.255.255.250/d.m3u8',
    '#EXTINF:-1 tvg-id="TVRSport.ro@SD",beIN Sports 5', 'rtmp://bein.example/e',
  ].join('\n');
  const probed = [];
  const probe = async url => { probed.push(url); return true; };
  const feed = createChannelFeed({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => m3u }), probe, now: () => 0 });
  const { channels } = await feed.fetchChannels();
  assert.deepEqual(probed, ['https://bein.example/a.m3u8']);
  assert.deepEqual(channels.map(c => c.id), ['beINSPORTSXTRA.us@SD']);
});
