// subtitles.test.js — the pure parts of the YTS subtitle path.
//
// YTS torrents ship .srt sidecars (verified Aug 18, 2026: Predator: Badlands
// carries a sidecar plus Subs/English.srt and Subs/Forced.eng.srt). Chrome's
// <track> element accepts WebVTT ONLY, so SRT has to be converted before it ever
// reaches the browser, and these files are frequently not UTF-8.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { srtToVtt, decodeSubtitle, subtitleLabel, isSubtitleFile, dedupeTrackLabels } from './subtitles.js';

// ---- srtToVtt ----

const SIMPLE_SRT = '1\n00:00:01,000 --> 00:00:03,500\nFirst line\n\n2\n00:01:02,250 --> 00:01:04,000\nSecond line\n';

test('output starts with the WEBVTT signature', () => {
  // Without this exact first line Chrome rejects the whole file silently.
  assert.match(srtToVtt(SIMPLE_SRT), /^WEBVTT\r?\n/);
});

test('comma decimal separators become periods', () => {
  const out = srtToVtt(SIMPLE_SRT);
  assert.match(out, /00:00:01\.000 --> 00:00:03\.500/);
  assert.doesNotMatch(out, /,\d{3} -->/, 'no SRT-style commas may survive');
});

test('every cue survives the conversion', () => {
  const out = srtToVtt(SIMPLE_SRT);
  assert.match(out, /First line/);
  assert.match(out, /Second line/);
  assert.equal((out.match(/-->/g) || []).length, 2);
});

test('CRLF input converts correctly', () => {
  const out = srtToVtt(SIMPLE_SRT.replace(/\n/g, '\r\n'));
  assert.match(out, /^WEBVTT/);
  assert.match(out, /00:00:01\.000 --> 00:00:03\.500/);
  assert.match(out, /First line/);
});

test('a leading BOM does not break the signature', () => {
  // A BOM before WEBVTT is the classic "subtitles silently do nothing" bug.
  const out = srtToVtt('﻿' + SIMPLE_SRT);
  assert.match(out, /^WEBVTT/);
  assert.ok(!out.includes('﻿'), 'BOM must be stripped, not merely moved');
});

test('two-digit hour timestamps are preserved', () => {
  const out = srtToVtt('1\n01:23:45,678 --> 01:23:47,000\nlate cue\n');
  assert.match(out, /01:23:45\.678 --> 01:23:47\.000/);
});

test('short mm:ss timestamps are padded to a full hour field', () => {
  // WebVTT allows mm:ss.mmm, but hh:mm:ss.mmm is universally safe.
  const out = srtToVtt('1\n00:01,000 --> 00:03,000\nshort form\n');
  assert.match(out, /00:00:01\.000 --> 00:00:03\.000/);
  assert.match(out, /short form/);
});

test('multi-line cue text stays on separate lines', () => {
  const out = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nline one\nline two\n');
  assert.match(out, /line one\r?\nline two/);
});

test('cue position/alignment payloads on the timing line are kept', () => {
  const out = srtToVtt('1\n00:00:01,000 --> 00:00:02,000 X1:100 X2:200\npositioned\n');
  assert.match(out, /00:00:01\.000 --> 00:00:02\.000/);
  assert.match(out, /positioned/);
});

test('garbage in yields a valid, empty-but-parseable VTT rather than a throw', () => {
  const out = srtToVtt('this is not a subtitle file at all');
  assert.match(out, /^WEBVTT/);
});

test('empty input still yields a valid VTT', () => {
  assert.match(srtToVtt(''), /^WEBVTT/);
});

// ---- decodeSubtitle ----

test('decodes UTF-8 text', () => {
  const buf = Buffer.from('Café — naïve', 'utf8');
  assert.equal(decodeSubtitle(buf), 'Café — naïve');
});

