# Live football: design

Date: 2026-09-27. Branch: `player-fullscreen-and-yts-subtitles`.

## Goal

Add a "Live" section to the MoviesDB TV app (and the desktop web app) that shows
today's football matches with kick-off times, live scores and a clock, lets the
user pick a match with the remote and play a free live stream, and offers a grid
of free 24/7 sports channels as a fallback when no match stream is available.

Success: open the TV app on the LG, press the Live tab, see live and upcoming
matches across every league that has a stream, pick one, it plays within about
ten seconds using only the remote. When the match stream is dead, the channel
grid is one Back press away.

## Constraints (user-stated and verified)

- **Free only.** No subscriptions, no debrid, no paid IPTV, no paid fixture API.
- **Everything with a stream.** No league filter; the source's own match list is
  the catalogue. Premier League and Champions League sort first.
- **Both fixtures and channels.** Fixtures are the main view; the channel grid is
  the fallback.
- **No blocked domains.** Sky applies Premier League High Court blocking orders
  on this line (DNS NXDOMAIN plus SNI-level TLS injection, verified 2026-09-27
  against streamed.pk, dlive.sx, sportsurge.net, api.ppv.st). This version does
  not route around them. Every host used below was reachable from Sky on the day
  of the survey: `site.api.espn.com`, `nuviosports.xyz`,
  `iptv-org.github.io`, the DaddyLive CDN hosts that Nuvio points at.
- **The TV is Chromium 79 (webOS 5).** No optional chaining, no nullish
  coalescing, no iframe players from aggregators (their pages use ES2020 and
  fail to parse). Native HLS exists but is flaky; hls.js (ES2016 output) is the
  primary player.
- **Streams need a relay.** Verified: segments return 403 with no headers, 403
  with Referer only, 403 with Origin only, 200 with both. Browsers cannot set
  either header. Playlist tokens are IP-bound and expire in minutes.

## Non-goals (this version)

EPG for channels, recording or DVR, kick-off notifications, the streamed.pk
adapter (and its embed.st unlock chain), per-user favourite teams, any
circumvention of ISP blocks.

## Architecture

```
TV / web client                         Helper (Node, laptop)                 Upstream
---------------                         ---------------------                 --------
Live tab  -> GET /live/matches   ---->  live-match.mjs joins:
                                          live-fixtures.mjs  ------------->  ESPN scoreboard (JSON)
                                          live-sources.mjs (Nuvio adapter) -> nuviosports.xyz (JSON)
          -> GET /live/channels  ---->  live-channels.mjs  ---------------->  iptv-org sports.m3u (+ HEAD probes)
Details   -> GET /live/streams?id ---->  live-sources.mjs                 -->  nuviosports.xyz stream list
Player    -> GET /live/hls?u&ref&org -> live-relay.mjs rewrites playlist -->  CDN m3u8 (with Referer+Origin)
(hls.js)  -> GET /live/seg?u&ref&org -> live-relay.mjs streams segment  -->  CDN .ts (with Referer+Origin)
```

All `/live/*` routes are key-gated through the existing `helperRequestAllowed`
mechanism (`HELPER_API_PATHS` gains a `/live/` prefix rule, like `/hls/`). The
client reaches the helper through `helperUrl()` and therefore the LAN-direct
base when available.

## Helper modules

Each module is a pure ES module with injectable `fetch` and clock, unit-tested
without network.

### `live-fixtures.mjs`

- `fetchFixtures(date, {fetchImpl, now})` calls
  `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=YYYYMMDD&limit=300`
  once and returns normalised fixtures:

  ```
  { id, league: {slug, name}, kickoff /* ISO UTC */,
    state: 'pre' | 'in' | 'post', clock /* "45'+3" | "HT" | "FT" | null */,
    home: {name, shortName, logo, score}, away: {…}, broadcasters: [string] }
  ```

