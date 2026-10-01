import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// The TV remembers where you were: per-row position, the details -> player -> Back stack,
// the season you are on, and it does not throw the home away when a signal changes.
// TV_E2E=1 TV_TEST_URL=http://127.0.0.1:8123 node --test tv-state-e2e.test.js
const BASE_URL = () => process.env.TV_TEST_URL || 'http://127.0.0.1:8123';
const today = () => new Date().toISOString().slice(0, 10);
const SHOW_ID = 7001;
const item = (id, extra = {}) => ({ id, title: `Film ${id}`, name: `Film ${id}`, media_type: 'movie', vote_average: 8, vote_count: 2000, popularity: 100, genre_ids: [18], release_date: today(), overview: `Overview ${id}`, backdrop_path: null, ...extra });
const LONG_ID = 7002; // 38 seasons of 24 episodes, two trailer candidates
const longShow = () => ({ id: LONG_ID, name: 'Endless Show', title: 'Endless Show', media_type: 'tv', vote_average: 8.1, vote_count: 9000, popularity: 480, first_air_date: '1989-01-01', genre_ids: [35], overview: 'A show that never ends.' });
const show = () => ({ id: SHOW_ID, name: 'Long Show', title: 'Long Show', media_type: 'tv', vote_average: 8.4, vote_count: 9000, popularity: 500, first_air_date: '2019-01-01', genre_ids: [18], overview: 'A show with many seasons.' });

async function openApp({ progress = null, path = '/tv.html?source=111Movies', beforeGoto = null } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (progress) await page.addInitScript(p => { if (!localStorage.getItem('tvShowProgress')) localStorage.setItem('tvShowProgress', JSON.stringify(p)); }, progress);
  await page.route('https://api.themoviedb.org/**', async route => {
    const url = route.request().url();
    const path = new URL(url).pathname;
    let body;
    if (/\/external_ids/.test(path)) body = { imdb_id: 'tt1234567' };
    else if (new RegExp(`/tv/${SHOW_ID}$`).test(path)) body = { seasons: [0, 1, 2, 3, 4].map(n => ({ season_number: n, name: n ? `Season ${n}` : 'Specials', episode_count: 3 })), number_of_seasons: 4 };
    else if (new RegExp(`/tv/${LONG_ID}$`).test(path)) body = { seasons: Array.from({ length: 39 }, (_, n) => ({ season_number: n, name: n ? `Season ${n}` : 'Specials', episode_count: 24 })), number_of_seasons: 38 };
    else if (new RegExp(`/tv/${LONG_ID}/season/(\\d+)$`).test(path)) {
      const s = Number(/season\/(\d+)$/.exec(path)[1]);
      body = { episodes: Array.from({ length: 24 }, (_, i) => ({ episode_number: i + 1, name: `S${s} Episode ${i + 1}` })) };
    } else if (new RegExp(`/tv/${LONG_ID}/videos$`).test(path)) body = { results: [{ site: 'YouTube', type: 'Trailer', key: 'AAAAAAAAAAA', official: true }, { site: 'YouTube', type: 'Teaser', key: 'BBBBBBBBBBB' }] };
    else if (new RegExp(`/tv/${SHOW_ID}/season/(\\d+)$`).test(path)) {
      const s = Number(/season\/(\d+)$/.exec(path)[1]);
      body = { episodes: [1, 2, 3].map(n => ({ episode_number: n, name: `S${s} Episode ${n}` })) };
    } else if (/\/credits/.test(path)) body = { cast: [{ name: 'Jane Doe' }] };
    else if (/\/videos|\/watch\/providers|\/keywords|\/recommendations|\/similar/.test(path)) body = { results: [] };
    else {
      // Every feed gets its own 20 distinct titles so rows are distinguishable.
      let h = 0; for (const c of path) h = (h * 31 + c.charCodeAt(0)) % 997;
      const base = 10000 + h * 100;
      const results = Array.from({ length: 20 }, (_, i) => item(base + i));
      if (/trending\/all/.test(path)) results.unshift(show(), longShow());
      body = { results, items: results, page: 1, total_pages: 1, total_results: results.length }; // `items` = the /list/ endpoints
    }
    await route.fulfill({ json: body });
  });
  await page.route('**/tv-torrents?*', route => route.fulfill({ json: { sources: [] } }));
  await page.route(/https:\/\/(?!api\.themoviedb\.org)/, route => route.fulfill({ contentType: 'text/html', body: 'fixture' }));
  if (beforeGoto) await beforeGoto(page);
  await page.goto(`${BASE_URL()}${path}`);
  await page.waitForSelector('.tv-card');
  await page.waitForFunction(() => ['Trending This Week', 'Popular Now', 'Top Rated'].every(t => [...document.querySelectorAll('.tv-row')].some(r => r.dataset.tvRow === t && r.dataset.rowComplete === '1')));
  return { browser, page, errors };
}