test('falls back to latin1 for non-UTF-8 bytes instead of producing replacement chars', () => {
  // 0xE9 alone is invalid UTF-8; as latin1 it is 'é'. YTS .srt files are often
  // windows-1252, and mis-decoding shows mojibake rather than failing loudly.
  const buf = Buffer.from([0x43, 0x61, 0x66, 0xE9]); // "Caf\xE9"
  const out = decodeSubtitle(buf);
  assert.equal(out, 'Café');
  assert.ok(!out.includes('�'), 'must not contain U+FFFD replacement characters');
});

test('strips a UTF-8 BOM while decoding', () => {
  const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('hello', 'utf8')]);
  assert.equal(decodeSubtitle(buf), 'hello');
});

// ---- isSubtitleFile ----

test('recognises subtitle extensions and rejects the video', () => {
  assert.ok(isSubtitleFile('Subs/English.srt'));
  assert.ok(isSubtitleFile('movie.VTT'));
  assert.ok(!isSubtitleFile('Predator.Badlands.2025.1080p.mp4'));
  assert.ok(!isSubtitleFile('YTS.BZ - Official site.jpg'));
});

test('image-based subtitle formats are excluded — a browser cannot render them', () => {
  // .sub/.idx are VobSub bitmaps; offering them would show an empty track.
  assert.ok(!isSubtitleFile('movie.sub'));
  assert.ok(!isSubtitleFile('movie.idx'));
});

// ---- subtitleLabel ----

test('names a language-named file by its language', () => {
  assert.equal(subtitleLabel('Subs/English.srt').label, 'English');
});

test('flags a forced track and says so in the label', () => {
  const got = subtitleLabel('Subs/Forced.eng.srt');
  assert.equal(got.forced, true);
  assert.match(got.label, /forced/i);
  assert.match(got.label, /English/);
});

test('a sidecar named after the release is labelled English, not the whole filename', () => {
  const got = subtitleLabel('Predator Badlands (2025) [1080p]/Predator.Badlands.2025.1080p.BluRay.x264.AAC5.1-[YTS.BZ].srt');
  assert.equal(got.label, 'English');
  assert.equal(got.forced, false);
});

test('recognises a non-English language name', () => {
  assert.equal(subtitleLabel('Subs/Spanish.srt').label, 'Spanish');
});

test('reports a best-guess language code for the track element', () => {
  assert.equal(subtitleLabel('Subs/English.srt').lang, 'en');
  assert.equal(subtitleLabel('Subs/Spanish.srt').lang, 'es');
});

// ---- dedupeTrackLabels ----
//
// A real torrent (Predator: Badlands) yields TWO tracks both labelled "English":
// the release-named sidecar and Subs/English.srt. Identical labels are not just
// confusing in the picker - selecting by label turned BOTH tracks on at once and
// the browser rendered two overlapping caption streams.

test('colliding labels are made distinguishable by size', () => {
  const out = dedupeTrackLabels([
    { index: 1, label: 'English', bytes: 11284 },
    { index: 4, label: 'English', bytes: 31705 },
    { index: 5, label: 'English (forced)', bytes: 11284 },
  ]);
  const labels = out.map((t) => t.label);
  assert.equal(new Set(labels).size, labels.length, `labels must be unique, got ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => /31/.test(l)), 'the larger track should advertise its size');
});

test('a label that does not collide is left exactly as it was', () => {
  const out = dedupeTrackLabels([
    { index: 4, label: 'English', bytes: 31705 },
    { index: 5, label: 'English (forced)', bytes: 11284 },
  ]);
  assert.deepEqual(out.map((t) => t.label), ['English', 'English (forced)']);
});

test('index is preserved - it is the track identity, not the label', () => {
  const out = dedupeTrackLabels([
    { index: 1, label: 'English', bytes: 100 },
    { index: 4, label: 'English', bytes: 200 },
  ]);
  assert.deepEqual(out.map((t) => t.index), [1, 4]);
});

test('an empty list is handled', () => {
  assert.deepEqual(dedupeTrackLabels([]), []);
});