- `normaliseEspnEvent(event)` is the pure mapper. `season.slug` and
  `leagues[0]` give the league. `status.type.state` gives `state`;
  `status.type.shortDetail` and `status.displayClock` give `clock`.
  `competitions[0].competitors[]` give teams, `team.logo` the logo,
  `broadcasts[].names` and `geoBroadcasts[].media.shortName` the broadcasters.
- Cache: in-memory, keyed by date. TTL 60 s if any fixture is `in`, else 600 s.
- ESPN's Akamai front returns 403 to curl-like user agents but 200 to Node's
  default and to browser UAs; the module sends a fixed Chrome UA.

### `live-sources.mjs`

- Adapter interface:

  ```
  { name, hosts: [string],
    listMatches({fetchImpl}) -> [{ sourceId, title, league, kickoff, home, away, poster }],
    streamsFor(sourceId, {fetchImpl}) -> [{ url, referer, origin, userAgent, label, language, quality, rank }] }
  ```

- `hosts` is tried in order on network error, so a domain move is a one-line
  edit. The chosen host is remembered per process.
- **Nuvio adapter** (`live-source-nuvio.mjs`):
  - `listMatches`: `GET {host}/catalog/tv/nuvio_sports_live/genre=Football.json`.
    Each meta maps: `id` -> `sourceId`; `name` minus a leading `LIVE: ` ->
    `title`; `description` line `League: …` -> `league`; `cast[0..1]` ->
    home/away names; `released` -> `kickoff`; `poster`.
  - `streamsFor`: `GET {host}/stream/tv/{id}.json`. For each stream, the
    upstream m3u8 is the `url` query parameter of their `/api/manifest` URL
    when present, else `url` itself. `referer`, `origin`, `userAgent` come from
    `behaviorHints.proxyHeaders.request` with the `/api/manifest` query as
    fallback. `label` = `title`, `language`, `quality` parsed from the title
    (`HD`, `1080p`, `720p`). `rank` = `speedScore` if present.
  - Nuvio's own `/api/manifest` proxy is not used for playback because it does
    not rewrite segment URLs; the helper relay does the full job.
- `listSources()` returns the adapter list; only Nuvio ships in this version.
- A second adapter (streamed.pk, iptv catalogues, anything) is added by
  dropping in a module that satisfies the interface. Nothing else changes.

### `live-match.mjs`

- `normaliseTeam(name)`: lower-case, strip diacritics, drop `FC`, `CF`, `AFC`,
  `SC`, `Women`, punctuation; apply an alias table (`man utd` ->
  `manchester united`, `wolves` -> `wolverhampton wanderers`, `inter` ->
  `inter milan`, `spurs` -> `tottenham hotspur`, `psg` ->
  `paris saint germain`, extendable).
- `joinFixtures(fixtures, sourceMatches, {now})`:
  - A source match joins a fixture when both normalised team names match (in
    either order) and kick-offs are within 30 minutes.
  - Output is one list of `LiveMatch`:

    ```
    { id, title, league, kickoff, state, clock, home, away, broadcasters,
      sources: [{ adapter, sourceId }], hasStream: boolean,
      priority /* league rank for sorting */ }
    ```

  - Fixtures with no source keep `sources: []` and `hasStream: false`.
  - Source matches with no fixture are kept too (state derived from kick-off:
    `pre` before, `in` within 130 minutes after, else `post`), so a league ESPN
    lacks still shows.
- `sortMatches(list)`: `in` first, then `pre` by kick-off, then `post`; within
  a group by `priority` (Premier League, Champions League, Europa League, La
  Liga, Serie A, Bundesliga, Ligue 1, internationals, then everything else),
  then by kick-off.
- Cache: the joined list is rebuilt on demand; inputs are already cached.

### `live-channels.mjs`

- `parseM3u(text)`: handles CRLF, `#EXTINF` attributes (`tvg-id`, `tvg-logo`,
  `group-title`), the `[Geo-blocked]` and `[Not 24/7]` name tags.
