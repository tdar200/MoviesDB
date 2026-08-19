// tv-api.test.js — the TV torrent source (torrentio -> browser-playable episode).
//
// Verified Aug 19, 2026 by probing torrentio: ~50 sources per episode, but only
// 24 of 200 sampled were .mp4 (the rest .mkv, which Chrome cannot play at all),
// and x265 outnumbered x264 among sources that state a codec. Every sampled
// episode still had 2-9 playable .mp4 sources, which is why an MP4-only path is
// viable at all. All tests here inject a fake fetch, so they run offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesEpisode, isPlayableTvFile, rankTvSources, pickEpisodeFile, fetchTvSources, clearTvCache,
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

test('only browser-playable containers pass', () => {
  assert.ok(isPlayableTvFile('Show.S01E01.mp4'));
  assert.ok(isPlayableTvFile('Show.S01E01.M4V'));
  assert.ok(!isPlayableTvFile('Show.S01E01.mkv'), 'Chrome cannot play Matroska');
  assert.ok(!isPlayableTvFile('Show.S01E01.avi'));
  assert.ok(!isPlayableTvFile('Show.S01E01.srt'));
});

test('an x265 mp4 is rejected — the container plays but the codec does not', () => {
  assert.ok(!isPlayableTvFile('Show.S01E01.2160p.x265.mp4'));
  assert.ok(!isPlayableTvFile('Show.S01E01.HEVC.mp4'));
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

test('asks torrentio for the right imdb/season/episode and returns ranked sources', async () => {
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

test('parses the seed count torrentio puts in the title', async () => {
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

test('throws a diagnosable error when torrentio cannot be reached', async () => {
  clearTvCache();
  const fake = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(
    () => fetchTvSources('tt3', 1, 1, { fetchImpl: fake, retryDelayMs: 1 }),
    (err) => { assert.match(err.message, /torrentio/i); return true; }
  );
});

test('retries once before giving up', async () => {
  clearTvCache();
  let calls = 0;
  const fake = async () => {
    if (++calls === 1) throw new Error('transient');
    return res(streams([{ infoHash: 'f'.repeat(40), behaviorHints: { filename: 'S.S01E01.720p.mp4' }, title: 'x\n👤 9' }]));
  };
  const out = await fetchTvSources('tt4', 1, 1, { fetchImpl: fake, retryDelayMs: 1 });
  assert.equal(calls, 2);
  assert.equal(out.length, 1);
});

test('a second lookup for the same episode is served from cache', async () => {
  clearTvCache();
  let calls = 0;
  const fake = async () => {
    calls++;
    return res(streams([{ infoHash: '1'.repeat(40), behaviorHints: { filename: 'S.S01E01.1080p.mp4' }, title: 'x\n👤 9' }]));
  };
  await fetchTvSources('tt5', 1, 1, { fetchImpl: fake });
  await fetchTvSources('tt5', 1, 1, { fetchImpl: fake });
  assert.equal(calls, 1);
});

test('different episodes are cached separately', async () => {
  clearTvCache();
  let calls = 0;
  const fake = async () => {
    calls++;
    return res(streams([{ infoHash: '2'.repeat(40), behaviorHints: { filename: 'S.S01E01.1080p.mp4' }, title: 'x\n👤 9' }]));
  };
  await fetchTvSources('tt6', 1, 1, { fetchImpl: fake });
  await fetchTvSources('tt6', 1, 2, { fetchImpl: fake });
  assert.equal(calls, 2);
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

test('a title mentioning x264 does not rescue an unplayable .mkv file', () => {
  const out = rankTvSources([{
    hash: 'e'.repeat(40), seeds: 500,
    filename: 'Show.S01E01.1080p.mkv', title: 'Show S01 1080p x264',
  }]);
  assert.equal(out.length, 0, 'container is decided by the actual file');
});
