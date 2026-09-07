# 111Movies popup guard — 7 September 2026

Reproduced on the LG TV: a blank iframe inside `player.vidlove.cc`, fixed across the full 1920 × 855 player viewport, opacity 0.85 and z-index 2147483646. It was the first element hit at the video centre. The previous `window.open` replacement neither removed this overlay nor protected fresh nested frame realms and target-based navigation.

The helper now injects a separate popup guard before the compatibility bridge. It applies only to 111Movies and its descendants beneath the configured Movies app origin. It locks window.open, blocks links/forms targeting another browsing context, protects blank child frames, and removes the reproduced full-screen blank iframe pattern when inserted or restyled. Ordinary controls, nonmatching frames and unrelated top-level pages remain available.

A fresh actual-TV run recorded ten 111Movies samples with the guard installed, window.open locked, and zero covering ad iframes. See [measurements](2026-09-07-popup-guard.json). This establishes removal of the reproduced DOM overlay, not a physical screenshot of the television.

The stream in that run remained at readyState 0 on Archer Queen and ultimately switched to the built-in player. **111Movies media delivery did not pass.** The popup fix does not establish that the provider is playable.

Regression results: 422 unit tests passed, 19 skipped; all 13 TV browser tests passed. The popup regression covers reinsertion, centre hit-testing, locked window.open, nested blank frames, new-window links and forms, working normal buttons and origin scoping.
