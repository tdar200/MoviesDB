# Stuck playback: server exhaustion and insufficient startup buffering

The reported stuck TV session was The Matrix at 52:38. 111Movies displayed “All servers are currently unavailable” and marked all seven servers offline. Its video stayed at readyState 2 with only about 0.125 seconds buffered ahead. The previous recovery logic only handled readyState 3/4 freezes, so this failure left the app showing Pause indefinitely.

The provider's Try Again control briefly recovered one server, but playback repeatedly ran out of data. Reconnecting subsequently stayed at readyState 0. This was an actual external-provider failure; the app cannot repair those servers.

## Changes

- Detect explicit provider exhaustion, prolonged startup/buffering, insufficient clock progress and frozen decoded frames.
- Reconnect once for a prolonged stall, retaining position and sound state. Exhausted servers or unsuccessful automatic recovery switch to the built-in player. 111Movies remains the initial/default source.
- Carry the movie/episode timestamp through YTS and alternate native-source lookup, including the secondary movie index.
- Expose Reconnect and Use built-in player on the remote toolbar, and transfer focus to native Play during fallback.
- Publish the native HLS playlist only after a full minute is prepared, rather than about 12 seconds. Allow up to 90 seconds of preparation; completed short videos can start sooner.

## Actual LG TV validation

Fallback resumed The Matrix at the captured 52:38 position. The first run, with the old startup buffer, reproduced buffering near 53:26; see the [baseline](2026-09-07-stall-before-buffer.json).

After deploying the larger buffer and restarting the helper, startup took approximately **15.9 seconds**. The measured playback interval lasted **228.0 seconds**, with **227.9 seconds of media-clock progress**, zero buffering samples and zero media errors. The displayed position advanced from **52:40 to 56:28**. The video occupied **1920 × 1080** with decoded dimensions **1280 × 532**. See the [buffered run](2026-09-07-stall-buffered.json).

The live run exercised the real native fallback at the captured timestamp via the app's fallback event. Separate cross-origin browser tests verify that provider failure messages trigger that event and preserve the timestamp for movies, episodes and alternate movie indexes. Native webOS HLS reports a zero webkitDecodedFrameCount here; the device evidence uses readiness, media-clock progress, video dimensions and errors. Physical picture/audio and full-length reliability are not established by these debugger measurements.

Pause/resume passed on the actual recovered stream. Forward seeking became ready in about five seconds and backward seeking in about four seconds; playback advanced for eight seconds after each. The movie was left playing in the built-in player. See [control measurements](2026-09-07-stall-controls.json).

## Regression checks

- Full unit run: 422 passed, 18 skipped, zero failures (440 total).
- Serial TV browser run: 12 passed, zero failures.
- Additional HLS validation decodes actual generated segments and requires a full minute in the published playlist.

These changes recover from unavailable 111Movies servers; they are not a claim that the external provider itself is reliable.