// The rail position is re-measured from layout when focus returns, so allow sub-pixel float noise.
const assertSameTx = (actual, expected, message) => assert.ok(Math.abs(parseFloat(actual) - parseFloat(expected)) < 0.5, `${message}: ${actual} vs ${expected}`);
const where = page => page.evaluate(() => {
  const a = document.activeElement;
  const row = a && a.closest && a.closest('[data-tv-row]');
  return row ? [row.dataset.tvRow, [...row.querySelectorAll('.tv-card')].indexOf(a)] : [a && (a.id || a.className), -1];
});

test('every row remembers its own position; a row never visited starts at its first card', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page, errors } = await openApp();
  try {
    // The first three catalogue rows, whatever they are called.
    const [A, B, C] = await page.evaluate(() => [...document.querySelectorAll('#main .tv-row')].filter(r => r.dataset.rowComplete === '1').map(r => r.dataset.tvRow));
    assert.ok(A && B && C, 'three rows are loaded');
    await page.locator(`[data-tv-row="${A}"] .tv-card`).first().focus();
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    assert.deepEqual(await where(page), [A, 8]);
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await where(page), [B, 0], 'an unvisited row starts at its first card, not at column 8');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    assert.deepEqual(await where(page), [B, 3]);
    await page.keyboard.press('ArrowUp');
    assert.deepEqual(await where(page), [A, 8], 'going back up returns to where that row was left');
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await where(page), [B, 3]);
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await where(page), [C, 0]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Back from the player returns to that title\'s details, then Back returns to the card with its row position', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page, errors } = await openApp();
  try {
    const row = page.locator('[data-tv-row="Popular Now"] .tv-card');
    await row.first().focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    const id = await page.locator(':focus').getAttribute('data-movie-id');
    const tx = await page.locator('[data-tv-row="Popular Now"] .tv-rail-track').getAttribute('data-tx');
    assert.notEqual(tx, null);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    await page.keyboard.press('Enter'); // Play
    await page.waitForSelector('#player-modal', { state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#player-modal', { state: 'hidden' });
    await page.waitForSelector('.tv-details:not([hidden])');
    assert.equal(await page.locator('.tv-details-title').textContent(), `Film ${id}`, 'Back from the player lands on the details of what was playing');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'tv-details-play');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tv-details', { state: 'hidden' });
    await page.waitForFunction(i => document.activeElement && document.activeElement.dataset.movieId === i, id);
    assert.deepEqual(await where(page), ['Popular Now', 5]);
    assertSameTx(await page.locator('[data-tv-row="Popular Now"] .tv-rail-track').getAttribute('data-tx'), tx, 'the rail stays where it was');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a series opens on the season you were watching, not Season 1', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page, errors } = await openApp({ progress: { [SHOW_ID]: { season: 3, episode: 2, positionSec: 0, durationSec: 0, timestamp: Date.now() } } });
  try {
    await page.locator(`.tv-card[data-movie-id="${SHOW_ID}"]`).first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    await page.waitForSelector('.tv-episode');
    assert.equal(await page.locator('.tv-season-chip.active').getAttribute('data-season'), '3');
    assert.equal(await page.locator('.tv-episode').first().getAttribute('data-season'), '3');
    assert.match(await page.locator('.tv-details-play').textContent(), /S3E2/, 'the primary button says where it will continue');
    assert.equal(await page.locator('.tv-episode.current').getAttribute('data-episode'), '2', 'the episode you are on is marked');
    // Choosing another season still works.
    await page.locator('.tv-season-chip[data-season="1"]').click();
    await page.waitForFunction(() => document.querySelector('.tv-episode') && document.querySelector('.tv-episode').dataset.season === '1');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a show with a saved resume point labels Resume with its season and episode', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page } = await openApp({ progress: { [SHOW_ID]: { season: 4, episode: 1, positionSec: 725, durationSec: 2700, timestamp: Date.now() } } });
  try {
    await page.locator(`.tv-card[data-movie-id="${SHOW_ID}"]`).first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    assert.match(await page.locator('.tv-details-play').textContent(), /Resume.*S4E1.*12:05/);
    await page.waitForSelector('.tv-season-chip.active');
    assert.equal(await page.locator('.tv-season-chip.active').getAttribute('data-season'), '4');
  } finally { await browser.close(); }
});

test('adding to My List does not repaint the home: rows keep their cards and position', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page, errors } = await openApp();
  try {
    await page.locator('[data-tv-row="Top Rated"] .tv-card').first().focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    const id = await page.locator(':focus').getAttribute('data-movie-id');
    const tx = await page.locator('[data-tv-row="Top Rated"] .tv-rail-track').getAttribute('data-tx');
    await page.evaluate(() => { window.__probe = document.querySelector('[data-tv-row="Popular Now"]'); window.__probeCard = document.querySelector('[data-tv-row="Top Rated"] .tv-card'); });
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    await page.locator('.tv-details-list').click(); // + My List -> onSignalChanged
    await page.waitForSelector('[data-tv-row="My List"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tv-details', { state: 'hidden' });
    await page.waitForFunction(i => document.activeElement && document.activeElement.dataset.movieId === i, id);
    assert.ok(await page.evaluate(() => window.__probe === document.querySelector('[data-tv-row="Popular Now"]') && window.__probeCard === document.querySelector('[data-tv-row="Top Rated"] .tv-card')), 'catalogue rows were not rebuilt');
    assert.deepEqual(await where(page), ['Top Rated', 6]);
    assertSameTx(await page.locator('[data-tv-row="Top Rated"] .tv-rail-track').getAttribute('data-tx'), tx, 'the rail stays where it was');
    const rows = await page.locator('.tv-row h2').allTextContents();
    assert.equal(rows[0], 'My List', 'the new personal row sits first');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the last media tab (All / Movies / TV) is remembered across a relaunch', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page } = await openApp();
  try {
    await page.locator('.tv-kind-tab[data-kind="tv"]').click();
    await page.waitForFunction(() => document.querySelector('.tv-kind-tab.active').dataset.kind === 'tv');
    await page.reload();
    await page.waitForSelector('.tv-card');
    assert.equal(await page.locator('.tv-kind-tab.active').getAttribute('data-kind'), 'tv');
  } finally { await browser.close(); }
});

