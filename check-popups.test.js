// check-popups.test.js — the player must not spawn popups, and the fix must keep
// the providers playing.
//
// Root cause (found 2 Sep 2026, real Chrome): the embed providers loaded into
// #player-iframe run popunder ad scripts that window.open() (or click a
// target=_blank anchor) on ordinary clicks inside the player — 11 of the 14 live
// sources spawned tabs on play/pause clicks. The one in-page control, the iframe
// `sandbox` attribute without `allow-popups`, IS detected by every major provider
// (Videasy, VidLink, VidFast, 111Movies, VixSrc): they run
// `document.domain = document.domain`, which throws a SecurityError naming the
// sandbox in ANY sandboxed frame whatever tokens are allowed, and replace the
// player with "Please Disable Sandbox". Chrome has no Permissions-Policy feature
// for popups either. So the fix is popup-guard/, a small Chrome extension that
// (a) neuters window.open / target=_blank inside frames embedded by the app and
// (b) closes any tab a provider frame still manages to spawn. Nothing it does is
// visible to the providers' sandbox check.
//
// The static tests run in plain `npm test`. The real-browser tests are gated
// behind CHECK_POPUPS=1 (needs a display; the provider test hits third-party
// hosts):
//   npm run check-popups
// Branded Google Chrome ignores --load-extension (since v137), so the browser
// tests use Chrome for Testing from the puppeteer cache. Install once with:
//   npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer
// (Loading the extension by hand via chrome://extensions -> Load unpacked works
// fine in ordinary Chrome — only the command-line flag is gone.)
//
// Tuning via env: POPUPS_SOURCES (top-N providers, default 4),
// PLAYBACK_MAXWAIT_SECS (per provider, default 40), POPUPS_CHROME (explicit
// Chrome for Testing binary).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const EXT = new URL('./popup-guard/', import.meta.url);
const readExt = (f) => readFileSync(new URL(f, EXT), 'utf8');

