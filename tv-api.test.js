// tv-api.test.js — TV torrent indexes -> browser-playable episode.
//
// Native MP4 plays directly; H.264 MKV is remuxed by the local helper. All index
// tests inject a fake fetch, so they run offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesEpisode, isPlayableTvFile, isRemuxableTvFile, rankTvSources,
  pickEpisodeFile, fetchTvSources, clearTvCache,
} from './tv-api.mjs';

// ---- matchesEpisode ----
// Season packs are common, so the helper must find the RIGHT episode inside a
// torrent rather than taking the largest file (which would play a random episode).

test('matches the standard SxxExx form', () => {
  assert.ok(matchesEpisode('Show.Name.S01E01.1080p.WEB-DL.mp4', 1, 1));
});

test('matches lowercase and spaced variants', () => {
  assert.ok(matchesEpisode('show name s01e01 1080p.mp4', 1, 1));
  assert.ok(matchesEpisode('Show Name S01 E01 1080p.mp4', 1, 1));
});

test('matches the 1x01 form', () => {
  assert.ok(matchesEpisode('Show.Name.1x01.HDTV.mp4', 1, 1));
});

test('matches single-digit SxEx', () => {
  assert.ok(matchesEpisode('Show.S1E1.mp4', 1, 1));
});

test('matches a Season/Episode directory layout', () => {
  assert.ok(matchesEpisode('Show Name/Season 1/Episode 1.mp4', 1, 1));
});

test('does NOT match a different episode in the same season', () => {
  assert.ok(!matchesEpisode('Show.S01E02.1080p.mp4', 1, 1));
});

test('does NOT confuse episode 10 with episode 1 — the classic off-by-nine', () => {
  assert.ok(!matchesEpisode('Show.S01E10.1080p.mp4', 1, 1));
  assert.ok(!matchesEpisode('Show.S01E01.1080p.mp4', 1, 10));
  assert.ok(matchesEpisode('Show.S01E10.1080p.mp4', 1, 10));
});

test('does NOT match a different season', () => {
  assert.ok(!matchesEpisode('Show.S02E01.1080p.mp4', 1, 1));
});

test('a resolution that looks like an episode code does not fool it', () => {
  // "1080p" and years must never be read as season/episode markers.
  assert.ok(!matchesEpisode('Show.Name.2020.1080p.WEB.mp4', 10, 80));
});

test('three-digit episode numbers work', () => {
  assert.ok(matchesEpisode('Anime.S01E101.mp4', 1, 101));
  assert.ok(!matchesEpisode('Anime.S01E101.mp4', 1, 10));
});

// ---- isPlayableTvFile ----

test('native MP4 and remuxable H.264 MKV pass', () => {
  assert.ok(isPlayableTvFile('Show.S01E01.mp4'));
  assert.ok(isPlayableTvFile('Show.S01E01.M4V'));
  assert.ok(isPlayableTvFile('Show.S01E01.H.264.mkv'));
  assert.ok(isRemuxableTvFile('Show.S01E01.H.264.mkv'));
  assert.ok(!isPlayableTvFile('Show.S01E01.mkv'), 'an MKV needs an explicit H.264 codec');
  assert.ok(!isPlayableTvFile('Show.S01E01.avi'));
  assert.ok(!isPlayableTvFile('Show.S01E01.srt'));
});

test('x265 is rejected in both native and remuxed containers', () => {
  assert.ok(!isPlayableTvFile('Show.S01E01.2160p.x265.mp4'));
  assert.ok(!isPlayableTvFile('Show.S01E01.HEVC.mp4'));
  assert.ok(!isPlayableTvFile('Show.S01E01.2160p.x265.mkv'));
  assert.ok(isPlayableTvFile('Show.S01E01.1080p.x264.mp4'));
});

// ---- rankTvSources ----

const src = (filename, seeds, extra = {}) => ({ filename, seeds, hash: 'a'.repeat(40), ...extra });

test('drops sources that are not playable', () => {
  const out = rankTvSources([src('a.S01E01.1080p.mkv', 500), src('b.S01E01.1080p.mp4', 5)]);
  assert.equal(out.length, 1);
  assert.match(out[0].filename, /\.mp4$/);
});

