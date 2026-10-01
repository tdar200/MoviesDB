import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

// TV_E2E=1 node --test tv-live-e2e.test.js   (helper serving tv.html on TV_TEST_URL)
test('Live tab: rows, details, stream picker, hls.js playback, Back, focus survives a refresh', { skip: !process.env.TV_E2E }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-live-'));
  const src = join(dir, 'src.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-y', src]);
  await exec('ffmpeg', ['-v', 'error', '-i', src, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', join(dir, 'index.m3u8')]);
  const playlist = (await readFile(join(dir, 'index.m3u8'), 'utf8')).split('\n').map(l => (l && !l.startsWith('#')) ? `/live/seg?u=${encodeURIComponent(l)}&s=sig&ref=&org=&key=k` : l).join('\n');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const now = Date.now();
    const kick = new Date(now + 90 * 60_000).toISOString();
    const matches = [
      { id: 'espn:1', title: 'Arsenal vs Chelsea', league: 'Premier League', kickoff: new Date(now - 40 * 60_000).toISOString(), state: 'in', clock: "40'", home: { name: 'Arsenal', logo: null, score: 1 }, away: { name: 'Chelsea', logo: null, score: 0 }, broadcasters: ['Sky Sports'], sources: [{ adapter: 'nuvio', sourceId: 's1' }], hasStream: true, priority: 1, poster: null },
      { id: 'espn:2', title: 'Inter vs Napoli', league: 'Serie A', kickoff: kick, state: 'pre', clock: null, home: { name: 'Inter', logo: null, score: null }, away: { name: 'Napoli', logo: null, score: null }, broadcasters: [], sources: [], hasStream: false, priority: 6, poster: null },
    ];
    await page.route('**/live/matches**', r => r.fulfill({ json: { matches, status: { fixtures: 'ok', sources: { nuvio: 'ok' } }, generatedAt: new Date(now).toISOString() } }));
    await page.route('**/live/channels**', r => r.fulfill({ json: { channels: [{ id: 'c1', name: 'Test Channel', logo: null, play: '/live/hls?u=ch&s=sig&ref=&org=' }], stale: false, fetchedAt: new Date(now).toISOString() } }));
    await page.route('**/live/streams**', r => r.fulfill({ json: { streams: [{ label: 'Stream One', language: 'English', quality: 'HD', rank: 9, health: 'ok', play: '/live/hls?u=one&s=sig&ref=&org=' }, { label: 'Stream Two', language: 'English', quality: 'SD', rank: 5, health: 'ok', play: '/live/hls?u=two&s=sig&ref=&org=' }] } }));
    await page.route('**/live/hls**', r => r.fulfill({ contentType: 'application/vnd.apple.mpegurl', headers: { 'access-control-allow-origin': '*' }, body: playlist }));
    await page.route('**/live/seg**', async r => {
      const name = decodeURIComponent(new URL(r.request().url()).searchParams.get('u'));
      r.fulfill({ contentType: 'video/mp2t', headers: { 'access-control-allow-origin': '*' }, body: await readFile(join(dir, name)) });
    });
    // TMDB is empty until the Live checks are done: the empty first trending load must
    // not clobber the Live home. Later requests return one title for the All-tab check.
    let tmdbFull = false;
    const tmdbTitle = { id: 550, title: 'Fight Club', media_type: 'movie', vote_average: 8.4, vote_count: 30000, release_date: '1999-10-15', poster_path: null, genre_ids: [18], popularity: 50 };
    await page.route('https://api.themoviedb.org/**', r => r.fulfill({ json: tmdbFull ? { results: [tmdbTitle], page: 1, total_pages: 1, total_results: 1 } : { results: [], page: 1, total_pages: 1, total_results: 0 } }));
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?helperkey=k&helper=${encodeURIComponent(process.env.TV_TEST_URL || 'http://127.0.0.1:8123')}`);
    await page.waitForSelector('.tv-kind-tab[data-kind="live"]');
    // Keyboard only: the kind nav is focused first; ArrowRight x3 lands on Live.
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator(':focus').getAttribute('data-kind'), 'live');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-tv-row="Football · Live now"] .tv-card-live');
    await page.waitForSelector('[data-tv-row="Sports channels"] .tv-card');
    assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#main .tv-row')).map(s => s.dataset.tvRow)), ['Football · Live now', 'Football · Today', 'Sports channels']);
    assert.equal(await page.locator('[data-tv-row="Football · Today"] .tv-card-nostream').count(), 1);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'espn:1');
    // Review Focus 5: a refresh while a card is focused keeps that card focused.
    await page.evaluate(() => window.__renderLiveHome());
    await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.movieId === 'espn:1');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details-live:not([hidden])');
    await page.waitForSelector('#tv-live-play');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'tv-live-play');
    assert.equal(await page.locator('.tv-live-stream').count(), 2);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#player-modal', { state: 'visible' });
    assert.equal(await page.locator('#player-modal').getAttribute('data-live'), '1');
    await page.waitForFunction(() => document.getElementById('player-video').currentTime > 1.5, null, { timeout: 30000 });
    assert.equal(await page.locator('#tv-progress').isVisible(), false);
    assert.equal(await page.locator('.tv-player-time').textContent(), 'LIVE');
    assert.equal(await page.locator('#player-title').textContent(), 'Arsenal vs Chelsea');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#player-modal', { state: 'hidden' });
    assert.equal(await page.evaluate(() => document.getElementById('player-modal').dataset.live), undefined);
    // Back from the player returns to the card (details was closed on Play).
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'espn:1');
    // Channel card plays directly, no details.
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'ch:c1');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#player-modal', { state: 'visible' });
    assert.equal(await page.locator('.tv-details-live').getAttribute('hidden'), '');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#player-modal', { state: 'hidden' });
    // Back from the home goes to the Live tab anchor.
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(':focus').getAttribute('data-kind'), 'live');
    // Leaving Live renders the TMDB home again, even though the first trending load
    // finished (empty) while Live was showing.
    tmdbFull = true;
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator(':focus').getAttribute('data-kind'), 'all');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#main .tv-card[data-movie-id="550"]');
    assert.equal(await page.locator('#main .tv-card-live').count(), 0);
    assert.equal(await page.locator('#main .no-results').count(), 0);
    assert.equal(await page.locator('#main').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Every segment 404s, so the player gives up with the Retry message; Retry (and the
// settings button next to Play) must be reachable with the remote's arrow keys.
test('Live: after every stream fails, Retry is reachable with the arrows and restarts playback', { skip: !process.env.TV_E2E }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const now = Date.now();
    const matches = [
      { id: 'espn:1', title: 'Arsenal vs Chelsea', league: 'Premier League', kickoff: new Date(now - 40 * 60_000).toISOString(), state: 'in', clock: "40'", home: { name: 'Arsenal', logo: null, score: 1 }, away: { name: 'Chelsea', logo: null, score: 0 }, broadcasters: ['Sky Sports'], sources: [{ adapter: 'nuvio', sourceId: 's1' }], hasStream: true, priority: 1, poster: null },
    ];
    const playlist = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0',
      ...[0, 1, 2, 3].flatMap(i => ['#EXTINF:2.0,', `/live/seg?u=seg${i}.ts&s=sig&ref=&org=&key=k`]), '#EXT-X-ENDLIST', ''].join('\n');
    let hlsRequests = 0;
    await page.route('**/live/matches**', r => r.fulfill({ json: { matches, status: { fixtures: 'ok', sources: { nuvio: 'ok' } }, generatedAt: new Date(now).toISOString() } }));
    await page.route('**/live/channels**', r => r.fulfill({ json: { channels: [], stale: false, fetchedAt: new Date(now).toISOString() } }));
    await page.route('**/live/streams**', r => r.fulfill({ json: { streams: [{ label: 'Stream One', language: 'English', quality: 'HD', rank: 9, health: 'ok', play: '/live/hls?u=one&s=sig&ref=&org=' }] } }));
    await page.route('**/live/hls**', r => { hlsRequests++; r.fulfill({ contentType: 'application/vnd.apple.mpegurl', headers: { 'access-control-allow-origin': '*' }, body: playlist }); });
    await page.route('**/live/seg**', r => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }));
    await page.route('https://api.themoviedb.org/**', r => r.fulfill({ json: { results: [], page: 1, total_pages: 1, total_results: 0 } }));
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?helperkey=k&helper=${encodeURIComponent(process.env.TV_TEST_URL || 'http://127.0.0.1:8123')}`);
    await page.waitForSelector('.tv-kind-tab[data-kind="live"]');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator(':focus').getAttribute('data-kind'), 'live');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-tv-row="Football · Live now"] .tv-card-live');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'espn:1');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#tv-live-play');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'tv-live-play');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#player-modal', { state: 'visible' });
    await page.waitForFunction(() => /No working stream yet\. Press Retry, or pick a channel\./.test(document.getElementById('yts-status').textContent), null, { timeout: 60000 });
    await page.waitForSelector('#tv-retry', { state: 'visible' });
    const before = hlsRequests;
    assert.ok(before >= 1);
    // Keyboard only. The failure may have revealed the HUD already (focus on Play); if
    // it auto-hid meanwhile, the first ArrowRight reveals it and focuses Play. Either
    // way Play -> Playback options -> Retry is within 4 presses (seek buttons hidden).
    let reached = false;
    for (let i = 0; i < 4 && !reached; i++) {
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.getElementById('player-modal').classList.contains('tv-hud-hidden')), false, 'HUD revealed');
      reached = await page.evaluate(() => document.activeElement && document.activeElement.id === 'tv-retry');
    }
    assert.ok(reached, `#tv-retry not reachable within 4 ArrowRight presses (focus: ${await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName))})`);
    await page.keyboard.press('Enter');
    const deadline = Date.now() + 10000;
    while (hlsRequests <= before && Date.now() < deadline) await page.waitForTimeout(100);
    assert.ok(hlsRequests > before, 'Retry made a new /live/hls request');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

