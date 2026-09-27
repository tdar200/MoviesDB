# Movies on LG webOS

The `Movies` TV app opens the hosted `tv.html` interface. It uses the same catalogue, watched history, recommendations, and list as the existing app, with a featured title, horizontal rows, and directional focus navigation.

## Run and build

```bash
npm ci
npm start
```

`npm start` builds the ES2019 TV bundle before starting the helper. Open `/tv.html` on the reported port. The existing hosted installation uses the helper on port 8123 behind its configured HTTPS endpoint. Keep that machine running while watching.

```bash
npm run package:tv
# Requires the installed LG/webOS ares CLI and a configured device:
ares-install --device lgtv dist/com.moviesdb.tv_1.2.0_all.ipk
ares-launch --device lgtv com.moviesdb.tv
```

The host URL is configured in `webos-app/index.html`. Repackage after changing it. The installed shell checks connectivity and offers Retry if the host cannot be reached. LG Developer Mode must remain enabled for development-installed apps.

## Remote

- Arrows move between controls and along title rows; Down from navigation reaches the featured title.
- OK opens a title or activates a control.
- Search & filters opens the search field and filters. OK on a select opens a remote-friendly option menu.
- Back closes an option menu, leaves fullscreen, closes playback, closes filters, then returns focus to navigation. Closing playback restores the selected title.
- Playback fills the screen. The timeline and transport controls hide after 4.5 seconds while playing. OK toggles playback when controls are hidden; Left/Right seek backward/forward. Playback options opens source, quality, subtitle, and episode menus. Back closes options before leaving playback.
- Quality, subtitles, season, and episode selectors use the same remote option menu.
- Load more titles fetches another catalogue batch. TV mode avoids the desktop's large background catalogue expansion.

## Playback and limits

TV playback defaults to 111Movies, shown first in Playback source. YTS (Torrent) for movies and TV (Torrent) for episodes remain available as manual source choices. An explicit `?source=...` selection or a manual source change remains available. On webOS, both movies and episodes use HLS with a prepared buffer and verified torrent range reads for seeking. Stalled sources are retried automatically while preserving playback position, up to five episode sources. TV movie playback starts with the existing 720p preference for faster buffering, retains higher qualities in Playback options, retries another quality when progress stops, and uses alternate movie indexes when YTS cannot supply a title. Late lookups from a previous title, episode, or source are discarded.

Native playback still depends on source availability, buffering, and compatible media. Preparation is bounded; an exhausted source list presents a retry action. Source identity checks reject explicit spin-off and episode mismatches. The helper must be reachable and its access key configured. Embedded providers are external services: during device validation, 111Movies redirected to a provider that failed to load. They are not a reliable remote-only default. Cross-origin embedded players control their own input and cannot be driven by the parent app's remote handler.
When a torrent has no text subtitle track, YTS releases first use a release-matched subtitle from YTS Subs; other releases fall back to a configured OpenSubtitles API key or the official public Stremio OpenSubtitles add-on without requiring an account or key. Matching includes the source format (BluRay versus WEBRip) to prevent timing drift. The helper uses public DNS resolution for subtitle downloads because this network sinkholes some download hosts through the ISP resolver.

YouTube retains the existing requirement for a configured YouTube API key.

## Validation

```bash
npm test
TV_TEST_URL=http://127.0.0.1:8123 npm run test:tv
```

TV browser tests use deterministic catalogue/provider fixtures, a real generated H.264/AAC video, and the installed Chrome executable (`CHROME_PATH` overrides it). They cover browsing, scrolling, player focus restoration, search, filter menus, shell retry, native source selection, full-screen playback, auto-hiding controls, seeking, pause/resume, options, stale episode lookups, and movie HLS selection at 720p. Backend tests generate and decode real HLS segments and check cancellation, authentication, and cleanup. These tests do not claim that external streaming services are available.

