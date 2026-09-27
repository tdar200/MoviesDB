// live-player.mjs — plays a live HLS relay URL through hls.js (native <video src>
// fallback) with a recover cascade: a fatal network error, a second media error,
// or a stall moves to the next untried stream; when every stream has failed the
// list is refreshed once (tokens expire in minutes) before giving up with a
// Retry. No seeking, no resume, no watch-time: live is not on-demand.
import { playbackHealth } from './playback-health.js';

export const LIVE_HLS_CONFIG = {
  maxBufferLength: 10,
  maxMaxBufferLength: 20,
  liveSyncDurationCount: 3,
  liveMaxLatencyDurationCount: 8,
  manifestLoadingTimeOut: 8000,
  // The relay does not rewrite LL-HLS #EXT-X-PART / #EXT-X-PRELOAD-HINT URIs, so
  // low-latency mode would request raw upstream parts; stay on full segments.
  lowLatencyMode: false,
  // Live: one quick retry per fragment, so a dead segment CDN surfaces in seconds
  // (hls.js 1.7 policy; the legacy fragLoadingTimeOut is ignored once this is set).
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 8000,
      maxLoadTimeMs: 15000,
      timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 1, retryDelayMs: 500, maxRetryDelayMs: 1000 },
    },
  },
  enableWorker: false, // webOS: keep it on the main thread
};

const STARTUP_MS = 30000;
const STALL_MS = 20000;
const FRAG_STRIKES = 2; // non-fatal fragment failures before the first frame that condemn a stream

export function createLivePlayer({ video, modal, helperUrl, setStatus, getHls = () => globalThis.Hls, now = Date.now, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  let session = null;
  let hls = null;
  let current = null;
  let tried = new Set();
  let refreshed = 0;
  let timer = null;
  let generation = 0;
  let nativeErrorHandler = null;

  // Drop the hls.js instance and watchdog of a failed stream without touching the video.
  function releaseStream() {
    if (hls) { try { hls.destroy(); } catch { /* already gone */ } hls = null; }
    if (nativeErrorHandler) { video.removeEventListener('error', nativeErrorHandler); nativeErrorHandler = null; }
    if (timer) { clearInterval(timer); timer = null; }
  }

  function teardownMedia() {
    if (hls) { try { hls.destroy(); } catch { /* already gone */ } hls = null; }
    if (nativeErrorHandler) { video.removeEventListener('error', nativeErrorHandler); nativeErrorHandler = null; }
    if (timer) { clearInterval(timer); timer = null; }
    try { video.pause(); } catch { /* not playing */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* jsdom-less */ }
  }

  function watchdog(gen) {
    let health = null;
    let started = false;
    timer = setInterval(() => {
      if (gen !== generation) return;
      if (video.currentTime > 0.25) started = true;
      health = playbackHealth(health, { now: now(), time: video.currentTime, paused: video.paused, started, timeoutMs: started ? STALL_MS : STARTUP_MS });
      if (health.stalled) { health = null; fail(gen, 'stalled'); }
    }, 1000);
  }

  function start(stream) {
    const gen = ++generation;
    teardownMedia();
    current = stream;
    tried.add(stream.play);
    if (modal && modal.dataset) modal.dataset.live = '1';
    setStatus(`Connecting to ${stream.label || 'stream'}…`, false);
    const url = helperUrl(stream.play);
    const Hls = getHls();
    let mediaRecovered = false;
    let fragStrikes = 0;
    if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
      hls = new Hls(LIVE_HLS_CONFIG);
      const details = Hls.ErrorDetails || {};
      const fragFailures = [details.FRAG_LOAD_ERROR || 'fragLoadError', details.FRAG_LOAD_TIMEOUT || 'fragLoadTimeOut'];
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (gen !== generation) return; setStatus(null); video.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data || gen !== generation) return;
        if (!data.fatal) {
          // Before the first frame, two fragment failures mean the segment CDN is dead:
          // do not wait out the stall watchdog.
          if (fragFailures.includes(data.details) && video.currentTime <= 0.25 && ++fragStrikes >= FRAG_STRIKES) fail(gen, 'segments unreachable');
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) { mediaRecovered = true; hls.recoverMediaError(); return; }
        const code = data.response && data.response.code;
        fail(gen, data.type === Hls.ErrorTypes.NETWORK_ERROR ? `network ${code || ''}`.trim() : data.type);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      nativeErrorHandler = () => fail(gen, 'media element error');
      video.addEventListener('error', nativeErrorHandler);
      video.src = url;
      video.load();
      video.play().then(() => { if (gen === generation) setStatus(null); }).catch(() => {});
    }
    watchdog(gen);
  }

  function nextUntried(list) { return (list || []).find(s => s && s.play && !tried.has(s.play)) || null; }

  async function startNext() {
    if (!session) return;
    const s = session;
    const next = nextUntried(session.streams);
    if (next) { start(next); return; }
    if (refreshed < 2 && session.refresh) {
      refreshed++;
      setStatus('Looking for another stream…', false);
      const gen = generation;
      let fresh = [];
      try { fresh = (await s.refresh()) || []; } catch { fresh = []; }
      // stop(), a new play() or a retry() while the refresh was in flight owns the player now.
      if (session !== s || generation !== gen) return;
      session.streams = fresh.length ? fresh : session.streams;
      const again = nextUntried(session.streams);
      if (again) { start(again); return; }
    }
    generation++;
    teardownMedia();
    current = null;
    setStatus('No working stream yet. Press Retry, or pick a channel.', true);
  }

  function fail(gen, reason) {
    if (gen !== generation || !session) return;
    console.log(`[live] stream failed (${reason}): ${current && current.label}`);
    generation++;
    releaseStream(); // the abandoned instance must not keep loading while a refresh is awaited
    startNext();
  }

  return {
    async play(next) {
      generation++;
      session = { title: next.title, streams: (next.streams || []).slice(), refresh: next.refresh || null };
      tried = new Set();
      refreshed = 0;
      const first = session.streams[next.startIndex || 0] || session.streams[0];
      if (first) start(first); else await startNext();
    },
    stop() {
      if (!session) return; // nothing live: leave the shared <video> (and its resume position) alone
      generation++;
      teardownMedia();
      session = null; current = null; tried = new Set();
      if (modal && modal.dataset) delete modal.dataset.live;
    },
    isActive: () => !!session,
    async retry() {
      if (!session) return;
      generation++;
      tried = new Set();
      refreshed = 0;
      await startNext();
    },
  };
}
