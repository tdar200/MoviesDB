import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Use the running helper: TV_E2E=1 TV_TEST_URL=http://localhost:8123 node --test tv-e2e.test.js
// Catalogue and embed responses are fixtures; live provider playback is checked on-device.
test('TV remote: rails, player, Back, search, and option selection', { skip: !process.env.TV_E2E }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const movies = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `Test Film ${i + 1}`, media_type: i % 3 ? 'movie' : 'tv', name: `Test Series ${i + 1}`, vote_average: 8, vote_count: 1000, popularity: 100, genre_ids: [18, 28], release_date: '2025-01-01', first_air_date: '2025-01-01', overview: 'A cinematic adventure for remote navigation testing.', poster_path: null, backdrop_path: null }));
    await page.route('https://api.themoviedb.org/**', async route => {
      const url = route.request().url();
      let body = { results: movies, page: 1, total_pages: 1, total_results: 20 };
      if (/\/videos|\/watch\/providers|\/credits|\/keywords/.test(url)) body = { results: [], cast: [], crew: [] };
      if (/\/tv\/\d+\?/.test(url)) body = { seasons: [{ season_number: 1, episode_count: 2 }], number_of_seasons: 1 };
      if (/\/season\/1/.test(url)) body = { episodes: [{ episode_number: 1, name: 'Pilot' }, { episode_number: 2, name: 'Next' }] };
      await route.fulfill({ json: body });
    });
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, route => route.fulfill({ contentType: 'text/html', body: '<html><body>Playback fixture</body></html>' }));
    // Pin 111Movies to exercise the embed path; the default TV source is now the
    // native torrent (verified separately) after the providers began bot-gating.
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?source=111Movies`);
    await page.waitForSelector('.tv-card');
    const focused = () => page.evaluate(() => document.activeElement.className);
    const focusedIs = cls => page.evaluate(c => document.activeElement.classList.contains(c), cls);
    // The home focus anchor is the active media-kind tab (All / Movies / TV / Live / Channels).
    const onHomeAnchor = () => page.evaluate(() => document.activeElement === document.querySelector('.tv-kind-tab.active'));
    assert.equal(await onHomeAnchor(), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'tv-play');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focusedIs('tv-card'), true);
    const first = await page.locator(':focus').getAttribute('data-movie-id');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    assert.notEqual(await page.locator(':focus').getAttribute('data-movie-id'), first);
    // The anchored rail glides its track (transform); the rail itself does not scroll.
    assert.ok(await page.locator('.tv-rail-track').first().evaluate(node => parseFloat(node.dataset.tx || '0') < 0));
    const selected = await page.locator(':focus').getAttribute('data-movie-id');
    // A card opens the details screen first; its focused Play button starts the player.
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    assert.equal(await focused(), 'tv-details-play');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#player-modal', { state: 'visible' });
    // Torrent sources are listed first on TV; 111Movies is the pinned selection here.
    assert.match(await page.locator('#source-select option').first().textContent(), /Torrent/);
    assert.equal(await page.locator('#source-select option:checked').textContent(), '111Movies');
    assert.ok(await page.locator('#player-iframe').evaluate(el => el.getBoundingClientRect().height > 850));
    assert.equal(await page.locator(':focus').getAttribute('id'), 'close-modal');
    const playerUrl = page.url();
    await page.locator('#tv-clear-search').evaluate(button => button.click());
    await page.waitForTimeout(250);
    assert.equal(page.url(), playerUrl);
    assert.equal(await page.locator('#player-modal').isVisible(), true);
    await page.keyboard.press('ArrowDown');
    assert.ok(await page.locator(':focus').evaluate(node => !!node.closest('#player-modal')));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#player-modal', { state: 'hidden' });
    // Back from the player lands on that title's details; Back again returns to its card.
    await page.waitForSelector('.tv-details:not([hidden])');
    assert.equal(await focused(), 'tv-details-play');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tv-details', { state: 'hidden' });
    await page.waitForFunction(id => document.activeElement && document.activeElement.dataset.movieId === id, selected); // restore is deferred one tick
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), selected);
    await page.keyboard.press('Escape');
    assert.equal(await onHomeAnchor(), true);
    // All -> Movies -> TV -> Live -> Cricket -> Channels -> IMDb Top 250 -> Search & filters.
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'tv-browse-controls');
    await page.keyboard.press('Enter');
    // Opening the panel focuses its first filter, not the search box (which would pop
    // the on-screen keyboard over the filters on webOS).
    assert.equal(await page.locator('#tv-browse-controls').getAttribute('aria-expanded'), 'true');
    assert.equal(await focusedIs('filter-select'), true);
    await page.locator('#search').focus();
    await page.keyboard.type('Adventure');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-card');
    await page.keyboard.press('ArrowUp');
    // The filters are reachable spatially, and each select has a D-pad option list.
    // (Media type moved to the top nav; sort is a remaining panel filter.)
    const sortBefore = await page.locator('#sort-by').inputValue();
    const sortNext = await page.locator('#sort-by').evaluate(s => s.options[s.selectedIndex + 1].value);
    await page.locator('#sort-by').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-picker');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.notEqual(sortNext, sortBefore);
    assert.equal(await page.locator('#sort-by').inputValue(), sortNext);
    assert.equal(await page.locator('.tv-picker').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#tv-browse-controls').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.tv-search-notice').isVisible(), true);
    assert.match(await page.locator('.tv-search-notice').textContent(), /Adventure/);
    await page.locator('#tv-clear-search').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(url => !url.searchParams.has('q'));
    await page.waitForSelector('.tv-card');
    assert.equal(await page.locator('.tv-search-notice').isVisible(), false);
    assert.equal(await page.locator('#search').inputValue(), '');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('TV shell recovers from an unreachable server and retries launch', { skip: !process.env.TV_E2E }, async () => {
  const { readFile } = await import('node:fs/promises');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let online = false;
    await page.route('**/webos-app/icon.png?*', route => online
      ? route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=', 'base64') })
      : route.abort());
    await page.route('**/tv.html?*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Movies ready</h1>' }));
    await page.setContent(await readFile(new URL('./webos-app/index.html', import.meta.url), 'utf8'));
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Cannot reach'));
    assert.equal(await page.locator(':focus').getAttribute('id'), 'retry');
    online = true;
    await page.keyboard.press('Enter');
    await page.waitForURL('**/tv.html?*');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('TV starts movies and episodes with their matching native sources', { skip: !process.env.TV_E2E }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const lookups = [];
    const titles = [
      { id: 9001, title: 'Native Movie', media_type: 'movie', vote_average: 9, vote_count: 5000, release_date: '2024-01-01', genre_ids: [18] },
      { id: 9002, name: 'Native Series', media_type: 'tv', vote_average: 8, vote_count: 5000, first_air_date: '2024-01-01', genre_ids: [18] },
    ];
    await page.route('https://api.themoviedb.org/**', async route => {
      const url = route.request().url();
      let body = { results: titles, page: 1, total_pages: 1 };
      if (/\/external_ids/.test(url)) body = { imdb_id: 'tt1234567' };
      else if (/\/tv\/9002\?/.test(url)) body = { seasons: [{ season_number: 1, episode_count: 2 }] };
      else if (/\/season\/1/.test(url)) body = { episodes: [{ episode_number: 1, name: 'Pilot' }, { episode_number: 2, name: 'Second' }] };
      else if (/\/videos/.test(url)) body = { results: [] };
      await route.fulfill({ json: body });
    });
    await page.route('**/movie-torrents?*', route => route.fulfill({ json: { sources: [] } }));
    await page.route('**/yts?*', route => { lookups.push('movie'); return route.fulfill({ status: 404, json: { error: 'No fixture stream' } }); });
    await page.route('**/tv-torrents?*', route => { lookups.push('tv'); return route.fulfill({ json: { sources: [] } }); });
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?source=YTS%20(Torrent)`);
    await page.waitForSelector('.tv-card');
    await page.locator('.tv-card[data-movie-id="9001"]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    await page.keyboard.press('Enter'); // Play, from the details screen
    await page.waitForSelector('#player-modal', { state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#source-select option:checked').textContent.includes('YTS'));
    await page.waitForTimeout(500);
    assert.ok(lookups.includes('movie'));
    await page.keyboard.press('Escape');
    await page.locator('.tv-card[data-movie-id="9002"]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    await page.keyboard.press('Enter'); // Play, from the details screen
    await page.waitForFunction(() => document.querySelector('#source-select option:checked').textContent.includes('TV (Torrent)'));
    await page.waitForFunction(() => document.getElementById('player-title').textContent.includes('S1E1'));
    await page.waitForTimeout(1000);
    assert.ok(lookups.includes('tv'), 'episode startup must request the native TV source');
    assert.equal(await page.locator('#player-iframe').getAttribute('src'), '');
  } finally { await browser.close(); }
});

test('111Movies toolbar works with D-pad and Enter across the provider frame', {skip:!process.env.TV_E2E,timeout:30000},async()=>{
 const {readFile}=await import('node:fs/promises');
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  page.setDefaultTimeout(5000);
  const appOrigin=new URL(process.env.TV_TEST_URL||'http://127.0.0.1:8123').origin;
  const bridge=await readFile(new URL('./tv-provider-bridge.js',import.meta.url),'utf8');
  await page.addInitScript(`if(location.hostname==='player.vidlove.cc'){window.moviesCompat={parentOrigin:${JSON.stringify(appOrigin)}};${bridge}}`);
  const movie={id:9005,title:'Remote provider fixture',media_type:'movie',vote_average:9,vote_count:5000,release_date:'2024-01-01',genre_ids:[18]};
  await page.route('https://api.themoviedb.org/**',r=>r.fulfill({json:{results:[movie],total_pages:1}}));
  await page.route('https://111movies.com/**',r=>r.fulfill({contentType:'text/html',body:'<script>location.replace("https://player.vidlove.cc/embed/movie/9005")</script>'}));
  // This fixture verifies keyboard/iframe command routing, not media delivery.
  await page.route('https://player.vidlove.cc/**',r=>r.fulfill({contentType:'text/html',body:`<video muted></video><script>var v=document.querySelector('video'),paused=false;Object.defineProperty(v,'paused',{get:()=>paused});Object.defineProperty(v,'readyState',{get:()=>4});Object.defineProperty(v,'duration',{get:()=>3600});Object.defineProperty(v,'currentTime',{value:50,writable:true});v.play=()=>{paused=false;return Promise.resolve()};v.pause=()=>{paused=true};</script>`}));
  await page.goto(appOrigin+'/tv.html?source=111Movies');await page.waitForSelector('.tv-card');
  // The curated IMDb/Emmy rails come first on All, so focus the fixture card itself.
  await page.locator('.tv-card[data-movie-id="9005"]').first().focus();
  await page.locator(':focus').evaluate(card=>card.addEventListener('click',()=>card.replaceWith(card.cloneNode(true)),{once:true}));
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tv-details:not([hidden])');
  await page.keyboard.press('Enter'); // Play, from the details screen
  await page.waitForFunction(()=>document.activeElement.id==='tv-provider-play');
  const frame=page.frames().find(f=>f.url().includes('player.vidlove.cc'));
  await page.keyboard.press('Enter');
  await frame.waitForFunction(()=>document.querySelector('video').paused);
  await page.keyboard.press('Enter');
  await frame.waitForFunction(()=>!document.querySelector('video').paused);
  await page.keyboard.press('ArrowRight');assert.equal(await page.locator(':focus').getAttribute('id'),'tv-provider-forward');
  await page.keyboard.press('Enter');await frame.waitForFunction(()=>document.querySelector('video').currentTime===80);
  await page.keyboard.press('ArrowRight');assert.equal(await page.locator(':focus').getAttribute('id'),'tv-provider-sound');
  await page.keyboard.press('Enter');await frame.waitForFunction(()=>!document.querySelector('video').muted);
  await page.waitForFunction(()=>document.activeElement.id==='tv-provider-play');
  await page.keyboard.press('ArrowLeft');assert.equal(await page.locator(':focus').getAttribute('id'),'tv-provider-backward');
  await page.keyboard.press('Enter');await frame.waitForFunction(()=>document.querySelector('video').currentTime===70);
  await frame.locator('video').evaluate(v=>{v.tabIndex=0;v.focus();});
  await page.keyboard.press('Enter');await frame.waitForFunction(()=>document.querySelector('video').paused);
  await page.keyboard.press('Escape');await page.waitForSelector('#player-modal',{state:'hidden'});
  await page.waitForSelector('.tv-details:not([hidden])');await page.keyboard.press('Escape');await page.waitForSelector('.tv-details',{state:'hidden'});
  await page.waitForFunction(()=>document.activeElement&&document.activeElement.dataset.movieId==='9005'); // restore is deferred one tick
  assert.equal(await page.locator(':focus').getAttribute('data-movie-id'),'9005');
 } finally {await browser.close();}
});

