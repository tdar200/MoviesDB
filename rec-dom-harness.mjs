// rec-dom-harness.mjs — runnable headless verification of the rec-page DOM contract.
// Uses the installed puppeteer. No network: a fixed rows fixture is rendered by the
// SAME buildRecRail/createRecommendationCard code pulled from script.js into the page.
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const scriptSrc = readFileSync(new URL('./script.js', import.meta.url), 'utf8');
const styleSrc = readFileSync(new URL('./style.css', import.meta.url), 'utf8');

// Guard (follow-up d): the two template-heavy builders must be delimited by extraction markers so a
// '}' inside a template string can't mis-slice their bodies. Fail loudly if a marker is missing.
for (const name of ['createRecommendationCard', 'buildRecRail']) {
  if (!scriptSrc.includes(`// >>> REC-HARNESS-EXPORT ${name}`) || !scriptSrc.includes(`// <<< REC-HARNESS-EXPORT ${name}`)) {
    throw new Error(`rec-dom-harness: missing extraction markers for ${name} in script.js`);
  }
}

// Extract a builder's REAL source from script.js. Prefer the REC-HARNESS-EXPORT markers (token-free:
// a '}' inside a template string can't mis-slice); fall back to paren+brace balancing for un-marked
// helpers (buildRecSkeleton/buildLazyRecRail/observeLazyRail/reconcileRecRails/scheduleRecRecompute).
function slice(name) {
  const begin = `// >>> REC-HARNESS-EXPORT ${name}`;
  const end = `// <<< REC-HARNESS-EXPORT ${name}`;
  const mb = scriptSrc.indexOf(begin);
  if (mb >= 0) {
    const bodyStart = mb + begin.length;
    const me = scriptSrc.indexOf(end, bodyStart);
    if (me < 0) throw new Error(`rec-dom-harness: begin marker for ${name} has no matching end marker`);
    return scriptSrc.slice(bodyStart, me);
  }
  const start = scriptSrc.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in script.js`);
  // Balance the '(' ... ')' param list first so a destructured param doesn't trip the body balancer.
  let p = scriptSrc.indexOf('(', start);
  let parenDepth = 0;
  for (; p < scriptSrc.length; p++) {
    if (scriptSrc[p] === '(') parenDepth++;
    else if (scriptSrc[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  // Then balance braces from the first '{' after the params (the real body).
  let i = scriptSrc.indexOf('{', p);
  let depth = 0;
  for (; i < scriptSrc.length; i++) {
    if (scriptSrc[i] === '{') depth++;
    else if (scriptSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return scriptSrc.slice(start, i);
}

const createCardSrc = slice('createRecommendationCard');
const buildRailSrc = slice('buildRecRail');
const skeletonSrc = slice('buildRecSkeleton');
const lazyRailSrc = slice('buildLazyRecRail');
const observeLazySrc = slice('observeLazyRail');
const reconcileSrc = slice('reconcileRecRails');
const scheduleRecomputeSrc = slice('scheduleRecRecompute');

// The two builders contain backtick template literals with ${...}; they must be injected
// into the page WITHOUT being interpolated by this module's own template literals. So the
// inline script body is assembled by string concatenation, not a tagged/embedded template.
const scriptHead = `
  const CONFIG = { IMAGE_URL: '' };
  function createStarButton() { const b = document.createElement('button'); b.className='star-btn'; return b; }
  function createDownvoteButton() { const b = document.createElement('button'); b.className='dv-btn'; return b; }
  let played = null;
  function openPlayer(movie) { played = movie.id; window.__played = movie.id; }
  // Stub the deps scheduleRecRecompute() closes over (it lives at module scope in script.js and
  // calls the heavy renderRecommendationsPage). The stub just counts runs so we can assert the
  // 1000ms debounce coalesces N rapid toggles into ONE recompute.
  window.__recomputeCount = 0;
  function renderRecommendationsPage() { window.__recomputeCount++; }
  const REC_RECOMPUTE_DEBOUNCE_MS = 1000;
  let __recRecomputeTimer = null;
`;

const scriptTail = `
  // Fixture mirrors groupIntoRows output: one collaborative card + an explore row.
  const rows = [
    { kind: 'top', title: 'Top picks for you', recs: [
      { movie: { id: 1, title: 'Inception', media_type: 'movie', vote_average: 8.8, vote_count: 30000,
                 _seeds: [{ source: 'rec', type: 'title', seedTitle: 'Interstellar', weight: 1 }] },
        score: 1, reasons: ['Because you liked Interstellar'] },
      { movie: { id: 2, title: 'Arrival', media_type: 'movie', vote_average: 7.9, vote_count: 20000, _seeds: [] },
        score: 0.9, reasons: ['Matches your love of Sci-Fi'] },
    ] },
    { kind: 'trending', title: 'Trending this week', recs: [
      { movie: { id: 4, title: 'Dune', media_type: 'movie', vote_average: 8.0, vote_count: 50000, _seeds: [{ source: 'trending', type: 'title', id: 4, rank: 0, weight: 1 }] },
        score: 0.8, reasons: ['Trending this week'] },
    ] },
    { kind: 'explore', title: 'Hidden gems in Sci-Fi', recs: [
      { movie: { id: 3, title: 'Coherence', media_type: 'movie', vote_average: 8.6, vote_count: 40, _seeds: [] },
        score: 0.3, reasons: ['A rarer pick'] },
    ] },
  ];

  const REC_ROW_KICKERS = {
    top: 'Calibrated to your basket',
    title: 'Because you liked it',
    genre: 'More of this genre',
    trending: 'Popular this week',
    explore: 'A little different',
  };
  const page = document.createElement('div');
  page.className = 'rec-page';
  rows.forEach((row, i) => {
    const kicker = REC_ROW_KICKERS[row.kind] || null;
    const railSection = buildRecRail(row.recs, { kicker, heading: row.title });
    railSection.classList.add('rec-row-' + row.kind);
    railSection.setAttribute('data-rec-kind', row.kind);
    if (row.kind === 'explore') railSection.classList.add('rec-explore');
    page.appendChild(railSection);
  });
  document.getElementById('main').appendChild(page);
`;

const inlineScript = scriptHead + createCardSrc + '\n' + buildRailSrc + '\n'
  + skeletonSrc + '\n' + lazyRailSrc + '\n' + observeLazySrc + '\n' + reconcileSrc + '\n'
  + scheduleRecomputeSrc + '\n'
  + scriptTail;

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  // Surface any in-page script error instead of silently rendering nothing.
  page.on('pageerror', (e) => { throw e; });
  // Load a minimal document with the #main mount, then inject the REAL builders via
  // addScriptTag (avoids document.write HTML-parsing pitfalls with the inlined SVG source).
  await page.setContent('<!doctype html><html><head><meta charset="utf8"></head><body><main id="main"></main></body></html>', { waitUntil: 'load' });
  // Inject the REAL style.css so layout-reserving rules (e.g. .rec-scroller--reserved
  // min-height, the no-CLS guarantee) are exercised, not just the DOM builders.
  await page.addStyleTag({ content: styleSrc });
  await page.addScriptTag({ content: inlineScript });

  // (a) every rail-section carries a rec-row-<kind> class AND a non-empty .rec-kicker.
  const railInfo = await page.$$eval('.rec-rail-section', (els) =>
    els.map((el) => ({
      kind: el.getAttribute('data-rec-kind'),
      hasKindClass: [...el.classList].some((c) => c.startsWith('rec-row-')),
      kicker: el.querySelector('.rec-kicker')?.textContent || '',
    })));
  assert.ok(railInfo.length >= 1, 'expected at least one rail');
  for (const r of railInfo) {
    assert.ok(r.hasKindClass, `rail kind=${r.kind} missing rec-row-* class`);
    assert.ok(r.kicker.length > 0, `rail kind=${r.kind} has empty kicker`);
  }

  // (b) exactly one explore rail.
  const exploreCount = await page.$$eval('.rec-explore', (els) => els.length);
  assert.equal(exploreCount, 1, 'exactly one .rec-explore rail');

  // (b2) the trending row renders exactly once (standing Trending this week row).
  const trendingCount = await page.$$eval('[data-rec-kind="trending"]', (els) => els.length);
  assert.equal(trendingCount, 1, 'exactly one trending rail (standing Trending this week row)');

  // (b3) anti-drift (follow-up b): the harness's trending kicker must equal production's
  // REC_ROW_KICKERS.trending in script.js, so the hardcoded fixture copy can't silently drift.
  const prodKickerBlock = scriptSrc.match(/REC_ROW_KICKERS\s*=\s*\{[\s\S]*?\}/)?.[0] || '';
  const prodTrending = prodKickerBlock.match(/trending:\s*'([^']*)'/)?.[1];
  assert.equal(prodTrending, 'Popular this week', 'production trending kicker changed — update the harness fixture copy');
  const trendingKicker = railInfo.find((r) => r.kind === 'trending')?.kicker;
  assert.equal(trendingKicker, prodTrending, 'harness trending rail kicker must match production REC_ROW_KICKERS.trending (no fixture drift)');

  // (c) the collaborative card exposes data-rec-source="rec" (on its .rec-because label,
  // matching the createRecommendationCard edit and the style.css `.rec-because[data-rec-source]`).
  const src = await page.$eval('.rec-because[data-rec-source]', (el) => el.getAttribute('data-rec-source'));
  assert.equal(src, 'rec', 'collaborative card must carry data-rec-source');

  // (d) clicking a card via $eval (not coordinate click) opens the player.
  await page.$eval('.rec-card', (el) => el.click());
  const played = await page.evaluate(() => window.__played);
  assert.equal(played, 1, 'clicking the first card opens its player');

  // (e) skeletons render synchronously with shimmer cards.
  const skeletonInfo = await page.evaluate(() => {
    const host = document.createElement('div'); document.body.appendChild(host);
    host.appendChild(buildRecSkeleton(3));
    return { sections: host.querySelectorAll('.rec-rail-section.rec-skeleton').length,
             cards: host.querySelectorAll('.rec-skel-card').length };
  });
  assert.equal(skeletonInfo.sections, 3, 'expected 3 skeleton rail sections');
  assert.ok(skeletonInfo.cards >= 3, 'skeleton rails carry shimmer cards');

  // (f) lazy rail builds 0 cards until hydrate(), and reserves min-height (no CLS).
  const lazyInfo = await page.evaluate(() => {
    const recs = [{ movie: { id: 9, title: 'Primer', media_type: 'movie', vote_average: 7, vote_count: 100, _seeds: [] }, score: 0.5, reasons: ['x'] }];
    const { section, hydrate } = buildLazyRecRail(recs, { kicker: 'k', heading: 'More Sci-Fi' });
    document.body.appendChild(section);
    const before = section.querySelectorAll('.rec-card').length;
    const minH = getComputedStyle(section.querySelector('.rec-scroller')).minHeight;
    hydrate();
    return { before, after: section.querySelectorAll('.rec-card').length, minH };
  });
  assert.equal(lazyInfo.before, 0, 'lazy rail builds no cards until hydrate()');
  assert.equal(lazyInfo.after, 1, 'hydrate() builds the deferred cards');
  assert.notEqual(lazyInfo.minH, '0px', 'lazy scroller reserves min-height');

  // (f2) observeLazyRail returns a live IntersectionObserver (so renderRecommendationsPage can collect
  // and disconnect it on teardown — guards the lazy-observer leak fix). A rail that never intersects
  // must still yield a disconnectable observer.
  const obsReturned = await page.evaluate(() => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const { section } = buildLazyRecRail([], { kicker: 'k', heading: 'h' });
    host.appendChild(section);
    let disconnected = 0;
    const io = observeLazyRail(section, () => {});
    if (!io || typeof io.disconnect !== 'function') return { ok: false };
    const orig = io.disconnect.bind(io);
    io.disconnect = () => { disconnected++; orig(); };
    io.disconnect();
    return { ok: true, disconnected };
  });
  assert.ok(obsReturned.ok, 'observeLazyRail must return a disconnectable IntersectionObserver');
  assert.equal(obsReturned.disconnected, 1, 'the returned observer can be disconnected on teardown');

  // (g) reconcileRecRails: reuses provisional title rails by key, orders by final rows,
  //     no duplicates, hero ends first, rows beyond eagerRows are lazy.
  const recon = await page.evaluate(() => {
    const mk = (kind, title) => { const s = document.createElement('section'); s.dataset.recKey = `${kind}::${title}`; return s; };
    const provisional = new Map([
      ['title::Because you liked A', mk('title', 'Because you liked A')],
      ['title::Because you liked B', mk('title', 'Because you liked B')],
    ]);
    const provA = provisional.get('title::Because you liked A');
    const rows = [
      { kind: 'top', title: 'Top picks for you', recs: [] },
      { kind: 'title', title: 'Because you liked A', recs: [] },
      { kind: 'title', title: 'Because you liked B', recs: [] },
      { kind: 'genre', title: 'More Sci-Fi', recs: [] },
      { kind: 'trending', title: 'Trending this week', recs: [] },
    ];
    const lazied = [];
    const buildRail = (row, i, lazy) => {
      const s = document.createElement('section');
      s.dataset.recKind = row.kind; s.dataset.built = lazy ? 'lazy' : 'eager';
      return { section: s, hydrate: () => {} };
    };
    const out = reconcileRecRails(rows, provisional, { buildRail, eagerRows: 3, onLazy: (s) => lazied.push(s.dataset.recKind) });
    return {
      order: out.map((s) => s.dataset.recKind || s.dataset.recKey),
      reusedA: out[1] === provA,
      count: out.length,
      lazyKinds: lazied,
    };
  });
  assert.deepEqual(recon.order, ['top', 'title::Because you liked A', 'title::Because you liked B', 'genre', 'trending'], 'hero first, final order, provisional reused');
  assert.ok(recon.reusedA, 'provisional title rail reused by key (same node)');
  assert.equal(recon.count, 5, 'exactly one rail per final row, no duplicates');
  assert.deepEqual(recon.lazyKinds, ['genre', 'trending'], 'rows beyond eagerRows=3 are lazy');

  // (g2) debounce: 5 rapid scheduleRecRecompute() calls coalesce into exactly 1 recompute.
  const recomputeRuns = await page.evaluate(async () => {
    window.__recomputeCount = 0;
    for (let i = 0; i < 5; i++) scheduleRecRecompute();
    await new Promise((r) => setTimeout(r, 1300));
    return window.__recomputeCount;
  });
  assert.equal(recomputeRuns, 1, '5 rapid toggles debounce to exactly 1 recompute');

  console.log('rec-dom-harness: PASS');
} finally {
  await browser.close();
}