const openLong = async (page) => {
  await page.locator(`.tv-card[data-movie-id="${LONG_ID}"]`).first().focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tv-details:not([hidden])');
  await page.waitForSelector('.tv-season-select');
};

test('a show with dozens of seasons has a season dropdown that lists EVERY season and opens on the current one', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page, errors } = await openApp({ progress: { [LONG_ID]: { season: 33, episode: 2, positionSec: 0, durationSec: 0, timestamp: Date.now() } } });
  try {
    await openLong(page);
    const info = await page.evaluate(() => {
      const select = document.querySelector('.tv-season-select');
      return { options: select.options.length, value: select.value, chips: document.querySelectorAll('.tv-season-chip').length, meta: document.querySelector('.tv-details-meta').textContent, first: select.options[0].textContent, tag: select.tagName };
    });
    assert.equal(info.options, 38, 'every season is an option (nothing hidden off screen)');
    assert.equal(info.value, '33', 'opens on the season you are in');
    assert.equal(info.chips, 0, 'no wall of chips');
    assert.match(info.meta, /38 Seasons/);
    assert.match(info.first, /Season 1 .*24 episodes/, 'each option shows its episode count');
    await page.waitForSelector('.tv-episode[data-season="33"]');
    // OK on the dropdown opens the TV picker with all 38; choosing one loads that season.
    await page.locator('.tv-season-select').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-picker');
    assert.equal(await page.locator('.tv-picker button').count(), 38);
    await page.locator('.tv-picker button', { hasText: /^Season 5 / }).click();
    await page.waitForFunction(() => document.querySelector('.tv-episode') && document.querySelector('.tv-episode').dataset.season === '5');
    assert.equal(await page.locator('.tv-season-select').inputValue(), '5');
    // Down from Play reaches the episodes within a few presses.
    await page.locator('.tv-details-play').focus();
    let presses = 0;
    for (; presses < 6; presses++) { await page.keyboard.press('ArrowDown'); if (await page.evaluate(() => document.activeElement.classList.contains('tv-episode'))) break; }
    assert.ok(presses <= 2, `episodes reached after ${presses + 1} presses`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('trailer candidates are prefetched while a tile rests under focus, and the trailer starts with no fixed wait', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page } = await openApp();
  try {
    const videoRequests = [];
    page.on('request', r => { if (new RegExp(`/tv/${LONG_ID}/videos`).test(r.url())) videoRequests.push(Date.now()); });
    await page.locator(`.tv-card[data-movie-id="${LONG_ID}"]`).first().focus();
    await page.waitForTimeout(1100);
    assert.equal(videoRequests.length, 1, 'the candidates were requested while the tile was only focused');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not([hidden])');
    const t0 = Date.now();
    await page.waitForSelector('.tv-details-trailer iframe', { timeout: 5000 });
    assert.ok(Date.now() - t0 < 1000, `the player starts loading straight away (${Date.now() - t0} ms), not after a fixed 1.2 s wait`);
    assert.equal(videoRequests.length, 1, 'opening the details did not repeat the lookup');
  } finally { await browser.close(); }
});

