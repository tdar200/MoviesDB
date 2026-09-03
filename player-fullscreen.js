// player-fullscreen.js — app-level fullscreen for the player, independent of the
// provider's own fullscreen button.
//
// Why this exists (found 3 Sep 2026, real Chrome): 111Movies (player.vidlove.cc)
// lays a transparent about:blank ad frame over its player. The first click on any
// control — the fullscreen button included — lands on that frame, which opens a
// popunder and swallows the click, so the player's fullscreen handler never runs
// and nothing happens. With the overlay neutralised (popup-guard/) the very same
// click resolves requestFullscreen(), which proves the permission chain is fine
// and only the click is being stolen. Nothing our page does inside a cross-origin
// frame can change that. But a click on OUR page carries user activation the
// frame cannot intercept, and the <iframe> element itself can be sent fullscreen
// from here — the provider's player fills the screen inside it, controls and all.
//
// Pure functions so they are unit-testable (player-fullscreen.test.js);
// script.js only wires them to the DOM.

// Which element should go fullscreen for the current player state: the trailer
// frame on the Trailer tab, the native <video> when a torrent source is playing,
// otherwise the provider iframe.
export function pickFullscreenTarget({ activeTab, videoVisible, playerIframe, playerVideo, trailerIframe }) {
  if (activeTab === 'trailer') return trailerIframe;
  return videoVisible ? playerVideo : playerIframe;
}

// Toggle: leave fullscreen if anything is fullscreen, otherwise enter it on
// `target`. Always returns a promise so the caller can report a rejection.
export function toggleFullscreen(doc, target) {
  if (doc.fullscreenElement) return doc.exitFullscreen();
  if (!target || typeof target.requestFullscreen !== 'function') {
    return Promise.reject(new Error('Fullscreen is not available for this player'));
  }
  return target.requestFullscreen();
}

// The `f` shortcut must never fire while the user is typing in a field.
export function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName || '');
}

// Plain `f`/`F` only — never a browser chord like Ctrl+F (find).
export function isFullscreenKey(e) {
  return (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey;
}
