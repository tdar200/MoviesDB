# 111Movies availability and recovery follow-up — 7 September 2026

Fresh desktop Chromium contexts reproduced playback failure both with and without the TV popup/compatibility guards. These are live provider checks, not fixture playback passes.

| Title / source | Observation over about 60 seconds |
| --- | --- |
| The Matrix / Archer Queen | Media endpoint HTTP 503, zero video frames |
| The Matrix / explicitly selected Barbarian King | Media endpoint HTTP 427; provider then switched to Archer Queen, HTTP 503; zero video frames |
| The Shawshank Redemption / automatic selection | Ready state 0, zero frames, eventually reported server unavailable |
| Game of Thrones S1E1 / automatic selection | Grand Warden selected; ready state 0 and zero frames |

Browser-origin discovery for Matrix returned stream URLs from two of seven internal sources; the other five returned no source. A returned URL or provider LIVE label did not establish playback. Direct Node discovery requests returned 403 and were excluded from availability conclusions. No signed media URLs are included in this report.

A TV network capture also recorded an app reload initiated by Clear search, aborting source requests. The origin of that activation (remote input or otherwise) was not established. Clear search now ignores activation while the player is open.

Recovery fixes: metadata-only paused media no longer cancels the startup timer, and terminal server errors are forwarded even when video is paused. The existing bounded reconnect and built-in fallback remain enabled. These fixes do not repair unavailable upstream streams.

Raw sanitized live samples are in `2026-09-07-provider-availability.json`. Prior on-device popup and built-in playback evidence remains in the separate popup-guard and stall-recovery reports.

Validation: `node --test tv-provider-compat.test.js` passed 6/6; `npm run test:tv` passed 14/14. Built the TV bundle and restarted the helper to load the updated bridge. Fresh TV navigation removes the temporary diagnostic fallback interception.
