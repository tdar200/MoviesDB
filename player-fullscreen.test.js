// player-fullscreen.test.js — the app-level fullscreen control (see the module
// header for why the provider's own button cannot be relied on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFullscreenTarget, toggleFullscreen, isTypingTarget, isFullscreenKey } from './player-fullscreen.js';

const els = { playerIframe: { id: 'iframe' }, playerVideo: { id: 'video' }, trailerIframe: { id: 'trailer' } };

test('embed source on the Watch tab targets the provider iframe', () => {
  assert.equal(pickFullscreenTarget({ activeTab: 'watch', videoVisible: false, ...els }), els.playerIframe);
});

test('torrent source (native <video> visible) targets the video element', () => {
  assert.equal(pickFullscreenTarget({ activeTab: 'watch', videoVisible: true, ...els }), els.playerVideo);
});

test('Trailer tab targets the trailer iframe regardless of the video state', () => {
  assert.equal(pickFullscreenTarget({ activeTab: 'trailer', videoVisible: true, ...els }), els.trailerIframe);
});

test('toggle enters fullscreen on the target when nothing is fullscreen', async () => {
  let requested = 0;
  const target = { requestFullscreen: async () => { requested++; } };
  await toggleFullscreen({ fullscreenElement: null }, target);
  assert.equal(requested, 1);
});

test('toggle exits when something is already fullscreen, and does not request again', async () => {
  let requested = 0, exited = 0;
  const doc = { fullscreenElement: {}, exitFullscreen: async () => { exited++; } };
  await toggleFullscreen(doc, { requestFullscreen: async () => { requested++; } });
  assert.deepEqual({ requested, exited }, { requested: 0, exited: 1 });
});

test('toggle rejects (never throws synchronously) when the target cannot go fullscreen', async () => {
  await assert.rejects(toggleFullscreen({ fullscreenElement: null }, null), /not available/);
  await assert.rejects(toggleFullscreen({ fullscreenElement: null }, {}), /not available/);
});

test('a rejected requestFullscreen propagates so the caller can report it', async () => {
  const target = { requestFullscreen: () => Promise.reject(new TypeError('Permissions check failed')) };
  await assert.rejects(toggleFullscreen({ fullscreenElement: null }, target), /Permissions check failed/);
});

test('typing targets: inputs, textareas, selects and contenteditable', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) assert.ok(isTypingTarget({ tagName }), tagName);
  assert.ok(isTypingTarget({ tagName: 'DIV', isContentEditable: true }));
  for (const el of [null, { tagName: 'BODY' }, { tagName: 'BUTTON' }, { tagName: 'DIV' }]) assert.ok(!isTypingTarget(el));
});

test('fullscreen key is a bare f/F, never a chord', () => {
  assert.ok(isFullscreenKey({ key: 'f' }));
  assert.ok(isFullscreenKey({ key: 'F' }));
  assert.ok(!isFullscreenKey({ key: 'f', ctrlKey: true }), 'Ctrl+F is find');
  assert.ok(!isFullscreenKey({ key: 'f', metaKey: true }));
  assert.ok(!isFullscreenKey({ key: 'f', altKey: true }));
  assert.ok(!isFullscreenKey({ key: 'g' }));
});