Device validation used the configured LG TV, whose browser reports Chrome 79. The TV rendered the catalogue and artwork, opened the installed application, and played a native movie with advancing playback time and no media error. The original open-ended MP4 episode delivery stalled within seconds. The replacement HLS path sustained more than two minutes of device playback, and a subsequent test verified source fallback, seeking, and episode switching. The final movie HLS test verified continuous advancing playback, pause/resume, forward and backward seeking, and Back to the selected title. App-rendered captions were also verified on the TV. LG Back (461) was tested, including stream cleanup and focus restoration. The ES2019 bundle and CSS include compatibility accommodations for that browser.

LG references: [remote keys](https://webostv.developer.lge.com/develop/guides/magic-remote), [Back handling](https://webostv.developer.lge.com/develop/guides/back-button), [CLI deployment](https://webostv.developer.lge.com/develop/tools/cli-dev-guide).

TV subtitles are rendered by the app because the native HLS player rejected sidecar tracks on the test TV. Embedded subtitle caches refresh as the torrent downloads and are separated by episode file. HLS sessions and their temporary segments are removed on close, source change, or helper shutdown; inactive sessions expire after 15 minutes.

YTS media downloads on the helper computer under `/tmp/webtorrent/`, not on the TV. It streams while downloading; normal playback teardown deletes its torrent store. Temporary HLS output uses `/tmp/moviesdb-hls-*`. Interrupted processes can leave temporary files behind.

## Repeat the real-TV playback matrix

With the TV app open, use the loopback inspector URL from the helper’s “111Movies compatibility bridge connected” log entry, then pass it to the device checker:

```bash
node tv-device-check.mjs http://localhost:PORT /tmp/movies-device-results.json
```

This takes control of the TV app and tests two movies and two series against 111Movies and the native torrent sources. It records provider-frame errors, six five-second playback samples, pause/resume, seeking, episode switching, and Back/focus restoration. It clears its search when finished. Use an idle TV while it runs. App controls are invoked through the debugger; physical remote navigation is a separate check. These short playback samples do not establish full-length viewing reliability or audible sound quality.

Native episode playback on TV now prefers available 720p sources, matching the movie preference. Higher qualities remain in Playback options. The September 7 live comparison found the tested 720p Rick and Morty source sustained a minute while the initial 1080p source buffered. See `docs/playback-validation/` for the broader failures and measurement limits.


## 111Movies compatibility on this TV

The installed webOS browser lacks `MediaSession.setPositionState`. The current 111Movies player calls it without checking support and crashes when duration metadata arrives. The helper now starts a private compatibility bridge for the configured `lgtv` device and `com.moviesdb.tv` app. It supplies the missing optional media-notification method only inside `player.vidlove.cc`, leaving the original provider and its media delivery intact. The provider also uses CSS `inset`, which this TV ignores; a feature-detected fallback supplies physical top/right/bottom/left offsets so the video cannot collapse to zero size. App-owned controls expose play/pause, seeking and sound; Back is forwarded out of the provider frame. A bounded transport restart recovers ready-but-frozen playback without resuming a user-paused video.

This uses the existing LG Developer Mode connection and installed `ares-inspect` CLI. Keep the helper computer running and Developer Mode available. Inspection forwarding is forced to `127.0.0.1`; it is not published through Funnel. The helper polls the running-app list and only starts inspection after the Movies app is already open; this avoids `ares-inspect` launching or foregrounding Movies on its own. It reconnects after app/device disconnection. Override the configured device with `TV_DEVICE`, the CLI paths with `TV_ARES_INSPECT` and `TV_ARES_LAUNCH`, or disable this integration with `TV_PROVIDER_BRIDGE=0`. The app origin must match `CONFIG.STREAM_HELPER_BASE`.

The earlier media-clock results missed a zero-size video layout. See `docs/playback-validation/2026-09-07-111movies-visible.md` for the follow-up investigation and measurement limits. No extra public HTTPS port was enabled.


For the stricter 111Movies-only run (three movies and two series), use:

```bash
node tv-provider-device-check.mjs http://localhost:PORT /tmp/111movies-visible.json
```

This requires an advancing clock and decoded-frame count before startup passes, then samples a visible video rectangle and sustained decoding for one minute per title. It checks D-pad focus, transport commands, fullscreen sizing, provider Back and episode switching. It exits nonzero on failed checks and saves failures. Set `TV_CHECK_TITLE` to a tested TMDB ID to repeat one title. Actual D-pad/Enter browser events are separately exercised by `npm run test:tv`; device actions use debugger-dispatched events and DOM clicks.

## Live football

The Live tab lists today's football and a grid of free 24/7 sports channels.

- Fixtures: ESPN's public scoreboard (`site.api.espn.com`, no key), every league, UTC kick-off, live clock and score.
- Match streams: the Nuvio Live Sports add-on (`nuviosports.xyz`), which wraps DaddyLive. Free, no key, reachable from Sky. Streams appear roughly ten minutes before kick-off. Playlists are fetched through Nuvio's `/api/manifest` wrapper URL because the upstream playlists are bound to Nuvio's resolver IP; fetching them directly from here returns 403 or times out. Segments are fetched directly by the helper relay with the stream's Referer and Origin.
- Channels: iptv-org `categories/sports.m3u`, filtered to football broadcasters and probed for liveness at fetch time (15 minute cache).
- Playback: upstream CDNs require both `Referer` and `Origin`, which browsers cannot set, so the helper relays playlists and segments (`/live/hls`, `/live/seg`). Every relayed URL is HMAC-signed with the helper key; the relay refuses unsigned targets. The relay refuses private, loopback, link-local, CGNAT (Tailscale 100.64/10) and multicast targets, re-checks every redirect hop. `/live/seg` returns 504 if upstream headers do not arrive within 10 s. The TV plays through hls.js (bundled) with native HLS as fallback.
- Stream listing: `/live/streams` probes every stream before listing it (playlist, at most one variant hop, first segment's first bytes; 5 s per probe, 16 in parallel, 2-minute cache). Streams whose segments are image-wrapped (RIFF/PNG/JPEG/GIF), return HTTP errors, or point at private network addresses are dropped. Working streams are listed first; streams whose CDN timed out are kept last and labelled "may not work" on the TV. The first stream list for a match can take about 15 s.
- DaddyLive on Sky: DaddyLive-sourced streams currently time out from this Sky line during matches (ISP blocking). The feature does not route around it. A dead stream costs about 16 s before the player moves to the next.
- Match rows: the Today and Live-now rows list every match that has a stream plus stream-less fixtures from the big leagues and internationals only, capped at 60 cards each.
- Not touched: streamed.pk, DaddyLive's own site, Sportsurge, TotalSportek. Sky court-blocks them on this line and this feature does not route around that.

Rot playbook: `npm run check-live` prints one line per source. If `nuvio` is BAD, check `NUVIO_HOSTS` in `live-source-nuvio.mjs` for a domain move; if `channels` is BAD, iptv-org changed its layout or every football channel died that hour. `journalctl --user -u moviesdb-helper | grep '\[live\]'` shows the same status per request. Env: none required; `LIVE_RELAY_ALLOW_PRIVATE=1` is for the integration test only.

Tests: `npm test` (unit, includes `live-health.test.js`). `npm run check-live-relay` probes the relay through a header-enforcing origin (needs ffmpeg). `npm run test:tv` includes `tv-live-e2e.test.js` (Playwright). Note that 7 of the older TV e2e tests (tv-e2e.test.js, tv-player-e2e.test.js) already failed before this feature and still do.


### Stalled or unavailable 111Movies streams

The helper reports exhausted provider servers and prolonged stalls to the app. The TV reconnects once for a stall, then uses the built-in player if recovery fails; explicit server exhaustion goes directly to the built-in player. Movie/episode position is preserved. The remote toolbar also exposes Reconnect and Use built-in player. Native HLS now prepares a full minute before starting (up to 90 seconds preparation), reducing early stalls from missing torrent pieces. See [the live recovery report](docs/playback-validation/2026-09-07-stall-recovery.md).


### 111Movies popups

The helper injects popup protection into 111Movies and its descendants under the configured app origin. It removes the reproduced full-screen blank ad iframe and blocks window.open and target-based popup navigation. It does not sandbox the provider. See [actual-TV popup checks](docs/playback-validation/2026-09-07-popup-guard.md); the recorded run removed the overlay but the provider stream still failed to start.
