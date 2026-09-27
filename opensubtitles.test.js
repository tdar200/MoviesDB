// opensubtitles.test.js — the external-subtitle fallback, fully offline (mock fetch).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imdbToNumber, searchSubtitle, fetchSubtitleText, searchStremioSubtitle, fetchStremioSubtitleText, searchYtsSubtitle, fetchYtsSubtitleText } from './opensubtitles.mjs';

test('imdbToNumber strips tt and leading zeros', () => {
  assert.equal(imdbToNumber('tt0816692'), 816692);
  assert.equal(imdbToNumber('816692'), 816692);
  assert.equal(imdbToNumber('tt12345'), 12345);
  assert.equal(imdbToNumber(''), null);
  assert.equal(imdbToNumber('nope'), null);
});

function mockFetch(routes) {
  return async (url, opts = {}) => {
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, opts);
    }
    throw new Error('unexpected url ' + url);
  };
}
const jsonRes = (obj, ok = true, status = 200) => ({ ok, status, json: async () => obj });
const textRes = (txt, ok = true, status = 200) => ({ ok, status, text: async () => txt });

test('searchSubtitle picks the highest download_count file and sends imdb_id for a movie', async () => {
  let seenUrl = '';
  const fetchImpl = mockFetch([
    ['/subtitles?', (url) => { seenUrl = url; return jsonRes({ data: [
      { attributes: { language: 'en', download_count: 10, release: 'LOW', files: [{ file_id: 111 }] } },
      { attributes: { language: 'en', download_count: 999, release: 'BEST', files: [{ file_id: 222 }] } },
    ] }); }],
  ]);
  const res = await searchSubtitle({ apiKey: 'k', imdbId: 'tt0816692' }, fetchImpl);
  assert.deepEqual(res, { fileId: '222', release: 'BEST', lang: 'en' });
  assert.match(seenUrl, /imdb_id=816692/);
  assert.match(seenUrl, /type=movie/);
});

test('searchSubtitle uses parent_imdb_id + season/episode for a show', async () => {
  let seenUrl = '';
  const fetchImpl = mockFetch([
    ['/subtitles?', (url) => { seenUrl = url; return jsonRes({ data: [
      { attributes: { language: 'en', download_count: 5, release: 'S1E2', files: [{ file_id: 333 }] } },
    ] }); }],
  ]);
  const res = await searchSubtitle({ apiKey: 'k', imdbId: 'tt111', season: 1, episode: 2 }, fetchImpl);
  assert.equal(res.fileId, '333');
  assert.match(seenUrl, /parent_imdb_id=111/);
  assert.match(seenUrl, /season_number=1/);
  assert.match(seenUrl, /episode_number=2/);
  assert.match(seenUrl, /type=episode/);
});

test('searchSubtitle returns null when there are no usable files', async () => {
  const fetchImpl = mockFetch([['/subtitles?', () => jsonRes({ data: [] })]]);
  assert.equal(await searchSubtitle({ apiKey: 'k', imdbId: 'tt1' }, fetchImpl), null);
});

test('searchSubtitle returns null without an api key or a valid imdb id', async () => {
  const boom = () => { throw new Error('should not be called'); };
  assert.equal(await searchSubtitle({ apiKey: '', imdbId: 'tt1' }, boom), null);
  assert.equal(await searchSubtitle({ apiKey: 'k', imdbId: 'bad' }, boom), null);
});

test('searchSubtitle throws on an HTTP error', async () => {
  const fetchImpl = mockFetch([['/subtitles?', () => jsonRes({}, false, 401)]]);
  await assert.rejects(() => searchSubtitle({ apiKey: 'k', imdbId: 'tt1' }, fetchImpl), /HTTP 401/);
});

test('fetchSubtitleText downloads the link and returns the SRT text', async () => {
  let postBody = null;
  const fetchImpl = mockFetch([
    ['/download', (url, opts) => { postBody = JSON.parse(opts.body); return jsonRes({ link: 'https://dl.opensubtitles/xyz.srt', remaining: 99 }); }],
    ['dl.opensubtitles', () => textRes('1\n00:00:01,000 --> 00:00:02,000\nHello\n')],
  ]);
  const txt = await fetchSubtitleText({ apiKey: 'k', fileId: '222' }, fetchImpl);
  assert.match(txt, /Hello/);
  assert.deepEqual(postBody, { file_id: 222 });
});

test('fetchSubtitleText throws a clear error when the quota link is missing', async () => {
  const fetchImpl = mockFetch([['/download', () => jsonRes({ message: 'quota' })]]);
  await assert.rejects(() => fetchSubtitleText({ apiKey: 'k', fileId: '1' }, fetchImpl), /no download link/);
});

test('no-key Stremio search prefers an English YTS release match', async () => {
  const fetchImpl = async () => jsonRes({ subtitles: [
    { lang: 'eng', url: 'https://subs5.strem.io/en/download/file/11', subtitleFileName: 'Dune.2021.WEB-DL-EVO.srt' },
    { lang: 'eng', url: 'https://subs5.strem.io/en/download/file/22', subtitleFileName: 'Dune.2021.720p.WEBRip-[YTS.MX].srt', releaseGroup: 'YTS.MX' },
  ] });
  const found = await searchStremioSubtitle({ imdbId: 'tt1160419', releaseName: 'Dune.2021.1080p.BluRay-[YTS.MX].mp4' }, fetchImpl);
  assert.equal(found.fileId, '22');
  assert.match(found.release, /YTS/);
});

test('no-key Stremio search uses the series episode route', async () => {
  let requested = '';
  const fetchImpl = async (url) => { requested = url; return jsonRes({ subtitles: [] }); };
  assert.equal(await searchStremioSubtitle({ imdbId: 'tt0944947', season: 1, episode: 2 }, fetchImpl), null);
  assert.match(requested, /\/subtitles\/series\/tt0944947:1:2\.json$/);
});

test('no-key Stremio subtitle download validates its host and returns text', async () => {
  const fetchImpl = async () => textRes('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  assert.match(await fetchStremioSubtitleText({ url: 'https://subs5.strem.io/en/download/file/22' }, fetchImpl), /Hello/);
  await assert.rejects(() => fetchStremioSubtitleText({ url: 'https://evil.example/file/22' }, fetchImpl), /invalid download URL/);
});

test('YTS subtitle search prefers the exact BluRay release and decodes its download URL', async () => {
  const archive = 'https://subtitles.yts-subs.com/subtitles/dune-2021-english-yify-374256.zip';
  const listing = `<tr><span class="sub-lang">English</span><a href="/subtitles/dune-2021-english-yify-398873">Dune.2021.720p.WEBRip.x264.AAC-[YTS.MX]</a></tr>
    <tr><span class="sub-lang">English</span><a href="/subtitles/dune-2021-english-yify-374256">Dune.2021.720p/1080p.BluRay.x264.AAC-[YTS.MX]</a></tr>`;
  const fetchImpl = mockFetch([
    ['/movie-imdb/', () => textRes(listing)],
    ['374256', () => textRes(`<a data-link="${Buffer.from(archive).toString('base64')}">download</a>`)],
  ]);
  const found = await searchYtsSubtitle({ imdbId: 'tt1160419', releaseName: 'Dune.2021.720p.BluRay.x264.AAC-[YTS.MX].mp4' }, fetchImpl);
  assert.equal(found.fileId, '374256');
  assert.equal(found.url, archive);
});

test('YTS subtitle download rejects an untrusted archive host', async () => {
  await assert.rejects(() => fetchYtsSubtitleText({ url: 'https://evil.example/dune.zip' }), /invalid download URL/);
});