test('TV home keeps complete category membership and Back from details returns to the card', { skip: !process.env.TV_E2E }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const mk = (start, n, mt) => Array.from({ length: n }, (_, i) => ({ id: start + i, title: `T${start + i}`, name: `T${start + i}`, media_type: mt, vote_average: 8, vote_count: 1000, popularity: 100, genre_ids: [18], release_date: new Date().toISOString().slice(0, 10), first_air_date: '2024-01-01', overview: 'Row fixture.', poster_path: null, backdrop_path: null }));
    await page.route('https://api.themoviedb.org/**', async route => {
      const url = route.request().url();
      let body = { results: [], page: 1, total_pages: 1 };
      if (/\/trending\/all/.test(url)) body.results = mk(1, 6, 'movie');
      else if (/\/movie\/popular/.test(url)) body.results = [...mk(3, 2, 'movie'), ...mk(100, 4, 'movie')]; // 3,4 overlap trending
      else if (/\/movie\/top_rated/.test(url)) body.results = mk(200, 5, 'movie');
      else if (/\/movie\/now_playing/.test(url)) body.results = mk(300, 5, 'movie');
      else if (/\/discover\/movie/.test(url)) body.results = mk(400, 5, 'movie');
      else if (/\/credits/.test(url)) body = { cast: [{ name: 'Jane Doe' }] };
      await route.fulfill({ json: body });
    });
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, route => route.fulfill({ contentType: 'text/html', body: 'fixture' }));
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html`);
    await page.waitForSelector('.tv-card');
    // Rows paint progressively; wait for the last fixture-backed one (every later
    // discover row repeats the same ids and is deduped away) before reading them all.
    await page.waitForFunction(() => [...document.querySelectorAll('.tv-row')].some(r => r.dataset.tvRow === 'Highest Weighted Rating' && r.dataset.rowComplete === '1'));
    // Several distinct rows, not slices of one feed.
    const headings = await page.locator('.tv-row h2').allTextContents();
    for (const h of ['Trending This Week', 'Popular Now', 'Top Rated', 'New Releases & Episodes', 'Highest Weighted Rating']) assert.ok(headings.includes(h), `missing row ${h}`);
    // A fresh profile has no taste signal, so no unpersonalised "Recommended" row
    // swallows the catalogue rows above.
    assert.ok(!headings.includes('Recommended for You'));
    // A category keeps its complete membership, including titles that also
    // belong to Trending. Duplicates are removed within each category only.
    const popularIds = await page.locator('[data-tv-row="Popular Now"]').evaluate(row =>
      [...row.querySelectorAll('.tv-card')].map(c => c.dataset.movieId).concat((row.__rest || []).map(m => String(m.id))));
    assert.deepEqual(popularIds, ['3', '4', '100', '101', '102', '103']);
    assert.equal(new Set(popularIds).size, popularIds.length);

    // Back from the details screen returns focus to the exact card.
    await page.locator('.tv-card[data-movie-id="200"]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'tv-details-play');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tv-details', { state: 'hidden' });
    await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.movieId === '200');
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), '200');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('TV details lists episodes for a series and plays the chosen one', { skip: !process.env.TV_E2E }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const show = { id: 7001, name: 'My Show', title: 'My Show', media_type: 'tv', vote_average: 8, vote_count: 5000, first_air_date: '2024-01-01', genre_ids: [18], overview: 'Series fixture.' };
    await page.route('https://api.themoviedb.org/**', async route => {
      const url = route.request().url();
      let body = { results: [show], page: 1, total_pages: 1 };
      if (/\/external_ids/.test(url)) body = { imdb_id: 'tt1234567' };
      else if (/\/tv\/7001\?/.test(url)) body = { seasons: [{ season_number: 1, episode_count: 2 }, { season_number: 2, episode_count: 2 }] };
      else if (/\/season\/1/.test(url)) body = { episodes: [{ episode_number: 1, name: 'Pilot' }, { episode_number: 2, name: 'Second' }] };
      else if (/\/season\/2/.test(url)) body = { episodes: [{ episode_number: 1, name: 'S2 Start' }] };
      else if (/\/credits/.test(url)) body = { cast: [{ name: 'Jane Doe' }] };
      else if (/\/videos/.test(url)) body = { results: [] };
      await route.fulfill({ json: body });
    });
    await page.route('**/tv-torrents?*', route => route.fulfill({ json: { sources: [] } }));
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, route => route.fulfill({ contentType: 'text/html', body: 'fixture' }));
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html`);
    await page.waitForSelector('.tv-card');
    await page.locator('.tv-card[data-movie-id="7001"]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    // Two seasons -> chips; the episode list renders for the first season.
    await page.waitForSelector('.tv-season-chip');
    await page.waitForSelector('.tv-episode[data-episode="2"]');
    await page.locator('.tv-episode[data-episode="2"]').click();
    await page.waitForSelector('#player-modal', { state: 'visible' });
    await page.waitForFunction(() => document.getElementById('player-title').textContent.includes('S1E2'));
  } finally { await browser.close(); }
});