test('a long season is drawn in pages, more episodes arrive as you move down it', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page } = await openApp();
  try {
    await openLong(page);
    await page.waitForSelector('.tv-episode');
    const first = await page.locator('.tv-episode').count();
    assert.ok(first > 0 && first <= 12, `first page has ${first} episodes, not all 24`);
    await page.locator('.tv-episode').nth(first - 1).focus();
    await page.waitForFunction(n => document.querySelectorAll('.tv-episode').length > n, first);
    await page.locator('.tv-episode').last().focus();
    await page.waitForFunction(() => document.querySelectorAll('.tv-episode').length === 24);
    assert.equal(await page.locator('.tv-episode').count(), 24);
  } finally { await browser.close(); }
});

test('the trailer is shown only once it is playing, falls back when a candidate fails, and stops when you leave the buttons', { skip: !process.env.TV_E2E, timeout: 60000 }, async () => {
  const { browser, page } = await openApp();
  try {
    await openLong(page);
    await page.waitForSelector('.tv-details-trailer iframe', { timeout: 10000 });
    const src = () => page.evaluate(() => { const f = document.querySelector('.tv-details-trailer iframe'); return f ? f.src : ''; });
    assert.match(await src(), /embed\/AAAAAAAAAAA\?/);
    assert.match(await src(), /enablejsapi=1/, 'the player API is enabled so the page can tell what the trailer is doing');
    const playing = () => page.evaluate(() => document.querySelector('.tv-details-trailer').classList.contains('playing'));
    assert.equal(await playing(), false, 'the backdrop stays until the video is really playing (no black box / spinner)');
    assert.equal(await page.evaluate(() => document.querySelector('.tv-details').classList.contains('trailer-loading')), true, 'a "Loading trailer" hint explains the wait');
    const fromYoutube = data => page.evaluate(d => { const f = document.querySelector('.tv-details-trailer iframe'); window.dispatchEvent(new MessageEvent('message', { source: f.contentWindow, origin: 'https://www.youtube.com', data: JSON.stringify(d) })); }, data);
    await fromYoutube({ event: 'onError', info: 101 }); // embedding disabled for the first candidate
    await page.waitForFunction(() => /embed\/BBBBBBBBBBB\?/.test((document.querySelector('.tv-details-trailer iframe') || {}).src || ''));
    assert.equal(await playing(), false);
    await fromYoutube({ event: 'onStateChange', info: 1 });
    await page.waitForFunction(() => document.querySelector('.tv-details-trailer').classList.contains('playing'));
    assert.equal(await page.evaluate(() => document.querySelector('.tv-details').classList.contains('trailer-loading')), false, 'the hint goes once it plays');
    // It keeps playing while you browse down to the seasons and episodes (no pausing, no hiding).
    await page.locator('.tv-season-select').focus();
    await page.locator('.tv-episode').first().focus();
    await page.waitForTimeout(400);
    assert.equal(await playing(), true, 'the trailer is still playing behind the episode list');
    assert.equal(await page.evaluate(() => !!document.querySelector('.tv-details-trailer iframe')), true);
    // Closing the screen silences it at once and destroys the player when the page is idle (not on the key press).
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tv-details', { state: 'hidden' });
    assert.equal(await playing(), false);
    await page.waitForFunction(() => !document.querySelector('.tv-details-trailer iframe'), null, { timeout: 8000 });
  } finally { await browser.close(); }
});

