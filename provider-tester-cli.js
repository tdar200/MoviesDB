#!/usr/bin/env node

import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { EMBED_SOURCES as SHARED_SOURCES, BLOCKED_PROVIDERS } from './embed-sources.js';

// Wrap puppeteer with the stealth plugin so these providers (which sniff for
// headless/automation and refuse to stream to a bot) see a normal browser.
const stealthPuppeteer = addExtra(puppeteer);
stealthPuppeteer.use(StealthPlugin());

// Helper function to wait (replacement for deprecated waitForTimeout)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Test the exact list the app plays (embed-sources.js), minus the torrent source
// (not an iframe) and any providers already known-dead (BLOCKED_PROVIDERS).
const EMBED_SOURCES = SHARED_SOURCES.filter(
  (s) => !s.torrent && !BLOCKED_PROVIDERS.includes(s.name)
);

// Resolve a Chrome/Chromium binary: env override, then Puppeteer's own download,
// then a system install. Lets the tester run without downloading a bundled browser.
export function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch { /* no bundled browser */ }
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(c)) return c;
  }
  return undefined; // let Puppeteer decide / throw a clear error
}

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-quic',
  '--enable-features=NetworkService,NetworkServiceInProcess',
];

// Launch a browser configured for provider testing. Shared by the CLI and the
// CHECK_PLAYBACK gated test so both behave identically.
export async function launchBrowser({ headless = true } = {}) {
  return stealthPuppeteer.launch({
    headless: headless ? 'new' : false,
    executablePath: findChrome(),
    args: LAUNCH_ARGS,
  });
}

export { EMBED_SOURCES };

// Common play button selectors
const PLAY_BUTTON_SELECTORS = [
  // Generic play buttons
  'button[class*="play"]',
  'div[class*="play"]',
  'span[class*="play"]',
  'a[class*="play"]',
  '[class*="play-button"]',
  '[class*="playButton"]',
  '[class*="play_button"]',
  '[id*="play"]',
  // Video.js
  '.vjs-big-play-button',
  '.vjs-play-control',
  // Plyr
  '.plyr__control--overlaid',
  '[data-plyr="play"]',
  // JW Player
  '.jw-icon-playback',
  '.jw-display-icon-container',
  // Generic
  '[aria-label*="play" i]',
  '[title*="play" i]',
  // SVG play icons (click parent)
  'svg[class*="play"]',
  // Center play overlays
  '.play-overlay',
  '.video-play',
  '.center-play-button',
  // iframe specific
  '.play-icon',
  '.btn-play',
  '#play',
  '.player-play',
];

