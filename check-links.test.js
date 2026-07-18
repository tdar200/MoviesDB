// check-links.test.js — live network health check for the streaming providers.
//
// Gated behind CHECK_LINKS=1 so it does NOT run in the normal offline `npm test`.
// It makes real HTTP requests to third-party embed hosts, so it is slow and can
// flake when a provider rate-limits — only run it when you want a live check:
//
//   CHECK_LINKS=1 npm test                         # full suite + link check
//   CHECK_LINKS=1 node --test check-links.test.js  # just the link check
//
// It asserts the app's DEFAULT source is alive and that at least a few sources
// work — enough to guarantee a picked movie can actually play somewhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMBED_SOURCES, BLOCKED_PROVIDERS } from './embed-sources.js';
import { checkSource } from './check-links.mjs';

const RUN = process.env.CHECK_LINKS === '1';
const embeddable = EMBED_SOURCES.filter((s) => !s.torrent && !BLOCKED_PROVIDERS.includes(s.name));

// A source may flake once, so retry a DEAD/REACHABLE verdict before trusting it.
async function checkWithRetry(source, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await checkSource(source);
    if (last.verdict === 'OK') return last;
  }
  return last;
}

test('link check is opt-in', { skip: RUN ? false : 'set CHECK_LINKS=1 to run live provider checks' }, async (t) => {
  const results = [];

  await t.test('every active source list entry is checkable', () => {
    assert.ok(embeddable.length > 0, 'expected at least one embeddable, non-blocked source');
  });

  for (const source of embeddable) {
    await t.test(`${source.name} serves a player page`, async () => {
      const r = await checkWithRetry(source);
      results.push(r);
      // Soft per-source: warn (don't fail the run) — providers rot individually and
      // the app has fallbacks. The hard guarantees are asserted in aggregate below.
      if (r.verdict !== 'OK') {
        t.diagnostic(`${source.name} = ${r.verdict}: movie→${r.movie.finalUrl} tv→${r.tv.finalUrl}`);
      }
    });
  }

  await t.test('DEFAULT source (first in list) is alive', () => {
    const def = results.find((r) => r.name === embeddable[0].name);
    assert.equal(def?.verdict, 'OK', `default source "${embeddable[0].name}" must play — the app opens on it`);
  });

  await t.test('enough sources work to guarantee playback', () => {
    const ok = results.filter((r) => r.verdict === 'OK').length;
    assert.ok(ok >= 3, `only ${ok} sources OK — expected >= 3 working fallbacks`);
  });
});