test('TV defaults to the native torrent source, not the bot-gated embed', { skip: !process.env.TV_E2E }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const movie = { id: 5001, title: 'Default Movie', media_type: 'movie', vote_average: 8, vote_count: 1000, genre_ids: [18], release_date: '2024-01-01', overview: 'x', poster_path: null, backdrop_path: null };
    const show = { id: 5002, name: 'Default Show', media_type: 'tv', vote_average: 8, vote_count: 1000, genre_ids: [18], first_air_date: '2024-01-01', overview: 'x', poster_path: null, backdrop_path: null };
    await page.route('https://api.themoviedb.org/**', async route => {
      const url = route.request().url();
      let body = { results: [movie, show], page: 1, total_pages: 1 };
      if (/\/external_ids/.test(url)) body = { imdb_id: 'tt1234567' };
      else if (/\/tv\/5002\?/.test(url)) body = { seasons: [{ season_number: 1, episode_count: 1 }] };
      else if (/\/season\/1/.test(url)) body = { episodes: [{ episode_number: 1, name: 'Pilot' }] };
      else if (/\/credits/.test(url)) body = { cast: [] };
      await route.fulfill({ json: body });
    });
    // Valid torrent lookups so the torrent source stays selected (no alternate-source swap).
    await page.route('**/yts?*', r => r.fulfill({ json: { title: 'Default Movie', torrents: [{ hash: 'a'.repeat(40), quality: '720p', seeds: 100, video_codec: 'x264' }] } }));
    await page.route(/\/(?:tv|movie)-torrents\?/, r => r.fulfill({ json: { sources: [{ hash: 'a'.repeat(40), quality: '720p', seeds: 100, filename: 'F.S01E01.x264.mkv', title: 'F x264', remux: true }] } }));
    await page.route('**/subtitles?*', r => r.fulfill({ json: { tracks: [] } }));
    await page.route('**/hls/start?*', r => r.fulfill({ status: 503, json: { error: 'fixture' } }));
    await page.route('**/stream?*', r => r.fulfill({ status: 503, body: 'fixture' }));
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html`);
    await page.waitForSelector('.tv-card');

    // Movie defaults to YTS (Torrent), and the embed iframe is not the active player.
    await page.locator('.tv-card[data-movie-id="5001"]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    await page.keyboard.press('Enter'); // Play
    await page.waitForSelector('#player-modal', { state: 'visible' });
    await page.waitForFunction(() => { const o = document.querySelector('#source-select option:checked'); return !!o && o.textContent.includes('YTS (Torrent)'); });
    assert.equal(await page.locator('#player-iframe').isVisible(), false);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#player-modal', { state: 'hidden' });

    // Series defaults to TV (Torrent).
    await page.locator('.tv-card[data-movie-id="5002"]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    await page.keyboard.press('Enter'); // Play
    await page.waitForSelector('#player-modal', { state: 'visible' });
    await page.waitForFunction(() => { const o = document.querySelector('#source-select option:checked'); return !!o && o.textContent.includes('TV (Torrent)'); });
  } finally { await browser.close(); }
});

// Shared fixture for the navigation/stress tests: several distinct catalogue rows,
// each with more cards than one render window, all movies with a playable MP4.
async function navigationFixture(page, bytes) {
  const { parseByteRange } = await import('./http-range.js');
  const mk = (start, n) => Array.from({ length: n }, (_, i) => ({ id: start + i, title: `Nav ${start + i}`, media_type: 'movie', vote_average: 8, vote_count: 1000, popularity: 100, genre_ids: [18], release_date: '2024-01-01', overview: 'Navigation fixture.', poster_path: null, backdrop_path: null }));
  // Registered first: Playwright tries the most recently added route first, so the
  // specific helper routes below (on the https helper origin) must come after this.
  await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
  const feeds = [[/\/trending\//, 1000], [/\/movie\/popular/, 2000], [/\/movie\/top_rated/, 3000], [/\/movie\/now_playing/, 4000], [/sort_by=vote_count/, 5000], [/with_genres=28&/, 6000], [/with_genres=35&/, 7000]];
  await page.route('https://api.themoviedb.org/**', route => {
    const url = route.request().url();
    if (/\/external_ids/.test(url)) return route.fulfill({ json: { imdb_id: 'tt1234567' } });
    const feed = feeds.find(([re]) => re.test(url));
    return route.fulfill({ json: { results: feed ? mk(feed[1], 20) : [], cast: [], page: 1, total_pages: 1 } });
  });
  await page.route('**/yts?*', r => r.fulfill({ json: { title: 'Nav', torrents: [{ hash: 'a'.repeat(40), quality: '1080p', seeds: 100, video_codec: 'x264' }] } }));
  await page.route('**/subtitles?*', r => r.fulfill({ json: { tracks: [] } }));
  await page.route('**/stream-status?*', r => r.fulfill({ json: { state: 'ready', peers: 100 } }));
  await page.route('**/stream-stop?*', r => r.fulfill({ status: 204 }));
  await page.route('**/stream?*', r => {
    const range = parseByteRange(r.request().headers().range, bytes.length);
    return r.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: range ? bytes.subarray(range.start, range.end + 1) : bytes, headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${bytes.length}` } : {}) } });
  });
  // Progressive MP4 path (no native HLS in desktop Chrome).
  await page.addInitScript(() => { const o = HTMLMediaElement.prototype.canPlayType; HTMLMediaElement.prototype.canPlayType = function (t) { return t.includes('mpegurl') ? '' : o.call(this, t); }; });
}