// Configuration
const CONFIG = {
  timeout: 45000,           // 45 seconds page timeout
  streamDuration: 120000,   // 2 minutes of streaming test per provider
  checkInterval: 10000,     // Check video progress every 10 seconds
  concurrency: 2,           // Test 2 providers at a time (more stable)
  testDuration: 600000,     // 10 minutes total test
  minPlaybackRatio: 0.7,    // At least 70% of expected playback time
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mediaType: 'movie',
    mediaId: 27205, // Inception (default)
    season: 1,
    episode: 1,
    concurrency: CONFIG.concurrency,
    duration: CONFIG.testDuration,
    streamDuration: CONFIG.streamDuration,
    output: 'provider-results.json',
    headless: true,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type':
      case '-t':
        options.mediaType = args[++i];
        break;
      case '--id':
      case '-i':
        options.mediaId = parseInt(args[++i], 10);
        break;
      case '--season':
      case '-s':
        options.season = parseInt(args[++i], 10);
        break;
      case '--episode':
      case '-e':
        options.episode = parseInt(args[++i], 10);
        break;
      case '--concurrency':
      case '-c':
        options.concurrency = parseInt(args[++i], 10);
        break;
      case '--duration':
      case '-d':
        options.duration = parseInt(args[++i], 10) * 1000;
        break;
      case '--stream':
      case '-S':
        options.streamDuration = parseInt(args[++i], 10) * 1000;
        break;
      case '--output':
      case '-o':
        options.output = args[++i];
        break;
      case '--visible':
      case '-v':
        options.headless = false;
        break;
      case '--help':
      case '-h':
        console.log(`
Video Provider Tester - Puppeteer CLI

Usage: node provider-tester-cli.js [options]

Options:
  -t, --type <type>       Media type: movie or tv (default: movie)
  -i, --id <id>           TMDB ID (default: 27205 - Inception)
  -s, --season <num>      Season number for TV (default: 1)
  -e, --episode <num>     Episode number for TV (default: 1)
  -c, --concurrency <num> Number of parallel tests (default: 2)
  -d, --duration <sec>    Total test duration in seconds (default: 600)
  -S, --stream <sec>      Stream duration per provider in seconds (default: 120)
  -o, --output <file>     Output JSON file (default: provider-results.json)
  -v, --visible           Show browser window (not headless)
  -h, --help              Show this help

Stream Quality Ratings:
  EXCELLENT (90%+)  - Video played smoothly for nearly all of test duration
  GOOD (70-90%)     - Video played well with minor buffering
  FAIR (50-70%)     - Video played but with noticeable buffering
  POOR (5s+)        - Video barely played, heavy buffering
  FAILED            - Video did not play

Examples:
  node provider-tester-cli.js                          # Default 2-min test
  node provider-tester-cli.js -S 60 -v                 # 1-min test, visible
  node provider-tester-cli.js -t movie -i 550 -S 120   # Test Fight Club for 2 mins
  node provider-tester-cli.js -t tv -i 1396 -s 1 -e 1  # Test Breaking Bad S1E1
        `);
        process.exit(0);
    }
  }

  return options;
}

// Find the "best" <video> across every frame Puppeteer is attached to (the top
// document AND nested cross-origin iframes — the DevTools protocol reaches into
// them regardless of same-origin policy). Prefers a video that is actively
// advancing/playing over a merely-present one.
async function scanFramesForVideo(page) {
  const none = { found: false, currentTime: 0, paused: true, ended: false, readyState: 0, duration: 0 };
  let best = none;
  for (const frame of page.frames()) {
    let state;
    try {
      state = await frame.evaluate(() => {
        const videos = document.querySelectorAll('video');
        let pick = null;
        for (const v of videos) {
          if (!pick) pick = v;
          // Prefer a playing video with real progress.
          if (!v.paused && v.currentTime > 0) { pick = v; break; }
        }
        if (!pick) return null;
        return {
          found: true,
          currentTime: pick.currentTime,
          paused: pick.paused,
          ended: pick.ended,
          readyState: pick.readyState,
          duration: pick.duration || 0,
        };
      });
    } catch {
      // Frame detached/navigated mid-scan — skip it.
      continue;
    }
    if (state?.found) {
      if (!best.found) best = state;
      // A playing, progressing video wins immediately.
      if (!state.paused && state.currentTime > 0) return state;
    }
  }
  return best;
}

