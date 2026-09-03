// background.js — tab-level backstop.
//
// defuse.js (below, in every provider frame) stops the common popup paths before
// a window is ever created. Anything that slips past it — a form.submit() into a
// _blank target, a scheme the content script can't run on — still surfaces here
// as a "navigation target created by <frame> of <tab>" event, and the new tab is
// closed immediately.
//
// Only popups whose SOURCE is a sub-frame of a MoviesDB tab are touched. The app's
// own page (frame 0) opens tabs deliberately (YouTube links, providers that refuse
// to embed), and those are left alone.
importScripts('guard-origins.js');

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (d) => {
  if (d.sourceFrameId === 0) return; // opened by the app itself, not by a provider
  let sourceTab;
  try { sourceTab = await chrome.tabs.get(d.sourceTabId); } catch { return; }
  let top;
  try { top = new URL(sourceTab.url || sourceTab.pendingUrl || '').origin; } catch { return; }
  if (!moviesdbGuardIsAppOrigin__(top)) return;

  // Leave exempt embeds (YouTube trailer) alone.
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId: d.sourceTabId, frameId: d.sourceFrameId });
    if (frame && MOVIESDB_GUARD_EXEMPT_HOSTS__.test(new URL(frame.url).hostname)) return;
  } catch { /* frame already gone — still a provider popup, close it */ }

  chrome.tabs.remove(d.tabId).catch(() => {});
});