function playerIframeTag() {
  const tag = html.match(/<iframe[^>]*\bid=["']player-iframe["'][^>]*>/i)?.[0];
  assert.ok(tag, 'no <iframe id="player-iframe"> found in index.html');
  return tag;
}

// ---- static (always run) ----

test('player iframe is NOT sandboxed — every major provider refuses to play in a sandboxed frame', () => {
  assert.doesNotMatch(
    playerIframeTag(),
    /\bsandbox\b/i,
    'a sandbox attribute on #player-iframe gets "Please Disable Sandbox" instead of a player from ' +
      'Videasy/VidLink/VidFast/111Movies/VixSrc (they detect it via document.domain). Popups are ' +
      'handled by the popup-guard/ extension instead.'
  );
});

test('popup-guard manifest wires both layers (frame defuser + tab closer)', () => {
  const m = JSON.parse(readExt('manifest.json'));
  assert.equal(m.manifest_version, 3);
  for (const p of ['webNavigation', 'tabs']) assert.ok(m.permissions.includes(p), `manifest needs the ${p} permission`);
  assert.equal(m.background?.service_worker, 'background.js');
  const cs = m.content_scripts?.[0];
  assert.ok(cs, 'manifest needs a content script');
  assert.deepEqual(cs.matches, ['<all_urls>'], 'providers redirect to arbitrary hosts, so the defuser must match everywhere (it bails unless framed by the app)');
  assert.equal(cs.all_frames, true, 'ad frames are nested — must run in all frames');
  assert.equal(cs.run_at, 'document_start', 'must beat the provider scripts to window.open');
  assert.equal(cs.world, 'MAIN', 'must patch the page\'s own window.open, not an isolated copy');
  assert.deepEqual(cs.js, ['guard-origins.js', 'defuse.js']);
});

test('popup-guard scripts parse', () => {
  for (const f of ['guard-origins.js', 'background.js', 'defuse.js']) new vm.Script(readExt(f), { filename: f });
});

test('guard origins: local/LAN app origins only; YouTube frames exempt', () => {
  const sb = {};
  vm.runInNewContext(
    readExt('guard-origins.js') + '\n;this.__ = { isApp: moviesdbGuardIsAppOrigin__, exempt: MOVIESDB_GUARD_EXEMPT_HOSTS__ };',
    sb
  );
  const { isApp, exempt } = sb.__;
  for (const o of ['http://localhost:3000', 'http://localhost:8123', 'http://127.0.0.1:3000', 'http://192.168.0.189:3000', 'http://10.0.0.5', 'http://[::1]:3000']) {
    assert.ok(isApp(o), `${o} should be guarded`);
  }
  for (const o of ['https://vidfast.pro', 'https://player.videasy.to', 'https://localhost.evil.com', 'http://localhost.evil.com:3000', 'null', 'https://www.youtube.com']) {
    assert.ok(!isApp(o), `${o} must NOT be guarded`);
  }
  assert.ok(exempt.test('www.youtube.com') && exempt.test('www.youtube-nocookie.com'));
  assert.ok(!exempt.test('vidfast.pro') && !exempt.test('youtube.com.evil.net'));
});

// ---- real-browser regression tests (opt-in) ----

const RUN = process.env.CHECK_POPUPS === '1';
const SKIP = RUN ? false : 'set CHECK_POPUPS=1 (use `npm run check-popups`) to run the real-browser popup checks';
const N = Math.max(1, parseInt(process.env.POPUPS_SOURCES || '4', 10));
const MAXWAIT_SECS = Math.max(10, parseInt(process.env.PLAYBACK_MAXWAIT_SECS || '40', 10));
const EXT_DIR = fileURLToPath(EXT).replace(/\/$/, '');

async function browserPrereqs() {
  assert.ok(process.env.DISPLAY, 'no DISPLAY — headed Chrome needs one. Use `npm run check-popups` (wraps Xvfb).');
  const { findChromeForTesting } = await import('./playback-tester.mjs');
  const chrome = process.env.POPUPS_CHROME || findChromeForTesting();
  assert.ok(
    chrome,
    'no Chrome for Testing found (branded Chrome ignores --load-extension). Install one:\n' +
      '  npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer'
  );
  return chrome;
}

// The exact attributes the app ships on #player-iframe, lifted out of index.html.
function playerAttrs() {
  const tag = playerIframeTag();
  return [
    /\ballowfullscreen\b/i.test(tag) ? 'allowfullscreen' : '',
    tag.match(/\ballow=["'][^"']*["']/i)?.[0] || '',
    tag.match(/\breferrerpolicy=["'][^"']*["']/i)?.[0] || '',
  ].filter(Boolean).join(' ');
}

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// A host page on localhost (a guarded origin) that frames ?src= with the app's real
// player-iframe attributes, filling the viewport the way the app's player does.
async function serveHost() {
  const http = await import('node:http');
  const attrs = playerAttrs();
  const srv = http.createServer((req, res) => {
    const src = new URL(req.url, 'http://localhost').searchParams.get('src') || 'about:blank';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0;background:#000"><div style="position:relative;width:100%;padding-top:56.25%">
      <iframe id="player-iframe" ${attrs} src="${escapeAttr(src)}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none"></iframe>
      </div></body>`);
  });
  await new Promise((r) => srv.listen(0, 'localhost', r));
  return { srv, url: (src) => `http://localhost:${srv.address().port}/?src=${encodeURIComponent(src)}` };
}

// Wait for the extension's service worker so its tab-closer is armed.
async function extensionLoaded(ctx) {
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => {});
  return ctx.serviceWorkers().length > 0;
}

test('real Chrome + popup-guard: a cross-origin frame cannot open a tab by any route', { skip: SKIP }, async (t) => {
  const chrome = await browserPrereqs();
  const http = await import('node:http');
  const { launchContext } = await import('./playback-tester.mjs');

  // A "provider" on 127.0.0.1 (cross-origin to the localhost host page) that, on a
  // real click, tries all three ways ad scripts spawn tabs.
  const child = `<!doctype html><body style="margin:0;background:#123">
    <button id="b" style="width:300px;height:120px">GO</button>
    <a id="a" href="/x" target="_blank">a</a>
    <form id="f" action="/x" target="_blank"><input name="q" value="1"></form>
    <script>document.getElementById('b').addEventListener('click', () => {
      const w = window.open('about:blank', '_blank');
      window.__r = { open: w === null ? 'null' : 'window' };
      document.getElementById('a').click();
      document.getElementById('f').submit();
    });</script></body>`;
  const srvB = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(child); });
  await new Promise((r) => srvB.listen(0, '127.0.0.1', r));
  const childUrl = `http://127.0.0.1:${srvB.address().port}/child`;
  const host = await serveHost();

  async function tryIt(ctx) {
    const page = await ctx.newPage();
    const popups = [];
    page.on('popup', (p) => popups.push(p));
    await page.goto(host.url(childUrl), { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const frame = page.frames().find((f) => f.parentFrame());
    assert.ok(frame, 'child frame never loaded');
    await frame.click('#b');
    await page.waitForTimeout(1500);
    const r = await frame.evaluate(() => window.__r);
    const out = { open: r?.open, seen: popups.length, surviving: popups.filter((p) => !p.isClosed()).length, topUrl: page.url() };
    for (const p of popups) await p.close().catch(() => {});
    await page.close().catch(() => {});
    return out;
  }

  try {
    // Baseline without the extension: the harness must actually see popups,
    // otherwise a green guarded run would prove nothing.
    const base = await launchContext({ executablePath: chrome, profileDir: '/tmp/moviesdb-pw-popups-base' });
    let baseline;
    try { baseline = await tryIt(base); } finally { await base.close().catch(() => {}); }
    t.diagnostic(`without popup-guard: window.open -> ${baseline.open}, popups seen ${baseline.seen}, surviving ${baseline.surviving}`);
    assert.ok(baseline.seen >= 1, 'harness saw no popups even without the guard — it cannot detect them');

    const ctx = await launchContext({ executablePath: chrome, extensionPath: EXT_DIR, profileDir: '/tmp/moviesdb-pw-popups-ext' });
    try {
      assert.ok(await extensionLoaded(ctx), 'popup-guard did not load — is this Chrome for Testing? (branded Chrome ignores --load-extension)');
      const guarded = await tryIt(ctx);
      t.diagnostic(`with popup-guard: window.open -> ${guarded.open}, popups seen ${guarded.seen}, surviving ${guarded.surviving}`);
      assert.equal(guarded.open, 'null', 'window.open inside the frame should be defused (return null)');
      assert.equal(guarded.surviving, 0, 'a tab spawned from the frame survived');
      assert.ok(guarded.topUrl.startsWith(host.url('').split('?')[0]), 'the frame navigated the app page away');
    } finally {
      await ctx.close().catch(() => {});
    }
  } finally {
    host.srv.close(); srvB.close();
  }
});

test('real Chrome + popup-guard: top providers still stream through the app iframe, with no surviving popup', { skip: SKIP }, async (t) => {
  const chrome = await browserPrereqs();
  const { EMBED_SOURCES, launchContext, testPlayback } = await import('./playback-tester.mjs');
  const host = await serveHost();
  const ctx = await launchContext({ executablePath: chrome, extensionPath: EXT_DIR, profileDir: '/tmp/moviesdb-pw-popups-providers' });
  const results = [];
  try {
    assert.ok(await extensionLoaded(ctx), 'popup-guard did not load — is this Chrome for Testing?');
    for (const source of EMBED_SOURCES.slice(0, N)) {
      await t.test(`${source.name} through the app iframe`, async () => {
        const r = await testPlayback(ctx, source, { maxWaitMs: MAXWAIT_SECS * 1000, embed: host.url, keepPopups: true });
        results.push(r);
        t.diagnostic(`${source.name}: ${r.played ? 'PLAYS' : 'no play'} (advanced ${r.advancedSecs}s), popups seen ${r.popups}, surviving ${r.popupsOpen}${r.error ? ', err: ' + r.error : ''}`);
      });
    }
  } finally {
    await ctx.close().catch(() => {});
    host.srv.close();
  }

  await t.test('no popup survives from any provider', () => {
    const leaked = results.filter((r) => r.popupsOpen > 0).map((r) => `${r.name}=${r.popupsOpen}`);
    assert.equal(leaked.length, 0, `popups survived the guard: ${leaked.join(', ')}`);
  });
  await t.test('at least one provider still streams with the guard active', () => {
    const summary = results.map((r) => `${r.name}=${r.played ? `PLAYS(${r.advancedSecs}s)` : 'no'}`).join(', ');
    assert.ok(results.some((r) => r.played), `no provider produced measurable playback with the guard loaded [${summary}]`);
  });
});
