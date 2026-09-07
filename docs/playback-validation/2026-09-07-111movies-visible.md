# 111Movies: visible playback investigation — 7 September 2026

The earlier “fixed” report was incomplete. It checked an advancing media clock but missed a video rendered at **0 × 0 pixels**. This investigation started from the user's failing Project Hail Mary session on the actual LG TV.

## Reproduced failures and changes

- **Invisible picture:** the provider's fixed root used `.inset-0`. The TV ignored the CSS `inset` shorthand, leaving both root and video at zero width/height. The iframe itself was correctly sized, so checking only the app frame missed the failure. A feature-detected fallback now supplies `top`, `right`, `bottom`, and `left`. The measured video changed to **1920 × 855**, and **1920 × 1080** in fullscreen. [MDN describes the shorthand and its constituent properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/inset).
- **Frozen resume:** reopening Project Hail Mary reproduced a stationary clock and decoded-frame count despite `readyState=4` and `paused=false`. Pause/resume recovered playback. The compatibility bridge now attempts at most two transport restarts for a sustained ready-but-frozen state. It leaves intentional pauses, buffering, seeking and background apps alone.
- **Back focus:** asynchronous search rendering could remove the launching card before the modal recorded it. The remote handler now captures the launching card before the click handler and can locate its replacement in the new catalogue.
- **False-positive episode checks:** the app's episode label changes before the provider navigates. The new checker requires the actual episode-2 provider URL and advancing decoded frames in that frame.

The fix still uses the original 111Movies provider and the helper's private loopback inspector. Keep the helper computer running and the existing LG Developer Mode connection available. The app and helper were both restarted during follow-up validation.

## Measurement method

The new `tv-provider-device-check.mjs` requires an advancing clock **and decoded-frame count**, a visible video rectangle, decoded video dimensions, and readiness before startup passes. It then samples for one minute per title and exercises transport, D-pad focus, unmute state, fullscreen dimensions, Back and episode changes. The original checker also rejects zero-size provider videos now.

Actual-device actions use debugger-dispatched key events and DOM clicks. Separate browser tests use real Playwright D-pad/Enter input through a controlled cross-origin provider fixture; they verify command routing, not external media delivery.

The TV denied compositor/display screenshot requests. A canvas capture was black and cannot establish the appearance of the hardware video layer. These results therefore establish layout, decoder progress and control behavior, **not direct observation of the physical screen, audible sound or full-length reliability**.

## Evidence

- [Initial five-title matrix](2026-09-07-111movies-visible.json): preserves the reproduced freeze, focus failure and seek-buffering results. Its episode transition checks were subsequently strengthened; do not treat those initial episode flags as proof of episode-2 playback.
- [Restarted follow-up](2026-09-07-111movies-visible-followup.json): retests the affected movies and verifies the actual episode-2 frames.

## Results

| Title | One-minute layout/decoding sample | Controls and follow-up |
| --- | --- | --- |
| Project Hail Mary | Passed after restart; 1920 × 855 throughout | Reopen/focus fixed. The rapid forward/back seek sequence missed the six-second progress threshold, but playback had resumed by the fullscreen sample. |
| The Shawshank Redemption | Passed | Transport, D-pad focus, unmute state, fullscreen and Back passed. |
| The Matrix | Passed | Initial seek buffering was preserved in the first report; the rerun passed every check. |
| Rick and Morty | Passed | Actual `/embed/tv/60625/1/2` video advanced with episode-2 text; controls passed. |
| Breaking Bad | Passed | Actual `/embed/tv/1396/1/2` video advanced with episode-2 text; controls passed. |

The follow-up is not an unconditional all-pass: the Project Hail Mary seek threshold remains a failure. An advancing clock alone is no longer sufficient to call playback successful.

## Automated checks

- Unit suite: 421 passed, 15 skipped (436 total).
- TV browser suite: 9 passed when run serially. A concurrent run timed out in two fixtures; the serial run completed without failures.
- Regression coverage includes the exact zero-size layout, resized fullscreen layout, actual D-pad/Enter toolbar actions, Back after replacing the launching card, and bounded freeze recovery that respects pause/buffering/seeking/background state.

Repeat the browser suite with `TV_E2E=1 node --test --test-concurrency=1 tv-e2e.test.js tv-player-e2e.test.js`. Repeat the device matrix using the loopback inspector URL printed by the running helper.
