// tv-api.test.js — TV torrent indexes -> browser-playable episode.
//
// Native MP4 plays directly; H.264 MKV is remuxed by the local helper. All index
// tests inject a fake fetch, so they run offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesEpisode, isPlayableTvFile, isRemuxableTvFile, rankTvSources,
  pickEpisodeFile, pickEpisodeVideoFile, pickMovieFileByIndex, fetchTvSources, clearTvCache,
  debridSettings, torrentioDebridSegment, indexStreamUrl, isTranscodableTvFile, supplementalTvSources,
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

test('prefers a smaller healthy episode over a larger one with stale-looking seed counts', () => {
  const out = rankTvSources([
    src('large.S01E01.720p.x264.mkv', 200, { title: 'large 👤 200 💾 2.4 GB' }),
    src('small.S01E01.720p.x264.mkv', 20, { title: 'small 👤 20 💾 650 MB' }),
  ]);
  assert.match(out[0].filename, /^small/);
});

test('prefers English or untagged audio over an explicit foreign-only release', () => {
  const out = rankTvSources([
    src('Show.S01E01.720p.FRENCH.x264.mkv', 300, { title: 'Show FRENCH 👤 300 💾 500 MB' }),
    src('Show.S01E01.720p.x264.mkv', 20, { title: 'Show English 👤 20 💾 700 MB' }),
  ]);
  assert.doesNotMatch(out[0].filename, /FRENCH/);
});