- `fetchChannels({fetchImpl, probe, now})`:
  - Downloads `https://iptv-org.github.io/iptv/categories/sports.m3u`.
  - Keeps channels whose name matches the football allowlist (Setanta Sports,
    Digi Sport, beIN, Golazo, Premier Sports, Sportitalia, MUTV, Real Madrid
    TV, Inter TV, ESPN, Fox Soccer, Sky Sport*, TNT Sport*, DAZN, Eleven,
    Sport TV, Futbol, Foot) or any `tvg-id` in a hand-kept list; drops
    `[Geo-blocked]`.
  - Probes each survivor with a 4 s GET of the playlist (HEAD is often
    unsupported); keeps those returning 200 with an HLS content-type or a body
    starting `#EXTM3U`. Probes run 8 at a time.
  - Returns `[{ id, name, logo, url, referer: null, origin: null }]`.
  - Cache 15 minutes; a failed download returns the last good list with
    `stale: true`.

### `live-relay.mjs`

- `signUpstream(url, key)` / `verifyUpstream(url, sig, key)`: HMAC-SHA256 of
  the upstream URL with the helper key. Every `u=` the relay accepts must carry
  a valid `s=`. The helper mints signatures when it returns stream URLs; the
  client never constructs relay URLs from raw upstream URLs. This keeps the
  relay from being an open proxy even though it is exposed on the funnel.
- `rewritePlaylist(text, {playlistUrl, relayBase, headers, key})`:
  - Resolves every non-comment line against `playlistUrl` and rewrites it to
    `{relayBase}/live/seg?u=<abs>&s=<sig>&ref=&org=&key=`.
  - Nested playlists (master -> variant) go to `/live/hls` instead of
    `/live/seg`, detected by `.m3u8` or by `#EXT-X-STREAM-INF` context.
  - Rewrites `URI="…"` inside `#EXT-X-KEY`, `#EXT-X-MAP`, `#EXT-X-MEDIA`,
    `#EXT-X-I-FRAME-STREAM-INF`.
  - Leaves every other tag untouched (live playlists must keep
    `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-TARGETDURATION`, discontinuities).
- `handleLiveHls(req, res, url)`: verifies the signature, fetches the upstream
  playlist with `Referer`, `Origin`, `User-Agent` (from query, defaulting to a
  Chrome UA), 8 s timeout, through plain `fetch` on the system resolver (no
  public-DNS fallback: the Constraints forbid routing around ISP blocks). Responds
  `application/vnd.apple.mpegurl`, `cache-control: no-store`,
  `access-control-allow-origin: *`. Upstream 403 or 5xx passes through as the
  same status so the client can react.
- `handleLiveSeg(req, res, url)`: verifies the signature, streams the upstream
  body with the same headers, passing through `content-type`, `content-length`
  and status. No buffering to disk, no ffmpeg. Aborts upstream when the client
  disconnects.
- `handleOptions`: answers preflights for `/live/*` with `GET`, `*` headers.

### Routes (all key-gated)

| Route | Returns |
|---|---|
| `GET /live/fixtures?date=YYYY-MM-DD` | normalised ESPN fixtures |
| `GET /live/matches` | sorted `LiveMatch[]` for today, plus `{ sources: { nuvio: 'ok' \| 'error: …' }, fixtures: 'ok' \| 'error: …' }` |
| `GET /live/streams?adapter=&id=` | stream list, each with a ready-made relay URL `play` (`/live/hls?u=&s=&ref=&org=&key=`) |
| `GET /live/channels` | alive channels, each with `play` |
| `GET /live/hls` | rewritten playlist |
| `GET /live/seg` | segment passthrough |
| `OPTIONS /live/*` | preflight |

Source status is logged once per fetch to the helper journal.

## Client

### Live kind

- `tv-remote.js` kind nav gains a fourth tab, `Live` (`data-kind="live"`).
- `setTvMediaKind('live')` renders `renderLiveHome()` instead of
  `renderTvHome()`. `homeAnchor()` already resolves to the active kind tab, so
  Back returns to the Live tab.
- `effectiveMediaType()` is unaffected; search and filters stay TMDB-only. The
  Live home hides the filter panel.
- Desktop web gets the same tab in `.app-tabs` and the same home.