async function makeClip() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'movies-nav-test-'));
  const file = join(dir, 'clip.mp4');
  await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-movflags', '+faststart', '-y', file]);
  const bytes = await readFile(file);
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

// The focused card must be a real, on-screen card: inside the viewport and inside its rail.
// The rail glides with a CSS transition, so wait for it to settle there (bounded).
const focusedCardOnScreen = async page => {
  await page.waitForFunction(() => {
    const a = document.activeElement;
    if (!a || !a.classList.contains('tv-card')) return false;
    const r = a.getBoundingClientRect();
    const rail = a.closest('.tv-rail').getBoundingClientRect();
    return r.left >= rail.left - 1 && r.right <= rail.right + 1 && r.top >= 0 && r.bottom <= innerHeight;
  }, null, { timeout: 3000 }).catch(() => {});
  return readFocusedCard(page);
};
const readFocusedCard = page => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || !a.classList.contains('tv-card')) return { ok: false, why: `focus on ${a && a.tagName}.${a && a.className}` };
  const r = a.getBoundingClientRect();
  const rail = a.closest('.tv-rail').getBoundingClientRect();
  const ok = r.width > 0 && r.left >= rail.left - 1 && r.right <= rail.right + 1 && r.top >= 0 && r.bottom <= innerHeight;
  return { ok, id: a.dataset.movieId, why: JSON.stringify({ r: [r.left, r.right, r.top, r.bottom], rail: [rail.left, rail.right] }) };
});