test('does not penalize MULTi releases because they normally include English audio', () => {
  const out = rankTvSources([
    src('Show.S01E01.720p.MULTi.FRENCH.x264.mkv', 20, { title: 'Show MULTi FRENCH 👤 20 💾 500 MB' }),
    src('Show.S01E01.720p.x264.mkv', 20, { title: 'Show 👤 20 💾 700 MB' }),
  ]);
  assert.match(out[0].filename, /MULTi/);
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

test('picks the indexed movie from a multi-film torrent instead of the largest file', () => {
  const files = [
    { name: 'Other.Movie.1080p.x264.mkv', path: 'Other.Movie.1080p.x264.mkv', length: 9000 },
    { name: 'The.God.of.Cookery.720p.x264.mkv', path: 'The.God.of.Cookery.720p.x264.mkv', length: 500 },
  ];
  assert.equal(pickMovieFileByIndex(files, 1, 'Ultimate Stephen Chow x264').name, 'The.God.of.Cookery.720p.x264.mkv');
  assert.equal(pickMovieFileByIndex(files, 9, 'Ultimate Stephen Chow x264'), null);
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
  // The x265 source is no longer dropped — it is kept as a GPU-transcode option,
  // ranked below the directly-playable H.264 copy.
  assert.equal(out.length, 2);
  assert.equal(out[0].hash, 'b'.repeat(40), 'the directly-playable 1080p H.264 ranks first');
  assert.equal(out[0].transcode, false);
  assert.equal(out[1].transcode, true, 'the 2160p x265 is offered for transcode, not direct play');
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

test('an H265 source revealed only by the title is offered for transcode, never direct play', () => {
  const out = rankTvSources([{
    hash: 'a'.repeat(40), seeds: 14,
    filename: 'Severance.S01E01.2160p.WEB-DL.DV.HDR[Ben The Men].mp4',
    title: 'Severance.S01.2160p.WEB-DL.DV.HDR.DDP5.1.Atmos.H265.MP4-BTM',
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].transcode, true, 'HEVC must be transcoded, not remuxed');
  assert.equal(out[0].remux, false, 'it must never be offered as a direct/remux copy');
});

test('HEVC named in the title is kept as a transcode source', () => {
  const out = rankTvSources([{
    hash: 'b'.repeat(40), seeds: 90, filename: 'Show.S01E01.1080p.mp4',
    title: 'Show S01 1080p WEB-DL HEVC-GROUP',
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].transcode, true);
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

// pickEpisodeVideoFile is the probe-time picker: it must find the episode's video
// even when pickEpisodeFile would reject it for codec reasons, because probing
// only reads metadata (duration, embedded subs). Real case: a season pack whose
// per-episode filenames name no codec — pickEpisodeFile returned null without the
// release title as context, so /subtitles found no file to probe and showed none.
test('pickEpisodeVideoFile finds the episode file with no codec in the name', () => {
  const files = [
    { path: 'Chernobyl S01/Chernobyl - S01E01 - 1.23.45.mkv', length: 1.2e9 },
    { path: 'Chernobyl S01/Chernobyl - S01E02 - Please Remain Calm.mkv', length: 1.1e9 },
  ];
  assert.equal(pickEpisodeVideoFile(files, 1, 1)?.path, files[0].path);
  assert.equal(pickEpisodeVideoFile(files, 1, 2)?.path, files[1].path);
});

test('pickEpisodeVideoFile ignores non-video files and falls back sensibly', () => {
  const files = [
    { path: 'Show/readme.txt', length: 100 },
    { path: 'Show/Show.S01E01.mkv', length: 5e8 },
  ];
  assert.equal(pickEpisodeVideoFile(files, 1, 1)?.path, 'Show/Show.S01E01.mkv');
  // No episode match, single video -> that video.
  assert.equal(pickEpisodeVideoFile([{ path: 'Movie.mkv', length: 1e9 }], 9, 9)?.path, 'Movie.mkv');
  assert.equal(pickEpisodeVideoFile([], 1, 1), null);
});

test('rejects a spin-off returned under the parent series lookup', async () => {
 const { matchesSeriesTitle } = await import('./tv-api.mjs');
 assert.equal(matchesSeriesTitle({filename:'Rick.and.Morty.The.Anime.S01E01.1080p.x264.mkv'},['Rick and Morty']),false);
 assert.equal(matchesSeriesTitle({filename:'Rick.and.Morty.S01E01.1080p.x264.mkv'},['Rick and Morty']),true);
 assert.equal(matchesSeriesTitle({filename:'The.Office.US.S01E01.1080p.x264.mkv'},['The Office']),true);
 assert.equal(matchesSeriesTitle({filename:'[Group] Rick.&.Morty.S01E01.mkv'},['Rick and Morty']),true);
 assert.equal(matchesSeriesTitle({filename:'S01E01.mkv'},['Rick and Morty']),true);
});
test('release names may drop or add apostrophes without losing the show', async () => {
 const { matchesSeriesTitle } = await import('./tv-api.mjs');
 assert.equal(matchesSeriesTitle({filename:'RuPauls.Drag.Race.S01E01.WEBRip.1080p-WOWRip.mp4'},["RuPaul's Drag Race"]),true);
 assert.equal(matchesSeriesTitle({filename:"RuPaul's.Drag.Race.S01E01.1080p.mkv"},["RuPaul's Drag Race"]),true);
 assert.equal(matchesSeriesTitle({filename:'Greys.Anatomy.S01E01.720p.mkv'},["Grey's Anatomy"]),true);
 // Scene releases also write the possessive as its own token ("Marvel.s.Agents..."), which
 // the pre-apostrophe-fix matcher accepted; both spellings must keep working.
 assert.equal(matchesSeriesTitle({filename:'Marvel.s.Agents.of.S.H.I.E.L.D.S01E01.720p.mkv'},["Marvel's Agents of S.H.I.E.L.D."]),true);
 assert.equal(matchesSeriesTitle({filename:'Marvels.Agents.of.S.H.I.E.L.D.S01E01.720p.mkv'},["Marvel's Agents of S.H.I.E.L.D."]),true);
 assert.equal(matchesSeriesTitle({filename:'Conan.S01E01.720p.mkv'},['Conan']),true);
 assert.equal(matchesSeriesTitle({filename:'ConMan.S01E01.720p.mkv'},['Conan']),false);
});

test('accepts the name every release uses when TMDB words the title differently', async () => {
 const { filterSeriesTitle } = await import('./tv-api.mjs');
 const rel = (filename) => ({ filename, title: filename });
 // TMDB calls the show "Lioness"; the index is queried by IMDb id and its releases are
 // named "Special Ops Lioness". A different show that merely starts with the word stays out.
 const lioness = [1, 2, 3, 4, 5, 6].map((n) => rel(`Special.Ops.Lioness.S01E01.${n}080p.x264.mkv`))
  .concat(rel('Lioness.Hunting.Documentary.S01E01.1080p.x264.mkv'));
 const kept = filterSeriesTitle(lioness, ['Lioness', 'Lioness']);
 assert.equal(kept.length, 6);
 assert.ok(kept.every((s) => /Special\.Ops/.test(s.filename)));
 // The other direction: TMDB carries the decoration, releases drop it.
 assert.equal(filterSeriesTitle([1, 2, 3].map((n) => rel(`Jack.Ryan.S01E01.${n}.mkv`)), ["Tom Clancy's Jack Ryan"]).length, 3);
});

test('an index that agrees on an unrelated name is still rejected', async () => {
 const { filterSeriesTitle } = await import('./tv-api.mjs');
 const rel = (filename) => ({ filename, title: filename });
 const many = (name, n = 5) => Array.from({ length: n }, (_, i) => rel(`${name}.S01E01.${i}.1080p.mkv`));
 // A dominant wrong show must never become an alias: these are real index answers the
 // filter correctly refused (Conan -> ConMan, Shadow Hunter -> Shadowhunters, Once -> an unrelated series).
 assert.equal(filterSeriesTitle(many('ConMan'), ['Conan']).length, 0);
 assert.equal(filterSeriesTitle(many('Shadowhunters'), ['Shadow Hunter']).length, 0);
 assert.equal(filterSeriesTitle(many('Jack.of.All.Trades.Party.of.None'), ['Once']).length, 0);
 // A spin-off that extends the title at the END is not a decorated copy of it, however common.
 assert.equal(filterSeriesTitle(many('Rick.and.Morty.The.Anime'), ['Rick and Morty']).length, 0);
 assert.equal(filterSeriesTitle(many('The.Walking.Dead.World.Beyond'), ['The Walking Dead']).length, 0);
});

test('one or two releases are not enough evidence to rename a show', async () => {
 const { filterSeriesTitle } = await import('./tv-api.mjs');
 const rel = (filename) => ({ filename, title: filename });
 // Live case: TMDB "Conan" (the talk show) -> an index answering ConMan + "Detective Conan"
 // (an anime). "Detective Conan" ends with "conan", so only the evidence bar keeps it out.
 assert.equal(filterSeriesTitle([rel('ConMan.S01E01.1080p.mkv'), rel('Detective.Conan.S01E01.mp4')], ['Conan']).length, 0);
 assert.equal(filterSeriesTitle([rel('Detective.Conan.S01E01.a.mkv'), rel('Detective.Conan.S01E01.b.mkv'), rel('ConMan.S01E01.mkv')], ['Conan']).length, 0);
 // A name shared by only a minority of a mixed pool does not qualify either.
 const mixed = [1, 2].map((n) => rel(`Special.Ops.Lioness.S01E01.${n}.mkv`)).concat([1, 2, 3].map((n) => rel(`Other.Show.S01E01.${n}.mkv`)));
 assert.equal(filterSeriesTitle(mixed, ['Lioness']).length, 0);
});

test('fetchTvSources keeps every source when releases use a longer show name than TMDB', async () => {
 clearTvCache();
 const fake = async () => res(streams([
  { infoHash: 'a'.repeat(40), behaviorHints: { filename: 'Special.Ops.Lioness.S01E01.1080p.WEB.x264.mkv' }, title: 'Special Ops Lioness\n👤 182' },
  { infoHash: 'b'.repeat(40), behaviorHints: { filename: 'Special Ops Lioness S01E01.mp4' }, title: 'Special Ops Lioness\n👤 142' },
  { infoHash: 'c'.repeat(40), behaviorHints: { filename: 'Special.Ops.Lioness.S01E01.720p.x264.mkv' }, title: 'Special Ops Lioness\n👤 20' },
 ]));
 const out = await fetchTvSources('tt13111078', 1, 1, { fetchImpl: fake, title: 'Lioness', originalTitle: 'Lioness', year: 2023, country: 'US' });
 assert.equal(out.length, 3);
});

test('a lookup that lost an index is retried soon instead of cached for the full TTL', async () => {
 // Live case: one lookup right after a helper restart lost Torrentio, and the Comet-only
 // pool (private-tracker swarms with no reachable peers) then stuck for 30 minutes.
 clearTvCache();
 let now = 1_000_000;
 let bUp = false;
 const calls = [];
 const fake = async (url) => {
  calls.push(url);
  if (url.startsWith('https://b.test')) {
   if (!bUp) throw new Error('connect timeout');
   return res(streams([{ infoHash: 'b'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.x264.mp4' }, title: 'Show\n👤 300' }]));
  }
  return res(streams([{ infoHash: 'a'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.x264.mkv' }, title: 'Show\n👤 40' }]));
 };
 const opts = { fetchImpl: fake, now: () => now, retries: 0, indexUrls: [{ name: 'A', url: 'https://a.test' }, { name: 'B', url: 'https://b.test' }] };

 const degraded = await fetchTvSources('tt9', 1, 1, opts);
 assert.deepEqual(degraded.map((s) => s.hash), ['a'.repeat(40)], 'only the index that answered contributes');
 const callsAfterFirst = calls.length;

 now += 5_000; // inside the short window: served from cache, the dead index is not hammered
 await fetchTvSources('tt9', 1, 1, opts);
 assert.equal(calls.length, callsAfterFirst);

 bUp = true;
 now += 25_000; // 30 s in: far short of the 30 min TTL, but the degraded entry has expired
 const healed = await fetchTvSources('tt9', 1, 1, opts);
 assert.ok(healed.some((s) => s.hash === 'b'.repeat(40)), 'the recovered index is picked up on the next request');
 assert.equal(healed[0].hash, 'b'.repeat(40), 'and its better-seeded copy ranks first');
});

test('a fully healthy lookup is still cached for the whole TTL', async () => {
 clearTvCache();
 let now = 1_000_000;
 let calls = 0;
 const fake = async () => { calls++; return res(streams([{ infoHash: 'a'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.x264.mp4' }, title: 'Show\n👤 40' }])); };
 const opts = { fetchImpl: fake, now: () => now, retries: 0, indexUrls: [{ name: 'A', url: 'https://a.test' }, { name: 'B', url: 'https://b.test' }] };
 await fetchTvSources('tt8', 1, 1, opts);
 const first = calls;
 now += 10 * 60 * 1000;
 await fetchTvSources('tt8', 1, 1, opts);
 assert.equal(calls, first, 'no index is re-queried after 10 minutes');
});

test('a retry of an index that just failed is short, so a dead index cannot stall every lookup', async () => {
 clearTvCache();
 let now = 1_000_000;
 const timeouts = [];
 const fake = async (url, init) => {
  if (url.startsWith('https://b.test')) { timeouts.push(init && init.signal ? 'signal' : 'none'); throw new Error('connect timeout'); }
  return res(streams([{ infoHash: 'a'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.x264.mkv' }, title: 'Show\n👤 40' }]));
 };
 const opts = { fetchImpl: fake, now: () => now, retries: 1, retryDelayMs: 1, indexUrls: [{ name: 'A', url: 'https://a.test' }, { name: 'B', url: 'https://b.test' }] };
 await fetchTvSources('tt7', 1, 1, opts);
 assert.equal(timeouts.length, 2, 'first lookup: the failing index gets its normal retry');
 now += 25_000;
 await fetchTvSources('tt7', 1, 1, opts);
 assert.equal(timeouts.length, 3, 're-lookup: the index that just failed gets ONE quick attempt, not another full retry cycle');
});

test('a single file explicitly naming a different episode is not a fallback', () => {
 assert.equal(pickEpisodeFile([{name:'Show.S01E02.mp4',length:100}],1,1),null);
});

test('movie fallback uses the movie endpoint and keeps playable alternatives', async () => {
 const {fetchMovieSources}=await import('./tv-api.mjs');
 clearTvCache();let requested='';
 const sources=await fetchMovieSources('tt1234567',{indexUrls:['https://index.test'],retries:0,fetchImpl:async url=>{requested=url;return {ok:true,json:async()=>({streams:[{infoHash:'a'.repeat(40),title:'Film.2024.1080p.x264.mkv\n👤 30',behaviorHints:{filename:'Film.2024.1080p.x264.mkv'}}]})};},year:2024});
 assert.match(requested,/\/stream\/movie\/tt1234567\.json$/);
 assert.equal(sources.length,1);
 assert.equal(sources[0].remux,true);
});

test("movie fallback rejects fan-made videos masquerading as a release", async () => {
 const {fetchMovieSources}=await import("./tv-api.mjs");
 clearTvCache();
 const sources=await fetchMovieSources("tt31349844",{indexUrls:["https://index.test"],retries:0,fetchImpl:async()=>({ok:true,json:async()=>({streams:[{infoHash:"a".repeat(40),title:"Runner 2026 Full Action Movie Fan-Made\\n👤 3",behaviorHints:{filename:"Runner.2026.Fan-Made.640x360.mp4"}}]})})});
 assert.deepEqual(sources,[]);
});

// ---- Optional debrid (Real-Debrid et al.) ----
// Cached debrid results arrive as ready `url` streams with no infohash. They must
// be surfaced (not dropped by the infohash filter), exempt from the seeds filter
// (a cached file has no swarm), and ranked above plain torrents.

test('debridSettings: off with no key, on with a valid key, default service realdebrid', () => {
  assert.equal(debridSettings({}), null);
  assert.equal(debridSettings({ DEBRID_API_KEY: '  ' }), null);
  assert.deepEqual(debridSettings({ DEBRID_API_KEY: 'abc' }), { service: 'realdebrid', key: 'abc' });
  assert.deepEqual(
    debridSettings({ DEBRID_API_KEY: 'k', DEBRID_SERVICE: 'AllDebrid' }),
    { service: 'alldebrid', key: 'k' },
  );
  assert.equal(debridSettings({ DEBRID_API_KEY: 'k', DEBRID_SERVICE: 'notareal service' }), null);
});

test('torrentioDebridSegment: empty without debrid, service=key with it', () => {
  assert.equal(torrentioDebridSegment(null), '');
  assert.equal(torrentioDebridSegment({ service: 'realdebrid', key: 'abc' }), 'sort=qualitysize|realdebrid=abc');
  // The key is url-encoded so odd characters cannot break the path segment.
  assert.match(torrentioDebridSegment({ service: 'realdebrid', key: 'a/b c' }), /realdebrid=a%2Fb%20c$/);
});

test('indexStreamUrl: injects debrid config for Torrentio only, never Comet', () => {
  const debrid = { service: 'realdebrid', key: 'K' };
  const t = indexStreamUrl({ name: 'Torrentio', url: 'https://torrentio.strem.fun' }, 'series', 'tt1:1:1', debrid);
  assert.equal(t, 'https://torrentio.strem.fun/sort=qualitysize|realdebrid=K/stream/series/tt1:1:1.json');
  const c = indexStreamUrl({ name: 'Comet', url: 'https://comet.feels.legal' }, 'series', 'tt1:1:1', debrid);
  assert.equal(c, 'https://comet.feels.legal/stream/series/tt1:1:1.json');
  // No debrid -> bare url for both.
  assert.equal(
    indexStreamUrl({ name: 'Torrentio', url: 'https://torrentio.strem.fun' }, 'movie', 'tt9', null),
    'https://torrentio.strem.fun/stream/movie/tt9.json',
  );
});

test('fetchTvSources surfaces a debrid url stream, marks it, and ranks it first', async () => {
  clearTvCache();
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    return res(streams([
      // A plain torrent with real seeds...
      { infoHash: 'b'.repeat(40), behaviorHints: { filename: 'Show.S01E01.1080p.x264.mkv' }, title: 'Show\n👤 40' },
      // ...and a cached debrid file with NO infohash and NO seeds.
      { url: 'https://x.download.real-debrid.com/d/ABC/Show.S01E01.1080p.x264.mkv', behaviorHints: { filename: 'Show.S01E01.1080p.x264.mkv' }, title: '[RD+] Show.S01E01.1080p' },
    ]));
  };
  const out = await fetchTvSources('tt1', 1, 1, {
    fetchImpl: fake,
    indexUrls: [{ name: 'Torrentio', url: 'https://torrentio.strem.fun' }],
    debrid: { service: 'realdebrid', key: 'K' },
  });
  assert.match(seen[0], /realdebrid=K/, 'the debrid config must reach Torrentio');
  assert.equal(out.length, 2);
  assert.equal(out[0].debrid, true, 'the cached source ranks first');
  assert.ok(out[0].url.startsWith('https://'), 'the debrid source keeps its url');
  assert.equal(out[0].hash, '', 'a debrid source has no infohash');
  assert.equal(out[1].hash, 'b'.repeat(40), 'the plain torrent ranks after');
});

test('a debrid source with zero seeds is NOT dropped by the seeds filter', () => {
  const ranked = rankTvSources([
    { url: 'https://x.real-debrid.com/f.mkv', debrid: true, filename: 'A.S01E01.1080p.x264.mkv', title: 'A', seeds: 0 },
    { hash: 'a'.repeat(40), filename: 'A.S01E01.1080p.x264.mkv', title: 'A 👤 0', seeds: 0 },
  ]);
  assert.equal(ranked.length, 1, 'the 0-seed torrent is dropped but the debrid file survives');
  assert.equal(ranked[0].debrid, true);
});

// ---- HEVC transcode sources ----
// The well-seeded copy of many shows (Mirzapur is the anchor case) is HEVC while
// the H.264 copy is dead. Rather than report "no source", the helper GPU-transcodes
// the HEVC copy; these tests pin how such sources are surfaced and ranked.

test('isTranscodableTvFile: HEVC containers yes, H.264/codec-less no', () => {
  assert.ok(isTranscodableTvFile('Show.S01E01.1080p.x265.mkv'));
  assert.ok(isTranscodableTvFile('Show.S01E01.2160p.HEVC.mp4'));
  assert.ok(isTranscodableTvFile('Show.S01E01.720p.mkv', 'Show S01 H.265'));
  assert.ok(!isTranscodableTvFile('Show.S01E01.1080p.x264.mkv'), 'H.264 is played directly, not transcoded');
  assert.ok(!isTranscodableTvFile('Show.S01E01.1080p.mkv'), 'no codec tag -> left alone, not transcoded');
  assert.ok(!isTranscodableTvFile('Show.S01E01.x265.srt'), 'a subtitle is not a video');
});

test('a well-seeded HEVC copy is preferred over a dead H.264 copy (the Mirzapur case)', () => {
  const out = rankTvSources([
    { hash: 'a'.repeat(40), seeds: 1, filename: 'M.S01E01.1080p.x264.mkv', title: 'M 👤 1' },
    { hash: 'b'.repeat(40), seeds: 15, filename: 'M.S01E01.1080p.x265.mkv', title: 'M 👤 15' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].hash, 'b'.repeat(40), 'the 15-seed HEVC outranks the 1-seed H.264');
  assert.equal(out[0].transcode, true);
  assert.equal(out[1].transcode, false);
});

test('a well-seeded H.264 copy is preferred over an equally-seeded HEVC (avoid needless transcode)', () => {
  const out = rankTvSources([
    { hash: 'a'.repeat(40), seeds: 50, filename: 'M.S01E01.1080p.x265.mkv', title: 'M 👤 50' },
    { hash: 'b'.repeat(40), seeds: 50, filename: 'M.S01E01.1080p.x264.mkv', title: 'M 👤 50' },
  ]);
  assert.equal(out[0].hash, 'b'.repeat(40), 'same seeds -> the H.264 copy that needs no transcode wins');
  assert.equal(out[0].transcode, false);
});

test('a compact healthy HEVC episode beats an oversized H.264 episode (the Chad Powers case)', () => {
  const out = rankTvSources([
    { hash: 'a'.repeat(40), seeds: 44, sizeBytes: 1812 * 1024 * 1024, filename: 'Chad.Powers.S01E01.1080p.WEB.h264-ETHEL.mkv', title: 'Chad Powers' },
    { hash: 'b'.repeat(40), seeds: 48, sizeBytes: 401 * 1024 * 1024, filename: 'Chad.Powers.S01E01.1080p.HEVC.x265-MeGusta.mkv', title: 'Chad Powers' },
  ]);
  assert.equal(out[0].hash, 'b'.repeat(40), 'the compact 1080p source should outrank an oversized direct-play file');
  assert.equal(out[0].transcode, true);
});

test('a healthy H.264 copy beats a MORE-seeded HEVC (the White Lotus case — avoid needless transcode)', () => {
  const out = rankTvSources([
    { hash: 'a'.repeat(40), seeds: 384, filename: 'WL.S03E01.1080p.x265.mkv', title: 'WL 👤 384' },
    { hash: 'b'.repeat(40), seeds: 227, filename: 'WL.S03E01.1080p.x264.mkv', title: 'WL 👤 227' },
    { hash: 'c'.repeat(40), seeds: 94, filename: 'WL.S03E01.1080p.mp4', title: 'WL x264 👤 94' },
  ]);
  assert.equal(out[0].transcode, false, 'a well-seeded direct copy is tried before any transcode');
  assert.equal(out[0].hash, 'b'.repeat(40), 'the 227-seed H.264 outranks the 384-seed HEVC');
  assert.equal(out[out.length - 1].hash, 'a'.repeat(40), 'the HEVC transcode source ranks last here');
});

test('a right-sized WEB-DL is preferred over a huge BluRay REMUX of the same quality (anti-buffering)', () => {
  const out = rankTvSources([
    { hash: 'a'.repeat(40), seeds: 300, filename: 'Show.S01E01.1080p.BluRay.REMUX.AVC.mkv', title: 'Show 👤 300 💾 22 GB' },
    { hash: 'b'.repeat(40), seeds: 60, filename: 'Show.S01E01.1080p.WEB-DL.x264.mkv', title: 'Show 👤 60 💾 2.4 GB' },
  ]);
  assert.equal(out[0].hash, 'b'.repeat(40), 'the 2.4GB WEB-DL beats the 22GB REMUX despite fewer seeds');
});

test('parses size and preferns the lighter of two similar WEB files', () => {
  const out = rankTvSources([
    { hash: 'a'.repeat(40), seeds: 50, filename: 'M.S01E01.1080p.WEB.x264.mkv', title: 'M 👤 50 💾 9 GB' },
    { hash: 'b'.repeat(40), seeds: 50, filename: 'M.S01E01.1080p.WEB.x264.mkv', title: 'M 👤 50 💾 3 GB' },
  ]);
  assert.equal(out[0].hash, 'b'.repeat(40), 'the 3GB copy (under the heavy cap) beats the 9GB one');
});

test('a debrid source that is HEVC (or bare) is kept and marked transcode, not dropped', () => {
  const out = rankTvSources([
    { url: 'https://x.real-debrid.com/a.mkv', debrid: true, filename: 'M.S01E01.1080p.x265.mkv', title: '[RD+] M', seeds: 0 },
    { url: 'https://x.real-debrid.com/b.mkv', debrid: true, filename: 'M.S01E01.mkv', title: '[RD+] M bare', seeds: 0 },
  ]);
  assert.equal(out.length, 2, 'both cached debrid files survive (GPU transcodes any codec)');
  assert.ok(out.every(s => s.transcode === true), 'each is marked for transcode');
});

test('AV1 episode files are offered through H.264 transcoding', () => {
  assert.ok(isTranscodableTvFile('Show.S01E01.1080p.AV1.mkv'));
  const [source] = rankTvSources([{ hash: 'f'.repeat(40), seeds: 4, filename: 'Show.S01E01.1080p.AV1.mkv', title: 'Show AV1' }]);
  assert.equal(source.transcode, true);
  assert.equal(source.quality, '1080p');
});

test('verified Windsors season-one packs expose selectable 1080p AV1 and H.264 sources', () => {
  const sources = rankTvSources(supplementalTvSources('tt5692740', 1, 1));
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((source) => source.quality), ['1080p', '1080p']);
  assert.equal(sources[0].hash, 'fe1d4208f36e9a1f1c2e771ee5e4e4734d6cf305');
  assert.equal(sources[0].transcode, true);
  assert.equal(sources[1].remux, true);
  assert.deepEqual(supplementalTvSources('tt5692740', 2, 1), []);
  assert.deepEqual(supplementalTvSources('tt0000000', 1, 1), []);
});

// ---- Which source starts FAST (measured on 160 live sources, 20 titles) ----
// The index's seed count is only as honest as the scraper behind it. Measured: every Comet|Ygg
// (private tracker) source failed to fetch metadata (0 of 7) while claiming 54+ seeds; TorBox-scraped
// rows managed about half. A fake "1080p" movie of 60 MB carried 281 seeds and ranked first.
const live = (filename, seeds, scraper, extra = {}) => ({
  hash: Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40), filename, seeds, sizeBytes: 1.2e9, provider: 'Comet',
  title: `${filename}\n👤 ${seeds} 💾 1.2 GB 🔎 ${scraper}`, ...extra,
});

test('a private-tracker scraper (Ygg) never outranks a reachable public swarm, however many seeds it claims', async () => {
  const { rankTvSources, sourceScraper } = await import('./tv-api.mjs');
  const ygg = live('Show.S01E01.1080p.WEB.x264.mkv', 182, 'Comet|Ygg API');
  const tpb = live('Show.S01E01.1080p.WEB.x264-GRP.mkv', 40, 'Comet|The Pirate Bay');
  assert.equal(sourceScraper(ygg), 'comet|ygg api');
  assert.equal(sourceScraper({ title: 'Name\nfile.mp4\n👤 142 💾 1.1 GB ⚙️ 1337x' }), '1337x');
  const out = rankTvSources([ygg, tpb]);
  assert.equal(out[0].hash, tpb.hash);
  assert.equal(out.length, 2, 'the Ygg copy stays available as a last resort');
});

test('TorBox-scraped seed counts are discounted: a modest public swarm beats a bigger TorBox number', async () => {
  const { rankTvSources } = await import('./tv-api.mjs');
  const torbox = live('Show.S01E01.1080p.WEB.x264.mkv', 50, 'TorBox|Knaben');
  const tpb = live('Show.S01E01.1080p.WEB.x264-GRP.mkv', 20, 'Comet|The Pirate Bay');
  assert.equal(rankTvSources([torbox, tpb])[0].hash, tpb.hash);
});

test('a tiny file claiming 1080p is demoted behind a plausible one (the 60 MB Dune Part Two with 281 seeds)', async () => {
  const { rankTvSources } = await import('./tv-api.mjs');
  const fake = live('Dune.Part.Two.2024.1080p.BluRay.x264.mkv', 281, 'TorBox|unknown', { sizeBytes: 60e6, title: 'Dune Part Two\n👤 281 💾 60 MB 🔎 TorBox|unknown' });
  const real = live('Dune.Part.Two.2024.1080p.WEB.x264-GRP.mkv', 30, 'Comet|The Pirate Bay', { sizeBytes: 1.5e9, title: 'Dune Part Two\n👤 30 💾 1.5 GB 🔎 Comet|The Pirate Bay' });
  assert.equal(rankTvSources([fake, real])[0].hash, real.hash);
  // A small but plausible TV episode is not touched.
  const small = live('Show.S01E01.1080p.x264.mkv', 40, 'Comet|The Pirate Bay', { sizeBytes: 140e6, title: 'Show\n👤 40 💾 140 MB 🔎 Comet|The Pirate Bay' });
  const big = live('Show.S01E01.1080p.WEB.x264-GRP.mkv', 40, 'Comet|The Pirate Bay', { sizeBytes: 900e6, title: 'Show\n👤 40 💾 900 MB 🔎 Comet|The Pirate Bay' });
  assert.equal(rankTvSources([big, small])[0].hash, small.hash, 'the lighter plausible episode still leads');
});

test('trust only reorders within the existing rules: 1080p still comes first', async () => {
  const { rankTvSources } = await import('./tv-api.mjs');
  const y1080 = live('Show.S01E01.1080p.WEB.x264.mkv', 182, 'Comet|Ygg API');
  const p720 = live('Show.S01E01.720p.WEB.x264-GRP.mkv', 60, 'Comet|The Pirate Bay');
  assert.equal(rankTvSources([p720, y1080])[0].quality, '1080p');
});