// The app reopens on the tab you were last on. Regression: with Live / Cricket / Channels saved, the first Live
// render ran before `tabRecommended` was initialised (esbuild turns bundled top-level const into var, so it read
// undefined) and the app launched to a BLANK screen with "Cannot read property 'classList' of undefined".
for (const kind of ['live', 'cricket', 'channels']) {
  test(`relaunch on a saved ${kind} tab opens that tab with content and no errors`, { skip: !process.env.TV_E2E }, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const now = Date.now();
      const matches = [
        { id: 'espn:1', title: 'Arsenal vs Chelsea', league: 'Premier League', kickoff: new Date(now - 40 * 60_000).toISOString(), state: 'in', clock: "40'", home: { name: 'Arsenal', logo: null, score: 1 }, away: { name: 'Chelsea', logo: null, score: 0 }, broadcasters: [], sources: [{ adapter: 'nuvio', sourceId: 's1' }], hasStream: true, priority: 1, poster: null },
        { id: 'espn:2', title: 'Western Fury vs Tasmanian Roar', league: 'National League Cricket', sport: 'cricket', kickoff: new Date(now - 30 * 60_000).toISOString(), state: 'in', clock: null, home: { name: 'Western Fury', logo: null, score: null }, away: { name: 'Tasmanian Roar', logo: null, score: null }, broadcasters: [], sources: [{ adapter: 'nuvio', sourceId: 's2' }], hasStream: true, priority: 2, poster: null },
      ];
      await page.addInitScript(k => localStorage.setItem('tvMediaKind', k), kind);
      await page.route('**/live/matches**', r => r.fulfill({ json: { matches, status: { fixtures: 'ok', sources: { nuvio: 'ok' } }, generatedAt: new Date(now).toISOString() } }));
      await page.route('**/live/channels**', r => r.fulfill({ json: { channels: [{ id: 'c1', name: 'Test Channel', logo: null, play: '/live/hls?u=ch&s=sig&ref=&org=' }], stale: false, fetchedAt: new Date(now).toISOString() } }));
      await page.route('**/live/catalog**', r => r.fulfill({ json: { categories: [{ name: 'News', channels: [{ id: 'n1', name: 'News One', logo: null, play: '/live/hls?u=n&s=sig&ref=&org=' }] }] } }));
      await page.route('https://api.themoviedb.org/**', r => r.fulfill({ json: { results: [], page: 1, total_pages: 1, total_results: 0 } }));
      await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
      await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?helperkey=k&helper=${encodeURIComponent(process.env.TV_TEST_URL || 'http://127.0.0.1:8123')}`);
      await page.waitForFunction(() => document.querySelectorAll('#main .tv-card').length > 0, null, { timeout: 15000 });
      assert.equal(await page.locator('.tv-kind-tab.active').getAttribute('data-kind'), kind);
      const rows = await page.evaluate(() => [...document.querySelectorAll('#main .tv-row')].map(r => r.dataset.tvRow));
      assert.ok(rows.length > 0, `rows are shown (${rows.join(', ')})`);
      if (kind === 'live') assert.ok(rows.some(r => /Live now/.test(r)), rows.join(', '));
      if (kind === 'channels') assert.deepEqual(rows, ['News']);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

// A channel that is only an official YouTube live stream (HUM, Geo, ARY ...) has no HLS to relay: the catalog gives it an
// embed url and OK opens it in the embed player; Back closes it and returns to the tile.
test('Channels: a YouTube live channel opens in the embed player; Back closes it and restores focus', { skip: !process.env.TV_E2E }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const embed = 'https://www.youtube.com/embed/live_stream?channel=UC_vt34wimdCzdkrzVejwX9g&autoplay=1&rel=0';
    await page.route('**/live/catalog**', r => r.fulfill({ json: { categories: [{ name: 'Pakistan', channels: [
      { id: 'youtube:UC_vt34wimdCzdkrzVejwX9g', name: 'Geo News', logo: null, height: 0, category: 'News', embed },
      { id: 'hls1', name: 'Dunya News UK', logo: null, height: 720, category: 'News', play: '/live/ch?id=hls1' },
    ] }] } }));
    await page.route('https://api.themoviedb.org/**', r => r.fulfill({ json: { results: [], page: 1, total_pages: 1, total_results: 0 } }));
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: '<html><body>stub</body></html>' }));
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?helperkey=k&helper=${encodeURIComponent(process.env.TV_TEST_URL || 'http://127.0.0.1:8123')}`);
    await page.waitForSelector('.tv-kind-tab[data-kind="channels"]');
    await page.locator('.tv-kind-tab[data-kind="channels"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-tv-row="Pakistan"] .tv-card');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'ch:youtube:UC_vt34wimdCzdkrzVejwX9g');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#player-modal', { state: 'visible' });
    const src = new URL(await page.locator('#player-iframe').getAttribute('src'));
    assert.equal(src.origin + src.pathname, 'https://www.youtube.com/embed/live_stream', 'the iframe shows the channel live stream');
    assert.equal(src.searchParams.get('channel'), 'UC_vt34wimdCzdkrzVejwX9g');
    assert.equal(src.searchParams.get('enablejsapi'), '1', 'the player reports errors back to us');
    assert.equal(await page.locator('#player-video').isVisible(), false, 'no native video for an embed');
    assert.equal(await page.locator('#player-title').textContent(), 'Geo News');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#player-modal', { state: 'hidden' });
    assert.ok(!(await page.locator('#player-iframe').getAttribute('src')), 'the embed is torn down, so the stream stops');
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'ch:youtube:UC_vt34wimdCzdkrzVejwX9g', 'Back returns to the tile');
    // The HLS channel next to it still takes the native player.
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'ch:hls1');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