test('TV focus returns to the same deep card after details, and rapid Right keeps a visible focus', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const bytes = await makeClip();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await navigationFixture(page, bytes);
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?source=YTS%20(Torrent)`);
    // Wait until the fixture rows have painted (Highest Weighted Rating = the 5000 feed).
    await page.waitForSelector('.tv-card[data-movie-id="5000"]');
    await page.keyboard.press('ArrowDown'); // hero Play
    assert.equal(await page.evaluate(() => document.activeElement.className), 'tv-play');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown'); // six rows deep
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight'); // eight cards across
    await page.waitForTimeout(350); // let the rail's glide (and the page's smooth scroll) settle before measuring
    const indexInRow = () => page.evaluate(() => [...document.activeElement.closest('.tv-rail-track').children].indexOf(document.activeElement));
    const deep = await focusedCardOnScreen(page);
    const deepIndex = await indexInRow();
    assert.ok(deep.ok, 'deep: ' + deep.why);
    const row = await page.evaluate(() => document.activeElement.closest('.tv-row').dataset.tvRow);
    const tx = await page.evaluate(() => document.activeElement.closest('.tv-rail-track').dataset.tx);
    assert.ok(parseFloat(tx) < 0, 'the rail glided to keep the ninth card on screen');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tv-details', { state: 'hidden' });
    await page.waitForFunction(id => document.activeElement && document.activeElement.dataset.movieId === id, deep.id);
    assert.equal(await page.evaluate(() => document.activeElement.closest('.tv-row').dataset.tvRow), row);
    await page.waitForTimeout(350);
    const back = await focusedCardOnScreen(page);
    assert.ok(back.ok, 'back: ' + back.why);

    // Rapid presses (no waits) and a held key (auto-repeat) never lose the focus.
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const rapid = await focusedCardOnScreen(page);
    assert.ok(rapid.ok, 'rapid: ' + rapid.why);
    assert.ok(await indexInRow() > deepIndex, 'rapid Right moved along the row');
    for (let i = 0; i < 15; i++) await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const held = await focusedCardOnScreen(page);
    assert.ok(held.ok, 'held: ' + held.why);
    // The row walked to its real end: all 20 titles of the feed's first page (none
    // skipped when paging), with focus on the last card.
    assert.deepEqual(await page.evaluate(() => { const t = document.activeElement.closest('.tv-rail-track'); return [t.children.length, t.lastElementChild === document.activeElement]; }), [20, true]);
    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowLeft'); // past the first card
    const start = await focusedCardOnScreen(page);
    assert.ok(start.ok, 'start: ' + start.why);
    assert.equal(await page.evaluate(() => document.activeElement.closest('.tv-rail-track').querySelector('.tv-card') === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('TV open -> play -> Back five times leaves one stopped player and the same card focused', { skip: !process.env.TV_E2E, timeout: 90000 }, async () => {
  const bytes = await makeClip();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await navigationFixture(page, bytes);
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?source=YTS%20(Torrent)`);
    await page.waitForSelector('.tv-card[data-movie-id="2003"]');
    await page.locator('.tv-card[data-movie-id="2003"]').first().focus();
    for (let round = 0; round < 5; round++) {
      const step = async (label, promise) => { try { return await promise; } catch (e) { throw new Error(`round ${round + 1}: ${label}: ${await page.evaluate(() => `${document.activeElement.tagName}.${document.activeElement.className}#${document.activeElement.id} ${document.activeElement.dataset.movieId || ''}`)}; ${e.message}`); } };
      await page.keyboard.press('Enter');
      await step('details open', page.waitForSelector('.tv-details:not([hidden])', { timeout: 10000 }));
      await page.keyboard.press('Enter'); // Play
      await step('player open', page.waitForSelector('#player-modal', { state: 'visible', timeout: 10000 }));
      await step('playing', page.waitForFunction(() => document.getElementById('player-video').currentTime > 0.3, null, { timeout: 15000 }));
      await page.keyboard.press('Escape'); // leave playback
      await step('player closed', page.waitForSelector('#player-modal', { state: 'hidden', timeout: 10000 }));
      await step('details shown again', page.waitForSelector('.tv-details:not([hidden])', { timeout: 10000 }));
      await page.keyboard.press('Escape'); // leave details
      await step('details closed', page.waitForSelector('.tv-details', { state: 'hidden', timeout: 10000 }));
      await step('focus restored', page.waitForFunction(() => document.activeElement && document.activeElement.dataset.movieId === '2003', null, { timeout: 10000 }));
      const state = await page.evaluate(() => ({
        videos: document.querySelectorAll('video').length,
        playing: Array.from(document.querySelectorAll('video')).filter(v => !v.paused).length,
        src: document.getElementById('player-video').getAttribute('src') || '',
        iframes: Array.from(document.querySelectorAll('iframe')).filter(f => f.getAttribute('src')).length,
        details: document.querySelectorAll('.tv-details:not([hidden])').length,
        pickers: document.querySelectorAll('.tv-picker').length,
      }));
      assert.deepEqual(state, { videos: 1, playing: 0, src: '', iframes: 0, details: 0, pickers: 0 }, `round ${round + 1}`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('TV home keeps loading category rows as focus moves down, up to the last one', { skip: !process.env.TV_E2E, timeout: 120000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
    // Every feed gets its own titles so cross-row dedupe never empties a row.
    const feedIds = new Map();
    await page.route('https://api.themoviedb.org/**', route => {
      const url = new URL(route.request().url());
      if (/\/external_ids/.test(url.pathname)) return route.fulfill({ json: { imdb_id: 'tt1234567' } });
      url.searchParams.delete('api_key');
      const feed = url.pathname + '?' + [...url.searchParams].filter(([k]) => k !== 'page').map(p => p.join('=')).join('&');
      if (!feedIds.has(feed)) feedIds.set(feed, 100000 + feedIds.size * 1000 + Number(url.searchParams.get('page') || 1) * 100);
      const base = feedIds.get(feed) + (Number(url.searchParams.get('page') || 1) - 1) * 50;
      const results = Array.from({ length: 20 }, (_, i) => ({ id: base + i, title: `Row ${base + i}`, media_type: 'movie', vote_average: 7, vote_count: 500, popularity: 50, genre_ids: [18], release_date: '2020-01-01', overview: 'x', poster_path: null, backdrop_path: null }));
      return route.fulfill({ json: { results, items: results, cast: [], page: 1, total_pages: 5 } });
    });
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?source=YTS%20(Torrent)`);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tv-row]')].some(r => r.dataset.tvRow === 'Highest Weighted Rating' && r.dataset.rowComplete === '1'), null, { timeout: 60000 });
    const rowCount = () => page.evaluate(() => [...document.querySelectorAll('#main [data-tv-row]')].filter(r => r.querySelector('.tv-card')).length);
    const initial = await rowCount();
    await page.keyboard.press('ArrowDown');
    // Walk down the home; batches of rows arrive as focus nears the bottom.
    // At the current last row, wait for the next batch before pressing on.
    for (let i = 0; i < 200; i++) {
      if (await page.evaluate(() => [...document.querySelectorAll('[data-tv-row]')].some(r => r.dataset.tvRow === 'On Paramount+' && r.dataset.rowComplete === '1'))) break;
      const before = await rowCount();
      await page.keyboard.press('ArrowDown');
      const atBottom = await page.evaluate(() => { const rows = [...document.querySelectorAll('#main [data-tv-row]')].filter(r => r.querySelector('.tv-card')); return rows.indexOf(document.activeElement.closest('[data-tv-row]')) >= rows.length - 1; });
      if (atBottom) await page.waitForFunction(n => [...document.querySelectorAll('#main [data-tv-row]')].filter(r => r.querySelector('.tv-card')).length > n, before, { timeout: 20000 }).catch(() => {});
    }
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tv-row]')].some(r => r.dataset.tvRow === 'On Paramount+' && r.dataset.rowComplete === '1'), null, { timeout: 30000 });
    const titles = await page.evaluate(() => [...document.querySelectorAll('#main [data-tv-row]')].map(r => r.dataset.tvRow));
    assert.ok(titles.length >= initial + 45, `rows ${initial} -> ${titles.length}`);
    for (const t of ['Oscar Best Picture Winners', 'Comedy', 'Bollywood & Indian', 'Pakistani', 'Heists', 'Hidden Gems', 'Documentaries']) assert.ok(titles.includes(t), t);
    assert.equal(titles.some(t => / Series$/.test(t)), false, 'All mixes films and shows in one row per category');
    assert.equal(new Set(titles).size, titles.length, 'no row appears twice');
    const focus = await page.evaluate(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); return { card: a.classList.contains('tv-card'), onScreen: r.top >= 0 && r.bottom <= innerHeight }; });
    assert.deepEqual(focus, { card: true, onScreen: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a category keeps overlapping titles and fetches its entire feed before ranking', { skip: !process.env.TV_E2E, timeout: 120000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
    const mk = (start, n, rating = 8) => Array.from({ length: n }, (_, i) => ({ id: start + i, name: `Show ${start + i}`, media_type: 'tv', vote_average: rating - i * 0.01, vote_count: 900, popularity: 50, genre_ids: [18], first_air_date: '2020-01-01', overview: 'x', poster_path: null, backdrop_path: null }));
    const feedIds = new Map();
    await page.route('https://api.themoviedb.org/**', route => {
      const url = new URL(route.request().url());
      const pg = Number(url.searchParams.get('page') || 1);
      // The shows in Top Rated and page 1 of the Drama row's tv feed are the same 20.
      if (/\/tv\/top_rated/.test(url.pathname)) return route.fulfill({ json: { results: mk(900000, 20, 9), page: pg, total_pages: 1 } });
      if (/\/discover\/tv/.test(url.pathname) && url.searchParams.get('with_genres') === '18') {
        return route.fulfill({ json: { results: pg === 1 ? mk(900000, 20, 9) : mk(910000 + pg * 100, 20, 8.5 - pg * 0.3), page: pg, total_pages: 10 } });
      }
      if (/\/discover\/movie/.test(url.pathname) && url.searchParams.get('with_genres') === '18') return route.fulfill({ json: { results: [], page: pg, total_pages: 1 } });
      url.searchParams.delete('api_key'); url.searchParams.delete('page');
      const feed = url.pathname + url.search;
      if (!feedIds.has(feed)) feedIds.set(feed, 100000 + feedIds.size * 1000);
      const base = feedIds.get(feed) + (pg - 1) * 50;
      const results = Array.from({ length: 20 }, (_, i) => ({ id: base + i, title: `Row ${base + i}`, media_type: 'movie', vote_average: 7, vote_count: 500, popularity: 50, genre_ids: [18], release_date: '2020-01-01', overview: 'x', poster_path: null, backdrop_path: null }));
      return route.fulfill({ json: { results, items: results, cast: [], page: pg, total_pages: 5 } });
    });
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?source=YTS%20(Torrent)`);
    // Drama is past the first batch of rows: walk down until it loads.
    await page.waitForFunction(() => [...document.querySelectorAll('#main [data-tv-row]')].filter(r => r.querySelector('.tv-card')).length >= 10, null, { timeout: 60000 });
    await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 60; i++) {
      if (await page.evaluate(() => [...document.querySelectorAll('[data-tv-row]')].some(r => r.dataset.tvRow === 'Drama'))) break;
      const before = await page.evaluate(() => [...document.querySelectorAll('#main [data-tv-row]')].filter(r => r.querySelector('.tv-card')).length);
      await page.keyboard.press('ArrowDown');
      const atBottom = await page.evaluate(() => { const rows = [...document.querySelectorAll('#main [data-tv-row]')].filter(r => r.querySelector('.tv-card')); return rows.indexOf(document.activeElement.closest('[data-tv-row]')) >= rows.length - 1; });
      if (atBottom) await page.waitForFunction(n => [...document.querySelectorAll('#main [data-tv-row]')].filter(r => r.querySelector('.tv-card')).length > n, before, { timeout: 20000 }).catch(() => {});
    }
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tv-row]')].some(r => r.dataset.tvRow === 'Drama' && r.dataset.rowComplete === '1'), null, { timeout: 30000 });
    const drama = await page.evaluate(() => { const r = [...document.querySelectorAll('[data-tv-row]')].find(x => x.dataset.tvRow === 'Drama'); const c = [...r.querySelectorAll('.tv-card')]; return { n: c.length, total: r.__total, pages: r.dataset.rowPages, ids: c.map(x => Number(x.dataset.movieId)), scores: c.map(x => Number(x.dataset.score)) }; });
    assert.ok(drama.n >= 12, `Drama shows ${drama.n} cards`);
    assert.ok(drama.ids.every(id => id >= 900000 && id < 910000), 'category retains its top-rated shows even when also in Top Rated');
    assert.equal(drama.total, 200, 'all ten category pages fetched');
    assert.equal(drama.pages, '11', 'ten show pages and one movie page');
    assert.deepEqual(drama.scores, [...drama.scores].sort((a, b) => b - a), 'highest (weighted) rating first');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('complete category ranking remains stable as scrolling renders more cards', { skip: !process.env.TV_E2E, timeout: 120000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
    const film = (id, rating) => ({ id, title: `Film ${id}`, media_type: 'movie', vote_average: rating, vote_count: 5000, popularity: 50, genre_ids: [18], release_date: '2020-01-01', overview: 'x', poster_path: null, backdrop_path: null });
    const feedIds = new Map();
    await page.route('https://api.themoviedb.org/**', route => {
      const url = new URL(route.request().url());
      const pg = Number(url.searchParams.get('page') || 1);
      // Highest Weighted Rating, as on the TV: TMDB's order is not the row's weighted order. Cards
      // 13-20 of page 1 outrate its first 12, and page 2 outrates all of page 1.
      if (/\/discover\/movie/.test(url.pathname) && url.searchParams.get('sort_by') === 'vote_count.desc') {
        const results = Array.from({ length: 20 }, (_, i) => pg === 1
          ? film(700000 + i, i < 12 ? 7 - i * 0.01 : 8 - (i - 12) * 0.01)
          : film(700000 + pg * 100 + i, 9.5 - pg * 0.2 - i * 0.01));
        return route.fulfill({ json: { results, page: pg, total_pages: 5 } });
      }
      if (/\/discover\/tv/.test(url.pathname) && url.searchParams.get('sort_by') === 'vote_count.desc') return route.fulfill({ json: { results: [], page: pg, total_pages: 1 } });
      url.searchParams.delete('api_key'); url.searchParams.delete('page');
      const feed = url.pathname + url.search;
      if (!feedIds.has(feed)) feedIds.set(feed, 100000 + feedIds.size * 1000);
      const base = feedIds.get(feed) + (pg - 1) * 50;
      const results = Array.from({ length: 20 }, (_, i) => film(base + i, 6.5));
      return route.fulfill({ json: { results, items: results, cast: [], page: pg, total_pages: 5 } });
    });
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html?source=YTS%20(Torrent)`);
    await page.waitForFunction(() => document.querySelector('[data-tv-row="Highest Weighted Rating"]')?.dataset.rowComplete === '1', null, { timeout: 60000 });
    for (let i = 0; i < 20; i++) {
      if (await page.evaluate(() => document.activeElement.closest && document.activeElement.closest('[data-tv-row]')?.dataset.tvRow === 'Highest Weighted Rating')) break;
      await page.keyboard.press('ArrowDown');
    }
    const row = () => page.evaluate(() => {
      const r = [...document.querySelectorAll('[data-tv-row]')].find(x => x.dataset.tvRow === 'Highest Weighted Rating');
      return { ids: [...r.querySelectorAll('.tv-card')].map(c => c.dataset.movieId), loading: r.dataset.rowLoading === '1' };
    });
    const complete = await page.locator('[data-tv-row="Highest Weighted Rating"]').evaluate(r => ({ total: r.__total, ids: [...r.querySelectorAll('.tv-card')].map(c => Number(c.dataset.movieId)).concat(r.__rest.map(m => m.id)) }));
    assert.equal(complete.total, 100, 'all five pages loaded before the first window');
    assert.equal(complete.ids[0], 700200, 'higher-rated second page winner appears first');
    let prev = (await row()).ids;
    assert.equal(prev.length, 12, 'the row opens with one window of cards');
    for (let step = 0; step < 45; step++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => {
        const r = [...document.querySelectorAll('[data-tv-row]')].find(x => x.dataset.tvRow === 'Highest Weighted Rating');
        return r.dataset.rowLoading !== '1';
      });
      const now = (await row()).ids;
      assert.deepEqual(now.slice(0, prev.length), prev, `step ${step + 1}: cards already in the row moved (${prev.length} before, ${now.length} now)`);
      prev = now;
    }
    assert.ok(prev.length > 20, `the row paged past its first page (${prev.length} cards)`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('failed category offers retry and never presents a partial ranking', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    let failures = 0;
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
    await page.route('https://api.themoviedb.org/**', route => {
      const url = new URL(route.request().url());
      const pg = Number(url.searchParams.get('page') || 1);
      if (url.pathname.includes('/trending/')) return route.fulfill({ json: { results: [{ id: 999001, title: 'Trending fixture', vote_average: 7, vote_count: 60000 }], total_pages: 1 } });
      if (url.pathname.endsWith('/discover/movie') && url.searchParams.get('sort_by') === 'vote_count.desc') {
        if (pg === 2 && failures++ < 2) return route.fulfill({ status: 503, json: {} });
        return route.fulfill({ json: { results: [{ id: 800000 + pg, title: `Movie ${pg}`, vote_average: pg === 2 ? 9 : 7, vote_count: 60000 }], total_pages: 3 } });
      }
      return route.fulfill({ json: { results: [], items: [], total_pages: 1, cast: [] } });
    });
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html`);
    const row = page.locator('[data-tv-row="Highest Weighted Rating"]');
    await row.getByRole('button', { name: 'Retry category' }).waitFor();
    assert.equal(await row.locator('.tv-card').count(), 0, 'failed page cannot produce a partial list');
    await row.getByRole('button', { name: 'Retry category' }).click();
    await page.waitForFunction(() => document.querySelector('[data-tv-row="Highest Weighted Rating"]')?.dataset.rowComplete === '1');
    assert.deepEqual(await row.locator('.tv-card').evaluateAll(cards => cards.map(c => Number(c.dataset.movieId))), [800002, 800001, 800003]);
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), '800002', 'retry restores remote focus to the completed category');
  } finally { await browser.close(); }
});

