// rec-css-harness.mjs — confirms style.css loads and the explore accent computes.
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf8"><style>${css}</style></head>
<body>
  <section class="rec-rail-section rec-row-explore rec-explore">
    <div class="rec-header"><span class="rec-kicker">A little different</span>
      <h2 class="rec-heading">Hidden gems</h2></div>
    <div class="rec-rail"><div class="rec-scroller"></div></div>
  </section>
  <p class="rec-because" data-rec-source="rec">Because you liked X</p>
</body></html>`;

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });

  const shadow = await page.$eval('.rec-row-explore .rec-rail',
    (el) => getComputedStyle(el, '::after').boxShadow);
  assert.notEqual(shadow, 'none', `explore rail ::after box-shadow should be set, got "${shadow}"`);

  const becauseColor = await page.$eval('.rec-because[data-rec-source]',
    (el) => getComputedStyle(el).color);
  assert.ok(/^rgb/.test(becauseColor), `evidence label color should resolve, got "${becauseColor}"`);

  console.log('rec-css-harness: PASS');
} finally {
  await browser.close();
}