const focusedRowIndex = page => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#main .tv-row')].filter(r => r.querySelector('.tv-card') || r.__dry);
  const a = document.activeElement; const row = a && a.closest && a.closest('.tv-row');
  return { index: row ? rows.indexOf(row) : -1, rows: rows.length };
});
const walkDown = async (page, target) => {
  for (let i = 0; i < 160; i++) {
    const { index, rows } = await focusedRowIndex(page);
    if (index >= target) return index;
    if (index >= rows - 1) await page.waitForFunction(n => [...document.querySelectorAll('#main .tv-row')].filter(r => r.querySelector('.tv-card') || r.__dry).length > n, rows, { timeout: 20000 }).catch(() => {});
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);
  }
  return (await focusedRowIndex(page)).index;
};

test('going deep down the home keeps the page small: far rows are emptied to same-height placeholders and refill on the way back', { skip: !process.env.TV_E2E, timeout: 180000 }, async () => {
  const { browser, page, errors } = await openApp();
  try {
    await page.locator('#main .tv-row .tv-card').first().focus();
    const heightAtTop = await page.evaluate(() => document.documentElement.scrollHeight);
    const reached = await walkDown(page, 30);
    assert.ok(reached >= 30, `walked down to row ${reached + 1}`);
    await page.waitForFunction(() => document.querySelectorAll('#main .tv-card').length <= 240, null, { timeout: 20000 }); // upkeep runs once you pause, one row per idle slice
    const deep = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#main .tv-row')].filter(r => r.__total);
      return {
        tiles: document.querySelectorAll('#main .tv-card').length,
        dry: rows.filter(r => r.__dry).length,
        rows: rows.length,
        broken: rows.filter(r => r.querySelectorAll('.tv-card').length + (r.__rest || []).length !== r.__total).map(r => r.dataset.tvRow),
        heightDeep: document.documentElement.scrollHeight,
      };
    });
    assert.ok(deep.dry >= 10, `${deep.dry} of ${deep.rows} rows are emptied`);
    assert.ok(deep.tiles <= 240, `only the rows near you stay drawn: ${deep.tiles} tiles, not ${deep.rows * 12}`);
    assert.deepEqual(deep.broken, [], 'every row still knows all of its titles (drawn + waiting = total)');
    assert.ok(deep.heightDeep >= heightAtTop, 'the page did not collapse');
    // Back up: rows refill before you reach them, focus is never lost, and each row keeps the position you left it at.
    let lost = 0;
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(90);
      if (!await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('tv-card'))) lost++;
    }
    assert.equal(lost, 0, 'focus stayed on a tile for every Up press');
    assert.ok((await focusedRowIndex(page)).index < reached - 15);
    const driedAgain = await page.evaluate(() => [...document.querySelectorAll('#main .tv-row')].filter(r => r.__dry).length);
    assert.ok(driedAgain >= 1, 'rows far from the new position are emptied again');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('an emptied row comes back where you left it (card and rail position)', { skip: !process.env.TV_E2E, timeout: 180000 }, async () => {
  const { browser, page } = await openApp();
  try {
    const [A] = await page.evaluate(() => [...document.querySelectorAll('#main .tv-row')].filter(r => r.querySelector('.tv-card')).map(r => r.dataset.tvRow));
    await page.locator(`[data-tv-row="${A}"] .tv-card`).first().focus();
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const before = await page.evaluate(a => { const r = document.querySelector(`[data-tv-row="${a}"]`); const f = document.activeElement; return { id: f.dataset.movieId, index: [...r.querySelectorAll('.tv-card')].indexOf(f), tx: r.querySelector('.tv-rail-track').dataset.tx }; }, A);
    await walkDown(page, 16);
    await page.waitForFunction(a => !!document.querySelector(`[data-tv-row="${a}"]`).__dry, A, { timeout: 15000 });
    assert.equal(await page.evaluate(a => !!document.querySelector(`[data-tv-row="${a}"]`).__dry, A), true, 'the first row is emptied while you are far away');
    // Jump back with Up presses.
    for (let i = 0; i < 20; i++) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(90); if ((await focusedRowIndex(page)).index === 0 || await page.evaluate(a => document.activeElement.closest('.tv-row') && document.activeElement.closest('.tv-row').dataset.tvRow === a, A)) break; }
    await page.waitForFunction(a => document.activeElement && document.activeElement.closest('.tv-row') && document.activeElement.closest('.tv-row').dataset.tvRow === a, A);
    const after = await page.evaluate(a => { const r = document.querySelector(`[data-tv-row="${a}"]`); const f = document.activeElement; return { id: f.dataset.movieId, index: [...r.querySelectorAll('.tv-card')].indexOf(f), tx: r.querySelector('.tv-rail-track').dataset.tx, dry: !!r.__dry }; }, A);
    assert.equal(after.dry, false);
    assert.equal(after.id, before.id, 'the same card');
    assert.equal(after.index, before.index);
    assertSameTx(after.tx, before.tx, 'the rail is where you left it');
  } finally { await browser.close(); }
});

