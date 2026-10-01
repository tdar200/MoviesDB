import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveTemplates, mergeCatalog, CATEGORY_ORDER } from './live-catalog.mjs';

// The channel lists are hand-maintained data (channels/*.json). These guard the invariants the
// catalog relies on, so a bad edit cannot silently blank or mis-file channels on the TV.
const files = readdirSync('channels').filter((f) => f.endsWith('.json') && !f.includes('excluded'));
const lists = files.map((f) => ({ file: f, entries: JSON.parse(readFileSync(`channels/${f}`, 'utf8')) }));
const all = lists.flatMap((l) => l.entries);

test('every channel has a unique id, a known category and official=true; Pluto entries also carry a measured height', () => {
  for (const { file, entries } of lists) {
    const seen = new Set();
    for (const e of entries) {
      assert.ok(e.id && !seen.has(e.id), `${file}: duplicate or missing id ${e.id}`);
      seen.add(e.id);
      assert.ok(e.name, `${file}: ${e.id} has no name`);
      assert.ok(CATEGORY_ORDER.includes(e.category), `${file}: ${e.name} has category "${e.category}" (falls into General)`);
      assert.equal(e.official, true, `${file}: ${e.name} is not marked official`);
      // The loader tolerates a missing height (the live probe fills it in), but Pluto entries are measured.
      if (String(e.id).startsWith('pluto:')) assert.ok(Number(e.height) > 0, `${file}: ${e.name} has no measured height`);
      assert.ok(e.url || e.urlTemplate, `${file}: ${e.name} has no url`);
    }
  }
});

test('Pluto channels use the session template and resolve to their own channel id', () => {
  const pluto = all.filter((e) => String(e.id).startsWith('pluto:'));
  assert.ok(pluto.length >= 140, `expected the Pluto UK set, got ${pluto.length}`);
  const resolved = resolveTemplates(pluto, { plutoSession: { stitcherParams: 'appName=web', sessionToken: 'tok.en' } });
  assert.equal(resolved.length, pluto.length, 'every Pluto entry must resolve with a session');
  for (const e of resolved) {
    const id = e.id.slice('pluto:'.length);
    assert.ok(e.url.includes(`/channel/${id}/master.m3u8`), `${e.name}: url does not carry its own channel id`);
    assert.ok(!/\{[A-Za-z]+\}/.test(e.url), `${e.name}: unresolved placeholder`);
  }
});

test('the merged catalog keeps every Pluto channel that has no twin on another platform', () => {
  const merged = mergeCatalog(lists.map((l) => l.entries));
  const pluto = all.filter((e) => String(e.id).startsWith('pluto:'));
  const keptIds = new Set(merged.map((e) => e.id));
  // Entries listed but merged away by the category+name dedupe are pure duplicates; none should be silently
  // dropped for any other reason (denied host, bare IP, non-http).
  const droppedWithoutTwin = pluto.filter((e) => !keptIds.has(e.id)
    && !merged.some((m) => m.category === e.category && String(m.name).toLowerCase().trim() === String(e.name).toLowerCase().trim()));
  assert.deepEqual(droppedWithoutTwin.map((e) => e.name), []);
});

test('no adult channels are listed', () => {
  assert.deepEqual(all.filter((e) => /erotica|\bxxx\b|porn|playboy/i.test(e.name)).map((e) => e.name), []);
});

// Official YouTube live channels (HUM, Geo, ARY ...): identity was confirmed from the broadcaster's own website or a
// verified channel badge. A wrong id here would put someone else's stream in the Pakistan row, so pin the shape.
test('YouTube live channels: valid channel ids, Pakistani, urls derived from the id, one entry per channel', () => {
  const yt = JSON.parse(readFileSync('channels/youtube.json', 'utf8'));
  assert.ok(yt.length >= 12, `expected the Pakistani broadcaster set, got ${yt.length}`);
  const ids = new Set();
  for (const e of yt) {
    assert.match(e.youtube, /^UC[\w-]{22}$/, `${e.name}: bad channel id`);
    assert.equal(e.id, `youtube:${e.youtube}`, `${e.name}: id must be derived from the channel id`);
    assert.equal(e.url, `https://www.youtube.com/channel/${e.youtube}/live`, `${e.name}: url must be the channel live page`);
    assert.equal(e.country, 'PK', `${e.name}: goes in the Pakistan row`);
    assert.equal(e.official, true);
    assert.ok(['embed', 'app'].includes(e.via), `${e.name}: via must be embed (plays in the app) or app (opens in the TV's YouTube app)`);
    assert.ok(!ids.has(e.youtube), `${e.name}: duplicate channel`);
    ids.add(e.youtube);
  }
  const names = yt.map(e => e.name);
  for (const n of ['Geo News', 'ARY News', 'Express News', 'Samaa TV', 'Dawn News', 'Dunya News', 'HUM TV', 'Geo Super']) assert.ok(names.includes(n), `${n} is listed`);
  // ARY Digital is live on YouTube but ARY disabled embedding, so it cannot play here: it must not be listed.
  assert.ok(!names.some(n => /ARY Digital/i.test(n)));
});

// Which channels play inside the app was measured on the TV with the real player: owners that disallow embedding
// (YouTube error 150) must be `via: app`, otherwise the tile opens to a grey error screen.
test('YouTube live channels: the ones measured as embeddable on the TV play in-app, the blocked ones open in the YouTube app', () => {
  const yt = JSON.parse(readFileSync('channels/youtube.json', 'utf8'));
  const via = Object.fromEntries(yt.map(e => [e.name, e.via]));
  for (const n of ['24 News HD', 'Dawn News', 'Neo News', 'GNN']) assert.equal(via[n], 'embed', `${n} plays in-app`);
  for (const n of ['Geo News', 'ARY News', 'Express News', 'Samaa TV', 'Dunya News', 'Aaj News', 'BOL News', 'Such News', 'Geo Super', 'PTV Sports']) assert.equal(via[n], 'app', `${n} blocks embedding`);
});
