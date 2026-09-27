import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCatalog, CATEGORY_ORDER, createCatalogFeed } from './live-catalog.mjs';

const ch = (id, category, height, extra = {}) => ({ id, name: id.toUpperCase(), category, url: `https://cdn.example/${id}.m3u8`, logo: null, height, codec: 'h264', country: 'GB', language: 'en', source: 'iptv-org', official: true, host: 'cdn.example', ...extra });

test('mergeCatalog dedupes by id and by url, drops unofficial, bare-IP, denied and non-http entries', () => {
  const out = mergeCatalog([
    [ch('bbc', 'News', 720), ch('dup', 'News', 720), ch('bad', 'Movies', 1080, { official: false })],
    [ch('bbc', 'News', 1080), ch('dup2', 'News', 720, { url: 'https://cdn.example/dup.m3u8' }), ch('ip', 'Kids', 1080, { url: 'http://1.2.3.4/x.m3u8' }), ch('rtmp', 'Kids', 1080, { url: 'rtmp://cdn.example/x' }), ch('ws', 'Music', 1080, { url: 'https://x.workers.dev/a.m3u8' })],
  ]);
  assert.deepEqual(out.map(c => c.id).sort(), ['bbc', 'dup']);
  assert.equal(out.find(c => c.id === 'bbc').height, 1080, 'the sharper duplicate wins');
});

test('mergeCatalog maps unknown categories to General', () => {
  const out = mergeCatalog([[ch('a', 'Weird Stuff', 720)]]);
  assert.equal(out[0].category, 'General');
  assert.ok(CATEGORY_ORDER.includes('News') && CATEGORY_ORDER.indexOf('News') < CATEGORY_ORDER.indexOf('Shopping'));
});

test('createCatalogFeed probes all entries, keeps alive ones, groups by category in order, sharpest first', async () => {
  let clock = 0; const probed = [];
  const entries = [ch('n1', 'News', 720), ch('n2', 'News', 1080), ch('k1', 'Kids', 1080), ch('dead', 'Kids', 1080), ch('m1', 'Movies', 480)];
  const probe = async e => { probed.push(e.id); if (e.id === 'dead') return { status: 'timeout' }; return { status: 'ok', height: e.id === 'n1' ? 1080 : 0 }; };
  const feed = createCatalogFeed({ entries, probe, now: () => clock, ttlMs: 1000 });
  await feed.refresh();
  const cats = feed.categories();
  assert.deepEqual(cats.map(c => c.name), ['News', 'Movies', 'Kids'].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)));
  const news = cats.find(c => c.name === 'News');
  assert.deepEqual(news.channels.map(c => [c.id, c.height]), [['n1', 1080], ['n2', 1080]], 'measured height wins over the stored one; ties by name');
  assert.deepEqual(cats.find(c => c.name === 'Kids').channels.map(c => c.id), ['k1']);
  assert.equal(probed.length, 5);
  assert.equal(feed.get('k1').url, 'https://cdn.example/k1.m3u8');
  assert.equal(feed.get('dead'), null);
});

test('createCatalogFeed serves the stored list before the first probe finishes and keeps last results on probe errors', async () => {
  const entries = [ch('a', 'News', 720)];
  let release;
  const feed = createCatalogFeed({ entries, probe: () => new Promise(r => { release = r; }) });
  const p = feed.refresh();
  assert.deepEqual(feed.categories().map(c => c.channels.map(x => x.id)), [['a']], 'optimistic before probing completes');
  release({ status: 'ok', height: 720 });
  await p;
  const feed2 = createCatalogFeed({ entries, probe: async () => { throw new Error('boom'); } });
  await feed2.refresh();
  assert.deepEqual(feed2.categories(), [], 'a throwing probe counts as dead');
});

test('within a category, English then Urdu, Punjabi, Hindi, Arabic lead; resolution breaks ties', async () => {
  const entries = [ch('hi1', 'News', 1080, { language: 'hi' }), ch('en1', 'News', 720, { language: 'en' }), ch('ur1', 'News', 720, { language: 'ur' }), ch('fr1', 'News', 1080, { language: 'fr' }), ch('en2', 'News', 1080, { language: 'en' }), ch('pa1', 'News', 720, { language: 'pa' })];
  const feed = createCatalogFeed({ entries, probe: async e => ({ status: 'ok', height: e.height }) });
  await feed.refresh();
  assert.deepEqual(feed.categories()[0].channels.map(c => c.id), ['en2', 'en1', 'ur1', 'pa1', 'hi1', 'fr1']);
});

test('mergeCatalog drops same-name duplicates within a category, keeping the sharper one', () => {
  const out = mergeCatalog([[ch('pluto-a', 'Movies', 684, { name: 'Pluto TV Action' })], [ch('pluto:123', 'Movies', 1080, { name: 'Pluto TV Action', url: 'https://cdn.example/other.m3u8' }), ch('keep', 'Kids', 684, { name: 'Pluto TV Action' })]]);
  assert.deepEqual(out.map(c => c.id).sort(), ['keep', 'pluto:123']);
});

test('UK channels lead their language group, and rows are capped', async () => {
  const entries = [ch('us1', 'News', 1080, { country: 'US' }), ch('gb1', 'News', 720, { country: 'GB' }), ch('uk2', 'News', 540, { country: 'UK' })];
  for (let i = 0; i < 130; i++) entries.push(ch('g' + i, 'General', 720));
  const feed = createCatalogFeed({ entries, probe: async e => ({ status: 'ok', height: e.height }), rowLimit: 100 });
  await feed.refresh();
  const cats = feed.categories();
  assert.deepEqual(cats.find(c => c.name === 'News').channels.map(c => c.id), ['gb1', 'uk2', 'us1']);
  assert.equal(cats.find(c => c.name === 'General').channels.length, 100);
});
