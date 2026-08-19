// fullscreen.test.js — guards the player iframe's fullscreen permission.
//
// Root cause this locks down (found Aug 18, 2026): the player iframe carried
//   allowfullscreen allow="autoplay; fullscreen; ..."
// A *bare* feature name in `allow` means the allowlist 'src' — the origin in the
// src attribute and nothing else — and declaring `fullscreen` there SUPPRESSES the
// legacy allowfullscreen attribute's wildcard. Several providers redirect the
// frame to a different origin the moment it loads (111movies.com ->
// player.vidlove.cc, vidfast.pro -> vidfast.vc, vsrc.su/vidsrc-embed.* ->
// vsembed.ru, multiembed.mov -> streamingnow.mov). After that hop the origin no
// longer matches the allowlist, the feature is dropped, document.fullscreenEnabled
// goes false and the player's fullscreen button silently does nothing.
//
// The fix is the wildcard allowlist (`fullscreen *`), which survives the redirect.
//
// The static tests below run in plain `npm test`. The browser test is gated behind
// CHECK_FULLSCREEN=1 (needs real Chrome + a display) — run it with:
//   npm run check-fullscreen
// It reproduces the cross-origin redirect entirely locally (localhost -> 127.0.0.1
// is a real cross-origin hop), so it needs no third-party host and cannot flake on
// provider rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

// Pull one <iframe ...> tag out of the document by its id attribute.
function iframeTag(id) {
  const tag = html.match(new RegExp(`<iframe[^>]*\\bid=["']${id}["'][^>]*>`, 'i'))?.[0];
  assert.ok(tag, `no <iframe id="${id}"> found in index.html`);
  return tag;
}

// Does this tag grant fullscreen with an allowlist that survives a cross-origin
// redirect? Either a wildcard `fullscreen *` in allow=, or the legacy
// allowfullscreen attribute with NO fullscreen declaration in allow= to narrow it.
function grantsFullscreenAfterRedirect(tag) {
  const allow = tag.match(/\ballow=["']([^"']*)["']/i)?.[1] || '';
  const legacy = /\ballowfullscreen\b/i.test(tag);
  const decl = allow.split(';').map((s) => s.trim()).find((s) => /^fullscreen\b/i.test(s));
  if (decl) return /^fullscreen\s+\*$/i.test(decl); // declared -> must be the wildcard
  return legacy; // not declared -> legacy attribute's wildcard applies
}

test('player iframe keeps fullscreen after a provider redirects cross-origin', () => {
  const tag = iframeTag('player-iframe');
  assert.ok(
    grantsFullscreenAfterRedirect(tag),
    'player iframe must grant fullscreen with a wildcard allowlist (`fullscreen *`), ' +
      'otherwise providers that redirect to another origin (111Movies, VidFast, ' +
      `Vsrc.su, SuperEmbed) lose fullscreen entirely. Got: ${tag}`
  );
});

test('player iframe still carries the legacy allowfullscreen attribute', () => {
  // Belt and braces for older/odd engines that only honour the legacy attribute.
  assert.match(iframeTag('player-iframe'), /\ballowfullscreen\b/i);
});

test('trailer iframe grants fullscreen too', () => {
  assert.ok(grantsFullscreenAfterRedirect(iframeTag('trailer-iframe')));
});

test('provider-tester iframes grant fullscreen with a wildcard allowlist', () => {
  // The standalone tester builds its iframe in JS, so assert on that source.
  const js = readFileSync(new URL('./provider-tester.js', import.meta.url), 'utf8');
  const allow = js.match(/iframe\.allow\s*=\s*['"]([^'"]*)['"]/)?.[1];
  assert.ok(allow, 'provider-tester.js no longer sets iframe.allow — update this test');
  const decl = allow.split(';').map((s) => s.trim()).find((s) => /^fullscreen\b/i.test(s));
  assert.ok(
    !decl || /^fullscreen\s+\*$/i.test(decl),
    `provider-tester iframe must use \`fullscreen *\`, got: ${allow}`
  );
});

// ---- real-browser regression test (opt-in) ----

const RUN = process.env.CHECK_FULLSCREEN === '1';

test(
  'real Chrome: the app\'s own iframe attributes survive a cross-origin redirect',
  { skip: RUN ? false : 'set CHECK_FULLSCREEN=1 (use `npm run check-fullscreen`) to run the real-browser fullscreen check' },
  async (t) => {
    assert.ok(process.env.DISPLAY, 'no DISPLAY — headed Chrome needs one. Use `npm run check-fullscreen` (wraps Xvfb).');
    const http = await import('node:http');
    const { chromium } = await import('playwright');

    // The exact attributes the app ships, lifted out of index.html.
    const tag = iframeTag('player-iframe');
    const attrs = [
      /\ballowfullscreen\b/i.test(tag) ? 'allowfullscreen' : '',
      tag.match(/\ballow=["'][^"']*["']/i)?.[0] || '',
    ].join(' ').trim();
    t.diagnostic(`iframe attributes under test: ${attrs}`);

    // A child page that tries to go fullscreen on a real click.
    const child = `<!doctype html><body style="margin:0;background:#123">
      <button id="b" style="width:240px;height:90px">FS</button>
      <script>document.getElementById('b').addEventListener('click', () => {
        document.documentElement.requestFullscreen().then(
          () => { window.__fs = 'resolved'; }, (e) => { window.__fs = 'rejected: ' + e.name; });
      });</script></body>`;

    // Two origins: localhost (host page) and 127.0.0.1 (redirect target).
    const srvB = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(child); });
    await new Promise((r) => srvB.listen(0, '127.0.0.1', r));
    const portB = srvB.address().port;

    const srvA = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${portB}/child` }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><body style="margin:0"><div style="position:relative;width:100%;padding-top:56.25%">
        <iframe id="f" ${attrs} src="/redirect" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none"></iframe>
        </div></body>`);
    });
    await new Promise((r) => srvA.listen(0, 'localhost', r));
    const portA = srvA.address().port;

    const ctx = await chromium.launchPersistentContext('/tmp/moviesdb-pw-fullscreen', {
      headless: false, channel: 'chrome', viewport: { width: 1280, height: 720 },
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
    try {
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${portA}/`, { waitUntil: 'load' });
      await page.waitForTimeout(800);
      const frame = page.frames().find((f) => f.parentFrame());
      assert.ok(frame, 'child frame never loaded');

      const enabled = await frame.evaluate(() => document.fullscreenEnabled);
      t.diagnostic(`document.fullscreenEnabled after cross-origin redirect: ${enabled}`);
      assert.equal(enabled, true, 'fullscreen permission was dropped by the cross-origin redirect');

      await frame.click('#b');
      await page.waitForTimeout(700);
      assert.equal(await frame.evaluate(() => window.__fs), 'resolved', 'requestFullscreen() was rejected');
      assert.equal(await page.evaluate(() => document.fullscreenElement?.id), 'f', 'the iframe did not become the fullscreen element');
    } finally {
      await ctx.close().catch(() => {});
      srvA.close(); srvB.close();
    }
  }
);
