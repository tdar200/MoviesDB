// defuse.js — runs at document_start, in the page's MAIN world, in EVERY frame.
//
// It bails out immediately unless this frame is embedded (at any depth) under a
// MoviesDB origin, so it is inert on every other site. Inside a provider frame it
// removes the two ways an ad script opens a popup/popunder:
//   1. window.open()           -> replaced by a locked no-op that returns null
//   2. target="_blank"/"_new"  -> the click/submit is cancelled in the capture
//                                phase (covers synthetic anchor.click() too)
//
// This is done here rather than with the iframe `sandbox` attribute because every
// major provider (Videasy, VidLink, VidFast, 111Movies, VixSrc) detects a sandboxed
// frame — `document.domain = document.domain` throws a SecurityError naming the
// sandbox — and replaces the player with "Please Disable Sandbox". Nothing in this
// file is observable through that check.
(() => {
  if (window === window.top) return; // never touch the app page itself

  let guarded = false;
  try {
    const anc = location.ancestorOrigins;
    for (let i = 0; i < anc.length; i++) if (moviesdbGuardIsAppOrigin__(anc[i])) guarded = true;
  } catch { /* no ancestorOrigins -> not guarded */ }
  if (!guarded) return;
  if (MOVIESDB_GUARD_EXEMPT_HOSTS__.test(location.hostname)) return;

  const blockedOpen = function open() { return null; };
  try {
    Object.defineProperty(window, 'open', { value: blockedOpen, writable: false, configurable: false });
  } catch { try { window.open = blockedOpen; } catch { /* give up on this path; background.js still closes the tab */ } }

  const cancelNewTab = (e) => {
    const t = e.target;
    const el = t && typeof t.closest === 'function' ? t.closest('a[target],area[target],form[target]') : null;
    if (el && /^_(blank|new)$/i.test(el.getAttribute('target') || '')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener('click', cancelNewTab, true);
  window.addEventListener('auxclick', cancelNewTab, true);
  window.addEventListener('submit', cancelNewTab, true);
})();
