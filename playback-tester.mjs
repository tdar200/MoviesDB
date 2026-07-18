// playback-tester.mjs — REAL playback verification with Playwright.
//
// Puppeteer (even headful + stealth) gets a 403 from the providers' stream CDNs:
// their anti-bot fingerprints the automation. Playwright driving the *real Chrome
// channel*, headed, with navigator.webdriver hidden, streams for real — verified
// Jul 2026 (Videasy advanced 10s of video in a 16s window, zero CDN 403s).
//
// Headed Chrome needs a display. In headless CI wrap the run in a virtual one:
//   xvfb-run -a --server-args="-screen 0 1280x720x24" node --test check-playback.test.js
// (the `npm run check-playback` script does this for you).

import { chromium } from 'playwright';
import { EMBED_SOURCES as SHARED_SOURCES, BLOCKED_PROVIDERS } from './embed-sources.js';

// The list the app actually plays, minus the torrent source and known-dead hosts.
export const EMBED_SOURCES = SHARED_SOURCES.filter(
  (s) => !s.torrent && !BLOCKED_PROVIDERS.includes(s.name)
);

// Launch a persistent Chrome context tuned to look like a real user, not a bot.
// A persistent (non-incognito) context + the real 'chrome' channel + hidden
// webdriver flag is the combination that gets past the stream CDNs.
export async function launchContext({ headless = false, profileDir = '/tmp/moviesdb-pw-profile' } = {}) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless,
    channel: 'chrome',
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

// Nudge a provider into playing. Players create/start the <video> only after a
// real gesture, and the button often lives in a nested cross-origin iframe, so we:
//  1) click any <video> element (correct cross-frame coords via ElementHandle),
//  2) click the most-central labelled/clickable overlay in EVERY frame,
//  3) press Space / k (common player shortcuts),
//  4) call video.play() (muted, so autoplay policy can't block it).
// Handle-based clicks are used (not page.mouse) so iframe-relative coordinates map
// correctly — page.mouse at a frame's local coords would click the wrong spot.
async function nudgePlay(page) {
  for (const frame of page.frames()) {
    // 1) click video elements directly
    for (const v of await frame.$$('video').catch(() => [])) {
      const box = await v.boundingBox().catch(() => null);
      if (box && box.width > 100) await v.click({ force: true, timeout: 1500 }).catch(() => {});
    }
    // 2) click the best central overlay/button
    const handles = await frame.$$('button,[role="button"],[class*="play" i],[aria-label*="play" i],.vjs-big-play-button,.plyr__control--overlaid,svg,div').catch(() => []);
    let best = null, bestScore = -1;
    for (const h of handles) {
      const box = await h.boundingBox().catch(() => null);
      if (!box || box.width < 32 || box.height < 32 || box.width > 1200) continue;
      const info = await h.evaluate((el) => (el.getAttribute('aria-label') || '') + ' ' + el.className).catch(() => '');
      const score = (/play/i.test(info) ? 800 : 0) - Math.hypot(box.x + box.width / 2 - 640, box.y + box.height / 2 - 360);
      if (score > bestScore) { bestScore = score; best = h; }
    }
    if (best) await best.click({ force: true, timeout: 1500 }).catch(() => {});
  }
  // 3) keyboard play shortcuts
  await page.keyboard.press('Space').catch(() => {});
  await page.keyboard.press('k').catch(() => {});
  // 4) direct muted play()
  for (const frame of page.frames()) {
    try { await frame.evaluate(() => document.querySelectorAll('video').forEach((v) => { v.muted = true; v.play?.().catch(() => {}); })); } catch { /* frame gone */ }
  }
}

// Highest video currentTime across all frames (players nest video in an iframe).
async function maxVideoTime(page) {
  let best = 0;
  for (const frame of page.frames()) {
    const t = await frame.evaluate(
      () => Math.max(0, ...[...document.querySelectorAll('video')].map((v) => v.currentTime || 0))
    ).catch(() => 0);
    best = Math.max(best, t);
  }
  return best;
}

// Play one source and measure whether video time actually advances. Polls up to
// maxWaitMs, re-nudging each round, and returns as soon as it detects real
// progress (providers resolve the stream server-side, which can take 20-40s).
// Returns { name, url, played, advancedSecs, forbidden, error }.
export async function testPlayback(ctx, source, { mediaType = 'movie', mediaId = 27205, season = 1, episode = 1, maxWaitMs = 40000 } = {}) {
  const url = source.getUrl(mediaType, mediaId, season, episode);
  const page = await ctx.newPage();
  page.on('popup', (pop) => pop.close().catch(() => {})); // ads open popups — close them
  let forbidden = 0;
  page.on('response', (r) => {
    if (r.status() === 403 && /stream|\.m3u8|\.ts|\.mp4|vd\/|cdn|moon|cloud|seg/i.test(r.url())) forbidden++;
  });
  const result = { name: source.name, url, played: false, advancedSecs: 0, forbidden: 0, error: null };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(3500);
    const t0 = await maxVideoTime(page);
    let elapsed = 0;
    const ROUND = 4000;
    while (elapsed < maxWaitMs) {
      await nudgePlay(page);
      await page.waitForTimeout(ROUND);
      elapsed += ROUND;
      const adv = (await maxVideoTime(page)) - t0;
      if (adv > 1.5) { result.advancedSecs = +adv.toFixed(1); break; }
    }
    if (!result.advancedSecs) result.advancedSecs = +((await maxVideoTime(page)) - t0).toFixed(1);
    result.played = result.advancedSecs > 1;
    result.forbidden = forbidden;
  } catch (e) {
    result.error = e.message?.slice(0, 80) || String(e);
  } finally {
    await page.close().catch(() => {});
  }
  return result;
}