test('a row change does no tile building inside the key press; far rows are emptied / refilled once you pause', { skip: !process.env.TV_E2E, timeout: 180000 }, async () => {
  const { browser, page } = await openApp();
  try {
    await page.locator('#main .tv-row .tv-card').first().focus();
    await walkDown(page, 14);
    // let the walk's own housekeeping finish, then check that one more press changes nothing synchronously
    await page.waitForFunction(() => document.querySelectorAll('#main .tv-row').length > 0 && !window.__pendingRows, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const sync = await page.evaluate(() => {
      const tiles = () => document.querySelectorAll('#main .tv-card').length;
      const dry = () => [...document.querySelectorAll('#main .tv-row')].filter(r => r.__dry).length;
      const before = { tiles: tiles(), dry: dry() };
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      return { before, during: { tiles: tiles(), dry: dry() } };
    });
    assert.deepEqual(sync.during, sync.before, 'the key press itself built/removed no tiles');
    // ... but once the user pauses, the window moves: a row beyond the slack is emptied.
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#main .tv-row')].filter(r => r.__virtual || r.__dry || r.querySelector('.tv-card'));
      const at = rows.indexOf(document.activeElement.closest('.tv-row'));
      return rows.slice(0, Math.max(0, at - 6)).every(r => r.__dry || !r.__all) && rows.slice(at, at + 4).every(r => !r.__dry);
    }, null, { timeout: 8000 });
  } finally { await browser.close(); }
});

// ---- Franchises: one tile per film series; it opens to every part, in order -----------------------------------------
import { FRANCHISES } from './franchises.js';
const FF = FRANCHISES.find(f => f.title === 'Fast & Furious');