// Test a single provider
export async function testProvider(browser, source, index, options) {
  const { mediaType, mediaId, season, episode } = options;
  const url = source.getUrl(mediaType, mediaId, season, episode);

  const result = {
    index,
    name: source.name,
    url,
    status: 'testing',
    loadTime: null,
    hasVideo: false,
    videoPlaying: false,
    playButtonFound: false,
    playButtonClicked: false,
    error: null,
    score: 0,
    // New streaming metrics
    streamStartTime: null,
    streamEndTime: null,
    videoTimeStart: 0,
    videoTimeEnd: 0,
    actualPlayback: 0,      // Actual video time played (seconds)
    expectedPlayback: 0,    // Expected playback time (seconds)
    playbackRatio: 0,       // actualPlayback / expectedPlayback
    bufferingEvents: 0,
    streamQuality: 'unknown',
  };

  const page = await browser.newPage();

  // Handle popups opened by this page
  page.on('popup', async (popup) => {
    console.log(`  🚫 ${source.name}: Blocked popup`);
    await popup.close().catch(() => {});
  });

  try {
    console.log(`[${index + 1}/${EMBED_SOURCES.length}] Testing ${source.name}...`);

    // Set realistic user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Set viewport
    await page.setViewport({ width: 1280, height: 720 });

    // Set extra headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    // Block popups and new tabs via JavaScript injection
    await page.evaluateOnNewDocument(() => {
      // Override window.open to block popups
      window.open = () => null;

      // Prevent creating new windows
      window.addEventListener('beforeunload', (e) => {
        e.preventDefault();
        return;
      });

      // Block target="_blank" links
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link && (link.target === '_blank' || link.href?.includes('javascript:'))) {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }, true);

      // Override alert/confirm/prompt
      window.alert = () => {};
      window.confirm = () => true;
      window.prompt = () => null;
    });

    // Block ad-related requests
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url().toLowerCase();
      const blockedDomains = [
        'doubleclick', 'googlesyndication', 'googleadservices',
        'adservice', 'adsystem', 'adnxs', 'advertising',
        'popads', 'popcash', 'popunder', 'clickadu',
        'juicyads', 'exoclick', 'trafficjunky', 'propellerads',
        'revcontent', 'mgid', 'taboola', 'outbrain',
        'facebook.com/tr', 'analytics', 'tracker',
        'popup', 'popunder', '.ads.', '/ads/',
      ];

      const isBlocked = blockedDomains.some(domain => url.includes(domain));
      const resourceType = req.resourceType();

      // Block ads and unnecessary resources
      if (isBlocked || resourceType === 'image' && url.includes('ad')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate to the URL
    const startTime = Date.now();

    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: CONFIG.timeout,
      });
    } catch (navError) {
      // Some sites may partially load, continue anyway
      if (!navError.message.includes('timeout')) {
        result.status = 'load_failed';
        result.error = `Navigation failed: ${navError.message}`;
        console.log(`  ❌ ${source.name}: Load failed - ${navError.message.substring(0, 50)}`);
        return result;
      }
      console.log(`  ⏱️ ${source.name}: Timeout but continuing...`);
    }

    result.loadTime = Date.now() - startTime;

    // Wait a bit for dynamic content
    await sleep(2000);

    // Check for a video element in ANY frame (players usually live in a nested
    // cross-origin iframe, invisible to the top document alone).
    result.hasVideo = (await scanFramesForVideo(page)).found;

    // Try to find and click play button
    for (const selector of PLAY_BUTTON_SELECTORS) {
      try {
        const button = await page.$(selector);
        if (button) {
          result.playButtonFound = true;
          const isVisible = await button.isIntersectingViewport();

          if (isVisible) {
            await button.click();
            result.playButtonClicked = true;
            console.log(`  ▶ ${source.name}: Clicked play button (${selector})`);
            break;
          }
        }
      } catch (e) {
        // Selector didn't match, continue
      }
    }

    // If no play button found, try clicking the center of the page
    if (!result.playButtonClicked) {
      try {
        await page.mouse.click(640, 360);
        console.log(`  ▶ ${source.name}: Clicked center of page`);
        result.playButtonClicked = true;
      } catch (e) {
        // Ignore click errors
      }
    }

    // Wait a moment for video to initialize
    await sleep(3000);

    // Get video state across all frames (top page + nested iframes).
    const getVideoState = () => scanFramesForVideo(page);

    let initialState = await getVideoState();

    // If no video playing yet, wait and try clicking again
    if (!initialState.found || initialState.paused) {
      await sleep(3000);
      // Try clicking center again (lands inside the player iframe)
      try {
        await page.mouse.click(640, 360);
      } catch (e) {}
      // Also directly call play() on any <video> in any frame — autoplay is allowed
      // by the launch flags, so this starts playback without a real gesture.
      for (const frame of page.frames()) {
        try { await frame.evaluate(() => document.querySelectorAll('video').forEach((v) => v.play?.().catch(() => {}))); } catch { /* frame gone */ }
      }
      await sleep(2000);
      initialState = await getVideoState();
    }

    if (!initialState.found) {
      result.status = 'no_video';
      result.score = 0;
      console.log(`  ❌ ${source.name}: No video element found`);
    } else {
      // Start 2-minute streaming test
      result.streamStartTime = Date.now();
      result.videoTimeStart = initialState.currentTime;

      const streamDuration = options.streamDuration || CONFIG.streamDuration;
      const checkInterval = CONFIG.checkInterval;
      const checks = Math.floor(streamDuration / checkInterval);

      console.log(`  ⏱️ ${source.name}: Starting ${streamDuration/1000}s stream test...`);

      let lastVideoTime = initialState.currentTime;
      let stalls = 0;

      for (let i = 0; i < checks; i++) {
        await sleep(checkInterval);

        const state = await getVideoState();
        const elapsed = ((i + 1) * checkInterval) / 1000;

        // Check if video time is progressing
        if (state.currentTime <= lastVideoTime && !state.paused && !state.ended) {
          stalls++;
          result.bufferingEvents++;
        }

        lastVideoTime = state.currentTime;

        // Log progress every 30 seconds
        if ((i + 1) % 3 === 0) {
          const videoPlayed = state.currentTime - result.videoTimeStart;
          console.log(`     ${source.name}: ${elapsed}s elapsed, video time: ${videoPlayed.toFixed(1)}s`);
        }
      }

      // Final measurement
      const finalState = await getVideoState();
      result.streamEndTime = Date.now();
      result.videoTimeEnd = finalState.currentTime;

      // Calculate metrics
      const wallClockTime = (result.streamEndTime - result.streamStartTime) / 1000;
      result.actualPlayback = result.videoTimeEnd - result.videoTimeStart;
      result.expectedPlayback = wallClockTime;
      result.playbackRatio = result.actualPlayback / result.expectedPlayback;

      // Determine quality based on playback ratio
      if (result.playbackRatio >= 0.9) {
        result.streamQuality = 'excellent';
        result.score = 100;
        result.status = 'streaming';
        result.videoPlaying = true;
      } else if (result.playbackRatio >= 0.7) {
        result.streamQuality = 'good';
        result.score = 80;
        result.status = 'streaming';
        result.videoPlaying = true;
      } else if (result.playbackRatio >= 0.5) {
        result.streamQuality = 'fair';
        result.score = 60;
        result.status = 'buffering';
        result.videoPlaying = true;
      } else if (result.actualPlayback > 5) {
        result.streamQuality = 'poor';
        result.score = 40;
        result.status = 'unstable';
        result.videoPlaying = true;
      } else {
        result.streamQuality = 'failed';
        result.score = 10;
        result.status = 'not_playing';
        result.videoPlaying = false;
      }

      console.log(`  ${result.score >= 80 ? '✅' : result.score >= 50 ? '⚠️' : '❌'} ${source.name}: ${result.streamQuality.toUpperCase()} - Played ${result.actualPlayback.toFixed(1)}s / ${result.expectedPlayback.toFixed(1)}s (${(result.playbackRatio * 100).toFixed(0)}%) - ${result.bufferingEvents} stalls`);
    }

  } catch (error) {
    result.status = 'error';
    result.error = error.message;
    console.log(`  ❌ ${source.name}: Error - ${error.message}`);
  } finally {
    await page.close().catch(() => {});
  }

  return result;
}