test('drops zero-seed sources — they never connect', () => {
  const out = rankTvSources([src('a.S01E01.1080p.mp4', 0), src('b.S01E01.720p.mp4', 3)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].seeds, 3);
});

test('prefers 1080p over 720p, and both over 2160p', () => {
  const out = rankTvSources([
    src('c.S01E01.2160p.mp4', 900),
    src('b.S01E01.720p.mp4', 900),
    src('a.S01E01.1080p.mp4', 10),
  ]);
  assert.deepEqual(out.map((s) => s.quality), ['1080p', '720p', '2160p']);
});

test('ranks by seeds within the same quality', () => {
  const out = rankTvSources([src('a.S01E01.1080p.mp4', 5), src('b.S01E01.1080p.mp4', 50)]);
  assert.deepEqual(out.map((s) => s.seeds), [50, 5]);
});

test('reports the quality it detected, and unknown when absent', () => {
  assert.equal(rankTvSources([src('a.S01E01.mp4', 5)])[0].quality, 'unknown');
});

// ---- pickEpisodeFile ----
// Given a torrent's file list, choose the file for the requested episode.

test('picks the requested episode out of a season pack, not the biggest file', () => {
  const files = [
    { name: 'Show.S01E01.1080p.mp4', path: 'Show S01/Show.S01E01.1080p.mp4', length: 500 },
    { name: 'Show.S01E02.1080p.mp4', path: 'Show S01/Show.S01E02.1080p.mp4', length: 9000 },
  ];
  assert.equal(pickEpisodeFile(files, 1, 1).name, 'Show.S01E01.1080p.mp4');
});

test('falls back to the only playable video in a single-episode torrent', () => {
  // Single-file torrents are sometimes named without any SxxExx marker at all.
  const files = [
    { name: 'readme.txt', path: 'readme.txt', length: 20 },
    { name: 'episode.mp4', path: 'episode.mp4', length: 700000 },
  ];
  assert.equal(pickEpisodeFile(files, 3, 7).name, 'episode.mp4');
});

test('returns null when the pack has no playable file for that episode', () => {
  const files = [{ name: 'Show.S01E01.mkv', path: 'Show.S01E01.mkv', length: 900 }];
  assert.equal(pickEpisodeFile(files, 1, 1), null);
});

test('picks an H.264 MKV episode for the local remux path', () => {
  const files = [
    { name: 'Show.S01E01.H.264.mkv', path: 'Show.S01E01.H.264.mkv', length: 500 },
    { name: 'Show.S01E02.H.264.mkv', path: 'Show.S01E02.H.264.mkv', length: 900 },
  ];
  assert.equal(pickEpisodeFile(files, 1, 1).name, 'Show.S01E01.H.264.mkv');
});

test('prefers the episode match over a larger non-matching playable file', () => {
  const files = [
    { name: 'Show.S01E05.1080p.mp4', path: 'a/Show.S01E05.1080p.mp4', length: 99999 },
    { name: 'Show.S01E01.1080p.mp4', path: 'a/Show.S01E01.1080p.mp4', length: 10 },
  ];
  assert.equal(pickEpisodeFile(files, 1, 1).name, 'Show.S01E01.1080p.mp4');
});

// ---- fetchTvSources ----

const streams = (arr) => ({ streams: arr });
const res = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

test('asks the primary index for the right imdb/season/episode and returns ranked sources', async () => {
  clearTvCache();
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    return res(streams([
      { infoHash: 'b'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.x264.mp4' }, title: 'Show\n👤 40' },
      { infoHash: 'c'.repeat(40), behaviorHints: { filename: 'Show.S01E01.2160p.x265.mkv' }, title: 'Show\n👤 900' },
    ]));
  };
  const out = await fetchTvSources('tt0903747', 1, 1, { fetchImpl: fake });
  assert.match(seen[0], /tt0903747:1:1/);
  assert.equal(out.length, 1, 'the mkv/x265 source must be dropped');
  assert.equal(out[0].hash, 'b'.repeat(40));
});