test('Franchises row: a tile opens the series with numbered parts; Back unwinds part details -> series -> the tile', { skip: !process.env.TV_E2E, timeout: 120000 }, async () => {
  const { browser, page, errors } = await openApp();
  try {
    const titles = await page.evaluate(() => [...document.querySelectorAll('#main .tv-row')].map(r => r.dataset.tvRow));
    assert.ok(titles.includes('Franchises'), `the Franchises row is on the home (${titles.join(' | ')})`);
    assert.ok(titles.indexOf('Franchises') > titles.indexOf('Popular Now'), 'it sits below the top category rows, not above Trending');
    // walk to the Fast & Furious tile (the row draws a window of tiles at a time)
    await page.locator('[data-tv-row="Franchises"] .tv-card').first().focus();
    for (let i = 0; i < 20 && (await page.evaluate(() => document.activeElement.getAttribute('aria-label') || '')).indexOf('Fast & Furious') < 0; i++) await page.keyboard.press('ArrowRight');
    const tile = await page.evaluate(() => ({ label: document.activeElement.getAttribute('aria-label'), id: document.activeElement.dataset.movieId, badge: (document.activeElement.querySelector('.tv-card-badge') || {}).textContent }));
    assert.match(tile.label, /Fast & Furious/);
    assert.equal(tile.id, FF.id);
    assert.equal(tile.badge, `${FF.parts.length} films`, 'the tile says how many films it holds, not a star rating');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-franchise:not([hidden])');
    assert.equal(await page.locator('.tv-franchise .tv-details-title').textContent(), 'Fast & Furious');
    assert.match(await page.locator('.tv-franchise .tv-details-meta').textContent(), new RegExp(`^${FF.parts.length} films`));
    const parts = await page.evaluate(() => [...document.querySelectorAll('.tv-franchise .tv-card')].map(c => ({ id: c.dataset.movieId, n: (c.querySelector('.tv-card-rank') || {}).textContent })));
    assert.deepEqual(parts.map(p => p.id), FF.parts.map(p => String(p.id)), 'every part, in release order');
    assert.deepEqual(parts.slice(0, 3).map(p => p.n), ['1', '2', '3'], 'numbered Part 1, 2, 3');
    const wide = await page.evaluate(() => [...document.querySelectorAll('.tv-franchise .tv-card')].map(c => c.classList.contains('tv-card-ranked-wide')));
    assert.deepEqual(wide, FF.parts.map((_, i) => i + 1 >= 10), 'two-digit part numbers get extra room so they do not run into the title');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.movieId), String(FF.parts[0].id), 'opens on Part 1 when nothing is watched');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.movieId), String(FF.parts[1].id), 'Right moves to Part 2');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tv-details:not(.tv-franchise):not([hidden])');
    assert.equal(await page.locator('.tv-franchise').getAttribute('hidden'), '', 'the series screen steps aside for the film');
    assert.equal(await page.locator('.tv-details:not(.tv-franchise) .tv-details-title').textContent(), FF.parts[1].title);
    await page.keyboard.press('Escape'); // Back from the film
    await page.waitForSelector('.tv-franchise:not([hidden])');
    await page.waitForFunction(id => document.activeElement && document.activeElement.dataset.movieId === id, String(FF.parts[1].id)); // focus is restored one tick after the screen changes
    assert.equal(await page.evaluate(() => document.activeElement.dataset.movieId), String(FF.parts[1].id), 'back on Part 2 in the series');
    await page.keyboard.press('Escape'); // Back from the series
    await page.waitForSelector('.tv-franchise', { state: 'hidden' });
    await page.waitForFunction(id => document.activeElement && document.activeElement.dataset.movieId === id, FF.id, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.activeElement.dataset.movieId), FF.id, 'focus returns to the Franchises tile');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Franchises row: on the Movies tab, not on the TV tab', { skip: !process.env.TV_E2E, timeout: 120000 }, async () => {
  const { browser, page } = await openApp();
  try {
    const rows = () => page.evaluate(() => [...document.querySelectorAll('#main .tv-row')].map(r => r.dataset.tvRow));
    for (const [kind, expected] of [['movie', true], ['tv', false]]) {
      await page.locator(`.tv-kind-tab[data-kind="${kind}"]`).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(k => document.querySelector(`.tv-kind-tab[data-kind="${k}"]`).classList.contains('active'), kind);
      await page.waitForFunction(() => document.querySelectorAll('#main .tv-row .tv-card').length > 12);
      await page.waitForTimeout(800);
      assert.equal((await rows()).includes('Franchises'), expected, `${kind} tab`);
    }
  } finally { await browser.close(); }
});
