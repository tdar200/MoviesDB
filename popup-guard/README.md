# MoviesDB Popup Guard

A tiny Chrome extension that stops the popups / popunders the streaming embed
providers open from inside the MoviesDB player. It only acts on frames embedded
by the MoviesDB page (local / LAN origins by default, see `guard-origins.js`),
so it does nothing anywhere else you browse.

## Why an extension and not the iframe `sandbox` attribute?

`sandbox` without `allow-popups` would block these popups in one line. But every
major provider (Videasy, VidLink, VidFast, 111Movies, VixSrc) detects a sandboxed
frame and replaces the player with **"Please Disable Sandbox"** — verified in real
Chrome on 2 Sep 2026 and in their shipped source: they run
`document.domain = document.domain`, which throws a SecurityError naming the
sandbox in any sandboxed frame, whatever tokens you allow. There is no
Permissions-Policy feature for popups, so the browser side has to be an extension.

## Install (once)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → pick this `popup-guard/` folder.

That's it. Reload the MoviesDB tab. Provider players work exactly as before, minus
the new tabs.

If you serve the app from a public host too, add its origin to the list in
`guard-origins.js` and click the extension's reload icon on `chrome://extensions`.

## What it does

- `defuse.js` (every frame under a MoviesDB origin, at `document_start`):
  `window.open` becomes a locked no-op returning `null`, and clicks/submits on
  `target="_blank"` / `_new` elements are cancelled — including synthetic
  `anchor.click()` calls ad scripts use.
- `background.js`: if anything still spawns a tab from a *sub-frame* of a
  MoviesDB tab, it is closed immediately. Tabs the app's own page opens (YouTube
  links, the "opened in new tab" fallback) are untouched, and the YouTube trailer
  frame is exempt so "Watch on YouTube" keeps working.

## Verify

```
npm run check-popups
```

runs a real (Xvfb-wrapped) Chrome with the extension loaded: a local
cross-origin frame that tries `window.open`, `target=_blank` and a `_blank` form
submit must produce no surviving tab, and the top providers must still stream
video with zero surviving popups.