test('TV complete category cache survives reload with zero category page refetches', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    let categoryRequests = 0;
    const feeds = new Map();
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/https:\/\/(?!api\.themoviedb\.org)/, r => r.fulfill({ contentType: 'text/html', body: 'x' }));
    await page.route('https://api.themoviedb.org/**', route => {
      const url = new URL(route.request().url());
      if (/\/genre\//.test(url.pathname)) return route.fulfill({ json: { genres: [] } });
      categoryRequests++;
      const pg = Number(url.searchParams.get('page') || 1);
      url.searchParams.delete('page'); url.searchParams.delete('api_key'); url.searchParams.sort();
      const key = url.toString();
      if (!feeds.has(key)) feeds.set(key, 200000 + feeds.size * 1000);
      const results = Array.from({ length: 20 }, (_, i) => ({ id: feeds.get(key) + pg * 20 + i, title: `Cached ${pg}-${i}`, vote_average: pg === 3 ? 9 - i * 0.01 : 7 - i * 0.01, vote_count: 60000, release_date: '2020-01-01' }));
      return route.fulfill({ json: { results, items: results, page: pg, total_pages: 3 } });
    });
    await page.goto(`${process.env.TV_TEST_URL || 'http://127.0.0.1:8123'}/tv.html`);
    await page.waitForFunction(() => document.querySelectorAll('[data-row-complete="1"]').length >= 12);
    assert.ok(categoryRequests >= 51, 'cold uncached fallback fetched complete source pages');
    const before = await page.locator('[data-tv-row="Top Rated"]').evaluate(r => ({ total: r.__total, first: r.querySelector('.tv-card').dataset.movieId }));
    await page.waitForFunction(() => new Promise(resolve => {
      const request = indexedDB.open('moviesdb-category-cache', 1);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('rows', 'readonly'), count = tx.objectStore('rows').count();
        count.onsuccess = () => resolve(count.result >= 12);
        tx.oncomplete = () => db.close();
      };
      request.onerror = () => resolve(false);
    }));
    categoryRequests = 0;
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-row-complete="1"]').length >= 12);
    assert.equal(categoryRequests, 0, 'persistent reload needs no TMDB category fetches');
    assert.equal(await page.locator('[data-row-cached="1"]').count(), 12);
    const after = await page.locator('[data-tv-row="Top Rated"]').evaluate(r => ({ total: r.__total, first: r.querySelector('.tv-card').dataset.movieId }));
    assert.deepEqual(after, before, 'entire membership and last-page winner survive caching');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('TV persistent cache evicts old categories within row and title budgets', { skip: !process.env.TV_E2E, timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const origin = process.env.TV_TEST_URL || 'http://127.0.0.1:8123';
    await page.route(origin + '/cache-store-test', r => r.fulfill({ contentType: 'text/html', body: '<title>Cache test</title>' }));
    await page.goto(origin + '/cache-store-test');
    const result = await page.evaluate(async origin => {
      const { createTvCatalogStore } = await import(origin + '/tv-catalog-store.mjs');
      const store = createTvCatalogStore({ maxRows: 2, maxItems: 4 });
      const snapshot = id => ({ row: { items: [{ id }, { id: id + 1 }] } });
      await store.set('a', snapshot(1));
      await store.set('b', snapshot(3));
      await new Promise(resolve => setTimeout(resolve, 5));
      await store.get('a');
      await store.set('c', snapshot(5));
      return { a: !!await store.get('a'), b: !!await store.get('b'), c: !!await store.get('c') };
    }, origin);
    assert.deepEqual(result, { a: true, b: false, c: true });
  } finally { await browser.close(); }
});