test('falls back to the next index when the primary is unreachable', async () => {
  clearTvCache();
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    if (url.startsWith('https://primary.test')) throw new Error('connect timeout');
    return res(streams([
      { infoHash: '9'.repeat(40), behaviorHints: { filename: 'Show.S01E01.720p.mp4' }, title: 'Show\n👤 4' },
    ]));
  };
  const out = await fetchTvSources('tt7', 1, 1, {
    fetchImpl: fake,
    retries: 0,
    indexUrls: [
      { name: 'Primary', url: 'https://primary.test' },
      { name: 'Fallback', url: 'https://fallback.test' },
    ],
  });
  assert.equal(seen.length, 2);
  assert.match(seen[1], /^https:\/\/fallback\.test/);
  assert.equal(out[0].provider, 'Fallback');
});

test('normalizes Comet descriptions, keeps fileIdx, and rejects a conflicting series year', async () => {
  clearTvCache();
  const correct = '8'.repeat(40);
  const fake = async () => res(streams([
    {
      infoHash: '7'.repeat(40),
      behaviorHints: { filename: 'Utopia.2020.S01E01.H.264.mkv' },
      description: '📄 Utopia.2020.S01E01.H.264.mkv\n📹 avc\n👤 50',
    },
    {
      infoHash: correct,
      fileIdx: 1,
      behaviorHints: { filename: 'Utopia.AU.S01E01.1080p.WEB-DL.H.264.mkv' },
      description: '📄 Utopia.AU.S01E01.1080p.WEB-DL.H.264.mkv\n📹 avc\n👤 2',
      name: '[TORRENT] Comet 1080p',
    },
  ]));
  const out = await fetchTvSources('tt3163562', 1, 1, {
    fetchImpl: fake,
    retries: 0,
    indexUrls: [{ name: 'Comet', url: 'https://comet.test' }],
    year: 2014,
    country: 'AU',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].hash, correct);
  assert.equal(out[0].seeds, 2);
  assert.equal(out[0].fileIndex, 1);
  assert.equal(out[0].provider, 'Comet');
  assert.equal(out[0].remux, true);
});