// Run tests with concurrency limit
async function runTests(options) {
  console.log('\n========================================');
  console.log('     VIDEO PROVIDER TESTER (Puppeteer)');
  console.log('========================================\n');
  console.log(`Media Type: ${options.mediaType}`);
  console.log(`Media ID: ${options.mediaId}`);
  if (options.mediaType === 'tv') {
    console.log(`Season: ${options.season}, Episode: ${options.episode}`);
  }
  console.log(`Stream Test Duration: ${options.streamDuration / 1000}s per provider`);
  console.log(`Concurrency: ${options.concurrency}`);
  console.log(`Headless: ${options.headless}`);
  console.log(`Total Providers: ${EMBED_SOURCES.length}`);
  console.log('----------------------------------------\n');

  const browser = await launchBrowser({ headless: options.headless });

  // We'll handle popups at the page level instead

  const results = [];
  const startTime = Date.now();

  // Process providers in batches
  for (let i = 0; i < EMBED_SOURCES.length; i += options.concurrency) {
    const batch = EMBED_SOURCES.slice(i, i + options.concurrency);
    const batchPromises = batch.map((source, batchIndex) =>
      testProvider(browser, source, i + batchIndex, options)
    );

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Check if we've exceeded test duration
    if (Date.now() - startTime > options.duration) {
      console.log('\n⏱️ Test duration exceeded, stopping...\n');
      break;
    }
  }

  await browser.close();

  return results;
}