// Broadcasters that disallow embedding (Geo News, ARY, HUM ...) open in the TV's own YouTube app, on the stream that is
// live now. webOS exposes the launcher as PalmServiceBridge; a desktop browser falls back to window.open.
for (const resolves of [true, false]) {
  test(`Channels: a YouTube-app channel launches the TV's YouTube app (live video lookup ${resolves ? 'works' : 'fails -> channel live page'})`, { skip: !process.env.TV_E2E }, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        window.__luna = [];
        window.PalmServiceBridge = function () { this.call = (uri, params) => { window.__luna.push({ uri, params: JSON.parse(params) }); }; };
      });
      await page.route('**/live/catalog**', r => r.fulfill({ json: { categories: [{ name: 'Pakistan', channels: [
        { id: 'youtube:UC_vt34wimdCzdkrzVejwX9g', name: 'Geo News', logo: null, height: 0, category: 'News', youtubeApp: 'UC_vt34wimdCzdkrzVejwX9g' },
      ] }] } }));
      await page.route('**/live/yt**', r => resolves ? r.fulfill({ json: { videoId: 'abcdefghijk' } }) : r.fulfill({ status: 404, json: { error: 'not live' } }));
      await page.route('https://api.themoviedb.org/**', r => r.fulfill({ json: { results: [], page: 1, total_pages: 1, total_results: 0 } }));
      await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
      await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?helperkey=k&helper=${encodeURIComponent(process.env.TV_TEST_URL || 'http://127.0.0.1:8123')}`);
      await page.waitForSelector('.tv-kind-tab[data-kind="channels"]');
      await page.locator('.tv-kind-tab[data-kind="channels"]').focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-tv-row="Pakistan"] .tv-card');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__luna.length > 0, null, { timeout: 15000 });
      const calls = await page.evaluate(() => window.__luna);
      assert.equal(calls.length, 1, 'one launch, not one per key press');
      assert.equal(calls[0].uri, 'luna://com.webos.applicationManager/launch');
      assert.equal(calls[0].params.id, 'youtube.leanback.v4');
      assert.equal(calls[0].params.params.contentTarget, resolves ? 'https://www.youtube.com/watch?v=abcdefghijk' : 'https://www.youtube.com/channel/UC_vt34wimdCzdkrzVejwX9g/live');
      assert.equal(await page.locator('#player-modal').isVisible(), false, 'our own player does not open');
      assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), 'ch:youtube:UC_vt34wimdCzdkrzVejwX9g', 'focus stays on the tile');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

// Whether a live stream may be embedded is decided per video, and a restarted stream is a new video (Neo News played and an
// hour later answered YouTube error 150). So an embed that is refused hands over to the YouTube app by itself.
test('Channels: an embed that YouTube refuses (error 150) closes and opens the YouTube app instead', { skip: !process.env.TV_E2E }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.__luna = [];
      window.PalmServiceBridge = function () { this.call = (uri, params) => { window.__luna.push({ uri, params: JSON.parse(params) }); }; };
      // The embed must be tried FIRST (it is the better experience); remember that it was opened.
      window.__embedOpened = false;
      new MutationObserver(() => { const f = document.getElementById('player-iframe'); if (f && /live_stream/.test(f.getAttribute('src') || '')) window.__embedOpened = true; })
        .observe(document, { subtree: true, attributes: true, attributeFilter: ['src'], childList: true });
    });
    const embed = 'https://www.youtube.com/embed/live_stream?channel=UC_vt34wimdCzdkrzVejwX9g&autoplay=1&rel=0';
    await page.route('**/live/catalog**', r => r.fulfill({ json: { categories: [{ name: 'Pakistan', channels: [
      { id: 'youtube:UC_vt34wimdCzdkrzVejwX9g', name: 'Neo News', logo: null, height: 0, category: 'News', embed, youtubeApp: 'UC_vt34wimdCzdkrzVejwX9g' },
    ] }] } }));
    await page.route('**/live/yt**', r => r.fulfill({ json: { videoId: 'abcdefghijk' } }));
    await page.route('https://api.themoviedb.org/**', r => r.fulfill({ json: { results: [], page: 1, total_pages: 1, total_results: 0 } }));
    // The embed answers the player-api handshake the way YouTube does for a video whose owner blocks embedding.
    await page.route('https://www.youtube.com/embed/**', r => r.fulfill({ contentType: 'text/html', body: `<html><body><script>
      window.addEventListener('message', function (e) { if (String(e.data).indexOf('"listening"') > -1) parent.postMessage(JSON.stringify({ event: 'onError', info: 150 }), '*'); });
    </script></body></html>` }));
    await page.route(/https:\/\/(?!api\.themoviedb\.org|www\.youtube\.com\/embed)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?helperkey=k&helper=${encodeURIComponent(process.env.TV_TEST_URL || 'http://127.0.0.1:8123')}`);
    await page.waitForSelector('.tv-kind-tab[data-kind="channels"]');
    await page.locator('.tv-kind-tab[data-kind="channels"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-tv-row="Pakistan"] .tv-card');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__luna.length > 0, null, { timeout: 15000 });
    const calls = await page.evaluate(() => window.__luna);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.id, 'youtube.leanback.v4');
    assert.equal(calls[0].params.params.contentTarget, 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(await page.evaluate(() => window.__embedOpened), true, 'the embed was tried first');
    await page.waitForSelector('#player-modal', { state: 'hidden' });
    assert.ok(!(await page.locator('#player-iframe').getAttribute('src')), 'the refused embed is torn down');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