test('parses the seed count an index puts in its text', async () => {
  clearTvCache();
  const fake = async () => res(streams([
    { infoHash: 'd'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.mp4' }, title: 'Show name\n👤 123 💾 1.2 GB' },
  ]));
  const out = await fetchTvSources('tt1', 1, 1, { fetchImpl: fake });
  assert.equal(out[0].seeds, 123);
});

test('an episode with no playable source resolves to an empty list, not an error', async () => {
  clearTvCache();
  const fake = async () => res(streams([
    { infoHash: 'e'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.mkv' }, title: 'x\n👤 50' },
  ]));
  assert.deepEqual(await fetchTvSources('tt2', 1, 1, { fetchImpl: fake }), []);
});

test('throws a diagnosable error when every torrent index is unreachable', async () => {
  clearTvCache();
  const fake = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(
    () => fetchTvSources('tt3', 1, 1, { fetchImpl: fake, retryDelayMs: 1 }),
    (err) => { assert.match(err.message, /torrent indexes/i); return true; }
  );
});

test('retries once before giving up', async () => {
  clearTvCache();
  let calls = 0;
  const fake = async () => {
    if (++calls === 1) throw new Error('transient');
    return res(streams([{ infoHash: 'f'.repeat(40), behaviorHints: { filename: 'S.S01E01.720p.mp4' }, title: 'x\n👤 9' }]));
  };
  const out = await fetchTvSources('tt4', 1, 1, { fetchImpl: fake, retryDelayMs: 1, indexUrls: [{ name: 'Only', url: 'https://only.test' }], });
  assert.equal(calls, 2, 'one failure + one retry against a single index');
  assert.equal(out.length, 1);
});

test('a second lookup for the same episode is served from cache', async () => {
  clearTvCache();
  let calls = 0;
  const fake = async () => {
    calls++;
    return res(streams([{ infoHash: '1'.repeat(40), behaviorHints: { filename: 'S.S01E01.1080p.mp4' }, title: 'x\n👤 9' }]));
  };
  await fetchTvSources('tt5', 1, 1, { fetchImpl: fake, indexUrls: [{ name: 'Only', url: 'https://only.test' }], });
  const afterFirst = calls;
  await fetchTvSources('tt5', 1, 1, { fetchImpl: fake, indexUrls: [{ name: 'Only', url: 'https://only.test' }], });
  assert.equal(calls, afterFirst, 'the second lookup must not touch the network');
});

test('different episodes are cached separately', async () => {
  clearTvCache();
  let calls = 0;
  const fake = async () => {
    calls++;
    return res(streams([{ infoHash: '2'.repeat(40), behaviorHints: { filename: 'S.S01E01.1080p.mp4' }, title: 'x\n👤 9' }]));
  };
  await fetchTvSources('tt6', 1, 1, { fetchImpl: fake, indexUrls: [{ name: 'Only', url: 'https://only.test' }], });
  const afterFirst = calls;
  await fetchTvSources('tt6', 1, 2, { fetchImpl: fake, indexUrls: [{ name: 'Only', url: 'https://only.test' }], });
  assert.ok(calls > afterFirst, 'a different episode must not reuse the cache');
});

// ---- codec/quality info that lives in the release title, not the filename ----
//
// Real data from torrentio (Severance S01E01, Aug 19 2026) broke both of these:
//   filename "Severance.S01E01.2160p.WEB-DL.DV.HDR[Ben The Men].mp4"
//   title    "Severance.S01.2160p.WEB-DL.DV.HDR.DDP5.1.Atmos.H265.MP4-BTM"
// The filename says nothing about the codec, so an HEVC file passed the filter and
// would have played as a black screen. And:
//   filename "Severance S01E01.mp4"  title "Severance - Season 1 - Mp4 x264 AC3 1080p"
// has its resolution only in the title, so the picker showed "unknown".

test('rejects a source whose TITLE reveals x265 even when the filename does not', () => {
  const out = rankTvSources([{
    hash: 'a'.repeat(40), seeds: 14,
    filename: 'Severance.S01E01.2160p.WEB-DL.DV.HDR[Ben The Men].mp4',
    title: 'Severance.S01.2160p.WEB-DL.DV.HDR.DDP5.1.Atmos.H265.MP4-BTM',
  }]);
  assert.equal(out.length, 0, 'an H265 release must never be offered');
});

test('rejects HEVC named in the title', () => {
  const out = rankTvSources([{
    hash: 'b'.repeat(40), seeds: 90, filename: 'Show.S01E01.1080p.mp4',
    title: 'Show S01 1080p WEB-DL HEVC-GROUP',
  }]);
  assert.equal(out.length, 0);
});

test('falls back to the title for quality when the filename has no resolution', () => {
  const out = rankTvSources([{
    hash: 'c'.repeat(40), seeds: 822,
    filename: 'Severance S01E01.mp4',
    title: 'Severance - Season 1 - Mp4 x264 AC3 1080p',
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].quality, '1080p', 'the title said 1080p');
});

test('the filename still wins when both name a resolution', () => {
  const out = rankTvSources([{
    hash: 'd'.repeat(40), seeds: 5,
    filename: 'Show.S01E01.720p.x264.mp4',
    title: 'Show S01 1080p pack',
  }]);
  assert.equal(out[0].quality, '720p');
});

test('a title mentioning x264 makes an MKV eligible for local remuxing', () => {
  const out = rankTvSources([{
    hash: 'e'.repeat(40), seeds: 500,
    filename: 'Show.S01E01.1080p.mkv', title: 'Show S01 1080p x264',
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].remux, true);
});

// Comet answers first and used to short-circuit the whole loop, so Torrentio —
// the index carrying PUBLIC-tracker torrents — was never consulted whenever Comet
// returned anything at all. On Chernobyl that meant 73 private-tracker sources
// with no reachable peers, and zero of the ThePirateBay/1337x/EZTV ones that
// actually seed. Merge every index that answers, then rank once across the lot.
test('merges sources from every index that answers, not just the first', async () => {
  clearTvCache();
  const fake = async (url) => {
    if (url.startsWith('https://a.test')) {
      return res(streams([
        { infoHash: 'a'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.x264.mp4' }, title: 'A\n👤 5' },
      ]));
    }
    return res(streams([
      { infoHash: 'b'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.x264.mp4' }, title: 'B\n👤 900' },
    ]));
  };
  const out = await fetchTvSources('tt5', 1, 1, {
    fetchImpl: fake,
    retries: 0,
    indexUrls: [{ name: 'A', url: 'https://a.test' }, { name: 'B', url: 'https://b.test' }],
  });
  assert.equal(out.length, 2, 'both indexes must contribute');
  assert.equal(out[0].hash, 'b'.repeat(40), 'the better-seeded source ranks first regardless of index order');
});

test('the same torrent listed by two indexes appears once', async () => {
  clearTvCache();
  const dupe = { infoHash: 'd'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.x264.mp4' }, title: 'Dupe\n👤 30' };
  const fake = async () => res(streams([dupe]));
  const out = await fetchTvSources('tt6', 1, 1, {
    fetchImpl: fake,
    retries: 0,
    indexUrls: [{ name: 'A', url: 'https://a.test' }, { name: 'B', url: 'https://b.test' }],
  });
  assert.equal(out.length, 1);
});

// Dedupe used to run BEFORE the playable/seeds filter, so whichever index was
// listed first won the hash — even when its metadata was worse. Real case
// (Chernobyl S01E01): Comet describes cf4d26… without any codec hint (so it reads
// as unplayable) and lists 3768630c… with no 👤 seed count at all, while
// Torrentio describes both correctly with 224-307 seeds. Keeping Comet's copy
// binned three of the only four sources that actually had reachable peers.
test('keeps the richest copy of a hash, not the first index to mention it', async () => {
  clearTvCache();
  const fake = async (url) => {
    if (url.startsWith('https://poor.test')) {
      // Same torrent, but no codec hint and no seed count.
      return res(streams([
        { infoHash: 'e'.repeat(40), behaviorHints: { filename: 'Show - S01E01.mkv' }, title: 'Show\n🔎 cache' },
      ]));
    }
    return res(streams([
      { infoHash: 'e'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.BluRay.x264-GRP.mkv' }, title: 'Show\n👤 224' },
    ]));
  };
  const out = await fetchTvSources('tt8', 1, 1, {
    fetchImpl: fake,
    retries: 0,
    indexUrls: [{ name: 'Poor', url: 'https://poor.test' }, { name: 'Rich', url: 'https://rich.test' }],
  });
  assert.equal(out.length, 1, 'the torrent must survive');
  assert.equal(out[0].seeds, 224, 'and must keep the copy that knows its seed count');
  assert.equal(out[0].provider, 'Rich');
});

// The source-level filter judges a torrent with its release title in hand, so
// "Chernobyl - S01E01 - 1.23.45.mkv" inside a pack whose title says BluRay x264
// is correctly ruled playable. pickEpisodeFile then re-judged the same file with
// NO context, found no codec in the bare filename, rejected every file and
// answered 404 "no playable file for S1E1" — for a torrent with 307 seeds that
// the app had just offered as the top source.
test('pickEpisodeFile accepts a file whose codec is only named in the release title', () => {
  const files = [
    { path: 'Chernobyl - Season 1/Chernobyl - S01E01 - 1.23.45.mkv', length: 2.5e9 },
    { path: 'Chernobyl - Season 1/Chernobyl - S01E02 - Please Remain Calm.mkv', length: 2.4e9 },
  ];
  const context = 'Chernobyl - Season 1 (2019) [1080p BluRay x264 SilentBob]';
  assert.equal(pickEpisodeFile(files, 1, 1, context)?.path, files[0].path);
  assert.equal(pickEpisodeFile(files, 1, 2, context)?.path, files[1].path);
});

test('pickEpisodeFile still refuses an HEVC pack, context or not', () => {
  const files = [{ path: 'Show - S01E01.mkv', length: 1e9 }];
  assert.equal(pickEpisodeFile(files, 1, 1, 'Show S01 2160p BluRay x265 HEVC'), null);
});

test('pickEpisodeFile without context keeps working for self-describing names', () => {
  const files = [{ path: 'Show.S01E01.1080p.x264-GRP.mkv', length: 1e9 }];
  assert.equal(pickEpisodeFile(files, 1, 1)?.path, files[0].path);
});