### `live-home.mjs` (client, pure where possible)

- `buildLiveRows(matches, channels, now)` returns rows in the existing
  `{ key, title, items }` shape:
  - `live-now`: `state === 'in'`.
  - `today`: `state === 'pre'`, then `post` for the last two hours.
  - `channels`: channel items.
- Each item is a card-compatible object:

  ```
  { id, title, image_url, live: { state, clock, kickoff, homeScore, awayScore,
    homeBadge, awayBadge, hasStream, league } , kind: 'match' | 'channel', raw }
  ```

- `renderLiveHome()` in `script.js` fetches `/live/matches` and
  `/live/channels` in parallel, builds rows, calls the existing `appendTvRow`
  per row, and re-fetches every 60 s while the Live home is current, guarded
  by the same `tvHomeToken` pattern. A one-line status under the rows names a
  failed source ("Match streams unavailable (Nuvio): timeout").
- Empty state: no matches -> "No football with a free stream right now" above
  the channel grid.

### Cards (`tv-ui.js`)

- `createTvCard` uses `movie.image_url` verbatim when present, else the TMDB
  prefix as today.
- When `movie.live` is present the card renders the live variant: two badges,
  `2 - 1` and `67'` for `in`; kick-off local time and "in 1h 20m" for `pre`;
  `FT` for `post`; league as the small label; a `LIVE` pill for `in`. Items
  with `hasStream: false` get a `.tv-card--nostream` class (dimmed, still
  focusable, opens details with "No stream yet").
- Movie cards are unchanged; the live branch is additive.

### Live details (`live-details.mjs`)

- Same overlay shell and focus handling as `tv-details.js`, separate module.
- Shows badges, score, clock or kick-off, league, broadcasters, and a stream
  picker: one button per stream, label + language + quality, sorted by `rank`.
- Play focuses first and starts the first stream. Picking another button
  switches. Channels bypass details and play directly from the grid.
- Stream list is fetched on open (`/live/streams`), so it is fresh at play
  time.

### Player (`live-player.mjs` + `script.js`)

- hls.js is added as a dependency and bundled by esbuild into `tv-bundle.js`
  (its UMD build targets ES2016, safe for Chromium 79). Loaded via static
  import in `script.js`; desktop uses the same code.
- `playLiveHls(playUrl, {title, recover})`:
  - Stops any torrent / HLS session / transcode (existing `stopYtsStream`).
  - Opens the player modal, `showPlayerVideo(true)`, sets `#player-title`.
  - Marks the modal `data-live="1"`. `tv-player.js` reads this to hide the
    progress bar, disable seek keys, show a `LIVE` indicator instead of a
    time, and keep only play/pause, retry and settings.
  - If `Hls.isSupported()`: `new Hls({ maxBufferLength: 10,
    liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8,
    manifestLoadingTimeOut: 8000, fragLoadingTimeOut: 10000 })`, attach,
    `loadSource(playUrl)`, play on `MANIFEST_PARSED`.
  - Else native: `playerVideo.src = playUrl`, `load()`, `play()`.
  - No dwell tracking, no `savePlaybackPosition`, no HLS keep-alive, no
    resume.
- Failure detection: hls.js fatal `networkError` with response code 403/404,
  fatal `mediaError` after one `recoverMediaError()`, or
  `watchPlaybackHealth` seeing no `currentTime` progress for 20 s (30 s at
  startup) calls `recover()`.

## Failure handling

| Failure | Behaviour |
|---|---|
| Stream 403 / expired token / stall | `recover()` re-fetches `/live/streams` for the match, picks the next stream not in `tried`, restarts. Tried set resets when the list changes. |
| Every stream failed | Player shows "No working stream yet" with Retry (clears `tried`, refetches) and Back to details. Channel grid is the escape route. |
| Nuvio unreachable / shape change | `/live/matches` still returns ESPN fixtures with `hasStream: false`; status line names the failure; channel grid unaffected. |
| ESPN unreachable | Matches come from the adapter list alone, `clock` and scores null; status line names it. |
| iptv-org download fails | Last good list served with `stale: true`; if none, empty grid with a message. |
| Channel dies mid-watch | Same `recover()`; a channel has one stream, so it goes straight to the error state. No auto-pick of another channel. |
| Helper unreachable | Existing helper error messaging. |
| Relay called with bad signature | 403 JSON, logged. |