// Generate report
function generateReport(results, options) {
  const excellent = results.filter(r => r.streamQuality === 'excellent');
  const good = results.filter(r => r.streamQuality === 'good');
  const fair = results.filter(r => r.streamQuality === 'fair');
  const poor = results.filter(r => r.streamQuality === 'poor');
  const failed = results.filter(r => ['no_video', 'error', 'load_failed', 'failed'].includes(r.status) || r.streamQuality === 'failed');

  // Sort by score
  const ranked = [...results].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.loadTime && b.loadTime) return a.loadTime - b.loadTime;
    return 0;
  });

  console.log('\n========================================');
  console.log('              RESULTS');
  console.log('========================================\n');

  console.log(`🌟 EXCELLENT (90%+):  ${excellent.length}`);
  console.log(`✅ GOOD (70-90%):     ${good.length}`);
  console.log(`⚠️  FAIR (50-70%):     ${fair.length}`);
  console.log(`😐 POOR (<50%):       ${poor.length}`);
  console.log(`❌ FAILED:            ${failed.length}`);

  console.log('\n--- TOP PROVIDERS BY STREAM QUALITY ---\n');

  const topProviders = ranked.filter(r => r.score >= 60).slice(0, 10);
  if (topProviders.length === 0) {
    console.log('No providers with good streaming quality found.');
    console.log('\nBest attempts:');
    ranked.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.name} - ${r.streamQuality || r.status} (${r.actualPlayback?.toFixed(1) || 0}s played)`);
    });
  } else {
    topProviders.forEach((r, i) => {
      const ratio = (r.playbackRatio * 100).toFixed(0);
      console.log(`  ${i + 1}. ${r.name} - ${r.streamQuality.toUpperCase()} (${ratio}%) - ${r.actualPlayback.toFixed(1)}s of ${r.expectedPlayback.toFixed(1)}s - ${r.bufferingEvents} stalls`);
    });
  }

  // Save to file
  const report = {
    testDate: new Date().toISOString(),
    options: {
      mediaType: options.mediaType,
      mediaId: options.mediaId,
      season: options.season,
      episode: options.episode,
      streamDuration: options.streamDuration / 1000,
    },
    summary: {
      total: results.length,
      excellent: excellent.length,
      good: good.length,
      fair: fair.length,
      poor: poor.length,
      failed: failed.length,
    },
    bestProvider: ranked[0]?.name || 'None',
    bestProviderQuality: ranked[0]?.streamQuality || 'N/A',
    results: ranked.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      status: r.status,
      streamQuality: r.streamQuality,
      score: r.score,
      loadTime: r.loadTime,
      actualPlayback: r.actualPlayback ? parseFloat(r.actualPlayback.toFixed(1)) : 0,
      expectedPlayback: r.expectedPlayback ? parseFloat(r.expectedPlayback.toFixed(1)) : 0,
      playbackRatio: r.playbackRatio ? parseFloat((r.playbackRatio * 100).toFixed(1)) : 0,
      bufferingEvents: r.bufferingEvents || 0,
      hasVideo: r.hasVideo,
      videoPlaying: r.videoPlaying,
      playButtonClicked: r.playButtonClicked,
      error: r.error,
      url: r.url,
    })),
  };

  fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
  console.log(`\n📄 Results saved to: ${options.output}`);

  return report;
}

// Main
async function main() {
  const options = parseArgs();

  try {
    const results = await runTests(options);
    generateReport(results, options);
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly, not when imported by the playback test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
