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
    assert.equal(await page.locator(':focus').getAttribute('id'), 'tab-movies');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'tv-play');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'tv-card');
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
    assert.equal(await page.locator(':focus').getAttribute('data-movie-id'), selected);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'tab-movies');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'tv-browse-controls');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'search');
    await page.keyboard.type('Adventure');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-card');
    await page.keyboard.press('ArrowUp');
    // The filters are reachable spatially, and each select has a D-pad option list.
    await page.locator('#media-type').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-picker');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#media-type').inputValue(), 'movie');
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
  await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
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
  assert.equal(await page.locator(':focus').getAttribute('data-movie-id'),'9005');
 } finally {await browser.close();}
});

test('TV home shows distinct, deduped rows and Back from details returns to the card', { skip: !process.env.TV_E2E }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const mk = (start, n, mt) => Array.from({ length: n }, (_, i) => ({ id: start + i, title: `T${start + i}`, name: `T${start + i}`, media_type: mt, vote_average: 8, vote_count: 1000, popularity: 100, genre_ids: [18], release_date: '2024-01-01', first_air_date: '2024-01-01', overview: 'Row fixture.', poster_path: null, backdrop_path: null }));
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
    // Rows paint progressively; wait for the last one before reading them all.
    await page.waitForFunction(() => [...document.querySelectorAll('.tv-row h2')].some(h => h.textContent === 'Action & Adventure'));
    // Several distinct rows, not slices of one feed.
    const headings = await page.locator('.tv-row h2').allTextContents();
    for (const h of ['Trending This Week', 'Popular Right Now', 'Top Rated', 'New Releases']) assert.ok(headings.includes(h), `missing row ${h}`);
    // No title appears in more than one row.
    const ids = await page.locator('.tv-card').evaluateAll(cards => cards.map(c => c.dataset.movieId));
    assert.equal(new Set(ids).size, ids.length, 'a title was repeated across rows');
    // The two ids that overlapped trending must not reappear under Popular.
    assert.equal(ids.filter(id => id === '3').length, 1);

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