## Rot resistance

- Adapter `hosts` arrays, tried in order.
- `npm run check-live` (`check-live.mjs`, test gated by `CHECK_LIVE=1`): for
  each adapter, list matches and fetch streams for the first one; probe the
  channel list; print a one-line status per source. Exits non-zero if the
  primary adapter fails. Mirrors `check-links`.
- Source status logged per fetch in the helper journal.
- Team-alias table and channel allowlist are plain data at the top of their
  modules.

## Security

- All `/live/*` routes require the helper key.
- Relay accepts only HMAC-signed upstream URLs minted by the helper.
- Relay refuses `http(s)` targets that resolve to private, loopback or
  link-local addresses (reuse `isSafeDebridUrl`, extended to allow plain
  `http` since many iptv-org channels are `http://ip:port`).
- No upstream credentials are ever sent to the client; the client sees only
  relay URLs.

## Testing

Unit (pure, `node --test`, no network):

- `live-fixtures.test.js`: normalisation from a saved ESPN response (pre, in
  with clock, post, missing broadcasters, missing logo); cache TTL switch.
- `live-source-nuvio.test.js`: catalog and stream parsing from saved
  responses, `/api/manifest` unwrapping, header extraction, host failover.
- `live-match.test.js`: `normaliseTeam` alias cases; join with swapped
  home/away; 30-minute window edge; unmatched fixture and unmatched source
  match both kept; sort order.
- `live-channels.test.js`: CRLF M3U, attribute parsing, tag filtering,
  allowlist, probe acceptance rules, stale fallback.
- `live-relay.test.js`: rewrite of relative and absolute segment URLs, master
  playlist variants to `/live/hls`, `URI=` in KEY/MAP/MEDIA, untouched tags,
  signature mint/verify, rejection of unsigned and tampered URLs, private
  address refusal.
- `live-home.test.js`: row building and item shape; `tv-ui` card live branch
  with a fake document (existing pattern in `tv-ui-focus.test.js`).
- `tv-player` live mode: HUD hides progress and ignores seek keys when
  `data-live` is set.

Integration (`live-relay.integration.test.js`, gated `CHECK_LIVE_RELAY=1`):
ffmpeg generates a live HLS stream into a temp dir served by a local HTTP
server that rejects requests lacking the expected Referer and Origin; the
relay is started against it; the test fetches the rewritten playlist, checks
every URI points at the relay, and fetches two segments through it.

TV e2e (`tv-live-e2e.test.js`, gated `TV_E2E`): Playwright stubs `/live/*`
with fixture JSON and the synthetic HLS; keyboard-only walk: Live tab, row,
card, details, Play, assert focus ids and `currentTime` advancing; Back
returns to the Live tab.

Live validation: on the real TV via direct CDP (192.168.0.112:9998) during a
match window, written up in `docs/playback-validation/`.

## Files

New: `live-fixtures.mjs`, `live-sources.mjs`, `live-source-nuvio.mjs`,
`live-match.mjs`, `live-channels.mjs`, `live-relay.mjs`, `check-live.mjs`,
`live-home.mjs`, `live-details.mjs`, `live-player.mjs`, their tests.

Modified: `stream-server.mjs` (routes, preflight), `helper-auth.js` (`/live/`
prefix), `script.js` (Live kind, `renderLiveHome`, `playLiveHls` wiring),
`tv-remote.js` (Live tab), `tv-ui.js` (image_url, live card), `tv-player.js`
(live HUD mode), `tv.css` / `style.css` (live card, pill, picker), `tv.html`
/ `index.html` (Live tab on web), `package.json` (hls.js, `check-live`),
`TV-README.md`.
