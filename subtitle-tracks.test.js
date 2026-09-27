import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTextSubCodec, parseEmbeddedSubStreams, embeddedTrackLabel,
  fileTrackId, embeddedTrackId, externalTrackId, stremioTrackId, ytsSubtitleTrackId, parseTrackId,
} from './subtitle-tracks.js';

test('text subtitle codecs are recognised; image-based ones are not', () => {
  for (const c of ['subrip', 'ass', 'webvtt', 'mov_text', 'SubRip']) assert.equal(isTextSubCodec(c), true, c);
  for (const c of ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', '']) assert.equal(isTextSubCodec(c), false, c);
});

test('parseEmbeddedSubStreams keeps only text subtitle streams with their ffmpeg index', () => {
  const streams = [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
    { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'SDH' }, disposition: { forced: 0 } },
    { index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
  ];
  const out = parseEmbeddedSubStreams(streams);
  assert.equal(out.length, 2, 'the PGS image track must be dropped');
  assert.deepEqual(out.map((s) => s.streamIndex), [2, 3]);
  assert.equal(out[1].title, 'SDH');
});

test('parseEmbeddedSubStreams tolerates junk', () => {
  assert.deepEqual(parseEmbeddedSubStreams(null), []);
  assert.deepEqual(parseEmbeddedSubStreams(undefined), []);
});

test('labels give the full language name plus a disambiguator', () => {
  assert.equal(embeddedTrackLabel({ lang: 'eng' }), 'English');
  assert.equal(embeddedTrackLabel({ lang: 'eng', title: 'SDH' }), 'English (SDH)');
  assert.equal(embeddedTrackLabel({ lang: 'eng', forced: true }), 'English (Forced)');
  assert.equal(embeddedTrackLabel({ lang: 'xyz' }), 'XYZ');
  assert.equal(embeddedTrackLabel({}), 'Subtitle');
});

test('track ids round-trip', () => {
  assert.equal(fileTrackId(3), 'f3');
  assert.equal(embeddedTrackId(0, 2), 'e0:2');
  assert.deepEqual(parseTrackId('f3'), { kind: 'file', fileIndex: 3 });
  assert.deepEqual(parseTrackId('e0:2'), { kind: 'embedded', fileIndex: 0, streamIndex: 2 });
  assert.equal(externalTrackId('4461104'), 'x4461104');
  assert.deepEqual(parseTrackId('x4461104'), { kind: 'external', fileId: '4461104' });
  assert.equal(stremioTrackId('1957415482'), 's1957415482');
  assert.deepEqual(parseTrackId('s1957415482'), { kind: 'stremio', fileId: '1957415482' });
  assert.equal(ytsSubtitleTrackId('374256'), 'y374256');
  assert.deepEqual(parseTrackId('y374256'), { kind: 'yts-subtitle', fileId: '374256' });
  assert.equal(parseTrackId('garbage'), null);
  assert.equal(parseTrackId(''), null);
});
