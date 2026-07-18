// check-playback.test.js — REAL playback check via Playwright + real Chrome.
//
// Loads each provider in a genuine Chrome (channel:'chrome', headed, webdriver
// hidden), clicks the real play button, and watches the <video> element's
// currentTime advance — proving a movie actually streams end-to-end. This is the
// setup that gets past the providers' stream-CDN anti-bot (plain Puppeteer, even
// with stealth, is 403'd; see playback-tester.mjs).
//
// Gated behind CHECK_PLAYBACK=1 (slow, needs Chrome + a display, hits third-party
// hosts). Headed Chrome needs a display, so run it through the npm script which
// wraps it in Xvfb:
//
//   npm run check-playback
//   CHECK_PLAYBACK=1 node --test check-playback.test.js   # needs a real DISPLAY
//
// Tuning via env: PLAYBACK_SOURCES (top-N sources to try, default 6),
// PLAYBACK_MAXWAIT_SECS (max wait per source before giving up, default 40 —
// it returns early as soon as playback is detected).
//
// Caveat: providers whose player lives in a nested iframe with a non-central play
// button may report 0s here even when a human can play them — the click heuristic
// misses their button. The hard assertion is therefore "at least one source
// actually streams", which proves the pipeline + CDN access work; per-source
// results are emitted as diagnostics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMBED_SOURCES, launchContext, testPlayback } from './playback-tester.mjs';

const RUN = process.env.CHECK_PLAYBACK === '1';
const N = Math.max(1, parseInt(process.env.PLAYBACK_SOURCES || '6', 10));
const MAXWAIT_SECS = Math.max(10, parseInt(process.env.PLAYBACK_MAXWAIT_SECS || '40', 10));
const hasDisplay = !!process.env.DISPLAY;

// Media under test — override via env to check newer titles / TV episodes:
//   PLAYBACK_TYPE=movie|tv  PLAYBACK_ID=<tmdb>  PLAYBACK_SEASON=<n>  PLAYBACK_EPISODE=<n>
// PLAYBACK_ALL=1 tests every embeddable source (no early-exit) for a full matrix.
const MEDIA = {
  mediaType: process.env.PLAYBACK_TYPE || 'movie',
  mediaId: parseInt(process.env.PLAYBACK_ID || '27205', 10), // default: Inception
  season: parseInt(process.env.PLAYBACK_SEASON || '1', 10),
  episode: parseInt(process.env.PLAYBACK_EPISODE || '1', 10),
};
const TEST_ALL = process.env.PLAYBACK_ALL === '1';
const mediaLabel = MEDIA.mediaType === 'tv' ? `tv ${MEDIA.mediaId} S${MEDIA.season}E${MEDIA.episode}` : `movie ${MEDIA.mediaId}`;

test('real playback check is opt-in', { skip: RUN ? false : 'set CHECK_PLAYBACK=1 (use `npm run check-playback`) to run the real-browser playback check' }, async (t) => {
  assert.ok(hasDisplay, 'no DISPLAY — headed Chrome needs one. Run via `npm run check-playback` (wraps Xvfb) or export DISPLAY.');
  t.diagnostic(`media under test: ${mediaLabel}${TEST_ALL ? ' | testing ALL sources' : ''}`);

  const sources = TEST_ALL ? EMBED_SOURCES : EMBED_SOURCES.slice(0, N);
  const ctx = await launchContext({ headless: false });
  const results = [];

  try {
    for (const source of sources) {
      // Per-source subtest: report measured playback, never hard-fail (providers
      // rot / have quirky player UIs individually — the aggregate is the gate).
      await t.test(`${source.name} playback`, async () => {
        const r = await testPlayback(ctx, source, { ...MEDIA, maxWaitMs: MAXWAIT_SECS * 1000 });
        results.push(r);
        t.diagnostic(`${source.name}: ${r.played ? 'PLAYS' : 'no play'} (advanced ${r.advancedSecs}s, CDN-403s ${r.forbidden}${r.error ? ', err: ' + r.error : ''})`);
      });
      // In default mode, one confirmed stream proves the pipeline works — stop so a
      // healthy run finishes fast. PLAYBACK_ALL=1 disables this to test every source.
      if (!TEST_ALL && results.some((r) => r.played)) break;
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  await t.test('at least one source actually streams video', () => {
    const playing = results.filter((r) => r.played);
    const summary = results.map((r) => `${r.name}=${r.played ? `PLAYS(${r.advancedSecs}s)` : 'no'}`).join(', ');
    assert.ok(playing.length >= 1, `no source produced measurable playback for ${mediaLabel} across ${results.length} sources [${summary}]`);
  });
});
