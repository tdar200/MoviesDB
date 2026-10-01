import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAudioIndex, probeAudioIndex } from './audio-track.mjs';

const a = (language, extra = {}) => ({ tags: language ? { language, ...(extra.title ? { title: extra.title } : {}) } : (extra.title ? { title: extra.title } : {}), disposition: { default: extra.default ? 1 : 0 } });

test('pickAudioIndex: the English track, wherever it sits (real releases: Italian, Spanish and Polish came FIRST)', () => {
  assert.equal(pickAudioIndex([a('ita', { default: true, title: 'Italian' }), a('eng', { title: 'English' })]), 1, 'ITA-ENG MULTI (V3SP4EV3R)');
  assert.equal(pickAudioIndex([a('spa', { default: true }), a('eng')]), 1, 'Dual YG: Spanish first');
  assert.equal(pickAudioIndex([a('pol'), a('eng')]), 1, 'ENG-Lektor PL: Polish first');
  assert.equal(pickAudioIndex([a('jpn'), a('eng')]), 1, 'anime Dual Audio');
  assert.equal(pickAudioIndex([a('fra'), a('ita'), a('en')]), 2, 'two-letter English code');
  assert.equal(pickAudioIndex([a('eng')]), 0);
});

test('pickAudioIndex: no English at all keeps what the release marks as default, else the first track', () => {
  assert.equal(pickAudioIndex([a('fra'), a('ita', { default: true })]), 1);
  assert.equal(pickAudioIndex([a('fra'), a('ita')]), 0);
  assert.equal(pickAudioIndex([a('und'), a('und')]), 0, 'untagged tracks: nothing to go on');
});

test('pickAudioIndex: an English track named English counts even when its language tag is missing', () => {
  assert.equal(pickAudioIndex([a('ita'), a('', { title: 'English 5.1' })]), 1);
  assert.equal(pickAudioIndex([a('und'), a('und', { title: 'English' })]), 1);
});

test('pickAudioIndex: skips an English commentary or audio-description track when the main English one exists', () => {
  assert.equal(pickAudioIndex([a('eng', { title: 'Director Commentary' }), a('ita'), a('eng', { title: 'English 5.1' })]), 2);
  assert.equal(pickAudioIndex([a('eng', { title: 'Audio Description' }), a('eng')]), 1);
  assert.equal(pickAudioIndex([a('ita'), a('eng', { title: 'Commentary' })]), 1, 'only a commentary in English: still better than Italian');
});

test('pickAudioIndex: nothing to choose from', () => {
  assert.equal(pickAudioIndex([]), 0);
  assert.equal(pickAudioIndex(undefined), 0);
  assert.equal(pickAudioIndex(null), 0);
});

test('probeAudioIndex: never throws; a failed or empty probe means the first track (the old behaviour)', async () => {
  assert.deepEqual(await probeAudioIndex('http://127.0.0.1:1/nothing.mkv', { timeoutMs: 3000 }), { index: 0, streams: [] });
  assert.deepEqual(await probeAudioIndex('pipe:0'), { index: 0, streams: [] }, 'a pipe cannot be probed ahead of time');
  assert.deepEqual(await probeAudioIndex(''), { index: 0, streams: [] });
});
