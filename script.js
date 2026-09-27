import { CONFIG, ENDPOINTS, MOVIE_GENRES, TV_GENRES, THEME_KEYWORDS } from './config.js';
import { initYouTube, activateYouTube } from './youtube.js';
import { getRecommendations, getRecommendationRows, clearRecommendationCache } from './recommendations.js';
import { createWatchTimer } from './watch-timer.js';
import { calculateScore, newestWeightedScore } from './scoring.js';
import { playbackHealth, bufferRecovery } from './playback-health.js';
import { createTvCard, renderTvBrowse, renderTvRows, appendTvRow, sortTvTrackByRating } from './tv-ui.js';
import { createTvDetails, mergeTitleRecommendations } from './tv-details.js';
import { catalogRowDefs, dedupeAcrossRows, dedupeItems, titleKey, signalRows, staticHomeRows } from './tv-rows.mjs';
import { fetchTmdbJson } from './tmdb-queue.js';
import { decodeImportPayload, mergeImportIntoStores } from './profile-import.js';
import { describeYtsLookupFailure, describeImdbLookupFailure, describeTvTorrentFailure } from './yts-status.js';
import { dedupeTrackLabels } from './subtitles.js';
import { IMDB_TOP_250 } from './imdb-top250.js';
import { EMMY_WINNERS } from './emmy-winners.js';
import { buildLiveRows, restoreFocusById, findCurrentMatch } from './live-home.mjs';
import { createLiveDetails } from './live-details.mjs';
import { createLivePlayer } from './live-player.mjs';

// App state - which tab is active
let currentApp = 'movies'; // 'movies' or 'youtube'

// Create a map for quick genre ID to name lookup
const GENRE_MAP = new Map();
[...MOVIE_GENRES, ...TV_GENRES].forEach(genre => {
  if (genre.id !== 0) {
    GENRE_MAP.set(genre.id, genre.name);
  }
});

// Get genre names from IDs
function getGenreNames(genreIds) {
  if (!genreIds || !Array.isArray(genreIds)) return [];
  return genreIds
    .map(id => GENRE_MAP.get(id))
    .filter(name => name); // Remove undefined
}

// DOM Elements
const form = document.getElementById('form');
const main = document.getElementById('main');
const search = document.getElementById('search');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const mediaTypeSelect = document.getElementById('media-type');
const genreSelect = document.getElementById('genre');
const minRatingSelect = document.getElementById('min-rating');
const minVotesSelect = document.getElementById('min-votes');
const yearFilterSelect = document.getElementById('year-filter');
const languageSelect = document.getElementById('language');
const sortBySelect = document.getElementById('sort-by');
const themeSelect = document.getElementById('theme');
const excludeGenresBtn = document.getElementById('exclude-genres-btn');
const excludeGenresDropdown = document.getElementById('exclude-genres-dropdown');
const providerSelect = document.getElementById('provider');

// Actor Filter Elements
const actorSearchInput = document.getElementById('actor-search');
const actorSuggestions = document.getElementById('actor-suggestions');
const actorIdInput = document.getElementById('actor-id');
const clearActorBtn = document.getElementById('clear-actor');

// Top 250 Button
const top250Btn = document.getElementById('top250-btn');

// Player Modal Elements
const playerModal = document.getElementById('player-modal');
const playerIframe = document.getElementById('player-iframe');
const playerStarBtn = document.getElementById('player-star');
const playerDownBtn = document.getElementById('player-down');
const trailerIframe = document.getElementById('trailer-iframe');
const playerVideo = document.getElementById('player-video');
const ytsStatusEl = document.getElementById('yts-status');
const qualitySelect = document.getElementById('quality-select');
const subtitleSelect = document.getElementById('subtitle-select');
const subtitleSyncControls = document.getElementById('subtitle-sync-controls');
const subtitleEarlierBtn = document.getElementById('subtitle-earlier');
const subtitleLaterBtn = document.getElementById('subtitle-later');
const subtitleOffsetLabel = document.getElementById('subtitle-offset-label');
const playerTitle = document.getElementById('player-title');
const closeModalBtn = document.getElementById('close-modal');
const playerFullscreenBtn = document.getElementById('player-fullscreen');
const watchContainer = document.getElementById('watch-container');
const trailerContainer = document.getElementById('trailer-container');
const tabWatch = document.getElementById('tab-watch');
const tabTrailer = document.getElementById('tab-trailer');

// Video embed sources live in a shared module so the live link-checker
// (check-links.mjs / `npm run check-links`) tests the exact same list the app plays.
import { EMBED_SOURCES, IFRAME_BLOCKED_PROVIDERS, BLOCKED_PROVIDERS } from './embed-sources.js';
import { pickFullscreenTarget, toggleFullscreen, isTypingTarget, isFullscreenKey } from './player-fullscreen.js';
import { buildHelperUrl, resolveHelperKey } from './helper-url.js';
import { isAdoptableLanBase } from './lan-info.mjs';
import { pickNextSource, describeSourceAttempt, describeTvSource, TV_SOURCE_ATTEMPT_CAP } from './tv-fallback.js';
import { absolutePosition, seekTarget, seekToFraction, formatTime } from './torrent-seek.js';
let currentSourceIndex = 0;
// Preferred default source for the player. The TV app opens with ?source=<name>
// (e.g. 111Movies) and it is remembered; falls back to CONFIG.DEFAULT_SOURCE, then
// to the first inline-loadable source. Empty on the web unless configured.
const PREFERRED_SOURCE = (() => {
  try {
    const q = new URLSearchParams(location.search).get('source');
    if (q !== null) { if (q) localStorage.setItem('preferredSource', q); else localStorage.removeItem('preferredSource'); }
    return localStorage.getItem('preferredSource') || (CONFIG.DEFAULT_SOURCE || '');
  } catch { return CONFIG.DEFAULT_SOURCE || ''; }
})();

// TV mode: a webOS TV (or ?tv=1). Its webview drops fetches under load, so the
// per-card enrichment storm (OMDb + providers + credits x hundreds of cards) is
// skipped — it also starved the subtitle/stream fetches. Cards still render from
// TMDB data; only the extra badges are omitted.
const TV_MODE = (() => {
  try {
    if (location.pathname.endsWith('/tv.html')) return true;
    const q = new URLSearchParams(location.search).get('tv');
    if (q !== null) { if (q === '1') localStorage.setItem('tvMode', '1'); else localStorage.removeItem('tvMode'); }
    if (localStorage.getItem('tvMode') === '1') return true;
  } catch { /* ignore */ }
  return /web0?os|smarttv|netcast/i.test(navigator.userAgent || '');
})();

let tvSourceChosenManually = new URLSearchParams(location.search).has('source');

const YOUTUBE_EMBED_URL = 'https://www.youtube.com/embed';

// The YTS torrent source needs the stream helper (stream-server.mjs). It can't run
// on serverless, so it lives either at the SAME origin (local `npm start`) or on a
// separately-hosted helper whose HTTPS base URL is configured.
const IS_LOCAL_HELPER = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/
  .test(location.hostname);

// Resolve the helper base URL. Precedence: ?helper=<url> query param (persisted so
// it's a one-time setup) > localStorage > config.js > same origin ('').
const STREAM_HELPER_BASE = (() => {
  try {
    const q = new URLSearchParams(location.search).get('helper');
    if (q !== null) {
      if (q) localStorage.setItem('streamHelperBase', q.replace(/\/+$/, ''));
      else localStorage.removeItem('streamHelperBase');
    }
    const ls = localStorage.getItem('streamHelperBase');
    if (ls) return ls.replace(/\/+$/, '');
  } catch { /* localStorage may be unavailable */ }
  return (CONFIG.STREAM_HELPER_BASE || '').replace(/\/+$/, '');
})();

// The helper is reachable if we're same-origin local OR a remote base is configured.
const HELPER_AVAILABLE = IS_LOCAL_HELPER || STREAM_HELPER_BASE !== '';

// The helper's access key, when it is published beyond the tailnet (see
// helper-auth.js). Arrives once via ?helperkey=<key> in the shared link and is
// kept in localStorage; every helper URL carries it as ?key=.
const STREAM_HELPER_KEY = resolveHelperKey(location.search, (() => { try { return localStorage; } catch { return null; } })());

// The helper base actually in use. It starts as the configured base (usually the
// Tailscale funnel) but can be upgraded at runtime to a direct LAN address when
// the TV turns out to be on the same network as the helper — the funnel routes
// through a relay that caps throughput below a video bitrate, while a LAN-direct
// hop runs an order of magnitude faster. See upgradeHelperToLan() below.
let activeHelperBase = STREAM_HELPER_BASE;
let lanProbeInFlight = null;

function rememberedLanHelperBase() {
  try {
    const base = localStorage.getItem('streamHelperLanBase') || '';
    return isAdoptableLanBase(base) ? base.replace(/\/+$/, '') : '';
  } catch { return ''; }
}

// Build a helper endpoint URL (prepends the active base; '' = same origin).
const helperUrl = (path) => buildHelperUrl(activeHelperBase, path, STREAM_HELPER_KEY);

// Resolves once the LAN-upgrade probe has finished (or was skipped). Playback
// awaits this so the very first stream already uses the fast path when available.
let helperBaseReady = Promise.resolve();

// Ask the helper for its LAN address and, if this client can actually reach it,
// switch to it. Only ever upgrades funnel/remote → private-LAN http; never the
// reverse. Silent and best-effort: any failure just keeps the configured base.
function upgradeHelperToLan() {
  // Only meaningful when we're pointed at a remote base (the funnel). A same-origin
  // or already-local helper needs no upgrade. Reuse an active probe so playback and
  // startup cannot launch duplicate requests on the TV's constrained webview.
  if (!STREAM_HELPER_BASE || IS_LOCAL_HELPER) return Promise.resolve();
  if (lanProbeInFlight) return lanProbeInFlight;
  lanProbeInFlight = (async () => {
    const candidates = [];
    const remembered = rememberedLanHelperBase();
    if (remembered) candidates.push(remembered);
    try {
      const info = await fetchWithTimeout(buildHelperUrl(STREAM_HELPER_BASE, '/lan-info', STREAM_HELPER_KEY), 8000);
      const { base } = await info.json();
      if (isAdoptableLanBase(base) && !candidates.includes(base)) candidates.push(base);
    } catch { /* a remembered LAN address can still work while the relay is slow */ }
    for (const base of candidates) {
      try {
        const probe = await fetchWithTimeout(buildHelperUrl(base, '/lan-info', STREAM_HELPER_KEY), 4000);
        if (!probe || !probe.ok) continue;
        activeHelperBase = base;
        try { localStorage.setItem('streamHelperLanBase', base); } catch { /* storage unavailable */ }
        console.log('[helper] using LAN-direct base', base);
        return;
      } catch { /* try the next advertised/private address */ }
    }
  })().finally(() => { lanProbeInFlight = null; });
  helperBaseReady = lanProbeInFlight;
  return helperBaseReady;
}

// fetch with an abort timeout (webOS's fetch has no timeout option).
function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal, cache: 'no-store' }).finally(() => clearTimeout(t));
}

// Kick the probe off at load so the fast path is resolved before playback.
if (HELPER_AVAILABLE) upgradeHelperToLan();

// Provider test results storage key
const PROVIDER_RESULTS_KEY = 'providerTestResults';
const PROVIDER_RESULTS_FILE = 'provider-results.json';

// Get provider test results (checks localStorage first, then tries to load from file)
function getProviderTestResults() {
  // First check localStorage for cached results
  try {
    const data = localStorage.getItem(PROVIDER_RESULTS_KEY);
    if (data) {
      const parsed = JSON.parse(data);
      const resultsMap = new Map();

      // Handle array format (from web tester history - use most recent)
      if (Array.isArray(parsed) && parsed.length > 0) {
        const mostRecent = parsed[0];
        if (mostRecent.results && Array.isArray(mostRecent.results)) {
          mostRecent.results.forEach(result => {
            if (result.name && result.playbackRatio !== undefined) {
              resultsMap.set(result.name, Math.round(result.playbackRatio));
            }
          });
        }
      }
      // Handle object format (from CLI tester)
      else if (parsed.results && Array.isArray(parsed.results)) {
        parsed.results.forEach(result => {
          if (result.name && result.playbackRatio !== undefined) {
            resultsMap.set(result.name, Math.round(result.playbackRatio));
          }
        });
      }

      if (resultsMap.size > 0) {
        return resultsMap;
      }
    }
  } catch (error) {
    console.error('Error loading provider test results from localStorage:', error);
  }
  return new Map();
}

// Async function to load provider results from JSON file and sync to localStorage
async function loadProviderResultsFromFile() {
  try {
    const response = await fetch(PROVIDER_RESULTS_FILE);
    if (response.ok) {
      const data = await response.json();
      // Save to localStorage for faster access next time
      localStorage.setItem(PROVIDER_RESULTS_KEY, JSON.stringify(data));
      console.log('Provider test results loaded from file and synced to localStorage');
      // Repopulate source selector with new data
      populateSourceSelector();
    }
  } catch (error) {
    // File doesn't exist or failed to load - that's OK
    console.log('No provider-results.json file found (run npm run test-providers to generate)');
  }
}

// Source selector element
const sourceSelect = document.getElementById('source-select');

// Episode control elements
const episodeControls = document.getElementById('episode-controls');
const seasonSelect = document.getElementById('season-select');
const episodeSelect = document.getElementById('episode-select');
const prevEpisodeBtn = document.getElementById('prev-episode');
const nextEpisodeBtn = document.getElementById('next-episode');

// Current movie being played (for source switching)
let currentPlayingMovie = null;
// IMDb id of the current playback, passed to the helper's /subtitles so it can fall
// back to OpenSubtitles when the torrent itself ships no subtitles (YIFY .mp4s).
let currentSubtitleImdb = '';
let dwellTitleId = null;       // id of the title whose watch session is in progress
let dwellMovie = null;         // its movie object, for committing to watched history
let playerModalOpen = false;   // is the player modal visible?
let activePlayerTab = 'watch'; // 'watch' | 'trailer' — which sub-tab is showing

// A title counts as "watched" only after this much ACTIVE watch-tab time. The player
// embeds cross-origin iframes, so real playback can't be detected — active watch-tab
// time (trailer time and backgrounded-tab time excluded) is the honest proxy.
const WATCHED_DWELL_THRESHOLD_MS = 180000; // 3 minutes

// Tracks active watch-tab time for the current session (see watch-timer.js).
const watchTimer = createWatchTimer();

// Allow tests/debugging to lower the threshold via localStorage; falls back to default.
function watchedThresholdMs() {
  const o = Number(localStorage.getItem('__watchedThresholdMs'));
  return Number.isFinite(o) && o > 0 ? o : WATCHED_DWELL_THRESHOLD_MS;
}

// The main video is "actively watched" only while the modal is open, the Watch tab
// (not the trailer) is showing, and the browser tab is in the foreground.
function isActivelyWatching() {
  return playerModalOpen && !!dwellTitleId && activePlayerTab === 'watch' && !document.hidden;
}

// Re-evaluate the watch timer after any state change (tab switch, visibility, open/close).
function syncWatchTimer() {
  if (isActivelyWatching()) watchTimer.start(Date.now());
  else watchTimer.pause(Date.now());
}

// Persist this session's active watch time and, if it crossed the threshold, commit the
// title to watched history. Idempotent — safe to call on close, reopen, and pagehide.
function flushDwell(options = {}) {
  if (!dwellTitleId) return false;
  const forceWatched = options.forceWatched === true;
  watchTimer.pause(Date.now());
  const watchMs = watchTimer.elapsed(Date.now());
  let changed = watchMs > 0;
  if (watchMs > 0) recordDwell(dwellTitleId, watchMs);
  if (dwellMovie && (forceWatched || watchMs >= watchedThresholdMs())) {
    addToWatchedHistory(dwellMovie);
    changed = true;
  }
  if (changed) clearRecommendationCache();
  watchTimer.reset();
  dwellTitleId = null;
  dwellMovie = null;
  return changed;
}

// Current trailer key
let currentTrailerKey = null;

// TV show episode state
let currentTvData = null;  // Full TV show data with seasons
let currentSeasonData = null;  // Current season's episode data
let currentSeason = 1;
let currentEpisode = 1;

// Watch progress storage key
const WATCH_PROGRESS_KEY = 'tvShowProgress';

// Save watch progress for a TV show
function saveWatchProgress(showId, season, episode) {
  try {
    const progress = JSON.parse(localStorage.getItem(WATCH_PROGRESS_KEY) || '{}');
    // Read-modify-write: this shares the entry with savePlaybackPosition (which
    // stores positionSec/durationSec). Switching episode resets the position to the
    // new episode's start, but must not drop the other fields' shape.
    const prev = progress[showId] || {};
    const changedEpisode = prev.season !== season || prev.episode !== episode;
    progress[showId] = { ...prev, season, episode, timestamp: Date.now() };
    if (changedEpisode) { progress[showId].positionSec = 0; progress[showId].durationSec = 0; }
    localStorage.setItem(WATCH_PROGRESS_KEY, JSON.stringify(progress));
  } catch (error) {
    console.error('Error saving watch progress:', error);
  }
}

// Get watch progress for a TV show
function getWatchProgress(showId) {
  try {
    const progress = JSON.parse(localStorage.getItem(WATCH_PROGRESS_KEY) || '{}');
    return progress[showId] || null;
  } catch (error) {
    console.error('Error loading watch progress:', error);
    return null;
  }
}

// ---- Resume: remember the playback POSITION (seconds), plus the episode for a
// show, so a title can be resumed where it was left off or restarted from scratch.
function savePlaybackPosition() {
  const m = currentPlayingMovie;
  if (!m || m.id == null || !playerModalOpen || !playerVideo) return;
  const pos = Math.floor(absolutePosition(torrentSeekBase, playerVideo.currentTime || 0));
  if (!Number.isFinite(pos) || pos < 5) return; // too early to be worth resuming
  const dur = Math.floor(torrentDuration || playerVideo.duration || 0);
  try {
    const store = JSON.parse(localStorage.getItem(WATCH_PROGRESS_KEY) || '{}');
    const entry = store[m.id] || {};
    // Finished (>95%): clear the position so it starts fresh next time.
    entry.positionSec = (dur && pos > dur * 0.95) ? 0 : pos;
    if (dur) entry.durationSec = dur;
    if (m.media_type === 'tv' || (m.name && !m.title)) { entry.season = currentSeason; entry.episode = currentEpisode; }
    entry.timestamp = Date.now();
    store[m.id] = entry;
    localStorage.setItem(WATCH_PROGRESS_KEY, JSON.stringify(store));
  } catch { /* localStorage full/blocked — resume is best-effort */ }
}

// Resumable info for a title, or null when there's nothing worth resuming (never
// started, only the first few seconds, or already finished).
function getResume(movie) {
  if (!movie || movie.id == null) return null;
  try {
    const e = (JSON.parse(localStorage.getItem(WATCH_PROGRESS_KEY) || '{}'))[movie.id];
    if (!e || !e.positionSec || e.positionSec < 30) return null;
    if (e.durationSec && e.positionSec > e.durationSec * 0.95) return null;
    return e;
  } catch { return null; }
}

// Save the position periodically while watching, and it's also saved on close.
setInterval(() => { if (playerModalOpen) savePlaybackPosition(); }, 8000);
// Finished playing → clear the resume position so it doesn't offer to resume the
// final seconds (matters when the duration was never learned, so the >95% clear in
// savePlaybackPosition couldn't fire).
if (playerVideo) playerVideo.addEventListener('ended', () => {
  const m = currentPlayingMovie;
  if (!m || m.id == null) return;
  const advanceEpisode = playerModalOpen
    && (m.media_type === 'tv' || (m.name && !m.title))
    && currentTvData && currentSeasonData && !nextEpisodeBtn.disabled;
  // Reaching the real media end is authoritative: commit even when this session
  // resumed inside the last three minutes, then rebuild whichever recommendation
  // surface is visible instead of leaving its now-stale cards mounted.
  const committed = flushDwell({ forceWatched: true });
  if (!committed) addToWatchedHistory(m);
  onSignalChanged();
  try {
    const s = JSON.parse(localStorage.getItem(WATCH_PROGRESS_KEY) || '{}');
    if (s[m.id]) { s[m.id].positionSec = 0; localStorage.setItem(WATCH_PROGRESS_KEY, JSON.stringify(s)); }
  } catch { /* best-effort */ }
  if (advanceEpisode) goToNextEpisode().catch((error) => console.error('Could not autoplay the next episode:', error));
});

// Watched history storage key
const WATCHED_HISTORY_KEY = 'watchedHistory';

// Add movie/show to watched history
function addToWatchedHistory(movie) {
  try {
    const history = JSON.parse(localStorage.getItem(WATCHED_HISTORY_KEY) || '[]');
    // Remove if already exists (to update timestamp and move to top)
    const filtered = history.filter(m => m.id !== movie.id);
    // Add to beginning with timestamp
    filtered.unshift({
      ...movie,
      watchedAt: Date.now()
    });
    // Retain the complete history: every watched title contributes to recommendations.
    localStorage.setItem(WATCHED_HISTORY_KEY, JSON.stringify(filtered));
    clearRecommendationCache();
  } catch (error) {
    console.error('Error saving to watched history:', error);
  }
}

// Get watched history
function getWatchedHistory() {
  try {
    return JSON.parse(localStorage.getItem(WATCHED_HISTORY_KEY) || '[]');
  } catch (error) {
    console.error('Error loading watched history:', error);
    return [];
  }
}

// Clear watched history
function clearWatchedHistory() {
  localStorage.removeItem(WATCHED_HISTORY_KEY);
}

// ---- Engagement + star signal stores ----
const TITLE_ENGAGEMENT_KEY = 'titleEngagement';
const STARRED_TITLES_KEY = 'starredTitles';
const DOWNVOTED_TITLES_KEY = 'downvotedTitles';
const SESSION_DWELL_CAP_MS = 10800000; // 3h per session
const TOTAL_DWELL_CAP_MS = 86400000;   // 24h lifetime per title

function getEngagementStore() {
  try { return JSON.parse(localStorage.getItem(TITLE_ENGAGEMENT_KEY) || '{}'); }
  catch { return {}; }
}
function saveEngagementStore(store) {
  try { localStorage.setItem(TITLE_ENGAGEMENT_KEY, JSON.stringify(store)); }
  catch (e) { console.error('engagement save failed:', e); }
}
function recordOpen(id) {
  const s = getEngagementStore();
  const e = s[id] || { dwellMs: 0, episodes: 0, opens: 0, _eps: [] };
  e.opens = (e.opens || 0) + 1;
  e.lastAt = Date.now();
  s[id] = e;
  saveEngagementStore(s);
}
function recordDwell(id, ms) {
  if (!id || !ms || ms <= 0) return;
  const capped = Math.min(ms, SESSION_DWELL_CAP_MS);
  const s = getEngagementStore();
  const e = s[id] || { dwellMs: 0, episodes: 0, opens: 0, _eps: [] };
  e.dwellMs = Math.min((e.dwellMs || 0) + capped, TOTAL_DWELL_CAP_MS);
  e.lastAt = Date.now();
  s[id] = e;
  saveEngagementStore(s);
}
function recordEpisode(id, season, episode) {
  const s = getEngagementStore();
  const e = s[id] || { dwellMs: 0, episodes: 0, opens: 0, _eps: [] };
  const key = `${season}:${episode}`;
  e._eps = e._eps || [];
  if (!e._eps.includes(key)) e._eps.push(key);
  e.episodes = e._eps.length;
  e.lastAt = Date.now();
  s[id] = e;
  saveEngagementStore(s);
}

function getStarredStore() {
  try { return JSON.parse(localStorage.getItem(STARRED_TITLES_KEY) || '{}'); }
  catch { return {}; }
}
function saveStarredStore(store) {
  try { localStorage.setItem(STARRED_TITLES_KEY, JSON.stringify(store)); }
  catch (e) { console.error('starred save failed:', e); }
}
function isStarred(id) {
  return Object.prototype.hasOwnProperty.call(getStarredStore(), id);
}
// The active reaction tier for a title: 'loved' | 'liked' | null. Entries without a
// reaction field predate the tiers and mean 'loved' (back-compat).
function reactionOf(id) {
  const e = getStarredStore()[id];
  return e ? (e.reaction === 'liked' ? 'liked' : 'loved') : null;
}
// Set/toggle a reaction tier for a movie. Clicking the active tier removes it; picking
// the other tier switches in place (keeps the original starredAt so basket order holds).
// Returns the now-active tier or null.
function setReaction(movie, level) {
  const store = getStarredStore();
  const existing = store[movie.id];
  if (existing && (existing.reaction === 'liked' ? 'liked' : 'loved') === level) {
    delete store[movie.id];
    saveStarredStore(store);
    clearRecommendationCache();
    return null;
  }
  // Remove from downvoted if present — mutually exclusive with the basket.
  const downvoted = getDownvotedStore();
  if (Object.prototype.hasOwnProperty.call(downvoted, movie.id)) {
    delete downvoted[movie.id];
    saveDownvotedStore(downvoted);
  }
  store[movie.id] = {
    ...signalSnapshot(movie),
    reaction: level,
    starredAt: existing?.starredAt || Date.now(),
  };
  saveStarredStore(store);
  clearRecommendationCache();
  return level;
}
// Legacy star toggle = the 'loved' tier; returns the new starred state (player header uses it).
function toggleStar(movie) {
  return setReaction(movie, 'loved') !== null;
}
function getStarredList() {
  const store = getStarredStore();
  return Object.values(store).sort((a, b) => (b.starredAt || 0) - (a.starredAt || 0));
}

function getDownvotedStore() {
  try { return JSON.parse(localStorage.getItem(DOWNVOTED_TITLES_KEY) || '{}'); }
  catch { return {}; }
}
function saveDownvotedStore(store) {
  try { localStorage.setItem(DOWNVOTED_TITLES_KEY, JSON.stringify(store)); }
  catch (e) { console.error('downvoted save failed:', e); }
}
function isDownvoted(id) {
  return Object.prototype.hasOwnProperty.call(getDownvotedStore(), id);
}
// Snapshot of a title for a signal store (basket or downvoted). Mirrors the star payload.
function signalSnapshot(movie) {
  return {
    id: movie.id,
    media_type: movie.media_type || (movie.title ? 'movie' : 'tv'),
    genre_ids: movie.genre_ids || [],
    vote_average: movie.vote_average,
    title: movie.title,
    name: movie.name,
    poster_path: movie.poster_path,
    release_date: movie.release_date,
    first_air_date: movie.first_air_date,
    overview: movie.overview,
  };
}
// Toggle downvote for a movie; returns the new downvoted state. Mutually exclusive with star.
function toggleDownvote(movie) {
  const store = getDownvotedStore();
  if (Object.prototype.hasOwnProperty.call(store, movie.id)) {
    delete store[movie.id];
    saveDownvotedStore(store);
    clearRecommendationCache();
    return false;
  }
  // Remove from basket if present — a title is in at most one of {basket, downvoted}.
  const starred = getStarredStore();
  if (Object.prototype.hasOwnProperty.call(starred, movie.id)) {
    delete starred[movie.id];
    saveStarredStore(starred);
  }
  store[movie.id] = { ...signalSnapshot(movie), downvotedAt: Date.now() };
  saveDownvotedStore(store);
  clearRecommendationCache();
  return true;
}
function getDownvotedList() {
  const store = getDownvotedStore();
  return Object.values(store).sort((a, b) => (b.downvotedAt || 0) - (a.downvotedAt || 0));
}

// "Seen it" — watched outside the app. Feeds the profile at neutral weight and keeps
// the title out of recommendations. Independent of reactions/downvotes.
const SEEN_TITLES_KEY = 'seenTitles';
function getSeenStore() {
  try { return JSON.parse(localStorage.getItem(SEEN_TITLES_KEY) || '{}'); }
  catch { return {}; }
}
function saveSeenStore(store) {
  try { localStorage.setItem(SEEN_TITLES_KEY, JSON.stringify(store)); }
  catch (e) { console.error('seen save failed:', e); }
}
function isSeen(id) {
  return Object.prototype.hasOwnProperty.call(getSeenStore(), id);
}
function toggleSeen(movie) {
  const store = getSeenStore();
  if (Object.prototype.hasOwnProperty.call(store, movie.id)) {
    delete store[movie.id];
    saveSeenStore(store);
    clearRecommendationCache();
    return false;
  }
  store[movie.id] = { ...signalSnapshot(movie), seenAt: Date.now() };
  saveSeenStore(store);
  clearRecommendationCache();
  return true;
}
function getSeenList() {
  return Object.values(getSeenStore()).sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
}

// Row-level "not interested": dismissed rec-row keys, persisted. The engine skips
// dismissed rows entirely and lets their items flow into other rows.
const DISMISSED_ROWS_KEY = 'dismissedRecRows';
function getDismissedRows() {
  try { return Object.keys(JSON.parse(localStorage.getItem(DISMISSED_ROWS_KEY) || '{}')); }
  catch { return []; }
}
function dismissRow(key) {
  try {
    const store = JSON.parse(localStorage.getItem(DISMISSED_ROWS_KEY) || '{}');
    store[key] = Date.now();
    localStorage.setItem(DISMISSED_ROWS_KEY, JSON.stringify(store));
  } catch (e) { console.error('dismiss save failed:', e); }
}

// Profile import: a #import=<base64url> hash seeds the signal stores (basket / seen /
// downvoted) in one visit. localStorage is per-browser and per-origin, so this is the
// only way a taste profile built elsewhere can arrive here. Existing user signals win
// over the payload; the hash is cleared afterwards so refresh/share doesn't re-import.
// Returns null when no valid import happened (no hash / malformed), else the number of
// titles added (0 for a re-import where everything was already present).
function handleProfileImportFromHash() {
  const match = window.location.hash.match(/^#import=(.+)$/);
  if (!match) return null;
  const payload = decodeImportPayload(match[1]);
  history.replaceState(null, '', window.location.pathname + window.location.search);
  if (!payload) {
    console.error('profile import: malformed payload, ignoring');
    return null;
  }
  const merged = mergeImportIntoStores(payload, {
    starred: getStarredStore(),
    downvoted: getDownvotedStore(),
    seen: getSeenStore(),
  }, Date.now());
  if (merged.added > 0) {
    saveStarredStore(merged.starred);
    saveDownvotedStore(merged.downvoted);
    saveSeenStore(merged.seen);
    clearRecommendationCache();
  }
  console.log(`profile import: ${merged.added} titles added`);
  return merged.added;
}

// Assemble every signal the engine consumes. Watched titles are full positive-profile
// inputs (with recency and engagement), not merely ids to exclude from the output.
function buildSignalItems() {
  const seen = getSeenList();
  const watched = getWatchedHistory();
  const engagement = getEngagementStore();
  const watchedForProfile = watched.map((movie) => ({
    ...movie,
    _engagement: engagement[movie.id] || null,
  }));
  return {
    basket: getStarredList(),
    downvoted: getDownvotedList(),
    watched: watchedForProfile,
    watchedIds: [...watched.map((m) => m.id), ...seen.map((m) => m.id)],
    seen,
  };
}

// Populate source selector with test results percentages
function populateSourceSelector() {
  sourceSelect.innerHTML = '';

  // The dropdown mirrors EMBED_SOURCES order, which is a curated best -> worst
  // ranking (see embed-sources.js). We no longer re-sort by provider-results.json:
  // that data came from the old headless tester which now hits provider anti-bot
  // and reports everything as failed, so it ranked good sources as bad.

  // Torrent sources (e.g. YTS) are movies-only; hide them when playing TV.
  const isTvNow = currentPlayingMovie?.media_type === 'tv';

  let firstUsableIndex = null;

  const orderedSources = EMBED_SOURCES.map((source, index) => ({ source, index }));
  // Torrent sources first on TV: they are the reliable default (no provider bot-checks).
  if (TV_MODE) orderedSources.sort((a, b) => Number(!!b.source.torrent) - Number(!!a.source.torrent));
  orderedSources.forEach(({ source, index }) => {
    // Skip completely blocked/dead providers.
    if (BLOCKED_PROVIDERS.includes(source.name)) return;

    // Torrent sources need the stream helper (stream-server.mjs), which can't run
    // on serverless. Offer them only when a helper is reachable: same-origin local
    // (`npm start`) or a configured remote helper base (CONFIG.STREAM_HELPER_BASE /
    // ?helper= / localStorage). Otherwise they'd just error "can't reach the helper".
    if (source.torrent) {
      if (!HELPER_AVAILABLE) return;
      if (source.movieOnly && isTvNow) return;
      if (source.tvOnly && !isTvNow) return;
      const option = document.createElement('option');
      option.value = index;
      option.textContent = source.name;
      sourceSelect.appendChild(option);
      return;
    }

    const isNewTab = IFRAME_BLOCKED_PROVIDERS.includes(source.name);
    const option = document.createElement('option');
    option.value = index;
    option.textContent = `${source.name}${isNewTab ? ' ↗' : ''}`;
    if (isNewTab) option.dataset.newTab = 'true';
    sourceSelect.appendChild(option);

    // Default = first shown source that loads inline (best-ranked, iframe-loadable).
    if (firstUsableIndex === null && !isNewTab) firstUsableIndex = index;
  });

  // Keep the current TV source when rebuilding options.
  if (TV_MODE && currentPlayingMovie && sourceSelect.querySelector(`option[value="${currentSourceIndex}"]`)) {
    sourceSelect.value = currentSourceIndex;
    return;
  }

  // Honour the preferred source when it exists in the list for this title and
  // loads inline (not a new-tab-only provider).
  if (PREFERRED_SOURCE && (!TV_MODE || tvSourceChosenManually)) {
    const pi = EMBED_SOURCES.findIndex((sc) => sc && sc.name === PREFERRED_SOURCE);
    const opt = pi >= 0 ? sourceSelect.querySelector(`option[value="${pi}"]`) : null;
    if (pi >= 0 && ((opt && opt.dataset.newTab !== 'true') || (TV_MODE && !currentPlayingMovie && HELPER_AVAILABLE && EMBED_SOURCES[pi].tvOnly))) firstUsableIndex = pi;
  }
  // Don't let the first inline embed clobber the torrent default openPlayer chose:
  // with dead embeds, the desktop app should open onto the torrent source too, not
  // just the TV app. Only preserve an UNMANUAL torrent default that's in the list.
  const keepingTorrentDefault = !tvSourceChosenManually && HELPER_AVAILABLE
    && EMBED_SOURCES[currentSourceIndex]?.torrent
    && sourceSelect.querySelector(`option[value="${currentSourceIndex}"]`);
  if (firstUsableIndex !== null && !keepingTorrentDefault) currentSourceIndex = firstUsableIndex;
  sourceSelect.value = currentSourceIndex;
}

// State
let allMovies = [];  // Store all fetched movies (unfiltered)
let filteredMovies = []; // Store filtered & sorted movies
let displayedCount = 0;  // How many movies currently displayed
let isLoadingMore = false; // Prevent multiple simultaneous loads
let currentApiPage = 0;  // Current API page fetched
let hasMorePages = true; // Whether more API pages exist
const ITEMS_PER_PAGE = 1000; // Movies to load per scroll
const seenIds = new Set(); // Track seen movie IDs to prevent duplicates

let currentFilters = {
  mediaType: 'all',
  genre: 0,
  genreIsKeyword: false,  // True if selected genre is actually a keyword filter
  minRating: 0,  // Default to all ratings
  minVotes: 0,   // Default to all votes
  yearFilter: 'all',  // 'all', 'newest', 'oldest', or year number like '2024'
  language: '',  // ISO 639-1 language code (e.g., 'en', 'es', 'ja')
  sortBy: 'weighted',
  theme: 0,      // Theme keyword ID (space, future, dystopia, etc.)
  excludeGenres: [],  // Array of genre IDs to exclude (e.g., [16, 878, 27] for Animation, Sci-Fi, Horror)
  provider: 0,
  actorId: 0,    // TMDB person ID for actor filter
  actorName: ''  // Actor name for display
};

// Store genre metadata for keyword detection
let genreMetadata = new Map();

let isSearchMode = false; // Track if we're showing search results
let isTop250Mode = false; // Track if we're showing Top 250

// URL query params helper
function getQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const excludeStr = params.get('exclude') || '';
  return {
    type: params.get('type') || 'all',
    genre: parseInt(params.get('genre'), 10) || 0,
    rating: parseInt(params.get('rating'), 10) || 0,
    votes: parseInt(params.get('votes'), 10) || 0,
    year: params.get('year') || 'all',
    language: params.get('lang') || '',
    sort: params.get('sort') || 'weighted',
    provider: parseInt(params.get('provider'), 10) || 0,
    theme: parseInt(params.get('theme'), 10) || 0,
    exclude: excludeStr ? excludeStr.split(',').map(id => parseInt(id, 10)) : [],
    search: params.get('q') || ''
  };
}

function updateQueryParams() {
  const params = new URLSearchParams();

  if (currentFilters.mediaType !== 'all') {
    params.set('type', currentFilters.mediaType);
  }
  if (currentFilters.genre !== 0) {
    params.set('genre', currentFilters.genre);
  }
  if (currentFilters.minRating !== 0) {
    params.set('rating', currentFilters.minRating);
  }
  if (currentFilters.minVotes !== 0) {
    params.set('votes', currentFilters.minVotes);
  }
  if (currentFilters.yearFilter !== 'all') {
    params.set('year', currentFilters.yearFilter);
  }
  if (currentFilters.language) {
    params.set('lang', currentFilters.language);
  }
  if (currentFilters.sortBy !== 'weighted') {
    params.set('sort', currentFilters.sortBy);
  }
  if (currentFilters.provider !== 0) {
    params.set('provider', currentFilters.provider);
  }
  if (currentFilters.theme !== 0) {
    params.set('theme', currentFilters.theme);
  }
  if (currentFilters.excludeGenres.length > 0) {
    params.set('exclude', currentFilters.excludeGenres.join(','));
  }
  if (search.value.trim()) {
    params.set('q', search.value.trim());
  }

  const newUrl = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;

  window.history.replaceState({}, '', newUrl);
}

// Cache for API responses
const cache = {
  trending: null,
  timestamp: null
};

// Cache for OMDb ratings (Rotten Tomatoes)
const omdbCache = new Map();

// Cache for watch providers
const providersCache = new Map();

// Cache for credits (director info)
const creditsCache = new Map();

// Fetch watch providers for a movie/show
async function fetchWatchProviders(type, id) {
  const cacheKey = `${type}-${id}`;

  if (providersCache.has(cacheKey)) {
    return providersCache.get(cacheKey);
  }

  try {
    const data = await fetchTmdbJson(ENDPOINTS.watchProviders(type, id));

    // Get US providers (or fallback to first available country)
    const results = data.results;
    const regionData = results?.US || results?.GB || Object.values(results || {})[0];

    if (regionData) {
      // Combine flatrate (streaming) providers
      const streaming = regionData.flatrate || [];
      const providers = streaming.slice(0, 3).map(p => ({
        id: p.provider_id,
        name: p.provider_name,
        logo: `https://image.tmdb.org/t/p/w45${p.logo_path}`
      }));

      providersCache.set(cacheKey, { display: providers, allIds: streaming.map(p => p.provider_id) });
      return { display: providers, allIds: streaming.map(p => p.provider_id) };
    }
  } catch (error) {
    console.error('Watch providers fetch error:', error);
  }

  providersCache.set(cacheKey, null);
  return null;
}

// Fetch credits (director/creator info) for a movie/show
async function fetchCredits(type, id) {
  const cacheKey = `${type}-${id}`;

  if (creditsCache.has(cacheKey)) {
    return creditsCache.get(cacheKey);
  }

  try {
    const data = await fetchTmdbJson(ENDPOINTS.credits(type, id));

    // For movies, find the director from crew
    // For TV shows, find the creator or showrunner
    let director = null;

    if (type === 'movie') {
      const directors = data.crew?.filter(p => p.job === 'Director') || [];
      director = directors.map(d => d.name).slice(0, 2).join(', ');
    } else {
      // For TV, look for created_by or Executive Producer
      const creators = data.crew?.filter(p =>
        p.job === 'Executive Producer' || p.job === 'Creator'
      ) || [];
      director = creators.map(c => c.name).slice(0, 2).join(', ');
    }

    creditsCache.set(cacheKey, director || null);
    return director || null;
  } catch (error) {
    console.error('Credits fetch error:', error);
  }

  creditsCache.set(cacheKey, null);
  return null;
}

// Search for actors by name
async function searchActors(query) {
  if (!query || query.length < 2) return [];

  try {
    const data = await fetchTmdbJson(ENDPOINTS.searchPerson(query));

    // Filter to only actors (known_for_department === 'Acting')
    return (data.results || [])
      .filter(person => person.known_for_department === 'Acting')
      .slice(0, 8)
      .map(person => ({
        id: person.id,
        name: person.name,
        profile_path: person.profile_path,
        known_for: person.known_for?.slice(0, 2).map(m => m.title || m.name).join(', ') || ''
      }));
  } catch (error) {
    console.error('Actor search error:', error);
    return [];
  }
}

// Fetch movies/shows by actor
async function fetchByActor(actorId, mediaType = 'all') {
  const movies = [];
  const seenActorIds = new Set();

  try {
    // Fetch movie credits
    if (mediaType === 'all' || mediaType === 'movie') {
      const movieData = await fetchTmdbJson(ENDPOINTS.personMovieCredits(actorId)).catch(() => null);
      if (movieData) {
        (movieData.cast || []).forEach(movie => {
          if (!seenActorIds.has(movie.id)) {
            seenActorIds.add(movie.id);
            movies.push({ ...movie, media_type: 'movie' });
          }
        });
      }
    }

    // Fetch TV credits
    if (mediaType === 'all' || mediaType === 'tv') {
      const tvData = await fetchTmdbJson(ENDPOINTS.personTvCredits(actorId)).catch(() => null);
      if (tvData) {
        (tvData.cast || []).forEach(show => {
          if (!seenActorIds.has(show.id)) {
            seenActorIds.add(show.id);
            movies.push({ ...show, media_type: 'tv' });
          }
        });
      }
    }
  } catch (error) {
    console.error('Error fetching actor filmography:', error);
  }

  return movies;
}

// Display actor suggestions
function displayActorSuggestions(actors) {
  if (actors.length === 0) {
    actorSuggestions.classList.remove('show');
    actorSuggestions.innerHTML = '';
    return;
  }

  actorSuggestions.innerHTML = actors.map(actor => `
    <div class="actor-suggestion" data-id="${actor.id}" data-name="${actor.name}">
      <img src="${actor.profile_path ? 'https://image.tmdb.org/t/p/w45' + actor.profile_path : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' fill='%23333'/><text x='50%25' y='55%25' fill='%23aaa' font-size='18' text-anchor='middle' font-family='sans-serif'>?</text></svg>"}" alt="${actor.name}">
      <div class="actor-suggestion-info">
        <span class="actor-suggestion-name">${actor.name}</span>
        <span class="actor-suggestion-known">${actor.known_for}</span>
      </div>
    </div>
  `).join('');

  actorSuggestions.classList.add('show');

  // Add click handlers
  actorSuggestions.querySelectorAll('.actor-suggestion').forEach(el => {
    el.addEventListener('click', () => {
      selectActor(parseInt(el.dataset.id), el.dataset.name);
    });
  });
}

// Select an actor and filter
async function selectActor(actorId, actorName) {
  currentFilters.actorId = actorId;
  currentFilters.actorName = actorName;

  actorSearchInput.value = actorName;
  actorSearchInput.classList.add('has-value');
  actorIdInput.value = actorId;
  clearActorBtn.style.display = 'flex';
  actorSuggestions.classList.remove('show');

  // Load movies by this actor
  await loadByActor();
}

// Clear actor filter
function clearActorFilter() {
  currentFilters.actorId = 0;
  currentFilters.actorName = '';

  actorSearchInput.value = '';
  actorSearchInput.classList.remove('has-value');
  actorIdInput.value = '';
  clearActorBtn.style.display = 'none';
  actorSuggestions.classList.remove('show');

  // Reload trending
  loadTrending();
}

// Load movies/shows by actor
async function loadByActor() {
  document.getElementById('recommendations-row')?.remove();
  if (!currentFilters.actorId) return;

  try {
    setLoading(true);
    hideError();
    resetFetchState();
    isSearchMode = false;
    isTop250Mode = false;
    top250Btn.classList.remove('active');

    const movies = await fetchByActor(currentFilters.actorId, effectiveMediaType());
    allMovies = movies;
    hasMorePages = false; // All results loaded at once for actor filter

    await processAndDisplayMovies(allMovies);
  } catch (error) {
    console.error('Error loading actor filmography:', error);
    showError('Failed to load filmography. Please try again.');
  } finally {
    setLoading(false);
  }
}

// Return the real IMDb Top 250 snapshot, already resolved to TMDB card metadata.
// Keeping this local avoids 250 searches every time the TV opens the collection
// and, unlike TMDB's /movie/top_rated feed, preserves IMDb's exact rank order.
async function fetchTop250() {
  return IMDB_TOP_250.map(movie => ({ ...movie }));
}

// Load Top 250 movies
async function loadTop250() {
  document.getElementById('recommendations-row')?.remove();
  try {
    setLoading(true);
    hideError();
    resetFetchState();
    isSearchMode = false;
    isTop250Mode = true;
    top250Btn.classList.add('active');

    // Clear actor filter if active
    if (currentFilters.actorId) {
      currentFilters.actorId = 0;
      currentFilters.actorName = '';
      actorSearchInput.value = '';
      actorSearchInput.classList.remove('has-value');
      actorIdInput.value = '';
      clearActorBtn.style.display = 'none';
    }

    // Clear search
    search.value = '';

    const movies = await fetchTop250();
    allMovies = movies;
    hasMorePages = false; // All 250 loaded at once

    await processAndDisplayMovies(allMovies);
  } catch (error) {
    console.error('Error loading Top 250:', error);
    showError('Failed to load Top 250. Please try again.');
  } finally {
    setLoading(false);
  }
}

// Write-through for the OMDB cache: the free tier is 1000 req/day, so page
// reloads must not re-spend quota. 24h TTL keeps young titles' ratings fresh.
function persistOmdbEntry(cacheKey, value) {
  try {
    localStorage.setItem(`omdb:${cacheKey}`, JSON.stringify({ t: Date.now(), v: value }));
  } catch (e) { /* quota/private mode: in-memory cache still applies */ }
}

// Fetch OMDb data for a movie (includes RT ratings)
async function fetchOmdbData(title, year, type) {
  // Skip if no API key configured
  if (!CONFIG.OMDB_API_KEY) {
    return null;
  }

  const cacheKey = `${title}-${year}`;

  if (omdbCache.has(cacheKey)) {
    return omdbCache.get(cacheKey);
  }

  try {
    const stored = localStorage.getItem(`omdb:${cacheKey}`);
    if (stored) {
      const { t, v } = JSON.parse(stored);
      // 7-day TTL (was 24h): IMDb/RT ratings drift weekly at most, and the free tier's
      // 1000 req/day quota is the scarcer resource.
      if (Date.now() - t < 7 * 24 * 60 * 60 * 1000) {
        omdbCache.set(cacheKey, v);
        return v;
      }
    }
  } catch (e) { /* private mode or corrupted entry: fall through to network */ }

  try {
    const mediaType = type === 'tv' ? 'series' : 'movie';
    const url = `${CONFIG.OMDB_BASE_URL}/?apikey=${CONFIG.OMDB_API_KEY}&t=${encodeURIComponent(title)}&y=${year}&type=${mediaType}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.Response === 'True') {
      const rtRating = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
      const imdbRating = data.imdbRating !== 'N/A' ? parseFloat(data.imdbRating) : null;
      const rtScore = rtRating ? parseInt(rtRating.Value) : null; // e.g., "85%" -> 85
      const imdbVotes = data.imdbVotes && data.imdbVotes !== 'N/A' ? parseInt(data.imdbVotes.replace(/,/g, ''), 10) : null;

      const result = {
        imdbRating,
        imdbVotes,
        rtScore,
        imdbId: data.imdbID,
        metascore: data.Metascore !== 'N/A' ? parseInt(data.Metascore) : null
      };

      omdbCache.set(cacheKey, result);
      persistOmdbEntry(cacheKey, result);
      return result;
    }

    // Definitive not-found: persist so we don't re-spend quota on it for 24h.
    omdbCache.set(cacheKey, null);
    persistOmdbEntry(cacheKey, null);
    return null;
  } catch (error) {
    console.error('OMDb fetch error:', error);
  }

  // Transient error (network/throttle): remember for this session only, so the
  // next visit retries instead of pinning a false null for a day.
  omdbCache.set(cacheKey, null);
  return null;
}

// Fetch RT ratings and watch providers for a batch of movies
async function enrichMoviesWithRatings(movies) {
  if (TV_MODE) return movies;   // no per-card fetch storm on webOS
  const promises = movies.map(async (movie) => {
    const title = movie.title || movie.name;
    const year = (movie.release_date || movie.first_air_date || '').split('-')[0];
    const type = movie.media_type;

    // Fetch OMDb data (RT ratings)
    if (title && year) {
      const omdbData = await fetchOmdbData(title, year, type);
      if (omdbData) {
        movie.rtScore = omdbData.rtScore;
        movie.imdbRating = omdbData.imdbRating;
        movie.imdbVotes = omdbData.imdbVotes;
        movie.metascore = omdbData.metascore;
      }
    }

    // Fetch watch providers
    if (type && movie.id) {
      const providers = await fetchWatchProviders(type, movie.id);
      if (providers && providers.display && providers.display.length > 0) {
        movie.providers = providers.display;
        movie.providerIds = providers.allIds;
      }
    }

    // Fetch credits (director info)
    if (type && movie.id) {
      const director = await fetchCredits(type, movie.id);
      if (director) {
        movie.director = director;
      }
    }

    return movie;
  });

  return Promise.all(promises);
}

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Fetch trailers from TMDB
async function fetchTrailers(type, id) {
  try {
    const data = await fetchTmdbJson(ENDPOINTS.videos(type, id));

    // Find YouTube trailers, prefer official ones
    const trailers = data.results?.filter(
      v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')
    ) || [];

    // Sort: official first, then by name
    trailers.sort((a, b) => {
      if (a.official && !b.official) return -1;
      if (!a.official && b.official) return 1;
      if (a.type === 'Trailer' && b.type !== 'Trailer') return -1;
      if (a.type !== 'Trailer' && b.type === 'Trailer') return 1;
      return 0;
    });

    return trailers[0]?.key || null;
  } catch (error) {
    console.error('Error fetching trailers:', error);
    return null;
  }
}

// Switch tabs
function switchTab(tab) {
  if (tab === 'watch') {
    tabWatch.classList.add('active');
    tabTrailer.classList.remove('active');
    watchContainer.style.display = 'block';
    trailerContainer.style.display = 'none';
    // Pause trailer when switching away
    trailerIframe.src = '';
    activePlayerTab = 'watch';
  } else if (tab === 'trailer' && currentTrailerKey) {
    tabTrailer.classList.add('active');
    tabWatch.classList.remove('active');
    trailerContainer.style.display = 'block';
    watchContainer.style.display = 'none';
    trailerIframe.src = `${YOUTUBE_EMBED_URL}/${currentTrailerKey}?autoplay=1`;
    // Pause main player when switching away
    playerIframe.src = '';
    if (playerVideo) { try { playerVideo.pause(); } catch { /* ignore */ } }
    activePlayerTab = 'trailer';
  }
  // Only watch-tab time counts toward "watched"; pause the timer on the trailer tab.
  syncWatchTimer();
}

// Open video player modal
// Get embed URL for current source (with optional season/episode for TV)
function getEmbedUrl(type, id, season = null, episode = null) {
  const source = EMBED_SOURCES[currentSourceIndex];
  return source.getUrl(type, id, season, episode);
}

// Load URL into iframe (handles blocked providers)
function loadIframeSrc(url) {
  // Any iframe load means we're not on the YTS torrent source — tear down the
  // native player and stop the local torrent so peers aren't held open.
  showPlayerVideo(false);
  stopYtsStream();
  const source = EMBED_SOURCES[currentSourceIndex];
  playerIframe.removeAttribute('srcdoc');
  playerIframe.removeAttribute('data-provider-origin');
  playerIframe.removeAttribute('sandbox');
  if (TV_MODE && HELPER_AVAILABLE && source.name === '111Movies') playerIframe.dataset.providerOrigin = 'https://player.vidlove.cc';
  if (IFRAME_BLOCKED_PROVIDERS.includes(source.name)) {
    window.open(url, '_blank');
    playerIframe.srcdoc = `
      <html>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#fff;font-family:sans-serif;text-align:center;">
          <div>
            <p style="font-size:1.2rem;">Opened in new tab ↗</p>
            <p style="color:#888;font-size:0.9rem;">${source.name} doesn't allow embedding</p>
          </div>
        </body>
      </html>
    `;
  } else {
    playerIframe.removeAttribute('srcdoc');
    playerIframe.src = url;
  }
}

// ---- YTS torrent source (native <video> via local helper) ----

let playbackGeneration = 0;
let hlsSessionId = null;
let hlsController = null;
let playbackHealthTimer = null;
let connectionHealthTimer = null;
// A manually selected torrent may need several minutes to discover a reachable
// peer. Automatic selection uses short deadlines so it can reach alternatives.
const TORRENT_EXTRA_STARTUP_MS = 5 * 60 * 1000;
const TV_HLS = TV_MODE && !!playerVideo?.canPlayType('application/vnd.apple.mpegurl');

function clearPlaybackHealth() {
  clearInterval(playbackHealthTimer);
  playbackHealthTimer = null;
  clearInterval(connectionHealthTimer);
  connectionHealthTimer = null;
}

// Index seed counts do NOT predict real connectivity: a "227-seed" torrent can pull
// 0 peers/0 bytes while an "88-seed" one screams at 5 MB/s. So before a source has
// produced any video, watch its ACTUAL swarm and abandon it fast when it is plainly
// dead (no peers, or peers but no data), letting the cascade reach a live source
// instead of burning the full startup window on each dud. Once playback begins this
// bows out and watchPlaybackHealth takes over.
function watchConnectionHealth(hash, recover, { noPeersMs = 13000, noDataMs = 22000, slowMs = 20000, minSustainBps = 700 * 1024, debrid = false } = {}) {
  clearInterval(connectionHealthTimer);
  // A debrid source is a cached HTTP file with no swarm — /stream-status reports it as
  // idle (0 peers), so the swarm-based dead/slow checks would always fire and cascade
  // away from a perfectly good file. There's nothing to watch here; let playback health
  // handle a genuine stall.
  if (debrid) return;
  const startedAt = Date.now();
  let maxProgress = 0;
  let maxSpeed = 0;
  connectionHealthTimer = setInterval(async () => {
    if (currentTorrentHash !== hash || !playerModalOpen) { clearInterval(connectionHealthTimer); return; }
    if (playerVideo.currentTime > 0.25) { clearInterval(connectionHealthTimer); return; } // playing — hand off
    let s;
    try { s = await fetch(helperUrl(`/stream-status?hash=${hash}`)).then((r) => r.json()); } catch { return; }
    if (currentTorrentHash !== hash) return;
    maxProgress = Math.max(maxProgress, s.progress || 0);
    maxSpeed = Math.max(maxSpeed, s.downloadSpeed || 0);
    const elapsed = Date.now() - startedAt;
    // Dead: no peers, or peers but no bytes. Too-slow: it connected and pulled data
    // but its PEAK rate can't sustain 1080p — waiting on it just buffers forever, so
    // move to a faster source (peak, not instantaneous, so one that ramps up is kept).
    const dead = (elapsed > noPeersMs && (s.peers || 0) === 0)
      || (elapsed > noDataMs && maxProgress <= 0.0005);
    const tooSlow = elapsed > slowMs && maxSpeed > 0 && maxSpeed < minSustainBps;
    if (dead || tooSlow) { clearInterval(connectionHealthTimer); recover(); }
  }, 2000);
}
let hlsKeepAlive = null;
// Ping the session's playlist while the player is open so a PAUSED (fully-buffered)
// stream isn't idle-swept out from under the viewer — reading the m3u8 refreshes the
// session's last-access clock. Without this, pausing for a while wedged playback.
function startHlsKeepAlive(id) {
  clearInterval(hlsKeepAlive);
  hlsKeepAlive = setInterval(() => {
    if (hlsSessionId !== id || !playerModalOpen) { clearInterval(hlsKeepAlive); hlsKeepAlive = null; return; }
    fetch(helperUrl(`/hls/${id}/index.m3u8`)).catch(() => {});
  }, 30000);
}
function stopHlsSession() {
  clearInterval(hlsKeepAlive);
  hlsKeepAlive = null;
  hlsController?.abort();
  hlsController = null;
  if (hlsSessionId) {
    const id = hlsSessionId;
    hlsSessionId = null;
    fetch(helperUrl(`/hls/stop?id=${id}`), { keepalive: true }).catch(() => {});
  }
}
function watchPlaybackHealth(recover, { startupMs = 30000, stallMs = 30000, source = null } = {}) {
  clearPlaybackHealth();
  let health = null;
  let starvation = null;
  let statusBusy = false;
  let lastStatusAt = 0;
  let started = false;
  playbackHealthTimer = setInterval(async () => {
    if (!currentTorrentHash || !playerModalOpen) return;
    if (playerVideo.currentTime > 0.25) started = true;
    const now = Date.now();
    // Before the first frame, allow a longer window (startupMs): a transcode source
    // must download AND transcode, and its swarm may still be ramping up peers —
    // abandoning it here would drop the best source for a dead one. Once playing,
    // fall back to the tighter stall window.
    health = playbackHealth(health, { now, time: playerVideo.currentTime, paused: playerVideo.paused, started, timeoutMs: started ? stallMs : startupMs });
    if (health.stalled) { clearPlaybackHealth(); recover(); return; }

    // Once duration is known, compare the source's real byte rate with its average
    // bitrate. A low readyState + under-two-second buffer sustained while download
    // speed is below the required rate predicts a stall, so move to the next ranked
    // source before the picture freezes. Debrid has no torrent status to inspect.
    if (!started || !source?.sizeBytes || source.debrid || !torrentDuration || statusBusy || now - lastStatusAt < 3000) return;
    lastStatusAt = now;
    statusBusy = true;
    const hash = currentTorrentHash;
    try {
      const status = await fetch(helperUrl(`/stream-status?hash=${hash}`)).then((r) => r.json());
      if (hash !== currentTorrentHash || !playerModalOpen) return;
      let bufferedSeconds = 0;
      if (playerVideo.buffered?.length) bufferedSeconds = Math.max(0, playerVideo.buffered.end(playerVideo.buffered.length - 1) - playerVideo.currentTime);
      starvation = bufferRecovery(starvation, {
        now: Date.now(), bufferedSeconds, readyState: playerVideo.readyState,
        paused: playerVideo.paused, downloadSpeed: status.downloadSpeed,
        requiredSpeed: Number(source.sizeBytes) / torrentDuration,
      });
      if (starvation.recover) { clearPlaybackHealth(); recover(); }
    } catch { /* the normal stall timer remains authoritative if status is unavailable */ }
    finally { statusBusy = false; }
  }, 1000);
}
async function prepareTvHls(hash, season, episode, src, startSec, recover, startupExtraMs = 0) {
  // Retry LAN discovery at playback time when the one-shot startup probe failed.
  // Persisted addresses are tested first, so normal playback avoids the relay and
  // does not wait for its slower public /lan-info response.
  try {
    if (activeHelperBase === STREAM_HELPER_BASE) await upgradeHelperToLan();
    else await helperBaseReady;
  } catch { /* keep configured base */ }
  stopHlsSession();
  clearPlaybackHealth();
  const controller = hlsController = new AbortController();
  const generation = playbackGeneration;
  const streamUrl = new URL(buildTvStreamUrl(hash, season, episode, src, startSec, 12000 + startupExtraMs), location.href);
  streamUrl.pathname = '/hls/start';
  // For an HEVC source, tell /hls/start to GPU-transcode into the HLS pipeline
  // (segmented files stream through the funnel; a live /transcode response does not).
  if (src?.transcode) streamUrl.searchParams.set('transcode', '1');
  setYtsStatus(startSec > 0 ? 'Preparing your selected position…' : 'Preparing playback…');
  // /hls/start can block for a long time on a dead swarm; watch the actual peers
  // and cascade fast if there is nothing to download (recover aborts this fetch).
  // A transcode source only needs the HEVC input bitrate (~300 KB/s), so hold it to
  // a lower "sustain" bar than a direct 1080p stream, and give it a touch longer.
  watchConnectionHealth(hash, recover, {
    noPeersMs: 13000 + startupExtraMs,
    noDataMs: 22000 + startupExtraMs,
    slowMs: (src?.transcode ? 26000 : 20000) + startupExtraMs,
    ...(src?.transcode ? { minSustainBps: 300 * 1024 } : {}),
    debrid: src?.debrid,
  });
  try {
    const response = await fetch(streamUrl.href, { signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Source unavailable');
    if (controller.signal.aborted || generation !== playbackGeneration || currentTorrentHash !== hash) {
      fetch(helperUrl(`/hls/stop?id=${result.id}`)).catch(() => {});
      return;
    }
    hlsSessionId = result.id;
    startHlsKeepAlive(result.id);
    // Stream-copy seeks start on the preceding keyframe, and MPEG-TS rebases its
    // timestamps. Use the helper's measured source-time base for subtitles,
    // progress, and subsequent seeks instead of the requested (but not exact)
    // start second.
    if (Number.isFinite(result.mediaStartSec)) {
      torrentSeekBase = result.mediaStartSec;
      reloadSubtitlesAtOffset(torrentSeekBase);
      renderTorrentTime();
    }
    playerVideo.src = helperUrl(`/hls/${result.id}/index.m3u8`);
    playerVideo.load();
    playerVideo.play().catch(() => { clearPlaybackHealth(); setYtsStatus('Press OK on Play to start.'); });
    watchPlaybackHealth(recover, { startupMs: 30000 + startupExtraMs, source: src });
  } catch (error) {
    if (controller.signal.aborted || generation !== playbackGeneration) return;
    recover();
  }
}

// ---- HEVC transcode playback (MediaSource) ----
//
// The helper GPU-transcodes an HEVC source to H.264 and streams it as a live
// fragmented MP4. A plain <video src> cannot decode a live fMP4, so we feed it
// through MediaSource instead — which works in desktop Chrome and webOS alike.
// The read is throttled to stay ~45s ahead and already-played data is evicted, so
// memory stays bounded across a full episode. Aborting kills the fetch, which
// closes the response and stops the helper's ffmpeg.
const TRANSCODE_MIME = 'video/mp4; codecs="avc1.640029,mp4a.40.2"';
let transcodeAbort = null;
let transcodeObjectUrl = null;
function stopTranscode() {
  if (transcodeAbort) { try { transcodeAbort.abort(); } catch { /* already gone */ } transcodeAbort = null; }
  // Release the MediaSource blob URL — otherwise every transcode/source switch leaks one.
  if (transcodeObjectUrl) { try { URL.revokeObjectURL(transcodeObjectUrl); } catch { /* ignore */ } transcodeObjectUrl = null; }
}
function playTranscodeMse(url, recover) {
  stopTranscode();
  const generation = playbackGeneration;
  const ac = transcodeAbort = new AbortController();
  if (!window.MediaSource || !MediaSource.isTypeSupported(TRANSCODE_MIME)) { recover(); return; }
  const ms = new MediaSource();
  transcodeObjectUrl = URL.createObjectURL(ms);
  playerVideo.src = transcodeObjectUrl;
  playerVideo.load();

  ms.addEventListener('sourceopen', async () => {
    if (ac.signal.aborted || generation !== playbackGeneration) return;
    let sb;
    try { sb = ms.addSourceBuffer(TRANSCODE_MIME); } catch { recover(); return; }
    const queue = [];
    const pump = () => {
      if (sb.updating || !queue.length || ac.signal.aborted) return;
      const chunk = queue[0]; // peek: only drop it once it is actually appended
      try { sb.appendBuffer(chunk); queue.shift(); } catch (e) {
        if (e && e.name === 'QuotaExceededError') {
          // Keep the chunk and free room. If nothing could be removed yet (playhead
          // still near the buffer start), updateend won't fire — so poll pump until
          // playback advances enough to evict. Without this the queue wedges.
          if (!evict(true)) setTimeout(() => { if (!ac.signal.aborted) pump(); }, 400);
        } else { queue.shift(); } // a chunk that can never be appended must not wedge the queue
      }
    };
    const evict = (force) => {
      try {
        const keepFrom = playerVideo.currentTime - (force ? 5 : 30);
        if (!sb.updating && sb.buffered.length && keepFrom > sb.buffered.start(0) + 1) {
          sb.remove(sb.buffered.start(0), keepFrom);
          return true;
        }
      } catch { /* remove races with append; harmless */ }
      return false;
    };
    const bufferedAhead = () => {
      try {
        for (let i = 0; i < sb.buffered.length; i++) {
          if (playerVideo.currentTime >= sb.buffered.start(i) - 0.5 && playerVideo.currentTime <= sb.buffered.end(i)) {
            return sb.buffered.end(i) - playerVideo.currentTime;
          }
        }
      } catch { /* buffered not ready */ }
      return 0;
    };
    sb.addEventListener('updateend', pump);

    try {
      const resp = await fetch(url, { signal: ac.signal });
      if (!resp.ok) { if (!ac.signal.aborted) recover(); return; }
      const reader = resp.body.getReader();
      ac.signal.addEventListener('abort', () => { try { reader.cancel(); } catch { /* already closed */ } });
      for (;;) {
        // Throttle: ffmpeg transcodes faster than real time, so don't race ahead
        // and pile the whole episode into memory. Also hold when the append queue
        // backs up (e.g. a quota stall) so it can't grow unbounded.
        while ((bufferedAhead() > 45 || queue.length > 120) && !ac.signal.aborted) await new Promise((r) => setTimeout(r, 400));
        if (ac.signal.aborted || generation !== playbackGeneration) return;
        const { done, value } = await reader.read();
        if (done) break;
        queue.push(value);
        pump();
        if (playerVideo.currentTime > 40) evict(false);
      }
      // Drain the queue, then close the stream so the video ends cleanly.
      const drain = setInterval(() => {
        if (ac.signal.aborted) { clearInterval(drain); return; }
        if (!queue.length && !sb.updating) {
          clearInterval(drain);
          try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* already ended */ }
        }
      }, 200);
    } catch (error) {
      if (!ac.signal.aborted && generation === playbackGeneration) recover();
    }
  });

  playerVideo.play().catch(() => { /* gesture policy; controls remain */ });
}

let currentTorrentHash = null;   // infohash being streamed, for teardown
let currentYtsTorrents = [];     // available qualities for the current movie
let currentYtsData = null;       // { title, year, torrents }
let ytsPollTimer = null;         // interval polling /stream-status
let ytsTriedHashes = new Set();  // qualities attempted (for mkv auto-fallback)

const DEFAULT_YTS_QUALITY = '1080p'; // user preference: default to 1080p

// Toggle between the iframe player (embed sources) and the <video> (YTS).
function showPlayerVideo(on) {
  if (playerVideo) playerVideo.style.display = on ? 'block' : 'none';
  if (playerIframe) playerIframe.style.display = on ? 'none' : 'block';
  if (qualitySelect && !on) qualitySelect.style.display = 'none';
  if (subtitleSelect && !on) subtitleSelect.style.display = 'none';
  // The seek bar belongs to the native torrent player; hide it whenever we leave
  // the <video> for an embed iframe or close the player. playTvSource re-shows it
  // for remuxed sources.
  if (!on) showTorrentSeek(false);
  if (!on) setYtsStatus(null);
}

function setYtsStatus(msg, isError = false) {
  if (!ytsStatusEl) return;
  if (!msg) {
    ytsStatusEl.style.display = 'none';
    ytsStatusEl.textContent = '';
    return;
  }
  ytsStatusEl.textContent = msg;
  ytsStatusEl.classList.toggle('error', isError);
  ytsStatusEl.style.display = 'flex';
}

const fmtSpeed = (bps) => (!bps ? '' : bps > 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.max(1, Math.round(bps / 1e3))} KB/s`);

// Resolution rank for ordering the dropdown (low -> high).
const qualityRank = (q) => (q === '720p' ? 0 : q === '1080p' ? 1 : q === '2160p' ? 2 : 3);

function clearYtsPoll() {
  if (ytsPollTimer) { clearInterval(ytsPollTimer); ytsPollTimer = null; }
}

function beaconStop(hash) {
  if (!hash) return;
  try {
    if (navigator.sendBeacon) navigator.sendBeacon(helperUrl(`/stream-stop?hash=${hash}`));
    else fetch(helperUrl(`/stream-stop?hash=${hash}`), { keepalive: true }).catch(() => {});
  } catch { /* ignore */ }
}

// Full teardown: used when leaving the YTS source / closing the player.
function stopYtsStream() {
  playbackGeneration++;
  clearPlaybackHealth();
  stopHlsSession();
  stopTranscode();
  tvPlayCtx = null;
  torrentSeekBase = 0;
  torrentDuration = 0;
  suppressSourceWalk = false;
  if (playerVideo) { playerVideo.onplaying = null; playerVideo.onerror = null; playerVideo.onloadedmetadata = null; }
  clearYtsPoll();
  if (playerVideo) {
    try { playerVideo.pause(); } catch { /* ignore */ }
    playerVideo.removeAttribute('src');
    try { playerVideo.load(); } catch { /* ignore */ }
  }
  beaconStop(currentTorrentHash);
  currentTorrentHash = null;
  currentYtsTorrents = [];
  currentYtsData = null;
  if (qualitySelect) { qualitySelect.style.display = 'none'; qualitySelect.innerHTML = ''; }
  clearSubtitleTracks();
}

// ---- Subtitles (from the .srt files inside the YTS torrent) ----
//
// YTS torrents carry their own subtitles, so no external service is involved: the
// helper lists them and serves each one converted to WebVTT (a <track> element
// accepts nothing else). Remembering the choice matters because the picker is
// rebuilt on every quality switch.

const SUBTITLE_PREF_KEY = 'ytsSubtitlePref'; // 'off' | a track label
// The tracks currently attached, in <track> element order. The index into this
// array IS the track identity used by the picker and by showSubtitleTrack.
let subtitleSlots = [];

function subtitlePref() {
  try { return localStorage.getItem(SUBTITLE_PREF_KEY) || ''; } catch { return ''; }
}
function setSubtitlePref(value) {
  try { localStorage.setItem(SUBTITLE_PREF_KEY, value); } catch { /* private mode */ }
}

function subtitleSyncKey(track) {
  if (!track?.src) return '';
  try {
    const url = new URL(track.src, location.href);
    return `subtitleSync:${url.searchParams.get('hash') || ''}:${url.searchParams.get('id') || ''}`;
  } catch { return ''; }
}
function subtitleSyncOffset(track) {
  const key = subtitleSyncKey(track);
  if (!key) return 0;
  try { return Math.max(-30, Math.min(30, Number(localStorage.getItem(key)) || 0)); }
  catch { return 0; }
}
function setSubtitleSyncOffset(track, value) {
  const key = subtitleSyncKey(track);
  if (!key) return 0;
  const offset = Math.round(Math.max(-30, Math.min(30, Number(value) || 0)) * 10) / 10;
  try { localStorage.setItem(key, String(offset)); } catch { /* private mode */ }
  return offset;
}
function renderSubtitleSyncControls(track, offset = 0) {
  if (!subtitleSyncControls) return;
  const visible = TV_MODE && !!track;
  subtitleSyncControls.style.display = visible ? 'flex' : 'none';
  if (subtitleOffsetLabel) subtitleOffsetLabel.textContent = `Sub ${offset >= 0 ? '+' : ''}${offset.toFixed(1)}s`;
}
function adjustSubtitleSync(delta) {
  if (!playerVideo || !subtitleSelect) return;
  const slot = subtitleSelect.value === '' ? -1 : Number(subtitleSelect.value);
  const track = slot >= 0 ? playerVideo.querySelectorAll('track')[slot] : null;
  if (!track) return;
  setSubtitleSyncOffset(track, subtitleSyncOffset(track) + delta);
  showSubtitleTrack(String(slot));
}

// Remove every <track> from the player. Detaching the elements is not enough on
// its own — a stale track left showing would caption the *next* movie.
function clearSubtitleTracks() {
  if (TV_MODE) document.dispatchEvent(new CustomEvent('tv-subtitle-track', { detail: { url: '' } }));
  subtitleSlots = [];
  if (playerVideo) {
    for (const t of [...playerVideo.querySelectorAll('track')]) t.remove();
    for (const tt of playerVideo.textTracks || []) tt.mode = 'disabled';
  }
  if (subtitleSelect) { subtitleSelect.style.display = 'none'; subtitleSelect.innerHTML = ''; }
  renderSubtitleSyncControls(null);
}

// Show only the chosen track, identified by its position among the <track>
// elements we appended. Selecting by LABEL is wrong: one torrent can carry two
// files that both label as "English" (a release-named sidecar plus
// Subs/English.srt), and matching on the label turned both on, so the browser
// rendered two overlapping caption streams at once.
function showSubtitleTrack(slot) {
  if (!playerVideo) return;
  const tracks = playerVideo.textTracks || [];
  const want = slot === '' || slot == null ? -1 : Number(slot);
  for (let i = 0; i < tracks.length; i++) {
    tracks[i].mode = !TV_MODE && i === want ? 'showing' : 'disabled';
  }
  const track = want >= 0 ? playerVideo.querySelectorAll('track')[want] : null;
  const offset = track ? subtitleSyncOffset(track) : 0;
  if (TV_MODE) {
    document.dispatchEvent(new CustomEvent('tv-subtitle-track', { detail: { url: track?.src || '', offset } }));
  }
  renderSubtitleSyncControls(track, offset);
  const chosen = want >= 0 ? subtitleSlots[want] : null;
  setSubtitlePref(chosen ? chosen.label : 'off');
}

// Pick the default track. NOT simply the first non-forced one: YTS often ships a
// sidecar that is really the forced/partial track (Predator: Badlands has an
// 11KB sidecar of alien dialogue beside a 31KB full English track), so the
// largest non-forced track is what a viewer actually wants.
function defaultSubtitleSlot(tracks) {
  const pref = subtitlePref();
  if (pref === 'off') return -1;
  if (pref) {
    const remembered = tracks.findIndex((t) => t.label === pref);
    if (remembered >= 0) return remembered;
  }
  const candidates = tracks.some((t) => !t.forced) ? tracks.filter((t) => !t.forced) : tracks;
  const best = [...candidates].sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
  return best ? tracks.indexOf(best) : -1;
}

// Attach the subtitle tracks for one torrent and build the picker.
let subtitleLoadRequest = 0;
async function loadSubtitlesFor(hash, season, episode, attempt = 0, fileIndex = null) {
  if (!playerVideo || !subtitleSelect) return;
  const generation = playbackGeneration;
  const request = ++subtitleLoadRequest;
  clearSubtitleTracks();

  let tracks = [];
  try {
    // streaming=1: we are playing this torrent, so the helper must not deselect
    // the video file to save bandwidth on our behalf. s/e let the helper pick the
    // right episode inside a season pack to read its embedded subtitle tracks.
    const ep = (Number.isFinite(season) && Number.isFinite(episode)) ? `&s=${season}&e=${episode}` : '';
    const file = Number.isInteger(fileIndex) ? `&file=${fileIndex}` : '';
    // imdb lets the helper fall back to OpenSubtitles when the torrent has no subs.
    const imdb = currentSubtitleImdb ? `&imdb=${encodeURIComponent(currentSubtitleImdb)}` : '';
    const r = await fetch(helperUrl(`/subtitles?hash=${hash}${ep}${file}${imdb}&streaming=1`));
    if (!r.ok) return;                      // no subtitles is not an error worth shouting about
    const body = await r.json();
    if (request !== subtitleLoadRequest) return;
    tracks = dedupeTrackLabels(body.tracks || []);
    if (body.duration && currentTorrentHash === hash && generation === playbackGeneration && request === subtitleLoadRequest) setTorrentDuration(body.duration);
    else if (TV_HLS && attempt < 6) {
      setTimeout(() => { if (currentTorrentHash === hash && generation === playbackGeneration && request === subtitleLoadRequest) loadSubtitlesFor(hash, season, episode, attempt + 1, fileIndex); }, 9000);
    }
  } catch {
    // Transient fetch failure (webOS drops fetches under the initial request
    // storm). Retry rather than leaving the film without subtitles for good.
    if (attempt < 6) setTimeout(() => { if (currentTorrentHash === hash && generation === playbackGeneration && request === subtitleLoadRequest) loadSubtitlesFor(hash, season, episode, attempt + 1, fileIndex); }, 9000);
    return;
  }

  if (currentTorrentHash !== hash || generation !== playbackGeneration || request !== subtitleLoadRequest) return;  // user switched quality/movie mid-fetch
  if (!tracks.length) {
    // Embedded subtitles live inside the .mkv and are unreadable until enough of
    // the header has downloaded. On a fresh stream that lags playback, so retry a
    // few times before giving up rather than showing no subtitles for the session.
    if (attempt < 6) setTimeout(() => { if (currentTorrentHash === hash && generation === playbackGeneration && request === subtitleLoadRequest) loadSubtitlesFor(hash, season, episode, attempt + 1, fileIndex); }, 9000);
    return;
  }

  subtitleSlots = tracks;
  for (const t of tracks) {
    const el = document.createElement('track');
    // webOS gets captions from our JS overlay because native HLS sidecar tracks
    // are unreliable there. Mark the backing track as metadata so the webview
    // cannot also paint it later and double the dialogue over the overlay.
    el.kind = TV_MODE ? 'metadata' : 'subtitles';
    el.label = t.label;
    el.srclang = t.lang || 'en';
    // t.id is the stable track id (file "f3" or embedded "e1:2"); older helpers
    // sent t.index, kept as a fallback.
    el.src = helperUrl(`/subtitle?hash=${hash}&id=${t.id || ('f' + t.index)}&streaming=1${torrentSeekBase ? '&t=' + Math.floor(torrentSeekBase) : ''}`);
    playerVideo.appendChild(el);
  }

  const off = document.createElement('option');
  off.value = '';
  off.textContent = 'Subtitles: off';
  subtitleSelect.appendChild(off);
  tracks.forEach((t, slot) => {
    const opt = document.createElement('option');
    opt.value = String(slot);   // slot, not label: labels are not unique
    opt.textContent = t.label;
    subtitleSelect.appendChild(opt);
  });
  subtitleSelect.style.display = 'inline-block';

  const slot = defaultSubtitleSlot(tracks);
  subtitleSelect.value = slot >= 0 ? String(slot) : '';
  // textTracks appear as the <track> elements are parsed; apply once they exist.
  setTimeout(() => { if (currentTorrentHash === hash && generation === playbackGeneration && request === subtitleLoadRequest) showSubtitleTrack(slot >= 0 ? String(slot) : ''); }, 0);
}

function populateQualitySelect(torrents, selectedHash) {
  if (!qualitySelect) return;
  qualitySelect.innerHTML = '';
  [...torrents]
    .sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality))
    .forEach((t) => {
      const opt = document.createElement('option');
      opt.value = (t.hash || '').toLowerCase();
      const codec = t.video_codec ? ` ${t.video_codec}` : '';
      opt.textContent = `${t.quality}${codec}${t.size ? ' · ' + t.size : ''}`;
      if (opt.value === selectedHash) opt.selected = true;
      qualitySelect.appendChild(opt);
    });
  qualitySelect.style.display = torrents.length ? 'inline-block' : 'none';
}

// Poll the helper for swarm/file status and narrate it in the overlay so a long
// buffer is explained (peers, progress) rather than a silent spinner.
function startYtsStatusPolling(hash) {
  clearYtsPoll();
  ytsPollTimer = setInterval(async () => {
    if (currentTorrentHash !== hash) { clearYtsPoll(); return; }
    let s;
    try { s = await fetch(helperUrl(`/stream-status?hash=${hash}`)).then((r) => r.json()); }
    catch { return; }
    if (currentTorrentHash !== hash) return;

    // For TV torrents, replace the index estimate with WebTorrent's actual
    // connected socket count. This remains useful after the overlay disappears.
    const tvSource = currentTvSources.find((source) => source.hash === hash);
    if (tvSource && qualitySelect) {
      const option = [...qualitySelect.options].find((item) => item.value === hash);
      if (option) option.textContent = describeTvSource(tvSource, Number(s.peers) || 0);
    }

    // Already playing smoothly — let onplaying clear the overlay.
    if (playerVideo && !playerVideo.paused && playerVideo.readyState >= 3) {
      setYtsStatus(null);
      return;
    }
    // This YTS-quality auto-step is movie-only logic (it walks `currentYtsTorrents`).
    // For a TV show that list is empty, and a mislabeled "not playable" would wrongly
    // show the "None of YTS's versions…" movie message, so only run it for movies.
    if (s.state === 'ready' && s.playable === false && currentYtsTorrents.length) {
      clearYtsPoll();
      // Auto-step to the next not-yet-tried quality (1080p is usually .mp4 even
      // when 720p is .mkv) so the default still ends up playing. Only consider
      // torrents that CAN play: skip x265 (mkv-only) and 0-seed (never connects).
      const next = [...currentYtsTorrents]
        .filter((t) => (t.video_codec || 'x264').toLowerCase() !== 'x265')
        .filter((t) => (Number(t.seeds) || 0) > 0)
        .sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality))
        .map((t) => (t.hash || '').toLowerCase())
        .find((h) => !ytsTriedHashes.has(h));
      if (next) {
        if (qualitySelect) qualitySelect.value = next;
        setYtsStatus('That quality is .mkv (not browser-playable) — trying the next one…');
        playYtsQuality(next);
      } else {
        setYtsStatus("None of YTS's versions are a browser-playable format (.mp4) for this movie.", true);
      }
      return;
    }
    const peers = s.peers || 0;
    const pct = s.progress ? Math.round(s.progress * 100) : 0;
    if (s.state === 'connecting' || !s.name) {
      setYtsStatus(`Connecting to peers… (${peers} peer${peers === 1 ? '' : 's'})`);
    } else {
      const spd = fmtSpeed(s.downloadSpeed);
      setYtsStatus(`Buffering… ${peers} peer${peers === 1 ? '' : 's'} · ${pct}%${spd ? ' · ' + spd : ''}`);
    }
  }, 1500);
}

// Stream a specific quality (by infohash) into the <video>.
function playYtsQuality(hash, startSec = 0) {
  if (!hash) return;
  // Tear down a previously-selected quality's torrent.
  if (currentTorrentHash && currentTorrentHash !== hash) beaconStop(currentTorrentHash);
  clearYtsPoll();
  currentTorrentHash = hash;
  ytsTriedHashes.add(hash);
  if (qualitySelect) qualitySelect.value = hash;

  const t = currentYtsTorrents.find((x) => (x.hash || '').toLowerCase() === hash);
  const title = currentYtsData?.title || currentPlayingMovie?.title || currentPlayingMovie?.name || '';
  setYtsStatus(`Connecting to peers… (${t?.quality || ''})\nFirst frames can take a moment.`);

  if (TV_HLS) {
    currentTvSources = currentYtsTorrents.filter(item => (item.video_codec || 'x264').toLowerCase() !== 'x265').map(item => ({
      hash: item.hash.toLowerCase(), quality: item.quality, seeds: item.seeds,
      filename: `${title}.${item.quality}.x264.mp4`, title, provider: 'YTS', remux: false,
    }));
    playTvSource(hash, undefined, undefined, [], startSec);
    return;
  }
  playerVideo.src = helperUrl(`/stream?hash=${hash}&title=${encodeURIComponent(title)}`);
  playerVideo.onplaying = () => { setYtsStatus(null); clearYtsPoll(); };
  const recover = () => {
    clearPlaybackHealth();
    const next = currentYtsTorrents.find(t => !ytsTriedHashes.has((t.hash || '').toLowerCase()) && (t.video_codec || 'x264').toLowerCase() !== 'x265');
    if (next) return playYtsQuality(next.hash.toLowerCase(), playerVideo.currentTime || startSec);
    clearYtsPoll();
    setYtsStatus('No source could sustain playback. Choose another quality or retry this movie.', true);
  };
  playerVideo.onerror = recover;
  playerVideo.onloadedmetadata = () => { if (startSec > 0 && Number.isFinite(playerVideo.duration)) playerVideo.currentTime = Math.min(startSec, playerVideo.duration); };
  if (TV_MODE) watchPlaybackHealth(recover);
  playerVideo.load();
  playerVideo.play().catch(() => { /* autoplay may be blocked; controls remain */ });
  startYtsStatusPolling(hash);
  loadSubtitlesFor(hash);
}

async function loadAlternateMovieStream(movie, imdbId, generation, startSec = 0) {
  setYtsStatus('Finding another movie source…');
  try {
    const query = new URLSearchParams({ imdb: imdbId, title: movie.title || '', year: String(movie.release_date || '').slice(0, 4) });
    const response = await fetch(helperUrl(`/movie-torrents?${query}`));
    const body = await response.json();
    if (generation !== playbackGeneration || currentPlayingMovie?.id !== movie.id) return;
    if (!response.ok || !body.sources?.length) {
      setYtsStatus('No playable source is available for this movie right now. Retry playback to check again.', true);
      return;
    }
    currentTvSources = stampDebridIds(body.sources);
    populateTvQualitySelect(currentTvSources);
    playTvSource(currentTvSources[0].hash, undefined, undefined, [], startSec);
  } catch {
    if (generation === playbackGeneration) setYtsStatus('Could not reach movie sources. Retry playback to try again.', true);
  }
}

// Load a movie from YTS via the local helper into the native <video>.
async function loadYtsStream(movie, startSec = 0) {
  stopYtsStream();
  playerIframe.src = '';
  playerIframe.removeAttribute('srcdoc');
  showPlayerVideo(true);
  setYtsStatus('Finding a torrent…');

  const reqId = movie.id;
  const generation = playbackGeneration;
  try {
    // TMDB id -> IMDb id (YTS is indexed by IMDb id). A failed REQUEST here is
    // transient (TMDB rate-limits hard) and says nothing about whether the title
    // has an IMDb id, so retry once and never report the two as the same thing.
    let extFailed = false;
    let ext = await fetchTmdbJson(ENDPOINTS.externalIds('movie', movie.id)).catch(() => { extFailed = true; return null; });
    if (extFailed) {
      extFailed = false;
      await new Promise((r) => setTimeout(r, 1200));
      if ((currentPlayingMovie?.id !== reqId || generation !== playbackGeneration)) return; // user switched away mid-retry
      ext = await fetchTmdbJson(ENDPOINTS.externalIds('movie', movie.id)).catch(() => { extFailed = true; return null; });
    }
    const imdbId = ext && ext.imdb_id;
    if (!imdbId) { setYtsStatus(describeImdbLookupFailure({ requestFailed: extFailed }), true); return; }
    if ((currentPlayingMovie?.id !== reqId || generation !== playbackGeneration)) return; // user switched away
    currentSubtitleImdb = imdbId; // for the OpenSubtitles fallback in loadSubtitlesFor

    // The lookup fails in two completely different ways and they need different
    // messages: the helper not being there at all (fetch throws) vs the helper
    // answering that IT could not reach YTS (5xx — ISPs block the YTS domains, so
    // this is transient and worth one retry before bothering the user).
    const lookupYts = async () => {
      try {
        const r = await fetch(helperUrl(`/yts?imdb=${encodeURIComponent(imdbId)}`));
        return r.ok ? { data: await r.json() } : { status: r.status };
      } catch {
        return { networkError: true };
      }
    };

    let attempt = await lookupYts();
    if (attempt.status >= 500) {
      setYtsStatus("Couldn't reach YTS's API — retrying…");
      await new Promise((r) => setTimeout(r, 1500));
      if ((currentPlayingMovie?.id !== reqId || generation !== playbackGeneration)) return; // user switched away mid-retry
      attempt = await lookupYts();
    }
    const data = attempt.data;
    if (generation !== playbackGeneration) return;
    if (!data && TV_MODE) return loadAlternateMovieStream(movie, imdbId, generation, startSec);
    if (!data) {
      setYtsStatus(describeYtsLookupFailure({ ...attempt, remoteBase: STREAM_HELPER_BASE }), true);
      return;
    }
    const torrents = (data.torrents || []).filter((t) => t.hash);
    if (!torrents.length) {
      if (TV_MODE) return loadAlternateMovieStream(movie, imdbId, generation, startSec);
      setYtsStatus('No YTS torrent found for this movie.', true); return;
    }
    if ((currentPlayingMovie?.id !== reqId || generation !== playbackGeneration)) return;

    currentYtsData = data;
    currentYtsTorrents = torrents;
    ytsTriedHashes = new Set();

    // Default pick: a browser-playable (x264, not x265/mkv-only) torrent, and
    // crucially one that HAS SEEDS — a 0-seed torrent never finds peers and hangs
    // forever on "Connecting…". So filter to seeded torrents first; only fall back
    // to unseeded if literally nothing is seeded. Among seeded, prefer 1080p (best
    // quality, usually .mp4), then 720p, then 4K; tie-break by seed count.
    const playablePool = torrents.filter((t) => (t.video_codec || 'x264').toLowerCase() !== 'x265');
    const base = playablePool.length ? playablePool : torrents;
    const seeded = base.filter((t) => (Number(t.seeds) || 0) > 0);
    const pool = seeded.length ? seeded : base;
    // 1080p first (default), then 720p, then other/SD, with 4K last (usually HEVC/huge).
    const defRank = (q) => (q === '1080p' ? 0 : q === '720p' ? 1 : q === '2160p' ? 3 : 2);
    const def = [...pool].sort((a, b) => {
      const r = defRank(a.quality) - defRank(b.quality);
      return r !== 0 ? r : (Number(b.seeds) || 0) - (Number(a.seeds) || 0);
    })[0];
    const defHash = (def.hash || '').toLowerCase();

    populateQualitySelect(torrents, defHash);
    playYtsQuality(defHash, startSec);
  } catch (err) {
    if (generation !== playbackGeneration) return;
    console.error('YTS stream error:', err);
    setYtsStatus('Failed to start the torrent stream.', true);
  }
}

// ---- TV torrents (Stremio-compatible indexes -> the native player) ----
//
// Native MP4 sources play directly. Compatible H.264 MKV sources are remuxed to
// fragmented MP4 by the local helper without re-encoding the video.

let currentTvSources = [];   // ranked streamable sources for the episode on screen

async function loadTvStream(movie, season, episode, startSec = 0) {
  stopYtsStream();
  playerIframe.src = '';
  playerIframe.removeAttribute('srcdoc');
  showPlayerVideo(true);
  setYtsStatus('Finding a source…');

  const reqId = movie.id;
  const generation = playbackGeneration;
  try {
    // TV torrent indexes use IMDb ids. Retry the TMDB external-id lookup once: a
    // failed request says nothing about whether the show has an id.
    let extFailed = false;
    let ext = await fetchTmdbJson(ENDPOINTS.externalIds('tv', movie.id)).catch(() => { extFailed = true; return null; });
    if (extFailed) {
      extFailed = false;
      await new Promise((r) => setTimeout(r, 1200));
      if ((currentPlayingMovie?.id !== reqId || generation !== playbackGeneration)) return;
      ext = await fetchTmdbJson(ENDPOINTS.externalIds('tv', movie.id)).catch(() => { extFailed = true; return null; });
    }
    const imdbId = ext && ext.imdb_id;
    if (!imdbId) { setYtsStatus(describeImdbLookupFailure({ requestFailed: extFailed }), true); return; }
    if ((currentPlayingMovie?.id !== reqId || generation !== playbackGeneration)) return;
    currentSubtitleImdb = imdbId; // series imdb id — /subtitles pairs it with s/e for OpenSubtitles

    const series = currentTvData || movie;
    const params = new URLSearchParams({
      imdb: imdbId,
      title: movie.name || movie.title || '',
      originalTitle: movie.original_name || '',
      season: String(season),
      episode: String(episode),
    });
    const year = String(series?.first_air_date || movie?.first_air_date || '').split('-')[0];
    const country = series?.origin_country?.[0] || movie?.origin_country?.[0] || '';
    if (year) params.set('year', year);
    if (country) params.set('country', country);

    let attempt;
    try {
      const r = await fetch(helperUrl(`/tv-torrents?${params}`));
      attempt = r.ok ? { data: await r.json() } : { status: r.status };
    } catch { attempt = { networkError: true }; }

    if (generation !== playbackGeneration) return;
    if (!attempt.data) {
      setYtsStatus(
        describeTvTorrentFailure({
          networkError: attempt.networkError,
          status: attempt.status,
          remoteBase: STREAM_HELPER_BASE,
        }),
        true
      );
      return;
    }
    if ((currentPlayingMovie?.id !== reqId || generation !== playbackGeneration)) return;

    // Trust the helper's ranking (rankTvSources): debrid first, then 1080p, then a
    // healthy direct-play copy BEFORE any HEVC transcode, then by seeds. An earlier
    // client-side re-sort here ordered purely by seed count and so kept picking a
    // well-seeded HEVC (needing transcode) over a healthy H.264 copy — the White
    // Lotus buffering bug. The server order is authoritative; don't re-sort.
    currentTvSources = stampDebridIds(attempt.data.sources || []);
    if (!currentTvSources.length) {
      setYtsStatus(`No active MP4 or H.264 MKV torrent for S${season}E${episode}. Try another source or episode.`, true);
      return;
    }

    populateTvQualitySelect(currentTvSources);
    playTvSource(currentTvSources[0].hash, season, episode, [], startSec);
  } catch (err) {
    if (generation !== playbackGeneration) return;
    console.error('TV torrent error:', err);
    setYtsStatus('Failed to start the torrent stream.', true);
  }
}

// The quality dropdown doubles as the source list for TV: each entry is a
// different torrent, labelled by what it actually is.
function populateTvQualitySelect(sources) {
  if (!qualitySelect) return;
  qualitySelect.innerHTML = '';
  sources.forEach((src) => {
    const opt = document.createElement('option');
    opt.value = src.hash;
    opt.textContent = describeTvSource(src);
    qualitySelect.appendChild(opt);
  });
  qualitySelect.style.display = sources.length ? 'inline-block' : 'none';
}

// Stream one source. s/e are passed to the helper so it serves the right episode
// out of a season pack rather than whichever file happens to be largest.
// --- Torrent seek: restart-at-timestamp for the remuxed MKV player ---
//
// A live-remuxed MKV is a fragmented MP4 with no seekable index, so the native
// scrub bar cannot move within it. Seeking reloads the stream at a new start time
// (?t=<seconds>); the <video> clock then runs from 0 and the true position is the
// start offset plus video.currentTime. torrent-seek.js does the pure arithmetic.
let tvPlayCtx = null;        // { hash, season, episode, src } for re-issuing ?t=
let torrentSeekBase = 0;     // seconds the current stream was started at
let torrentDuration = 0;     // episode length, from the /subtitles probe
let suppressSourceWalk = false;

// Debrid sources arrive with a ready `url` and NO infohash, but the whole player
// keys sources by `.hash` (dropdown values, the fallback cascade's tried-set,
// currentTvSources lookups). Give each a stable, non-hex synthetic id so it flows
// through that machinery untouched; playTvSource branches on `.debrid`/`.url` to
// build the right helper URL. Non-hex means it can never be mistaken for a real
// 40-char infohash by the helper.
function stampDebridIds(sources) {
  return (Array.isArray(sources) ? sources : []).map((s) => {
    if (s && !s.hash && s.url) {
      let h = 5381;
      for (let i = 0; i < s.url.length; i++) h = ((h << 5) + h + s.url.charCodeAt(i)) >>> 0;
      return { ...s, hash: 'debrid_' + h.toString(16) };
    }
    return s;
  });
}

function buildTvStreamUrl(hash, season, episode, src, t, ready) {
  // A debrid source is a ready HTTP file. A native H.264 copy is proxied straight
  // through (no transcode); an HEVC/unknown copy is GPU-transcoded from the URL
  // (/transcode?src=). On the TV, prepareTvHls rewrites the path to /hls/start and
  // keeps ?src= either way.
  if (src?.debrid && src?.url) {
    let path = src?.transcode
      ? `/transcode?src=${encodeURIComponent(src.url)}`
      : `/debrid-proxy?src=${encodeURIComponent(src.url)}`;
    if (t > 0) path += `&t=${Math.floor(t)}`;
    return helperUrl(path);
  }
  // An HEVC source is transcoded to H.264 on the helper's GPU and streamed as a
  // progressive fragmented MP4 — plays in plain <video> on the TV and desktop alike.
  if (src?.transcode) {
    let path = `/transcode?hash=${hash}&s=${season}&e=${episode}` +
      `&title=${encodeURIComponent(src?.filename || '')}`;
    if (Number.isInteger(src?.fileIndex)) path += `&file=${src.fileIndex}`;
    if (t > 0) path += `&t=${Math.floor(t)}`;
    return helperUrl(path);
  }
  let path = `/stream?hash=${hash}&s=${season}&e=${episode}&ready=${ready}` +
    `&title=${encodeURIComponent(src?.filename || '')}` +
    `&ctx=${encodeURIComponent((src?.title || '').slice(0, 200))}`;
  if (Number.isInteger(src?.fileIndex)) path += `&file=${src.fileIndex}`;
  if (t > 0) path += `&t=${Math.floor(t)}`;
  return helperUrl(path);
}

function setTorrentDuration(d) { torrentDuration = Number(d) || 0; renderTorrentTime(); }

const tsEls = () => ({
  wrap: document.getElementById('torrent-seek'),
  bar: document.getElementById('ts-bar'),
  fill: document.getElementById('ts-fill'),
  buffered: document.getElementById('ts-buffered'),
  time: document.getElementById('ts-time'),
});
function showTorrentSeek(on) { const { wrap } = tsEls(); if (wrap) wrap.style.display = on ? 'flex' : 'none'; }
function renderTorrentTime() {
  const { fill, buffered, time } = tsEls();
  if (!time || !playerVideo) return;
  const pos = absolutePosition(torrentSeekBase, playerVideo.currentTime);
  if (fill) fill.style.width = (torrentDuration > 0 ? Math.min(100, pos / torrentDuration * 100) : 0) + '%';
  if (buffered && playerVideo.buffered && playerVideo.buffered.length) {
    const end = torrentSeekBase + playerVideo.buffered.end(playerVideo.buffered.length - 1);
    buffered.style.width = (torrentDuration > 0 ? Math.min(100, end / torrentDuration * 100) : 0) + '%';
  }
  time.textContent = `${formatTime(pos)} / ${formatTime(torrentDuration)}`;
}
// After a seek, the <video> clock is 0-based but the subtitle cues are absolute,
// so realign them by refetching each track shifted by the seek offset (?t=). The
// helper caches the extracted VTT, so this is a cheap string shift server-side.
function reloadSubtitlesAtOffset(offset) {
  if (!playerVideo || !subtitleSelect) return;
  const selected = subtitleSelect.value;
  playerVideo.querySelectorAll('track').forEach((el) => {
    try {
      const u = new URL(el.src, location.href);
      if (offset > 0) u.searchParams.set('t', Math.floor(offset)); else u.searchParams.delete('t');
      el.src = u.toString();   // reassigning src refetches and reparses the cues
    } catch { /* leave this track as-is */ }
  });
  // Cues reload asynchronously; re-apply the chosen track once they exist.
  setTimeout(() => { if (currentTorrentHash) showSubtitleTrack(selected); }, 60);
}

// Reload the current source at absolute time t, without triggering the source-walk
// (a seek stumble means the swarm hiccupped, not that the source is dead).
function torrentSeekTo(t) {
  if (!tvPlayCtx) return;
  torrentSeekBase = seekTarget(0, t, torrentDuration);   // clamp into the episode
  if (TV_HLS) {
    playTvSource(tvPlayCtx.hash, tvPlayCtx.season, tvPlayCtx.episode, [], torrentSeekBase, { manualSource: tvPlayCtx.manualSource });
    return;
  }
  suppressSourceWalk = true;
  setYtsStatus('Seeking…');
  playerVideo.src = buildTvStreamUrl(tvPlayCtx.hash, tvPlayCtx.season, tvPlayCtx.episode, tvPlayCtx.src, torrentSeekBase, 20000 + TORRENT_EXTRA_STARTUP_MS);
  playerVideo.load();
  playerVideo.play().catch(() => {});
  renderTorrentTime();
  reloadSubtitlesAtOffset(torrentSeekBase);
}
function torrentSeekBy(delta) {
  torrentSeekTo(seekTarget(absolutePosition(torrentSeekBase, playerVideo.currentTime), delta, torrentDuration));
}

function playTvSource(hash, season, episode, tried = [], startSec = 0, { manualSource = false } = {}) {
  if (!hash) return;
  stopHlsSession();
  stopTranscode();
  clearPlaybackHealth();
  playerVideo.onerror = null;
  playerVideo.onloadedmetadata = null;
  playerVideo.pause();
  playerVideo.removeAttribute('src');
  playerVideo.load();
  if (currentTorrentHash && currentTorrentHash !== hash) beaconStop(currentTorrentHash);
  clearYtsPoll();
  currentTorrentHash = hash;
  if (qualitySelect) qualitySelect.value = hash;

  const attempted = [...tried, hash];
  const src = currentTvSources.find((x) => x.hash === hash);
  if (src && qualitySelect) {
    const option = [...qualitySelect.options].find((item) => item.value === hash);
    if (option) option.textContent = describeTvSource(src);
  }
  setYtsStatus(describeSourceAttempt({ attempt: attempted.length, quality: src?.quality, remux: src?.remux, debrid: src?.debrid, transcode: src?.transcode }));

  // A fresh source starts at 0 and its length is unknown until the subtitle probe
  // returns it. The seek bar only helps for remuxed MKV; native <video> controls
  // already seek a direct MP4.
  tvPlayCtx = { hash, season, episode, src, manualSource };
  torrentSeekBase = startSec;
  torrentDuration = 0;
  showTorrentSeek(TV_HLS || Boolean(src?.remux));
  renderTorrentTime();

  // Ask the helper to give up on a peerless swarm quickly: the index's seed
  // counts include private trackers we cannot reach, so a dead top source is
  // routine and the useful move is the next source, not a longer wait.
  const recover = () => {
    const resumeAt = torrentSeekBase + (Number(playerVideo.currentTime) || 0);
    stopHlsSession();
    stopTranscode();
    clearPlaybackHealth();
    // A deliberate seek reloaded THIS source at a new offset. A transient error there
    // should retry the same source at the seek point, not cascade to a different
    // (often worse) one. Reset the flag so a persistent failure still cascades next.
    if (suppressSourceWalk) { suppressSourceWalk = false; return playTvSource(hash, season, episode, tried, torrentSeekBase, { manualSource }); }
    const next = pickNextSource(currentTvSources, attempted);
    if (next) return playTvSource(next.hash, season, episode, attempted, resumeAt);
    clearYtsPoll();
    setYtsStatus('No source could sustain playback. Choose another quality or try this episode again.', true);
  };
  const startupExtraMs = manualSource ? TORRENT_EXTRA_STARTUP_MS : 0;
  playerVideo.onplaying = () => { setYtsStatus(null); clearYtsPoll(); };
  playerVideo.onerror = recover;
  // HEVC delivery differs by client. On the TV (native HLS) it is GPU-transcoded
  // into the HLS pipeline (segmented files stream through the funnel; a single live
  // /transcode response gets buffered by the funnel and never arrives). On the
  // desktop (no native HLS) it is GPU-transcoded to a live fMP4 fed through
  // MediaSource. Both are handled below — the TV case falls through to prepareTvHls.
  if (src?.transcode && !TV_HLS) {
    const url = buildTvStreamUrl(hash, season, episode, src, startSec, 0);
    playTranscodeMse(url, recover);
    // Be patient before the first frame (download + GPU-encode + swarm ramp); the
    // connection watchdog still bails fast if the swarm is genuinely dead. HEVC only
    // needs its input bitrate, so a lower sustain bar than a direct 1080p stream.
    watchPlaybackHealth(recover, { startupMs: 90000 + startupExtraMs, source: src });
    watchConnectionHealth(hash, recover, { noPeersMs: 13000 + startupExtraMs, noDataMs: 22000 + startupExtraMs, minSustainBps: 300 * 1024, slowMs: 26000 + startupExtraMs, debrid: src?.debrid });
    startYtsStatusPolling(hash);
    loadSubtitlesFor(hash, season, episode, 0, src?.fileIndex);
    return;
  }
  if (TV_HLS) {
    // Remux (H.264 copy) or transcode (HEVC->H.264) — prepareTvHls picks based on src.
    prepareTvHls(hash, season, episode, src, startSec, recover, startupExtraMs);
    startYtsStatusPolling(hash);
    loadSubtitlesFor(hash, season, episode, 0, src?.fileIndex);
    return;
  }
  const ready = (attempted.length >= TV_SOURCE_ATTEMPT_CAP ? 30000 : 12000) + startupExtraMs;
  playerVideo.src = buildTvStreamUrl(hash, season, episode, src, startSec, ready);
  watchPlaybackHealth(recover, { startupMs: 30000 + startupExtraMs, source: src });
  watchConnectionHealth(hash, recover, { noPeersMs: 13000 + startupExtraMs, noDataMs: 22000 + startupExtraMs, slowMs: 20000 + startupExtraMs, debrid: src?.debrid }); // skip a dead swarm fast, reach a live source
  playerVideo.load();
  playerVideo.play().catch(() => { /* autoplay may be blocked; controls remain */ });
  startYtsStatusPolling(hash);
  loadSubtitlesFor(hash, season, episode, 0, src?.fileIndex);   // embedded tracks live inside the MKV
}

// Change video source
function changeSource(newIndex) {
  currentSourceIndex = newIndex;
  sourceSelect.value = newIndex; // Keep dropdown in sync
  if (!currentPlayingMovie) return;

  const source = EMBED_SOURCES[newIndex];

  // Torrent sources -> native <video> via the local helper. YTS covers movies;
  // torrentio covers shows (YTS has no TV catalogue).
  if (source && source.torrent) {
    playerIframe.src = '';
    if (source.tvOnly) loadTvStream(currentPlayingMovie, currentSeason, currentEpisode);
    else loadYtsStream(currentPlayingMovie);
    return;
  }

  const type = currentPlayingMovie.media_type === 'tv' ? 'tv' : 'movie';
  let url;
  if (type === 'tv' && currentTvData) {
    url = getEmbedUrl(type, currentPlayingMovie.id, currentSeason, currentEpisode);
  } else {
    url = getEmbedUrl(type, currentPlayingMovie.id);
  }

  console.log('Switching to source:', source.name, 'URL:', url);

  // Clear and reload
  playerIframe.src = '';
  setTimeout(() => loadIframeSrc(url), 50);
}

// Fetch TV show details (seasons)
async function fetchTvDetails(tvId) {
  try {
    return await fetchTmdbJson(ENDPOINTS.tvDetails(tvId));
  } catch (error) {
    console.error('Error fetching TV details:', error);
    return null;
  }
}

// Fetch season details (episodes)
async function fetchSeasonDetails(tvId, seasonNum) {
  try {
    return await fetchTmdbJson(ENDPOINTS.seasonDetails(tvId, seasonNum));
  } catch (error) {
    console.error('Error fetching season details:', error);
    return null;
  }
}

// Populate season dropdown
function populateSeasonSelect(seasons) {
  seasonSelect.innerHTML = '';
  // Filter out season 0 (specials) unless it's the only season
  const regularSeasons = seasons.filter(s => s.season_number > 0);
  const seasonsToShow = regularSeasons.length > 0 ? regularSeasons : seasons;

  seasonsToShow.forEach(season => {
    const option = document.createElement('option');
    option.value = season.season_number;
    option.textContent = `Season ${season.season_number}`;
    seasonSelect.appendChild(option);
  });
}

// Populate episode dropdown
function populateEpisodeSelect(episodes) {
  episodeSelect.innerHTML = '';
  const todayIso = new Date().toISOString().slice(0, 10);
  episodes.forEach(ep => {
    const option = document.createElement('option');
    option.value = ep.episode_number;
    const baseLabel = `E${ep.episode_number}: ${ep.name || 'Episode ' + ep.episode_number}`;
    if (ep.air_date) option.dataset.airDate = ep.air_date;
    if (ep.air_date && ep.air_date > todayIso) {
      option.textContent = `${baseLabel} — airs ${ep.air_date}`;
    } else {
      option.textContent = baseLabel;
    }
    episodeSelect.appendChild(option);
  });
}

// Update navigation buttons state
function updateNavButtons() {
  if (!currentTvData || !currentSeasonData) {
    prevEpisodeBtn.disabled = true;
    nextEpisodeBtn.disabled = true;
    return;
  }

  const seasons = currentTvData.seasons.filter(s => s.season_number > 0);
  const minSeason = seasons.length > 0 ? Math.min(...seasons.map(s => s.season_number)) : 1;
  const maxSeason = seasons.length > 0 ? Math.max(...seasons.map(s => s.season_number)) : 1;
  const maxEpisode = currentSeasonData.episodes?.length || 1;

  // Disable prev if at first episode of first season
  prevEpisodeBtn.disabled = (currentSeason === minSeason && currentEpisode === 1);

  // Disable next if at last episode of last season
  nextEpisodeBtn.disabled = (currentSeason === maxSeason && currentEpisode === maxEpisode);
}

// Play specific episode
function playEpisode(season, episode) {
  currentSeason = season;
  currentEpisode = episode;

  seasonSelect.value = season;
  episodeSelect.value = episode;

  const showName = currentPlayingMovie.name || currentPlayingMovie.title || 'Unknown';
  playerTitle.textContent = `${showName} - S${season}E${episode}`;

  const epData = currentSeasonData?.episodes?.find(e => e.episode_number === episode);
  const todayIso = new Date().toISOString().slice(0, 10);
  if (epData?.air_date && epData.air_date > todayIso) {
    playerIframe.src = '';
    playerIframe.srcdoc = `
      <html>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#fff;font-family:sans-serif;text-align:center;padding:1rem;">
          <div>
            <p style="font-size:1.4rem;margin:0 0 .5rem;">Not yet aired</p>
            <p style="color:#aaa;font-size:1rem;margin:0;">${epData.name || 'Episode ' + episode} airs on ${epData.air_date}</p>
          </div>
        </body>
      </html>
    `;
  } else if (EMBED_SOURCES[currentSourceIndex]?.tvOnly) {
    // Torrent source: every episode is a different torrent, so re-resolve.
    loadTvStream(currentPlayingMovie, season, episode);
  } else {
    const embedUrl = getEmbedUrl('tv', currentPlayingMovie.id, season, episode);
    loadIframeSrc(embedUrl);
  }

  saveWatchProgress(currentPlayingMovie.id, season, episode);
  recordEpisode(currentPlayingMovie.id, season, episode);
  updateNavButtons();
}

// Go to next episode
async function goToNextEpisode() {
  if (!currentTvData || !currentSeasonData) return;

  const maxEpisode = currentSeasonData.episodes?.length || 1;

  if (currentEpisode < maxEpisode) {
    // Next episode in same season
    playEpisode(currentSeason, currentEpisode + 1);
  } else {
    // Go to next season
    const seasons = currentTvData.seasons.filter(s => s.season_number > 0);
    const maxSeason = Math.max(...seasons.map(s => s.season_number));

    if (currentSeason < maxSeason) {
      const nextSeason = currentSeason + 1;
      currentSeasonData = await fetchSeasonDetails(currentPlayingMovie.id, nextSeason);
      if (currentSeasonData && currentSeasonData.episodes) {
        populateEpisodeSelect(currentSeasonData.episodes);
        playEpisode(nextSeason, 1);
      }
    }
  }
}

// Go to previous episode
async function goToPrevEpisode() {
  if (!currentTvData || !currentSeasonData) return;

  if (currentEpisode > 1) {
    // Previous episode in same season
    playEpisode(currentSeason, currentEpisode - 1);
  } else {
    // Go to previous season
    const seasons = currentTvData.seasons.filter(s => s.season_number > 0);
    const minSeason = Math.min(...seasons.map(s => s.season_number));

    if (currentSeason > minSeason) {
      const prevSeason = currentSeason - 1;
      currentSeasonData = await fetchSeasonDetails(currentPlayingMovie.id, prevSeason);
      if (currentSeasonData && currentSeasonData.episodes) {
        populateEpisodeSelect(currentSeasonData.episodes);
        const lastEpisode = currentSeasonData.episodes.length;
        playEpisode(prevSeason, lastEpisode);
      }
    }
  }
}

// Handle season change
async function handleSeasonChange(seasonNum) {
  currentSeason = parseInt(seasonNum, 10);
  currentSeasonData = await fetchSeasonDetails(currentPlayingMovie.id, currentSeason);

  if (currentSeasonData && currentSeasonData.episodes) {
    populateEpisodeSelect(currentSeasonData.episodes);
    playEpisode(currentSeason, 1);
  }
}

// Handle episode change
function handleEpisodeChange(episodeNum) {
  playEpisode(currentSeason, parseInt(episodeNum, 10));
}

async function openPlayer(movie, target = null) {
  // Begin engagement capture for this title. Watched status is NOT set on open — it is
  // committed later by flushDwell() once enough active watch-tab time has accrued.
  livePlayer.stop(); // an on-demand title replaces any live stream that did not close cleanly
  flushDwell(); // flush any prior session that didn't close cleanly (may mark it watched)
  dwellTitleId = movie.id;
  dwellMovie = movie;
  activePlayerTab = 'watch';
  watchTimer.reset();
  recordOpen(movie.id);

  const title = movie.title || movie.name || 'Unknown';
  const type = movie.media_type === 'tv' ? 'tv' : 'movie';
  // Resume position (seconds) from the details screen's Resume button, else 0 (start).
  const startSec = target && Number.isFinite(target.startSec) ? Math.max(0, Math.floor(target.startSec)) : 0;

  // Store current movie for source switching
  currentPlayingMovie = movie;

  // Sync the player-header star + downvote to this title, kept mutually exclusive.
  if (playerStarBtn) {
    const syncPlayerStar = () => {
      const on = isStarred(movie.id);
      playerStarBtn.classList.toggle('starred', on);
      playerStarBtn.setAttribute('aria-pressed', String(on));
      playerStarBtn.title = on ? 'Remove from favorites' : 'Add to favorites';
      playerStarBtn.innerHTML = on ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
    };
    const syncPlayerDown = () => {
      if (!playerDownBtn) return;
      const on = isDownvoted(movie.id);
      playerDownBtn.classList.toggle('downvoted', on);
      playerDownBtn.setAttribute('aria-pressed', String(on));
      playerDownBtn.setAttribute('aria-label', on ? 'Remove downvote' : 'Not interested (downvote)');
      playerDownBtn.title = on ? 'Remove downvote' : 'Not interested';
      playerDownBtn.innerHTML = on ? DOWN_FILLED_SVG : DOWN_OUTLINE_SVG;
    };
    syncPlayerStar();
    syncPlayerDown();
    playerStarBtn.onclick = (e) => { e.stopPropagation(); toggleStar(movie); syncPlayerStar(); syncPlayerDown(); onSignalChanged(); };
    playerStarBtn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); };
    if (playerDownBtn) {
      playerDownBtn.onclick = (e) => { e.stopPropagation(); toggleDownvote(movie); syncPlayerStar(); syncPlayerDown(); onSignalChanged(); };
      playerDownBtn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); };
    }
  }

  // Reset TV state
  currentTvData = null;
  currentSeasonData = null;
  currentSeason = 1;
  currentEpisode = 1;

  // Reset state
  trailerIframe.src = '';
  currentTrailerKey = null;
  stopYtsStream();
  showPlayerVideo(false);

  // If the previously selected source isn't valid for this title (e.g. a
  // movies-only torrent source while opening a TV show), fall back to the first.
  if (!tvSourceChosenManually) {
    // Default to the native torrent source in BOTH the TV app and the desktop app:
    // the embed providers (Videasy, 111Movies et al.) now load a blank/CAPTCHA'd
    // player, whereas torrents stream through the helper with no such challenge.
    // Fall back to the 111Movies embed only when no helper is reachable (torrents
    // need it). Previously this ran only in TV_MODE, so the desktop app opened
    // shows onto the dead Videasy embed.
    const torrentDefault = HELPER_AVAILABLE
      ? EMBED_SOURCES.findIndex(s => s.torrent && (type === 'tv' ? s.tvOnly : s.movieOnly))
      : -1;
    currentSourceIndex = torrentDefault >= 0
      ? torrentDefault
      : EMBED_SOURCES.findIndex(source => source.name === '111Movies');
  }
  const sel = EMBED_SOURCES[currentSourceIndex];
  if (sel && sel.torrent && ((sel.movieOnly && type === 'tv') || (sel.tvOnly && type !== 'tv'))) {
    currentSourceIndex = HELPER_AVAILABLE
      ? EMBED_SOURCES.findIndex(source => source.torrent && (type === 'tv' ? source.tvOnly : source.movieOnly)) : 0;
  }

  // Rebuild the source list for this title (shows/hides the YTS torrent source).
  populateSourceSelector();

  // Update source selector
  sourceSelect.value = currentSourceIndex;

  // Handle TV shows with episode selection
  if (type === 'tv') {
    episodeControls.style.display = 'flex';

    // Fetch TV show details
    currentTvData = await fetchTvDetails(movie.id);

    if (currentTvData && currentTvData.seasons && currentTvData.seasons.length > 0) {
      populateSeasonSelect(currentTvData.seasons);

      // Check for saved progress
      const savedProgress = getWatchProgress(movie.id);

      // Get first valid season (skip season 0/specials if possible)
      const regularSeasons = currentTvData.seasons.filter(s => s.season_number > 0);
      const firstSeason = regularSeasons.length > 0 ? regularSeasons[0].season_number : currentTvData.seasons[0].season_number;

      // Use saved progress if available, otherwise start from beginning
      if (savedProgress) {
        currentSeason = savedProgress.season;
        currentEpisode = savedProgress.episode;
      } else {
        currentSeason = firstSeason;
        currentEpisode = 1;
      }

      // An explicit target from the details screen's episode list wins over both.
      if (target && Number.isFinite(target.season) && Number.isFinite(target.episode)) {
        currentSeason = target.season;
        currentEpisode = target.episode;
      }

      seasonSelect.value = currentSeason;

      // Fetch episodes for the season
      currentSeasonData = await fetchSeasonDetails(movie.id, currentSeason);

      if (currentSeasonData && currentSeasonData.episodes) {
        populateEpisodeSelect(currentSeasonData.episodes);

        // Validate that the saved episode exists in this season
        const maxEpisode = currentSeasonData.episodes.length;
        if (currentEpisode > maxEpisode) {
          currentEpisode = 1;
        }

        episodeSelect.value = currentEpisode;
      }

      // Play the episode
      const epData = currentSeasonData?.episodes?.find(e => e.episode_number === currentEpisode);
      const todayIso = new Date().toISOString().slice(0, 10);
      if (epData?.air_date && epData.air_date > todayIso) {
        playerIframe.src = '';
        playerIframe.srcdoc = `
          <html>
            <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#fff;font-family:sans-serif;text-align:center;padding:1rem;">
              <div>
                <p style="font-size:1.4rem;margin:0 0 .5rem;">Not yet aired</p>
                <p style="color:#aaa;font-size:1rem;margin:0;">${epData.name || 'Episode ' + currentEpisode} airs on ${epData.air_date}</p>
              </div>
            </body>
          </html>
        `;
      } else if (EMBED_SOURCES[currentSourceIndex]?.tvOnly) {
        loadTvStream(movie, currentSeason, currentEpisode, startSec);
      } else {
        const embedUrl = getEmbedUrl(type, movie.id, currentSeason, currentEpisode);
        loadIframeSrc(embedUrl);
      }
      playerTitle.textContent = `${title} - S${currentSeason}E${currentEpisode}`;

      updateNavButtons();
    } else {
      // Fallback if no season data
      if (EMBED_SOURCES[currentSourceIndex]?.tvOnly) loadTvStream(movie, 1, 1);
      else {
        const embedUrl = getEmbedUrl(type, movie.id);
        loadIframeSrc(embedUrl);
      }
      playerTitle.textContent = title;
      episodeControls.style.display = 'none';
    }
  } else {
    // Movie - no episode controls
    episodeControls.style.display = 'none';
    playerTitle.textContent = title;
    // An unreleased movie (future release date) has no torrent and no embed —
    // trying to play it just yields a dead "No YTS torrent found" lookup. This is
    // the trap behind e.g. "Mirzapur: The Movie" (2026) sitting next to the series
    // in search. Say it plainly instead.
    const todayIso = new Date().toISOString().slice(0, 10);
    if (movie.release_date && movie.release_date > todayIso) {
      showPlayerVideo(false);
      stopYtsStream();
      playerIframe.src = '';
      playerIframe.srcdoc = `
        <html>
          <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#fff;font-family:sans-serif;text-align:center;padding:1rem;">
            <div>
              <p style="font-size:1.4rem;margin:0 0 .5rem;">Not released yet</p>
              <p style="color:#aaa;font-size:1rem;margin:0;">${title} releases on ${movie.release_date}</p>
            </div>
          </body>
        </html>
      `;
    } else {
      const sourceNow = EMBED_SOURCES[currentSourceIndex];
      if (sourceNow && sourceNow.torrent) {
        loadYtsStream(movie, startSec);
      } else {
        const embedUrl = getEmbedUrl(type, movie.id);
        loadIframeSrc(embedUrl);
      }
    }
  }

  // Reset tabs to Watch
  switchTab('watch');

  // Show modal
  playerModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  playerModalOpen = true;
  syncWatchTimer(); // start counting active watch-tab time now that the modal is visible

  // Fetch trailer in background
  const trailerKey = await fetchTrailers(type, movie.id);
  currentTrailerKey = trailerKey;

  // Enable/disable trailer tab based on availability
  if (trailerKey) {
    tabTrailer.disabled = false;
    tabTrailer.title = 'Watch trailer';
  } else {
    tabTrailer.disabled = true;
    tabTrailer.title = 'No trailer available';
  }
}

// Close video player modal
function closePlayer() {
  savePlaybackPosition(); // capture the final position before we tear the player down
  livePlayer.stop(); // after the save: stop() must never touch an on-demand position
  delete playerModal.dataset.live;
  playerModalOpen = false;
  const recommendationsChanged = flushDwell();
  playerModal.style.display = 'none';
  stopYtsStream();
  showPlayerVideo(false);
  playerIframe.src = '';
  trailerIframe.src = '';
  currentTrailerKey = null;
  currentPlayingMovie = null;
  currentTvData = null;
  currentSeasonData = null;
  document.body.style.overflow = '';
  if (recommendationsChanged) onSignalChanged();
}

// Show/hide loading state
function setLoading(isLoading) {
  // A grid/search load must not hide the Live home behind the spinner.
  if (isLoading && liveHomeOwnsMain()) return;
  if (loadingEl) {
    loadingEl.style.display = isLoading ? 'flex' : 'none';
  }
  main.style.display = isLoading ? 'none' : 'flex';
}

// Show error message
function showError(message) {
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }
  main.innerHTML = '';
}

// Hide error message
function hideError() {
  if (errorEl) {
    errorEl.style.display = 'none';
  }
}

// Check if cache is valid
function isCacheValid() {
  return cache.trending && cache.timestamp &&
         (Date.now() - cache.timestamp < CONFIG.CACHE_DURATION);
}

// Fetch with error handling — TMDB list/discover pages go through the shared
// rate-limited queue like everything else (throws on persistent failure).
async function fetchWithErrorHandling(url) {
  return fetchTmdbJson(url);
}

// Populate genre dropdown based on media type
function populateGenres(mediaType) {
  genreSelect.innerHTML = '';
  genreMetadata.clear();

  let genres;
  if (mediaType === 'movie') {
    genres = MOVIE_GENRES;
  } else if (mediaType === 'tv') {
    genres = TV_GENRES;
  } else {
    // For 'all', combine unique genres
    const allGenres = [...MOVIE_GENRES];
    TV_GENRES.forEach(tvGenre => {
      if (!allGenres.find(g => g.id === tvGenre.id)) {
        allGenres.push(tvGenre);
      }
    });
    genres = allGenres.sort((a, b) => a.name.localeCompare(b.name));
    // Move "All Genres" to top
    genres = [{ id: 0, name: 'All Genres' }, ...genres.filter(g => g.id !== 0)];
  }

  genres.forEach(genre => {
    const option = document.createElement('option');
    option.value = genre.id;
    option.textContent = genre.name;
    genreSelect.appendChild(option);
    // Store metadata for keyword detection
    genreMetadata.set(genre.id, { isKeyword: genre.type === 'keyword' });
  });

  // Reset genre selection
  currentFilters.genre = 0;
  currentFilters.genreIsKeyword = false;
  genreSelect.value = '0';
}

// Populate theme dropdown
function populateThemes() {
  themeSelect.innerHTML = '';
  THEME_KEYWORDS.forEach(theme => {
    const option = document.createElement('option');
    option.value = theme.id;
    option.textContent = theme.name;
    themeSelect.appendChild(option);
  });
}

// Filter movies based on current filters
function applyFilters(movies, isSearch = false) {
  const isActorFilter = currentFilters.actorId > 0;
  const isTop250 = isTop250Mode;

  return movies.filter(movie => {
    // Skip non-movie/tv results (like "person" from search)
    if (movie.media_type !== 'movie' && movie.media_type !== 'tv') {
      return false;
    }

    // Media type filter (explicit filter, or the TV top-nav kind)
    const wantType = effectiveMediaType();
    if (wantType !== 'all' && movie.media_type !== wantType) {
      return false;
    }

    // Genre filter (skip if genre is keyword-based, as it's filtered server-side)
    if (currentFilters.genre !== 0 && !currentFilters.genreIsKeyword && !movie.genre_ids?.includes(currentFilters.genre)) {
      return false;
    }

    // Exclude genres filter - always apply client-side for all modes
    if (currentFilters.excludeGenres.length > 0 && movie.genre_ids) {
      const hasExcludedGenre = currentFilters.excludeGenres.some(genreId => movie.genre_ids.includes(genreId));
      if (hasExcludedGenre) {
        return false;
      }
    }

    // Language filter - always apply client-side for all modes
    if (currentFilters.language && movie.original_language !== currentFilters.language) {
      return false;
    }

    // Provider filter - only apply client-side for search/actor/top250 modes
    // For trending mode, provider filtering is done via discover API
    if (currentFilters.provider !== 0 && (isSearch || isActorFilter || isTop250)) {
      // Skip movies without provider info in these modes
      if (!movie.providerIds || !movie.providerIds.includes(currentFilters.provider)) {
        return false;
      }
    }

    // For search results, actor filmography, or Top 250, skip quality filters
    if (isSearch || isActorFilter || isTop250) {
      return true;
    }

    // Minimum rating filter (for trending)
    if (currentFilters.minRating > 0 && movie.vote_average < currentFilters.minRating) {
      return false;
    }

    // Minimum votes filter (for trending)
    if (currentFilters.minVotes > 0 && movie.vote_count < currentFilters.minVotes) {
      return false;
    }

    // Year filter (only if it's a numeric year like 2024, 2020, etc.)
    const yearFilter = currentFilters.yearFilter;
    if (yearFilter !== 'all' && yearFilter !== 'newest' && yearFilter !== 'oldest') {
      const minYear = parseInt(yearFilter, 10);
      const movieYear = Number(movie.release_date?.split('-')[0] || movie.first_air_date?.split('-')[0] || 0);
      if (movieYear < minYear) {
        return false;
      }
    }

    // Basic quality filter (minimum vote count)
    return movie.vote_count >= CONFIG.MIN_VOTE_COUNT;
  });
}

// Calculate ranking stats including mean rating
function calculateStats(movies) {
  if (movies.length === 0) {
    return { minCount: 0, maxCount: 0, minRating: 0, maxRating: 0, meanRating: 0 };
  }

  let minCount = Infinity, maxCount = 0;
  let minRating = Infinity, maxRating = 0;
  let totalRating = 0;

  movies.forEach(movie => {
    minCount = Math.min(minCount, movie.vote_count);
    maxCount = Math.max(maxCount, movie.vote_count);
    minRating = Math.min(minRating, movie.vote_average);
    maxRating = Math.max(maxRating, movie.vote_average);
    totalRating += movie.vote_average;
  });

  const meanRating = totalRating / movies.length;

  return { minCount, maxCount, minRating, maxRating, meanRating };
}

// Sort movies based on selected sort option; scoring lives in scoring.js
// (Bayesian rating-first: the weighted score IS a confidence-weighted 0-10 rating).
function sortMovies(movies, stats) {
  if (!movies || movies.length === 0) return [];

  // Calculate weighted score for all movies (used for weighted sort and display)
  const moviesWithScore = movies.map(movie => {
    const score = calculateScore(movie);
    return {
      ...movie,
      weightedScore: parseFloat(score.toFixed(2))
    };
  });

  if (isTop250Mode) {
    return moviesWithScore.sort((a, b) => a.imdb_rank - b.imdb_rank);
  }

  // Sort based on current sort option
  const sortBy = currentFilters.sortBy;

  return moviesWithScore.sort((a, b) => {
    switch (sortBy) {
      case 'rating':
        return (b.vote_average || 0) - (a.vote_average || 0);

      case 'votes':
        return (b.vote_count || 0) - (a.vote_count || 0);

      case 'newest-weighted':
        // Recency ladder applied to the above-baseline portion of the weighted score
        const yearANW = parseInt((a.release_date || a.first_air_date || '0').split('-')[0]) || 0;
        const yearBNW = parseInt((b.release_date || b.first_air_date || '0').split('-')[0]) || 0;
        return newestWeightedScore(b.weightedScore, yearBNW) - newestWeightedScore(a.weightedScore, yearANW);

      case 'year-new':
        const yearA = parseInt((a.release_date || a.first_air_date || '0').split('-')[0]) || 0;
        const yearB = parseInt((b.release_date || b.first_air_date || '0').split('-')[0]) || 0;
        return yearB - yearA;

      case 'year-old':
        const yearA2 = parseInt((a.release_date || a.first_air_date || '9999').split('-')[0]) || 9999;
        const yearB2 = parseInt((b.release_date || b.first_air_date || '9999').split('-')[0]) || 9999;
        return yearA2 - yearB2;

      case 'title':
        const titleA = (a.title || a.name || '').toLowerCase();
        const titleB = (b.title || b.name || '').toLowerCase();
        return titleA.localeCompare(titleB);

      case 'weighted':
      default:
        return b.weightedScore - a.weightedScore;
    }
  });
}

// Fetch more trending pages from API (or discover API if provider/theme/exclude filter is active)
// Helper function to delay execution
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Map the app's sort options to TMDB discover sort_by values (TV filter view).
function tmdbSortBy(sortBy, type) {
  const dateField = type === 'tv' ? 'first_air_date' : 'primary_release_date';
  switch (sortBy) {
    case 'rating': return 'vote_average.desc';
    case 'votes': return 'vote_count.desc';
    case 'year-new': return `${dateField}.desc`;
    case 'year-old': return `${dateField}.asc`;
    case 'title': return type === 'tv' ? 'popularity.desc' : 'original_title.asc';
    default: return 'popularity.desc'; // weighted / newest-weighted / unset
  }
}

async function fetchMoreTrending(pagesToFetch = 5, abortToken) {
  if (!hasMorePages) return [];

  const providerId = currentFilters.provider;
  const themeId = currentFilters.theme;
  const excludeGenres = currentFilters.excludeGenres.length > 0 ? currentFilters.excludeGenres.join(',') : null;
  const language = currentFilters.language || null;
  const mediaType = effectiveMediaType();
  const minVotes = currentFilters.minVotes || null;

  // Combine keyword IDs: theme + genre (if genre is keyword-based)
  let keywordId = themeId;
  if (currentFilters.genreIsKeyword && currentFilters.genre > 0) {
    keywordId = themeId > 0 ? `${themeId},${currentFilters.genre}` : currentFilters.genre;
  }

  // On TV, standard genre/rating/year/sort also go through discover so filtering
  // returns the full catalogue, not a client-filter of the small trending pool.
  const genreId = TV_MODE && !currentFilters.genreIsKeyword && currentFilters.genre > 0 ? currentFilters.genre : null;
  const minRating = TV_MODE ? (currentFilters.minRating || null) : null;
  const yearGte = TV_MODE && /^\d{4}$/.test(String(currentFilters.yearFilter)) ? currentFilters.yearFilter : null;
  const tvSort = TV_MODE && currentFilters.sortBy && currentFilters.sortBy !== 'weighted' && currentFilters.sortBy !== 'newest-weighted';

  // Use discover API if any filter is active
  const useDiscoverApi = providerId > 0 || keywordId || excludeGenres || language || minVotes || genreId || minRating || yearGte || tvSort;

  // Fetch in batches to avoid TMDB rate limiting (40 req/10s)
  const BATCH_SIZE = 10; // Requests per batch
  const BATCH_DELAY = 300; // ms between batches
  const allNewMovies = [];
  let totalPagesAvailable = Infinity;

  for (let batchStart = 0; batchStart < pagesToFetch && hasMorePages; batchStart += BATCH_SIZE) {
    // A newer load reset the fetch state — appending this query's pages would pollute it.
    if (abortToken !== undefined && abortToken !== gridLoadToken) break;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, pagesToFetch);
    const promises = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const page = currentApiPage + 1 + i;
      if (page > 500 || page > totalPagesAvailable) break; // TMDB max pages or no more data

      if (useDiscoverApi) {
        // TV routes through discoverFull (genre/rating/year/sort aware); desktop keeps
        // its existing discover calls so its behaviour is unchanged.
        const disc = (t) => TV_MODE
          ? ENDPOINTS.discoverFull(t, page, { genreId, keywordId, excludeGenres, language, minVotes, minRating, yearGte, sortBy: tmdbSortBy(currentFilters.sortBy, t), providerId })
          : (t === 'movie'
              ? ENDPOINTS.discoverMovies(page, providerId, keywordId, excludeGenres, language, minVotes)
              : ENDPOINTS.discoverTv(page, providerId, keywordId, excludeGenres, language, minVotes));
        if (mediaType === 'movie') {
          promises.push(fetchWithErrorHandling(disc('movie')).catch(() => null));
        } else if (mediaType === 'tv') {
          promises.push(fetchWithErrorHandling(disc('tv')).catch(() => null));
        } else {
          // For 'all', fetch both movies and TV
          promises.push(fetchWithErrorHandling(disc('movie')).catch(() => null));
          promises.push(fetchWithErrorHandling(disc('tv')).catch(() => null));
        }
      } else {
        promises.push(fetchWithErrorHandling(ENDPOINTS.trending(page)).catch(() => null));
      }
    }

    if (promises.length === 0) break;

    const responses = await Promise.all(promises);

    responses.forEach(data => {
      if (!data?.results) return;
      // Track total pages to stop early
      if (data.total_pages) {
        totalPagesAvailable = Math.min(totalPagesAvailable, data.total_pages);
      }
      data.results.forEach(movie => {
        if (!seenIds.has(movie.id)) {
          seenIds.add(movie.id);
          if (!movie.media_type) {
            movie.media_type = movie.title ? 'movie' : 'tv';
          }
          allNewMovies.push(movie);
        }
      });
    });

    currentApiPage += (batchEnd - batchStart);

    // Check if we've fetched all available pages
    if (currentApiPage >= totalPagesAvailable) {
      hasMorePages = false;
      break;
    }

    // Add delay between batches to avoid rate limiting (skip delay on last batch)
    if (batchEnd < pagesToFetch && hasMorePages) {
      await delay(BATCH_DELAY);
    }
  }

  allMovies = [...allMovies, ...allNewMovies];
  return allNewMovies;
}

// Quality-gems pool widening: trending/popularity feeds only supply titles with buzz, so a
// well-rated low-buzz release can never appear no matter how the client sorts. Two passes:
// recent gems (vote floor 300, last 3 years) so "good but not famous" new titles are sortable,
// and all-time classics (no date floor, high vote floor) so the weighted sort can surface
// established greats like Interstellar or The Matrix that never trend anymore.
const GEM_PAGES_PER_TYPE = 5;
const GEM_WINDOW_YEARS = 3;
const CLASSIC_VOTE_FLOOR_MOVIE = 5000;
const CLASSIC_VOTE_FLOOR_TV = 2000;

async function fetchQualityGems(pagesPerType = GEM_PAGES_PER_TYPE) {
  const providerId = currentFilters.provider;
  const excludeGenres = currentFilters.excludeGenres.length > 0 ? currentFilters.excludeGenres.join(',') : null;
  const language = currentFilters.language || null;
  const mediaType = effectiveMediaType();
  const minVotes = currentFilters.minVotes || 0;
  let keywordId = currentFilters.theme;
  if (currentFilters.genreIsKeyword && currentFilters.genre > 0) {
    keywordId = keywordId > 0 ? `${keywordId},${currentFilters.genre}` : currentFilters.genre;
  }
  const dateGte = `${new Date().getFullYear() - GEM_WINDOW_YEARS}-01-01`;

  const promises = [];
  for (let page = 1; page <= pagesPerType; page++) {
    if (mediaType === 'all' || mediaType === 'movie') {
      promises.push(fetchWithErrorHandling(ENDPOINTS.discoverMoviesByRating(page, providerId, keywordId, excludeGenres, language, minVotes, dateGte)).catch(() => null));
    }
    if (mediaType === 'all' || mediaType === 'tv') {
      promises.push(fetchWithErrorHandling(ENDPOINTS.discoverTvByRating(page, providerId, keywordId, excludeGenres, language, minVotes, dateGte)).catch(() => null));
    }
  }

  // All-time classics pass: no date floor, high vote floor keeps it to established titles
  for (let page = 1; page <= pagesPerType; page++) {
    if (mediaType === 'all' || mediaType === 'movie') {
      promises.push(fetchWithErrorHandling(ENDPOINTS.discoverMoviesByRating(page, providerId, keywordId, excludeGenres, language, Math.max(minVotes, CLASSIC_VOTE_FLOOR_MOVIE), null)).catch(() => null));
    }
    if (mediaType === 'all' || mediaType === 'tv') {
      promises.push(fetchWithErrorHandling(ENDPOINTS.discoverTvByRating(page, providerId, keywordId, excludeGenres, language, Math.max(minVotes, CLASSIC_VOTE_FLOOR_TV), null)).catch(() => null));
    }
  }

  const responses = await Promise.all(promises);
  const gems = [];
  responses.forEach(data => {
    if (!data?.results) return;
    data.results.forEach(movie => {
      if (!seenIds.has(movie.id)) {
        seenIds.add(movie.id);
        if (!movie.media_type) {
          movie.media_type = movie.title ? 'movie' : 'tv';
        }
        gems.push(movie);
      }
    });
  });

  allMovies = [...allMovies, ...gems];
  return gems;
}

// Reset fetch state
// Bumped on every fresh grid load; in-flight background pool-deepening from a previous
// load checks it and aborts instead of appending a stale query's pages.
let gridLoadToken = 0;

function resetFetchState() {
  gridLoadToken++;
  allMovies = [];
  filteredMovies = [];
  displayedCount = 0;
  currentApiPage = 0;
  hasMorePages = true;
  seenIds.clear();
}

// Process and display movies with current filters
// Monotonic token: only the LATEST grid render may apply its deferred enrichment
// re-sort. Any newer processAndDisplayMovies call (filter change, new search) or a
// tab switch supersedes the pending one.
let gridEnrichToken = 0;

async function processAndDisplayMovies(movies, isSearch = false) {
  const filtered = applyFilters(movies, isSearch);
  const stats = calculateStats(filtered);

  // FIRST PAINT with TMDB-only scores: awaiting ~100 enrichment fetches (OMDb +
  // providers + credits) kept the grid on a spinner for tens of seconds on a cold
  // cache. Paint the provisional order now; refine it in the background.
  filteredMovies = sortMovies(filtered, stats);
  displayedCount = 0;

  // The home is the Live one: a late trending load must not clobber it (nor paint
  // "No movies found"). Keep the result as the seed for when the user leaves Live.
  if (liveHomeCurrent()) {
    if (filteredMovies.length) lastTrendingSeed = filteredMovies;
    if (!liveHomeOwnsMain()) renderLiveHome(); // e.g. a search was cleared under Live
    return;
  }

  main.innerHTML = '';

  if (filteredMovies.length === 0) {
    const noResults = document.createElement('p');
    noResults.className = 'no-results';
    noResults.textContent = 'No movies found matching your filters.';
    main.appendChild(noResults);
    return;
  }

  // TV home: curated, distinct rows instead of one trending page sliced up.
  if (tvHomeIsCurrent()) { renderTvHome(filteredMovies); return; }

  loadMoreMovies();
  if (TV_MODE) return;

  // Enrich the provisional top 100 (per the active sort), not the first 100 in fetch
  // order: fetch order is trending/popularity, so rank contenders outside it would
  // never receive their IMDb/RT cross-check. sortMovies returns copies, so map the
  // top ids back to the pool objects and enrich those in place — enrichment then
  // persists across re-renders. When done, re-sort + re-render IN PLACE (scroll kept)
  // unless a newer render or another view took over the grid meanwhile.
  const topKeys = new Set(filteredMovies.slice(0, 100).map(m => `${m.media_type}:${m.id}`));
  const token = ++gridEnrichToken;
  enrichMoviesWithRatings(filtered.filter(m => topKeys.has(`${m.media_type}:${m.id}`)))
    .then(() => {
      if (token !== gridEnrichToken) return;                       // superseded render
      if (currentApp !== 'movies' || isWatchedMode || isFavoritesMode) return;
      if (tabRecommended.classList.contains('active')) return;     // rec page owns #main
      if (tvMediaKind === 'live') return;                          // Live home owns #main
      const scrollY = window.scrollY;
      filteredMovies = sortMovies(filtered, stats);
      displayedCount = 0;
      main.innerHTML = '';
      loadMoreMovies();
      window.scrollTo(0, scrollY);
    })
    .catch((e) => console.warn('background enrichment failed:', e));
}

// Search movies
async function searchMovies(query) {
  const data = await fetchWithErrorHandling(ENDPOINTS.search(query));
  return data.results || [];
}

// Build a single purpose-built recommendation card (poster-forward, reason-first).
// Deliberately NOT createMovieCard — Discover candidates lack RT/votes/director,
// so the heavy browse card renders empty fields. This is a lean, curated card.
// >>> REC-HARNESS-EXPORT createRecommendationCard
function createRecommendationCard(rec, index) {
  const movie = rec.movie;
  const displayTitle = movie.title || movie.name || 'Unknown';
  const year = movie.release_date?.split('-')[0] || movie.first_air_date?.split('-')[0] || '';
  const isTv = movie.media_type === 'tv';
  const kind = isTv ? 'Series' : 'Film';
  const rating = typeof movie.vote_average === 'number' && movie.vote_average > 0
    ? movie.vote_average.toFixed(1) : null;

  const card = document.createElement('article');
  card.className = 'rec-card';
  card.style.setProperty('--i', index);
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `${displayTitle}${year ? `, ${year}` : ''}, ${kind}. ${rec.reasons[0] || ''}`);

  // Poster with overlaid scrim, rank, type tag, play affordance.
  const poster = document.createElement('div');
  poster.className = 'rec-poster';

  const img = document.createElement('img');
  img.className = 'rec-art';
  img.loading = 'lazy';
  img.alt = `${displayTitle} poster`;
  img.src = movie.poster_path
    ? CONFIG.IMAGE_URL + movie.poster_path
    : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='450'><rect width='300' height='450' fill='%231b1d3e'/><text x='50%25' y='50%25' fill='%236b6f9c' font-size='20' text-anchor='middle' font-family='sans-serif'>No Art</text></svg>";
  poster.appendChild(img);

  const rank = document.createElement('span');
  rank.className = 'rec-rank';
  rank.textContent = String(index + 1).padStart(2, '0');
  poster.appendChild(rank);

  const typeTag = document.createElement('span');
  typeTag.className = 'rec-type';
  typeTag.textContent = kind;
  poster.appendChild(typeTag);

  const play = document.createElement('span');
  play.className = 'rec-play';
  play.setAttribute('aria-hidden', 'true');
  play.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  poster.appendChild(play);

  const scrim = document.createElement('div');
  scrim.className = 'rec-scrim';
  const titleEl = document.createElement('h3');
  titleEl.className = 'rec-title';
  titleEl.textContent = displayTitle;
  scrim.appendChild(titleEl);
  const sub = document.createElement('div');
  sub.className = 'rec-sub';
  if (rating) {
    const star = document.createElement('span');
    star.className = 'rec-rating';
    star.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.3 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg>${rating}`;
    sub.appendChild(star);
  }
  if (year) {
    const yr = document.createElement('span');
    yr.className = 'rec-year';
    yr.textContent = year;
    sub.appendChild(yr);
  }
  scrim.appendChild(sub);
  poster.appendChild(scrim);
  poster.appendChild(createStarButton(movie));
  poster.appendChild(createLikeButton(movie));
  poster.appendChild(createSeenButton(movie));
  poster.appendChild(createDownvoteButton(movie));
  card.appendChild(poster);

  // The "why" — theme-led, with an optional dominant title.
  const because = document.createElement('p');
  because.className = 'rec-because';
  because.innerHTML =
    '<svg class="rec-spark" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 2l1.6 5.2L19 9l-5.4 1.8L12 16l-1.6-5.2L5 9l5.4-1.8z"/></svg>';
  const theme = rec.reasons[0] || 'Picked for your taste';
  because.appendChild(document.createTextNode(theme));
  const collab = (movie._seeds || []).find((s) => s.source === 'rec' || s.source === 'similar');
  if (collab) because.setAttribute('data-rec-source', collab.source);
  const espMatch = (rec.reasons[1] || '').match(/^esp\. (.+)$/);
  if (espMatch) {
    because.appendChild(document.createTextNode(' · esp. '));
    const b = document.createElement('b');
    b.textContent = espMatch[1];
    because.appendChild(b);
  }
  card.appendChild(because);

  const handleClick = () => openPlayer(movie);
  card.addEventListener('click', handleClick);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); }
  });
  return card;
}
// <<< REC-HARNESS-EXPORT createRecommendationCard

// Shimmer placeholder rails shown immediately in a VISIBLE #main while the first real
// rows resolve. Mirrors .rec-rail-section structure so replacing a skeleton with a real
// rail causes no layout shift. Card count is fixed so the reserved height is deterministic.
function buildRecSkeleton(count = 3) {
  const frag = document.createDocumentFragment();
  for (let s = 0; s < count; s++) {
    const section = document.createElement('section');
    section.className = 'rec-rail-section rec-skeleton';
    const header = document.createElement('div');
    header.className = 'rec-header';
    const kick = document.createElement('span');
    kick.className = 'rec-kicker rec-skel-line';
    header.appendChild(kick);
    const head = document.createElement('h2');
    head.className = 'rec-heading rec-skel-line rec-skel-line--wide';
    header.appendChild(head);
    section.appendChild(header);
    const rail = document.createElement('div');
    rail.className = 'rec-rail';
    const scroller = document.createElement('div');
    scroller.className = 'rec-scroller';
    for (let c = 0; c < 6; c++) {
      const card = document.createElement('div');
      card.className = 'rec-skel-card';
      scroller.appendChild(card);
    }
    rail.appendChild(scroller);
    section.appendChild(rail);
    frag.appendChild(section);
  }
  return frag;
}

// Render the "Recommended for you" rail at the top of the Movies home view.
// Build one labelled recommendation rail (editorial header + edge-faded scroller of
// rec cards). Shared by the Movies-home teaser row and the dedicated Recommendation page.
// >>> REC-HARNESS-EXPORT buildRecRail
function buildRecRail(recs, { kicker, heading, subline }) {
  const section = document.createElement('section');
  section.className = 'rec-rail-section';

  const header = document.createElement('div');
  header.className = 'rec-header';
  if (kicker) {
    const k = document.createElement('span');
    k.className = 'rec-kicker';
    k.textContent = kicker;
    header.appendChild(k);
  }
  const h = document.createElement('h2');
  h.className = 'rec-heading';
  h.textContent = heading;
  header.appendChild(h);
  if (subline) {
    const s = document.createElement('span');
    s.className = 'rec-subline';
    s.textContent = subline;
    header.appendChild(s);
  }
  section.appendChild(header);

  const rail = document.createElement('div');
  rail.className = 'rec-rail';
  const scroller = document.createElement('div');
  scroller.className = 'rec-scroller';
  recs.forEach((rec, index) => scroller.appendChild(createRecommendationCard(rec, index)));
  rail.appendChild(scroller);
  section.appendChild(rail);
  return section;
}
// <<< REC-HARNESS-EXPORT buildRecRail

// Below-the-fold rail: header + an empty, min-height-reserved scroller (no cards built,
// so their poster <img>s never request data) until hydrate() runs. hydrate() is idempotent.
function buildLazyRecRail(recs, { kicker, heading, subline }) {
  const section = buildRecRail([], { kicker, heading, subline });
  const scroller = section.querySelector('.rec-scroller');
  scroller.classList.add('rec-scroller--reserved');
  let hydrated = false;
  const hydrate = () => {
    if (hydrated) return;
    hydrated = true;
    scroller.classList.remove('rec-scroller--reserved');
    recs.forEach((rec, index) => scroller.appendChild(createRecommendationCard(rec, index)));
  };
  return { section, hydrate };
}

// Hydrate a lazy rail when it nears the viewport (rootMargin pre-empts the scroll). Falls
// back to immediate hydration where IntersectionObserver is unavailable.
function observeLazyRail(section, hydrate) {
  if (typeof IntersectionObserver !== 'function') { hydrate(); return null; }
  const io = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (e.isIntersecting) { hydrate(); obs.disconnect(); }
    }
  }, { rootMargin: '600px' });
  io.observe(section);
  return io;
}

// Build the final ordered rail list from the authoritative rows, reusing already-painted
// provisional rails by key (no rebuild → no flicker), building the rest. Rows beyond
// `eagerRows` are built lazy and registered via onLazy. Pure of #main; returns sections to
// hand to replaceChildren. Provisional rails consumed here are deleted from the map so any
// leftover (stale, not in final) can be dropped by the caller.
function reconcileRecRails(rows, provisional, { buildRail, eagerRows = 3, onLazy }) {
  return rows.map((row, i) => {
    const key = `${row.kind}::${row.title}`;
    const reused = provisional.get(key);
    if (reused) { provisional.delete(key); return reused; }
    const lazy = i >= eagerRows;
    const { section, hydrate } = buildRail(row, i, lazy);
    if (lazy && hydrate && onLazy) onLazy(section, hydrate);
    return section;
  });
}

async function renderRecommendationsRow() {
  // Remove any existing row first (avoids duplicates on re-render).
  document.getElementById('recommendations-row')?.remove();

  // Only show on the Movies home/browse view. Callers fire late (end of loadTrending,
  // debounced signal changes) — re-check ownership here rather than trusting them: the
  // rec page in particular must not get a duplicate pipeline run + injected teaser row.
  if (!browseGridOwnsMain() || tvMediaKind === 'live') return;

  const items = buildSignalItems();
  if (items.basket.length === 0 && items.watched.length === 0 && items.seen.length === 0) return;

  let recs = [];
  try {
    recs = await getRecommendations(items, { limit: 20 });
  } catch (e) {
    console.warn('Recommendations failed:', e);
    return;
  }
  if (recs.length === 0) return;

  const section = buildRecRail(recs, {
    kicker: 'Curated for you',
    heading: 'Recommended',
    subline: `Tuned to your taste · ${recs.length} picks`,
  });
  section.id = 'recommendations-row';
  section.classList.add('recommendations-row');

  // Insert above the main grid (remove again to close any async double-render race).
  document.getElementById('recommendations-row')?.remove();
  main.parentNode.insertBefore(section, main);
}

// Called after any basket/downvote toggle. The stores already busted the rec cache;
// re-render whichever recommendation surface is currently showing so the change applies.
function onSignalChanged() {
  if (TV_MODE && tvHomeIsCurrent()) {
    renderTvHome(lastTrendingSeed);
    return;
  }
  if (tabRecommended.classList.contains('active')) {
    scheduleRecRecompute();
  } else if (currentApp === 'movies' && !isWatchedMode && !isFavoritesMode && !isSearchMode && !isTop250Mode) {
    renderRecommendationsRow();
  }
}

// Render the full themed Recommendation page (stacked rails) into #main.
// Bumped on each render so a slower in-flight render (e.g. from a rapid second toggle)
// can detect it was superseded and skip mutating #main — avoids stacked duplicate pages.
let recPageRenderToken = 0;

// Rapid curation (several ★/👎) should trigger ONE heavy pipeline run, not one per click.
// The clicked card already flips optimistically (createStar/DownvoteButton sync()); only the
// full-page recompute is debounced.
const REC_RECOMPUTE_DEBOUNCE_MS = 1000;
let __recRecomputeTimer = null;
function scheduleRecRecompute() {
  if (__recRecomputeTimer) clearTimeout(__recRecomputeTimer);
  __recRecomputeTimer = setTimeout(() => {
    __recRecomputeTimer = null;
    renderRecommendationsPage();
  }, REC_RECOMPUTE_DEBOUNCE_MS);
}

// Leaving the Recommended tab: cancel any pending debounced recompute and SUPERSEDE any in-flight
// async render (bump the token so renderRecommendationsPage bails at its token guards instead of
// finishing a now-pointless reconcile), and disconnect EVERY mounted rec-page's lazy observers —
// during the SWR cross-fade two .rec-pages co-exist briefly, so disconnect all, not just the first.
function leaveRecommended() {
  if (__recRecomputeTimer) { clearTimeout(__recRecomputeTimer); __recRecomputeTimer = null; }
  recPageRenderToken++;
  document.querySelectorAll('.rec-page').forEach((p) => p.__recObservers?.forEach((io) => io.disconnect()));
}

async function renderRecommendationsPage() {
  // Guard: a debounced recompute (or any deferred caller) must not paint over another tab's view.
  // switchToRecommended() sets the active class before calling us, so a legitimate render passes.
  if (!tabRecommended.classList.contains('active')) return;
  const token = ++recPageRenderToken;
  document.getElementById('recommendations-row')?.remove();
  filteredMovies = [];
  displayedCount = 0;
  hasMorePages = false;
  document.getElementById('load-more-indicator')?.remove();
  // Stale-while-revalidate: a recompute (a .rec-page already exists) keeps the old rows
  // visible while the new page is built DETACHED, then cross-fades in at the end.
  const existingPage = main.querySelector('.rec-page');
  setLoading(false);            // visible #main + skeletons instead of the global spinner
  hideError();

  const items = buildSignalItems();
  const coldStart = items.basket.length === 0;

  const page = document.createElement('div');
  page.className = 'rec-page';
  if (coldStart) page.classList.add('rec-cold-start');
  // Reserved hero slot (top) + 2 generic skeletons below. Provisional title rows fill BELOW the
  // hero slot so the calibrated Top Picks lands in the top slot in place — nothing jumps.
  const heroSkeleton = buildRecSkeleton(1).firstChild; // single skeleton section = hero placeholder
  if (existingPage) {
    // Stale-while-revalidate: keep old rows visible; build the new page DETACHED, cross-fade at end.
    page.classList.add('rec-page--incoming');
    page.appendChild(heroSkeleton);
  } else {
    main.innerHTML = '';
    page.appendChild(heroSkeleton);
    page.appendChild(buildRecSkeleton(2));
    main.appendChild(page);
  }

  const REC_ROW_KICKERS = {
    top: 'Calibrated to your basket', title: 'Because you liked it',
    genre: 'More of this genre', trending: 'Popular this week', explore: 'A little different',
    wildcard: 'A leap outside your taste',
  };
  const keyOf = (row) => `${row.kind}::${row.title}`;
  const buildRail = (row, i, lazy) => {
    const heading = coldStart && i === 0 ? 'Trending to get started' : row.title;
    const kicker = coldStart && i === 0 ? 'Popular right now' : (REC_ROW_KICKERS[row.kind] || null);
    const built = lazy ? buildLazyRecRail(row.recs, { kicker, heading })
                       : { section: buildRecRail(row.recs, { kicker, heading }), hydrate: null };
    built.section.classList.add(`rec-row-${row.kind}`);
    built.section.setAttribute('data-rec-kind', row.kind);
    built.section.setAttribute('data-rec-key', keyOf(row));
    if (row.kind === 'explore') built.section.classList.add('rec-explore');
    // Row-level "not interested": persists the row key, then recomputes the page — the
    // engine skips the row and redistributes its items (session cache makes this cheap).
    if (row.key && !coldStart) {
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'rec-dismiss';
      dismissBtn.title = 'Not interested in this row';
      dismissBtn.setAttribute('aria-label', `Dismiss the "${heading}" row`);
      dismissBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissRow(row.key);
        renderRecommendationsPage();
      });
      built.section.querySelector('.rec-header')?.appendChild(dismissBtn);
    }
    return built;
  };

  // Provisional preview: paint title rows below the hero slot as they stream in.
  const provisional = new Map();
  let belowCleared = false;
  const onStream = (row) => {
    if (token !== recPageRenderToken) return;
    if (!row || row.provisional !== true || row.kind !== 'title') return;
    const key = keyOf(row);
    if (provisional.has(key)) return;
    if (!belowCleared) {
      // drop the generic below-hero skeletons (keep the hero slot) before the first preview row
      page.querySelectorAll('.rec-skeleton').forEach((sk) => { if (sk !== heroSkeleton) sk.remove(); });
      belowCleared = true;
    }
    const { section } = buildRail(row, 1, false); // eager preview, i!=0 (below hero)
    page.appendChild(section);
    provisional.set(key, section);
  };

  let rows = [];
  let failed = false;
  try {
    ({ rows } = await getRecommendationRows(items, {
      limit: 60,
      onRow: onStream,
      groupOpts: { dismissedRows: getDismissedRows() },
    }));
  } catch (e) {
    console.warn('Recommendation page failed:', e);
    failed = true;
  }
  if (token !== recPageRenderToken) return; // superseded — don't touch #main

  if (failed) {
    if (!existingPage) main.innerHTML = '<p class="no-results rec-empty">Couldn’t load recommendations right now. Try again shortly.</p>';
    return; // recompute failure: keep the last good rows, drop the detached page
  }
  if (rows.length === 0) {
    if (!existingPage) main.innerHTML = '<p class="no-results rec-empty">No recommendations yet — keep watching to tune your taste.</p>';
    return;
  }

  // Authoritative reconcile in ONE atomic pass: reuse provisional title rails by key, fill the
  // hero slot in place, lazy below the fold, drop skeletons + any stale provisional rails.
  const recObservers = [];
  const finalSections = reconcileRecRails(rows, provisional, {
    buildRail,
    eagerRows: 3,
    onLazy: (section, hydrate) => { const io = observeLazyRail(section, hydrate); if (io) recObservers.push(io); },
  });
  page.__recObservers = recObservers;
  page.replaceChildren(...finalSections);

  if (existingPage && existingPage.isConnected) {
    main.appendChild(page); // incoming (opacity 0 via .rec-page--incoming)
    const removeOld = () => {
      existingPage.__recObservers?.forEach((io) => io.disconnect());
      existingPage.remove();
    };
    requestAnimationFrame(() => {
      page.classList.remove('rec-page--incoming');
      existingPage.classList.add('rec-page--fading');
      existingPage.addEventListener('transitionend', removeOld, { once: true });
      setTimeout(removeOld, 400); // safety net (reduced-motion / no transition)
    });
  }
}

const STAR_FILLED_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.3 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg>';
const STAR_OUTLINE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3.2l2.6 5.7 6.2.6-4.7 4.1 1.4 6.1L12 16.6 6.5 19.8l1.4-6.1L3.2 9.5l6.2-.6z"/></svg>';

// All four signal buttons (star/like/seen/down) share sibling re-sync: after any toggle,
// every other signal button on the same poster re-reads its store state.
const SIGNAL_BTN_SELECTOR = '.star-btn, .like-btn, .seen-btn, .down-btn';
function resyncSiblingSignals(btn) {
  btn.parentElement?.querySelectorAll(SIGNAL_BTN_SELECTOR).forEach((b) => {
    if (b !== btn) b.dispatchEvent(new CustomEvent('resync'));
  });
}
// Shared behavior for a poster signal toggle: swallow play-triggering events, resync
// siblings after toggling, refresh the basket view + rec surfaces.
function wireSignalButton(btn, onToggle) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle();
    resyncSiblingSignals(btn);
    if (isFavoritesMode) loadFavorites();
    onSignalChanged();
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  });
}

// The star = the 'loved' tier. Stops click propagation so it never triggers play.
function createStarButton(movie) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'star-btn';
  const sync = () => {
    const on = reactionOf(movie.id) === 'loved';
    btn.classList.toggle('starred', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Remove from loved' : 'Loved it');
    btn.title = on ? 'Remove from loved' : 'Loved it';
    btn.innerHTML = on ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
  };
  sync();
  btn.addEventListener('resync', sync);
  wireSignalButton(btn, () => { setReaction(movie, 'loved'); sync(); });
  return btn;
}

// The lighter 'liked' tier — same thumb glyph as the downvote, flipped via CSS.
function createLikeButton(movie) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'like-btn';
  const sync = () => {
    const on = reactionOf(movie.id) === 'liked';
    btn.classList.toggle('liked', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Remove liked' : 'Liked it');
    btn.title = on ? 'Remove liked' : 'Liked it';
    btn.innerHTML = on ? DOWN_FILLED_SVG : DOWN_OUTLINE_SVG;
  };
  sync();
  btn.addEventListener('resync', sync);
  wireSignalButton(btn, () => { setReaction(movie, 'liked'); sync(); });
  return btn;
}

const SEEN_OUTLINE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>';
const SEEN_FILLED_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.8 14.6L5.6 12l1.4-1.4 3.2 3.2 6.8-6.8 1.4 1.4-8.2 8.2z"/></svg>';

// "Seen it" — marks a title watched outside the app (neutral profile signal + exclusion).
function createSeenButton(movie) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'seen-btn';
  const sync = () => {
    const on = isSeen(movie.id);
    btn.classList.toggle('seen', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Unmark seen' : 'Seen it');
    btn.title = on ? 'Unmark seen' : 'Seen it (watched elsewhere)';
    btn.innerHTML = on ? SEEN_FILLED_SVG : SEEN_OUTLINE_SVG;
  };
  sync();
  btn.addEventListener('resync', sync);
  wireSignalButton(btn, () => { toggleSeen(movie); sync(); });
  return btn;
}

const DOWN_OUTLINE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 14V3H4v11h3zm0 0l4 7c1.1 0 2-.9 2-2v-4h5.5c.8 0 1.4-.7 1.3-1.5l-1-6A1.5 1.5 0 0 0 17.3 9H13V5"/></svg>';
const DOWN_FILLED_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M22 4h-3v11h3V4zM2 14.5C2 15.3 2.7 16 3.5 16H10l-1 4.5c-.2.9.5 1.5 1.3 1.5.5 0 1-.3 1.3-.8L16 14V4H4.2c-.7 0-1.3.5-1.5 1.2l-2 8.3c0 .3 0 .7.3 1z"/></svg>';

// A downvote toggle bound to a movie. Mutually exclusive with the star; stops click
// propagation so it never triggers play. Re-syncs the sibling star button after toggling.
function createDownvoteButton(movie) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'down-btn';
  const sync = () => {
    const on = isDownvoted(movie.id);
    btn.classList.toggle('downvoted', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Remove downvote' : 'Not interested (downvote)');
    btn.title = on ? 'Remove downvote' : 'Not interested';
    btn.innerHTML = on ? DOWN_FILLED_SVG : DOWN_OUTLINE_SVG;
  };
  sync();
  btn.addEventListener('resync', sync);
  wireSignalButton(btn, () => { toggleDownvote(movie); sync(); });
  return btn;
}

// ---- TV details screen + Netflix-style home (distinct rows) ----
// Created at module eval so the overlay is in the DOM before the remote installs.
// Top-billed cast names for the details screen. fetchCredits returns only the
// director string, so read the raw credits endpoint here for the cast list.
async function fetchCast(type, id) {
  try {
    const data = await fetchTmdbJson(ENDPOINTS.credits(type, id));
    return Array.isArray(data && data.cast) ? data.cast : [];
  } catch (e) { return []; }
}
async function fetchDetailsRecommendations(type, id) {
  const safeResults = async url => {
    try {
      const data = await fetchTmdbJson(url);
      return Array.isArray(data && data.results) ? data.results : [];
    } catch { return []; }
  };
  const [recommended, similar] = await Promise.all([
    safeResults(ENDPOINTS.recommendations(type, id)),
    safeResults(ENDPOINTS.similar(type, id)),
  ]);
  return mergeTitleRecommendations(recommended, similar, { id, media_type: type }, 20);
}
const tvDetails = TV_MODE ? createTvDetails({
  fetchCast, fetchTrailer: fetchTrailers, fetchTvDetails, fetchSeasonDetails,
  fetchRecommendations: fetchDetailsRecommendations,
  onPlay: (movie, target) => { tvDetails.close(); openPlayer(movie, target); },
  getResume,
  isStarred, toggleStar, isDownvoted, toggleDownvote, onSignalChanged,
}) : null;

// Streams for one match, flattened across every source adapter that listed it.
// 70 s timeout: Nuvio can take up to ~45 s to list streams at peak, then the
// helper probes every stream (~10 s more).
// Re-resolve against the current match list first: sources rename matches
// mid-game, and the old id then lists no streams.
async function currentMatch(match) {
  try { return findCurrentMatch((await fetchLiveJson('/live/matches')).matches, match); } catch (e) { return match; }
}
async function fetchStreamsForMatch(match) {
  const lists = await Promise.all((match.sources || []).map(s =>
    fetchLiveJson(`/live/streams?adapter=${encodeURIComponent(s.adapter)}&id=${encodeURIComponent(s.sourceId)}`, 70000)
      .then(r => (r.streams || []).map(st => ({ ...st, adapter: s.adapter })))
      .catch(() => [])));
  return lists.flat();
}
const liveDetails = createLiveDetails({
  fetchStreams: async match => fetchStreamsForMatch(await currentMatch(match)),
  onPlay: (match, streams, index) => { liveDetails.close(); openLivePlayer({ title: match.title, streams, startIndex: index, refresh: async () => fetchStreamsForMatch(await currentMatch(match)) }); },
});
const livePlayer = createLivePlayer({
  video: playerVideo, modal: playerModal, helperUrl,
  setStatus: (msg, isError) => setYtsStatus(msg, !!isError),
});
function openLivePlayer(session) {
  stopYtsStream();
  currentPlayingMovie = null;
  currentTvData = null;
  showPlayerVideo(true);
  if (qualitySelect) qualitySelect.style.display = 'none';
  if (subtitleSelect) subtitleSelect.style.display = 'none';
  playerTitle.textContent = session.title || 'Live';
  playerModal.dataset.live = '1';
  playerModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  playerModalOpen = true;
  livePlayer.play(session);
}

// A card opens details first; the hero's Play button still plays immediately.
function openDetails(movie) {
  if (tvDetails) tvDetails.open(movie);
  else openPlayer(movie);
}
if (TV_MODE) document.addEventListener('tv-close-details', () => { if (tvDetails) tvDetails.close(); liveDetails.close(); });
// The web page has no remote handler, so Escape closes the live details there.
if (!TV_MODE) document.addEventListener('keydown', event => { if (event.key === 'Escape' && liveDetails.isOpen()) liveDetails.close(); });

// A non-default filter or a search means the user wants specific results, not the
// curated home. Everything else on the Movies tab is the home.
function tvFiltersActive() {
  const f = currentFilters;
  return f.mediaType !== 'all' || Number(f.genre) !== 0 || Number(f.minRating) !== 0
    || Number(f.minVotes) !== 0 || f.yearFilter !== 'all' || f.language !== ''
    || (f.excludeGenres && f.excludeGenres.length) || Number(f.provider) !== 0
    || Number(f.actorId) !== 0 || Number(f.theme) !== 0 || (f.sortBy && f.sortBy !== 'weighted');
}
function tvHomeIsCurrent() {
  return TV_MODE && browseGridOwnsMain() && !isSearchMode && !tvFiltersActive();
}

// Render the TV home from genuinely distinct TMDB feeds, deduped across rows, with
// Continue Watching + My List first. Rows paint as each feed arrives so the screen
// fills top-down rather than waiting on eight requests. `seed` reuses the trending
// page loadTrending already fetched, so that request is not repeated.
// Which slice of the catalogue the home shows: 'all' | 'movie' | 'tv' (top nav).
// Live home refresh state lives up here so setTvMediaKind/renderTvHome can call
// stopLiveHomeRefresh() before the live block below has been evaluated.
const LIVE_HOME_REFRESH_MS = 60_000;
let liveHomeTimer = null;
function stopLiveHomeRefresh() { clearTimeout(liveHomeTimer); liveHomeTimer = null; }

let tvMediaKind = 'all';
function setTvMediaKind(kind) {
  tvMediaKind = (kind === 'movie' || kind === 'tv' || kind === 'live') ? kind : 'all';
  document.querySelectorAll('.tv-kind-tab').forEach(b => b.classList.toggle('active', b.dataset.kind === tvMediaKind));
  window.scrollTo(0, 0);
  if (tvMediaKind === 'live') { setLoading(false); renderLiveHome(); }
  else { stopLiveHomeRefresh(); renderTvHome(lastTrendingSeed); }
}
if (TV_MODE) window.__setTvMediaKind = setTvMediaKind; // called by the injected top nav in tv-remote.js

// Media type to apply to FILTERED/SEARCH results: the explicit media-type filter if
// set, else the top-nav kind on TV (the media-type dropdown is hidden there). Kept
// separate from currentFilters.mediaType so selecting a kind doesn't make the home
// read as "filtered" (which would swap the curated home for a flat results grid).
function effectiveMediaType() {
  if (currentFilters.mediaType && currentFilters.mediaType !== 'all') return currentFilters.mediaType;
  return TV_MODE && tvMediaKind !== 'all' && tvMediaKind !== 'live' ? tvMediaKind : 'all';
}

let tvHomeToken = 0;
let lastTrendingSeed = null;
const TV_HOME_ROW_LIMIT = 12;
const TV_HOME_CARD_LIMIT = 12;
const TV_HOME_RECOMMENDATION_LIMIT = TV_HOME_CARD_LIMIT * 10;
async function renderTvHome(seed) {
  stopLiveHomeRefresh();
  if (seed && seed.length) lastTrendingSeed = seed;
  // Late callers (a trending load resolving, a basket toggle) re-render "the home";
  // while the Live kind is selected that home is the live one, not the TMDB rows.
  if (tvMediaKind === 'live') return renderLiveHome();
  installTvEndlessRows();
  const token = ++tvHomeToken;
  const onSelect = openDetails;
  const onPlay = (movie) => openPlayer(movie);
  const kind = tvMediaKind;
  const personal = signalRows({ continueWatching: getWatchedHistory(), myList: getStarredList() }, TV_HOME_CARD_LIMIT);
  // The trending seed is all-media, so only use it as the hero under the "All" tab;
  // under Movies/TV let renderTvRows pick the hero from the first kind-appropriate row.
  const featured = (kind === 'all' && seed && seed.length && seed[0]) || (personal[0] && personal[0].items[0]) || null;

  renderTvRows(main, personal, { onSelect, onPlay, featured });

  const seen = new Set();
  dedupeAcrossRows(personal).forEach(r => r.items.forEach(it => seen.add(titleKey(it))));

  // Surface the complete IMDb and Emmy collections directly on All. These rails
  // deliberately bypass cross-row dedupe so their curated membership stays intact.
  const staticCollections = { imdbTop250: IMDB_TOP_250, emmyWinners: EMMY_WINNERS };
  const staticCollectionLimit = Math.max(IMDB_TOP_250.length, EMMY_WINNERS.length);
  for (const row of staticHomeRows(kind, staticCollections, staticCollectionLimit)) {
    appendTvRow(main, row, onSelect);
  }

  // Append one endless row: paint it AND stamp it so it can page as the user scrolls.
  const appendEndless = (def, items) => {
    if (def.mediaType) items = items.map(it => (it.media_type ? it : { ...it, media_type: def.mediaType }));
    const shown = dedupeItems(items.slice(0, TV_HOME_CARD_LIMIT), seen);
    const section = appendTvRow(main, { key: def.key, title: def.title, items: shown }, onSelect);
    if (section) {
      section.dataset.rowUrl = def.url;
      section.dataset.rowPage = '1';
      if (def.mediaType) section.dataset.rowMedia = def.mediaType;
      // Seed with a snapshot of everything shown across rows so far, so paging deep
      // into this rail doesn't reintroduce titles already shown in an earlier row.
      tvRowSeen.set(section, new Set(seen));
    }
    return section;
  };

  // Recommended row: use the same aggregate taste engine as the full recommendation
  // page. Every watched title contributes; no single recent film can dictate the rail.
  try {
    // Ask for extra candidates so Movies/TV tabs can filter by media type and
    // still fill the expanded 120-card recommendation rail.
    const ranked = await getRecommendations(buildSignalItems(), { limit: TV_HOME_RECOMMENDATION_LIMIT * 2 });
    let candidates = ranked.map(rec => rec && rec.movie).filter(Boolean);
    if (kind !== 'all') {
      candidates = candidates.filter(movie => {
        const type = (movie.media_type === 'tv' || (movie.name && !movie.title)) ? 'tv' : 'movie';
        return type === kind;
      });
    }
    if (candidates.length && token === tvHomeToken && tvHomeIsCurrent()) {
      const items = dedupeItems(candidates, new Set(seen)).slice(0, TV_HOME_RECOMMENDATION_LIMIT);
      items.forEach(item => seen.add(titleKey(item)));
      appendTvRow(main, { key: 'recommended', title: 'Recommended for You', items }, onSelect);
    }
  } catch { /* no recommendations; skip the row */ }

  const defs = catalogRowDefs(CONFIG.API_KEY, CONFIG.BASE_URL, kind).slice(0, TV_HOME_ROW_LIMIT);
  for (const def of defs) {
    if (token !== tvHomeToken || !tvHomeIsCurrent()) return; // user navigated away
    let items = [];
    if (def.key === 'trending' && kind === 'all' && seed && seed.length) {
      items = seed.slice(0, 40);
    } else {
      try {
        const data = await fetchTmdbJson(def.url);
        items = (data && (data.results || data.items)) || []; // curated lists use `items`
      } catch (e) { items = []; }
    }
    if (token !== tvHomeToken || !tvHomeIsCurrent()) return;
    appendEndless(def, items);
  }
}

// ---- Live football home -------------------------------------------------------
// Rows come from the helper (/live/matches joins ESPN fixtures to free streams;
// /live/channels is the probed iptv-org list). Re-rendered every 60 s while the
// Live home is on screen and nothing is open on top of it; focus is restored to
// the same card by id so the remote never drops to <body>.
const liveHomeCurrent = () => tvMediaKind === 'live' && (!TV_MODE || tvHomeIsCurrent());
// Is the Live home (its rows, or its loading/empty placeholder) what #main shows now?
function liveHomeOwnsMain() {
  return liveHomeCurrent() && !!main.querySelector('.tv-card-live, .tv-live-empty, .tv-live-status');
}

async function fetchLiveJson(path, ms = 15000) {
  await helperBaseReady;
  const res = await fetchWithTimeout(helperUrl(path), ms);
  if (!res.ok) throw new Error(`helper ${res.status}`);
  return res.json();
}

function liveStatusText(matchesRes, channelsRes) {
  const parts = [];
  if (matchesRes.error) parts.push(`Matches unavailable: ${matchesRes.error.message || matchesRes.error}`);
  else {
    const st = matchesRes.status || {};
    if (st.fixtures && st.fixtures !== 'ok') parts.push(`Fixtures (ESPN): ${st.fixtures}`);
    for (const [name, v] of Object.entries(st.sources || {})) if (v !== 'ok') parts.push(`Match streams (${name}): ${v}`);
  }
  if (channelsRes.error) parts.push(`Channels unavailable: ${channelsRes.error.message || channelsRes.error}`);
  else if (channelsRes.stale) parts.push('Channel list may be out of date');
  return parts.join('   ·   ');
}

// Matches open the details screen; channels play straight away (Task 12's player).
let onLiveSelect = card => {
  if (card.kind === 'channel') openLivePlayer({ title: card.title, streams: [{ label: card.title, play: card.raw.play }], startIndex: 0, refresh: async () => [{ label: card.title, play: card.raw.play }] });
  else liveDetails.open(card.raw);
};

async function renderLiveHome() {
  stopLiveHomeRefresh();
  const token = ++tvHomeToken;
  if (liveHomeCurrent() && !liveHomeOwnsMain()) { main.textContent = ''; main.append(Object.assign(document.createElement('p'), { className: 'tv-live-empty', textContent: 'Loading live football…' })); }
  const [matchesRes, channelsRes] = await Promise.all([
    fetchLiveJson('/live/matches').catch(error => ({ error })),
    // /live/channels can take ~20 s on a cold cache (it probes every stream).
    fetchLiveJson('/live/channels', 40000).catch(error => ({ error })),
  ]);
  if (token !== tvHomeToken || !liveHomeCurrent()) return;
  const now = Date.now();
  const rows = buildLiveRows(matchesRes.matches || [], channelsRes.channels || [], now);
  // Read focus NOW, not before the fetch: the old rows stayed on screen for up to
  // 25 s and the user may have moved (or left the rows for the kind nav).
  const focusedCard = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.tv-card') : null;
  const focusedId = (focusedCard && focusedCard.dataset.movieId) || '';
  main.textContent = '';
  if (!rows.some(r => r.key === 'live-now' || r.key === 'today')) {
    main.append(Object.assign(document.createElement('p'), { className: 'tv-live-empty', textContent: matchesRes.error ? 'Could not reach the stream helper.' : 'No football with a free stream right now.' }));
  }
  for (const row of rows) appendTvRow(main, row, card => onLiveSelect(card));
  const status = liveStatusText(matchesRes, channelsRes);
  if (status) main.append(Object.assign(document.createElement('p'), { className: 'tv-live-status', textContent: status }));
  // Repaint, but never pull focus back to a card while the player or a details
  // overlay (e.g. the live stream picker) sits on top and owns focus.
  if (focusedId && !playerModalOpen && !document.querySelector('.tv-details:not([hidden])')) restoreFocusById(focusedId);
  // Refresh tick: bail if the user left the Live home; while the player or a
  // details panel is open on top, re-check later instead of repainting under it.
  const tick = () => {
    if (!liveHomeCurrent() || token !== tvHomeToken) return;
    if (playerModalOpen || document.querySelector('.tv-details:not([hidden])')) { liveHomeTimer = setTimeout(tick, LIVE_HOME_REFRESH_MS); return; }
    renderLiveHome();
  };
  liveHomeTimer = setTimeout(tick, LIVE_HOME_REFRESH_MS);
}
window.__renderLiveHome = renderLiveHome; // e2e hook

// Per-row dedupe sets for endless paging: keyed by the row's <section>.
const tvRowSeen = new WeakMap();

// Fetch the next page of a row's feed and append it. Called as the user nears the
// end of a rail, so every category (Comedies, Top Rated, …) scrolls endlessly
// instead of stopping at the first page.
async function extendTvRow(section) {
  if (!section || section.dataset.rowLoading === '1' || section.dataset.rowDone === '1') return;
  const base = section.dataset.rowUrl;
  if (!base) return;
  const page = Number(section.dataset.rowPage || '1') + 1;
  section.dataset.rowLoading = '1';
  try {
    const url = /[?&]page=\d+/.test(base) ? base.replace(/([?&]page=)\d+/, `$1${page}`) : `${base}${base.includes('?') ? '&' : '?'}page=${page}`;
    const data = await fetchTmdbJson(url);
    let items = (data && (data.results || data.items)) || []; // curated lists use `items`
    if (section.dataset.rowMedia) items = items.map(it => (it.media_type ? it : { ...it, media_type: section.dataset.rowMedia }));
    const seen = tvRowSeen.get(section) || new Set();
    const fresh = dedupeItems(items, seen);
    tvRowSeen.set(section, seen);
    const track = section.querySelector('.tv-rail-track');
    if (track) {
      fresh.forEach(m => track.append(createTvCard(m, openDetails)));
      sortTvTrackByRating(track);
    }
    section.dataset.rowPage = String(page);
    // Stop when a page adds nothing new (empty page, or an endpoint that ignores
    // ?page= and re-returns the same items — all deduped away), or past total_pages.
    // Without the fresh===0 guard such a row would refetch forever on every scroll.
    if (!items.length || fresh.length === 0 || page >= (data.total_pages || 500)) section.dataset.rowDone = '1';
  } catch { /* transient; a later scroll retries */ } finally {
    section.dataset.rowLoading = '0';
  }
}

// Trigger the fetch when focus lands within the last few cards of a rail. Installed
// once; harmless off the TV home (rows without rowUrl are ignored).
let tvEndlessInstalled = false;
function installTvEndlessRows() {
  if (tvEndlessInstalled) return;
  tvEndlessInstalled = true;
  document.addEventListener('focusin', (event) => {
    const card = event.target?.closest?.('.tv-card');
    const section = card?.closest?.('[data-tv-row]');
    if (!card || !section || !section.dataset.rowUrl) return;
    const cards = section.querySelectorAll('.tv-card');
    if (Array.prototype.indexOf.call(cards, card) >= cards.length - 6) extendTvRow(section);
  });
}

// Create movie card element
function createMovieCard(movie, index) {
  if (TV_MODE) return createTvCard(movie, openDetails);
  const {
    title,
    name,
    poster_path,
    vote_average,
    vote_count,
    overview,
    media_type,
    release_date,
    first_air_date,
    rtScore,
    imdbRating,
    providers,
    director,
    genre_ids
  } = movie;

  const displayTitle = title || name || 'Unknown';
  const year = release_date?.split('-')[0] || first_air_date?.split('-')[0] || 'N/A';
  const weightedScore = movie.weightedScore?.toFixed(2) || vote_average?.toFixed(2) || 'N/A';

  const card = document.createElement('article');
  card.className = 'movie';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `${displayTitle}, rated ${vote_average}`);

  // Image container
  const imageDiv = document.createElement('div');
  imageDiv.className = 'image';

  const img = document.createElement('img');
  img.src = poster_path ? CONFIG.IMAGE_URL + poster_path : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='450'><rect width='300' height='450' fill='%23222'/><text x='50%25' y='50%25' fill='%23888' font-size='22' text-anchor='middle' font-family='sans-serif'>No Image</text></svg>";
  img.alt = `${displayTitle} poster`;
  img.loading = 'lazy';
  imageDiv.appendChild(img);

  // Movie info container
  const infoDiv = document.createElement('div');
  infoDiv.className = 'movie-info';

  // Title section
  const titleDiv = document.createElement('div');
  titleDiv.className = 'title';

  const indexSpan = document.createTextNode(`${index + 1} `);
  titleDiv.appendChild(indexSpan);

  const titleH3 = document.createElement('h3');
  titleH3.textContent = displayTitle;
  titleDiv.appendChild(titleH3);

  const typeH6 = document.createElement('h6');
  typeH6.textContent = media_type || '';
  titleDiv.appendChild(typeH6);

  infoDiv.appendChild(titleDiv);

  // Genre tags section
  const genres = getGenreNames(genre_ids);
  if (genres.length > 0) {
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'genre-tags';
    genres.slice(0, 4).forEach(genre => { // Limit to 4 tags
      const tag = document.createElement('span');
      tag.className = 'genre-tag';
      tag.textContent = genre;
      tagsDiv.appendChild(tag);
    });
    infoDiv.appendChild(tagsDiv);
  }

  // Ratings section
  const ratingsDiv = document.createElement('div');
  ratingsDiv.className = 'votes';

  // TMDB Rating
  const tmdbDiv = document.createElement('div');
  const tmdbLabel = document.createElement('p');
  tmdbLabel.textContent = 'TMDB';
  const tmdbSpan = document.createElement('span');
  tmdbSpan.className = getClassByRate(vote_average);
  tmdbSpan.textContent = vote_average?.toFixed(1) || 'N/A';
  tmdbDiv.appendChild(tmdbLabel);
  tmdbDiv.appendChild(tmdbSpan);

  // RT Rating
  const rtDiv = document.createElement('div');
  const rtLabel = document.createElement('p');
  rtLabel.textContent = 'RT';
  const rtSpan = document.createElement('span');
  if (rtScore !== null && rtScore !== undefined) {
    rtSpan.className = rtScore >= 75 ? 'green' : rtScore >= 60 ? 'orange' : 'red';
    rtSpan.textContent = `${rtScore}%`;
  } else {
    rtSpan.className = 'vote-count';
    rtSpan.textContent = '-';
  }
  rtDiv.appendChild(rtLabel);
  rtDiv.appendChild(rtSpan);

  // Vote Count
  const countDiv = document.createElement('div');
  const countLabel = document.createElement('p');
  countLabel.textContent = 'Votes';
  const countSpan = document.createElement('span');
  countSpan.className = 'vote-count';
  countSpan.textContent = vote_count?.toLocaleString() || '0';
  countDiv.appendChild(countLabel);
  countDiv.appendChild(countSpan);

  ratingsDiv.appendChild(tmdbDiv);
  ratingsDiv.appendChild(rtDiv);
  ratingsDiv.appendChild(countDiv);
  infoDiv.appendChild(ratingsDiv);

  // Streaming providers section
  if (providers && providers.display && providers.display.length > 0) {
    const providersDiv = document.createElement('div');
    providersDiv.className = 'providers';
    providers.forEach(provider => {
      const providerImg = document.createElement('img');
      providerImg.src = provider.logo;
      providerImg.alt = provider.name;
      providerImg.title = provider.name;
      providerImg.className = 'provider-logo';
      providersDiv.appendChild(providerImg);
    });
    infoDiv.appendChild(providersDiv);
  }

  // Weighted score span
  const scoreSpan = document.createElement('span');
  scoreSpan.className = 'vote-count';
  scoreSpan.style.margin = '0.5rem 0';
  scoreSpan.textContent = `Weighted: ${weightedScore}`;
  infoDiv.appendChild(scoreSpan);

  // Year span
  const yearSpan = document.createElement('span');
  yearSpan.className = 'vote-count';
  yearSpan.textContent = `Year: ${year}`;
  infoDiv.appendChild(yearSpan);

  // Director span
  if (director) {
    const directorSpan = document.createElement('span');
    directorSpan.className = 'vote-count director';
    directorSpan.textContent = media_type === 'tv' ? `Creator: ${director}` : `Director: ${director}`;
    infoDiv.appendChild(directorSpan);
  }

  // Overview section
  const overviewDiv = document.createElement('div');
  overviewDiv.className = 'overview';

  const overviewTitle = document.createElement('h3');
  overviewTitle.textContent = 'Overview';
  overviewDiv.appendChild(overviewTitle);

  const overviewText = document.createElement('p');
  overviewText.textContent = overview || 'No overview available.';
  overviewDiv.appendChild(overviewText);

  // Assemble card
  imageDiv.appendChild(createStarButton(movie));
  imageDiv.appendChild(createLikeButton(movie));
  imageDiv.appendChild(createSeenButton(movie));
  imageDiv.appendChild(createDownvoteButton(movie));
  card.appendChild(imageDiv);
  card.appendChild(infoDiv);
  card.appendChild(overviewDiv);

  // Click handler - open video player
  const handleClick = () => {
    openPlayer(movie);
  };

  card.addEventListener('click', handleClick);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  });

  return card;
}

// Get rating class based on vote average
function getClassByRate(vote) {
  if (vote >= 8) return 'green';
  if (vote >= 6) return 'orange';
  return 'red';
}

// Load more movies (for infinite scroll)
async function loadMoreMovies() {
  if (TV_MODE) {
    // The curated home renders its own distinct rows; infinite-scroll must not
    // clobber it with a flat results rail. It only paginates search/filtered views.
    if (tvHomeIsCurrent()) return;
    if (displayedCount >= filteredMovies.length) return;
    renderTvBrowse(main, filteredMovies, { onSelect: openDetails, onPlay: openPlayer });
    displayedCount = filteredMovies.length;
    document.getElementById('load-more-indicator')?.remove();
    if (hasMorePages && !isSearchMode) {
      const more = document.createElement('button');
      more.className = 'tv-more';
      more.textContent = 'Load more titles';
      more.onclick = async () => {
        if (isLoadingMore) return;
        isLoadingMore = true;
        more.disabled = true;
        more.textContent = 'Loading…';
        const token = gridLoadToken;
        try {
          await fetchMoreTrending(3);
          if (token !== gridLoadToken || !browseGridOwnsMain()) return;
          const filtered = applyFilters(allMovies);
          filteredMovies = sortMovies(filtered, calculateStats(filtered));
          displayedCount = 0;
          await loadMoreMovies();
          (main.querySelector('.tv-more') || main.querySelector('.tv-play'))?.focus();
        } catch {
          more.textContent = 'Could not load titles — try again';
        } finally {
          isLoadingMore = false;
          more.disabled = false;
        }
      };
      main.appendChild(more);
    }
    return;
  }
  if (isLoadingMore) return;

  // If we've shown all filtered movies, try to fetch more from API
  if (displayedCount >= filteredMovies.length) {
    if (!hasMorePages) {
      updateLoadMoreIndicator(false); // Remove loader when no more pages
      return;
    }

    isLoadingMore = true;
    updateLoadMoreIndicator(true); // Show loading

    const previousDisplayed = displayedCount;
    await fetchMoreTrending(3); // Fetch 3 more pages

    // Re-filter and sort with new movies
    const filtered = applyFilters(allMovies);

    // Fetch RT ratings for new filtered movies that don't have them yet
    const moviesToEnrich = filtered.filter(m => m.rtScore === undefined).slice(0, 30);
    await enrichMoviesWithRatings(moviesToEnrich);

    const stats = calculateStats(filtered);
    filteredMovies = sortMovies(filtered, stats);

    // Clear display and re-render ALL movies with correct rankings
    main.innerHTML = '';
    displayedCount = 0;

    // Re-render up to previous count + new batch
    const targetCount = Math.min(previousDisplayed + ITEMS_PER_PAGE, filteredMovies.length);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < targetCount; i++) {
      fragment.appendChild(createMovieCard(filteredMovies[i], i));
    }
    main.appendChild(fragment);
    displayedCount = targetCount;

    isLoadingMore = false;
    updateLoadMoreIndicator(false);
    return;
  }

  isLoadingMore = true;

  const nextBatch = filteredMovies.slice(displayedCount, displayedCount + ITEMS_PER_PAGE);
  const fragment = document.createDocumentFragment();

  nextBatch.forEach((movie, index) => {
    fragment.appendChild(createMovieCard(movie, displayedCount + index));
  });

  main.appendChild(fragment);
  displayedCount += nextBatch.length;
  isLoadingMore = false;

  updateLoadMoreIndicator(false);
}

// Update the "load more" indicator
function updateLoadMoreIndicator(isLoading = false) {
  let indicator = document.getElementById('load-more-indicator');

  const hasMore = displayedCount < filteredMovies.length || hasMorePages;

  if (!hasMore) {
    // All loaded, remove indicator
    if (indicator) indicator.remove();
    return;
  }

  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'load-more-indicator';
    indicator.className = 'load-more-indicator';
    main.parentNode.insertBefore(indicator, main.nextSibling);
  }

  if (isLoading) {
    indicator.innerHTML = '<div class="spinner small"></div><span>Loading more...</span>';
  } else {
    indicator.innerHTML = '<div class="spinner small"></div><span>Scroll for more...</span>';
  }
}

// Check if should load more (scroll position)
function checkScrollPosition() {
  const scrollTop = window.scrollY;
  const windowHeight = window.innerHeight;
  const docHeight = document.documentElement.scrollHeight;

  // Load more when within 300px of bottom
  if (scrollTop + windowHeight >= docHeight - 300) {
    loadMoreMovies();
  }
}

// Main function to load trending movies
// Does the trending/browse grid currently own #main? Grid loads resolve late (paced
// queue, hundreds of pages) — by then the user may be on the basket, watched, search,
// Top 250, YouTube, or Recommended surface, and a late grid paint must not wipe it.
function browseGridOwnsMain() {
  return currentApp === 'movies' && !isWatchedMode && !isFavoritesMode
    && !isSearchMode && !isTop250Mode && !tabRecommended.classList.contains('active');
}

async function loadTrending() {
  try {
    setLoading(true);
    hideError();
    resetFetchState();
    isSearchMode = false;
    isTop250Mode = false;
    top250Btn.classList.remove('active');
    updateQueryParams();

    // Determine how many pages to fetch based on filters
    // High vote filters have limited results, so fetch fewer pages
    let pagesToFetch = 250; // Default for trending
    if (currentFilters.minVotes >= 10000) {
      pagesToFetch = 25; // ~500 results max for 10k+ votes
    } else if (currentFilters.minVotes >= 5000) {
      pagesToFetch = 50; // More results for 5k+ votes
    } else if (currentFilters.minVotes >= 1000) {
      pagesToFetch = 100; // Even more for 1k+ votes
    }

    // FIRST WAVE: enough pages for a meaningful paint (~200 titles), shown immediately.
    // The deep pool the weighted sort wants (up to 250 pages + quality gems) follows in
    // the background and re-sorts in place — waiting for it kept the grid on a spinner
    // for ~20s on a cold cache.
    const FIRST_WAVE_PAGES = 10;
    const loadToken = gridLoadToken; // resetFetchState() above stamped this load
    const firstWave = Math.min(FIRST_WAVE_PAGES, pagesToFetch);
    await fetchMoreTrending(firstWave);
    // The first wave resolves seconds after the call — the user may have left the
    // browse grid meanwhile (fast tab click, #import= landing on the basket). Painting
    // anyway would wipe whichever surface owns #main now (this exact race blanked the
    // rec page: its skeleton got replaced by the grid, and the engine's rows then
    // reconciled into a detached node).
    if (loadToken === gridLoadToken && browseGridOwnsMain()) {
      await processAndDisplayMovies(allMovies);
    }

    // TV loads further pages on demand; thousands of background cards exhaust its webview.
    if (TV_MODE) return;

    (async () => {
      if (pagesToFetch > firstWave) await fetchMoreTrending(pagesToFetch - firstWave, loadToken);
      if (loadToken !== gridLoadToken) return;
      await fetchQualityGems();
      if (loadToken !== gridLoadToken) return;
      // Only re-render if the browse grid still owns #main.
      if (!browseGridOwnsMain()) return;
      await processAndDisplayMovies(allMovies);
    })().catch((e) => console.warn('background pool deepening failed:', e));
  } catch (error) {
    console.error('Error loading trending movies:', error);
    showError('Failed to load movies. Please try again later.');
  } finally {
    setLoading(false);
  }

  // Refresh the personalized row whenever the browse view (re)renders.
  renderRecommendationsRow();
}

// Handle filter changes
async function handleFilterChange() {
  updateQueryParams();
  // TV filters query TMDB directly (discover), so re-fetch rather than client-filter
  // the small trending pool. With no filters active this reloads the curated home.
  if (TV_MODE && !isSearchMode) {
    loadTrending();
    return;
  }
  if (allMovies.length > 0) {
    setLoading(true);
    await processAndDisplayMovies(allMovies, isSearchMode);
    setLoading(false);
  }
}

// Handle search
async function handleSearch(query) {
  if (!query.trim()) {
    search.value = '';
    updateQueryParams();
    // If actor filter is active, load by actor, otherwise load trending
    if (currentFilters.actorId) {
      loadByActor();
    } else {
      loadTrending();
    }
    return;
  }

  // Clear actor filter when searching
  if (currentFilters.actorId) {
    currentFilters.actorId = 0;
    currentFilters.actorName = '';
    actorSearchInput.value = '';
    actorSearchInput.classList.remove('has-value');
    actorIdInput.value = '';
    clearActorBtn.style.display = 'none';
  }

  // Clear Top 250 mode when searching
  if (isTop250Mode) {
    isTop250Mode = false;
    top250Btn.classList.remove('active');
  }

  document.getElementById('recommendations-row')?.remove();
  try {
    setLoading(true);
    hideError();
    updateQueryParams();
    const movies = await searchMovies(query);
    // Apply filters to search results (with relaxed filtering)
    allMovies = movies;
    isSearchMode = true;
    await processAndDisplayMovies(movies, true);
  } catch (error) {
    console.error('Error searching movies:', error);
    showError('Search failed. Please try again.');
  } finally {
    setLoading(false);
  }
}

// Debounced search handler
const debouncedSearch = debounce(handleSearch, 300);

// Event Listeners

// Media type change
mediaTypeSelect.addEventListener('change', (e) => {
  currentFilters.mediaType = e.target.value;
  populateGenres(e.target.value);
  // If actor filter is active, reload by actor with new media type
  if (currentFilters.actorId) {
    loadByActor();
  } else if (currentFilters.provider > 0 && !isSearchMode && !isTop250Mode) {
    // Provider filter requires API reload when media type changes
    loadTrending();
  } else {
    handleFilterChange();
  }
});

// Genre change
genreSelect.addEventListener('change', (e) => {
  const genreId = parseInt(e.target.value, 10);
  const wasKeyword = currentFilters.genreIsKeyword;
  currentFilters.genre = genreId;
  const metadata = genreMetadata.get(genreId);
  currentFilters.genreIsKeyword = metadata?.isKeyword || false;

  // Keyword-based genres require API reload (also reload when switching away from keyword)
  if ((currentFilters.genreIsKeyword || wasKeyword) && !isSearchMode && !isTop250Mode && !currentFilters.actorId) {
    loadTrending();
  } else {
    handleFilterChange();
  }
});

// Min rating change
minRatingSelect.addEventListener('change', (e) => {
  currentFilters.minRating = parseInt(e.target.value, 10);
  handleFilterChange();
});

// Min votes change - needs to reload from API since we use discover endpoint with vote_count.gte
minVotesSelect.addEventListener('change', (e) => {
  currentFilters.minVotes = parseInt(e.target.value, 10);
  // minVotes filter requires API reload for server-side filtering
  if (!isSearchMode && !isTop250Mode && !currentFilters.actorId) {
    loadTrending();
  } else {
    handleFilterChange();
  }
});

// Year filter change
yearFilterSelect.addEventListener('change', (e) => {
  currentFilters.yearFilter = e.target.value;
  handleFilterChange();
});

// Sort by change
sortBySelect.addEventListener('change', (e) => {
  currentFilters.sortBy = e.target.value;
  handleFilterChange();
});

// Language change - needs to reload from API since we use discover endpoint with language
languageSelect.addEventListener('change', (e) => {
  currentFilters.language = e.target.value;
  // Language filter requires API reload
  if (!isSearchMode && !isTop250Mode && !currentFilters.actorId) {
    loadTrending();
  } else {
    handleFilterChange();
  }
});

// Theme change - needs to reload from API since we use discover endpoint with keywords
themeSelect.addEventListener('change', (e) => {
  currentFilters.theme = parseInt(e.target.value, 10);
  // Theme filter requires API reload
  if (!isSearchMode && !isTop250Mode && !currentFilters.actorId) {
    loadTrending();
  } else {
    handleFilterChange();
  }
});

// Exclude genres dropdown toggle
excludeGenresBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = excludeGenresDropdown.style.display !== 'none';
  excludeGenresDropdown.style.display = isOpen ? 'none' : 'block';
  excludeGenresBtn.setAttribute('aria-expanded', !isOpen);
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!excludeGenresDropdown.contains(e.target) && e.target !== excludeGenresBtn) {
    excludeGenresDropdown.style.display = 'none';
    excludeGenresBtn.setAttribute('aria-expanded', 'false');
  }
});

// Exclude genres checkbox change - needs to reload from API
excludeGenresDropdown.addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;

  // Get all checked checkboxes
  const checkboxes = excludeGenresDropdown.querySelectorAll('input[type="checkbox"]:checked');
  currentFilters.excludeGenres = Array.from(checkboxes).map(cb => parseInt(cb.value, 10));

  // Update button text to show count
  const count = currentFilters.excludeGenres.length;
  excludeGenresBtn.textContent = count > 0 ? `Exclude (${count})` : 'Exclude Genres';
  excludeGenresBtn.classList.toggle('has-selections', count > 0);

  // Exclude genres filter requires API reload
  if (!isSearchMode && !isTop250Mode && !currentFilters.actorId) {
    loadTrending();
  } else {
    handleFilterChange();
  }
});

// Provider change - needs to reload from API since we use discover endpoint
providerSelect.addEventListener('change', (e) => {
  currentFilters.provider = parseInt(e.target.value, 10);
  // Provider filter requires API reload, not just client-side filtering
  if (!isSearchMode && !isTop250Mode && !currentFilters.actorId) {
    loadTrending();
  } else {
    handleFilterChange();
  }
});

// Actor search input
const debouncedActorSearch = debounce(async (query) => {
  if (query.length < 2) {
    actorSuggestions.classList.remove('show');
    return;
  }
  const actors = await searchActors(query);
  displayActorSuggestions(actors);
}, 300);

actorSearchInput.addEventListener('input', (e) => {
  const query = e.target.value.trim();
  if (query.length === 0) {
    actorSuggestions.classList.remove('show');
    // If there was an actor selected and user clears it, clear the filter
    if (currentFilters.actorId) {
      clearActorFilter();
    }
    return;
  }
  debouncedActorSearch(query);
});

// Clear actor filter button
clearActorBtn.addEventListener('click', (e) => {
  e.preventDefault();
  clearActorFilter();
});

// Close suggestions when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.actor-filter')) {
    actorSuggestions.classList.remove('show');
  }
});

// Top 250 button click
top250Btn.addEventListener('click', () => {
  leaveRecommended();
  if (isTop250Mode) {
    // If already in Top 250 mode, go back to trending
    loadTrending();
  } else {
    loadTop250();
  }
});

// Form submit
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const query = search.value.trim();
  handleSearch(query);
});

// Live search as user types
search.addEventListener('input', (e) => {
  const query = e.target.value.trim();
  if (query.length >= 3) {
    debouncedSearch(query);
  } else if (query.length === 0) {
    loadTrending();
  }
});

// Modal close handlers
closeModalBtn.addEventListener('click', closePlayer);

// Tab click handlers
tabWatch.addEventListener('click', () => switchTab('watch'));
tabTrailer.addEventListener('click', () => {
  if (!tabTrailer.disabled) {
    switchTab('trailer');
  }
});

// Provider failure must not strand the TV in an unresponsive cross-origin player.
document.addEventListener('tv-provider-fallback', event => {
  if (!TV_MODE || !HELPER_AVAILABLE || !currentPlayingMovie || EMBED_SOURCES[currentSourceIndex]?.name !== '111Movies') return;
  const tv = currentPlayingMovie.media_type === 'tv';
  const index = EMBED_SOURCES.findIndex(source => source.torrent && !!source.tvOnly === tv);
  if (index < 0) return;
  const position = Number(event.detail?.position);
  const startSec = Number.isFinite(position) ? Math.max(0, Math.min(position, 86400)) : 0;
  currentSourceIndex = index;
  sourceSelect.value = index;
  playerIframe.removeAttribute('data-provider-origin');
  if (tv) loadTvStream(currentPlayingMovie, currentSeason, currentEpisode, startSec);
  else loadYtsStream(currentPlayingMovie, startSec);
});

// Source selector change
sourceSelect.addEventListener('change', (e) => {
  tvSourceChosenManually = true;
  changeSource(parseInt(e.target.value, 10));
});

// YTS quality switch — restart the stream with the chosen quality's torrent.
if (qualitySelect) {
  qualitySelect.addEventListener('change', (e) => {
    const hash = (e.target.value || '').toLowerCase();
    // For TV the dropdown lists whole torrents, not qualities of one movie.
    if (tvPlayCtx && currentTvSources.some(source => source.hash === hash)) playTvSource(hash, tvPlayCtx.season, tvPlayCtx.episode, [], 0, { manualSource: true });
    else playYtsQuality(hash);
  });
}

if (subtitleSelect) {
  subtitleSelect.addEventListener('change', (e) => {
    showSubtitleTrack(e.target.value || '');
  });
}

if (subtitleEarlierBtn) subtitleEarlierBtn.addEventListener('click', () => adjustSubtitleSync(-0.5));
if (subtitleLaterBtn) subtitleLaterBtn.addEventListener('click', () => adjustSubtitleSync(0.5));

// Episode control event listeners
seasonSelect.addEventListener('change', (e) => {
  handleSeasonChange(e.target.value);
});

episodeSelect.addEventListener('change', (e) => {
  handleEpisodeChange(e.target.value);
});

prevEpisodeBtn.addEventListener('click', goToPrevEpisode);
nextEpisodeBtn.addEventListener('click', goToNextEpisode);

playerModal.addEventListener('click', (e) => {
  // Close if clicking outside the modal content
  if (e.target === playerModal) {
    closePlayer();
  }
});

// App-level fullscreen. The provider's own fullscreen button can be hijacked by
// an ad overlay inside its frame (111Movies does this); a click on our page
// cannot — see player-fullscreen.js. Sends the visible player element fullscreen
// with the provider's player still inside it.
function togglePlayerFullscreen() {
  const target = pickFullscreenTarget({
    activeTab: activePlayerTab,
    videoVisible: !!playerVideo && playerVideo.style.display !== 'none',
    playerIframe, playerVideo, trailerIframe,
  });
  toggleFullscreen(document, target).catch((err) => console.warn('Fullscreen failed:', err?.message || err));
}
if (playerFullscreenBtn) playerFullscreenBtn.addEventListener('click', togglePlayerFullscreen);

document.addEventListener('keydown', (e) => {
  if (playerModal.style.display !== 'flex') return;
  if (e.key === 'Escape') {
    // Escape leaves fullscreen first (the browser does that); only a second
    // Escape, outside fullscreen, closes the player.
    if (!document.fullscreenElement) closePlayer();
    return;
  }
  if (isFullscreenKey(e) && !isTypingTarget(e.target)) {
    e.preventDefault();
    togglePlayerFullscreen();
    return;
  }
  // Arrow keys seek the torrent player (only while its seek bar is showing).
  if (!isTypingTarget(e.target) && document.getElementById('torrent-seek')?.style.display === 'flex') {
    if (e.key === 'ArrowLeft') { e.preventDefault(); torrentSeekBy(-10); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); torrentSeekBy(30); }
  }
});

// Torrent seek-bar wiring: keep the readout live and turn clicks/buttons into
// restart-at-timestamp seeks.
if (playerVideo) {
  playerVideo.addEventListener('waiting', () => {
    if (!TV_MODE || !currentTorrentHash || !playerModalOpen || playerVideo.paused) return;
    setYtsStatus('Buffering… If this continues, choose another quality or source.');
    startYtsStatusPolling(currentTorrentHash);
  });
  playerVideo.addEventListener('timeupdate', renderTorrentTime);
  playerVideo.addEventListener('progress', renderTorrentTime);
}
{
  const tsBar = document.getElementById('ts-bar');
  if (tsBar) tsBar.addEventListener('click', (e) => {
    const rect = tsBar.getBoundingClientRect();
    torrentSeekTo(seekToFraction((e.clientX - rect.left) / rect.width, torrentDuration));
  });
  const tsBack = document.getElementById('ts-back');
  const tsFwd = document.getElementById('ts-fwd');
  if (tsBack) tsBack.addEventListener('click', () => torrentSeekBy(-10));
  if (tsFwd) tsFwd.addEventListener('click', () => torrentSeekBy(30));
}

// Initialize from URL params
function initFromUrl() {
  const params = getQueryParams();

  // Set media type
  currentFilters.mediaType = params.type;
  mediaTypeSelect.value = params.type;
  populateGenres(params.type);

  // Set genre
  currentFilters.genre = params.genre;
  genreSelect.value = params.genre.toString();

  // Set min rating
  currentFilters.minRating = params.rating;
  minRatingSelect.value = params.rating.toString();

  // Set min votes
  currentFilters.minVotes = params.votes;
  minVotesSelect.value = params.votes.toString();

  // Set year filter
  currentFilters.yearFilter = params.year;
  yearFilterSelect.value = params.year;

  // Set language
  currentFilters.language = params.language;
  languageSelect.value = params.language;

  // Set sort by
  currentFilters.sortBy = params.sort;
  sortBySelect.value = params.sort;

  // Set provider
  currentFilters.provider = params.provider;
  providerSelect.value = params.provider.toString();

  // Set theme
  currentFilters.theme = params.theme;
  themeSelect.value = params.theme.toString();

  // Set exclude genres
  currentFilters.excludeGenres = params.exclude;
  if (params.exclude.length > 0) {
    // Check the corresponding checkboxes
    const checkboxes = excludeGenresDropdown.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
      cb.checked = params.exclude.includes(parseInt(cb.value, 10));
    });
    // Update button text
    excludeGenresBtn.textContent = `Exclude (${params.exclude.length})`;
    excludeGenresBtn.classList.add('has-selections');
  }

  // Set search
  if (params.search) {
    search.value = params.search;
    handleSearch(params.search);
  } else if (importedTitleCount === null) {
    // An #import= landing goes straight to the Basket tab — don't burn hundreds of
    // trending-page fetches (and queue slots the rec engine needs) on a grid the user
    // isn't looking at. Clicking the Movies tab later runs loadTrending() fresh.
    loadTrending();
  }
}

// Scroll event for infinite scroll (debounced)
window.addEventListener('scroll', debounce(checkScrollPosition, 100));

// Pause watch-time accumulation while the browser tab is hidden; flush on page close.
document.addEventListener('visibilitychange', () => {
  if (!dwellTitleId) return;
  syncWatchTimer();
});
window.addEventListener('pagehide', flushDwell);

// Initialize
// Ingest a #import= profile payload before anything renders, so the first paint of
// any tab already reflects the imported signals.
const importedTitleCount = handleProfileImportFromHash();
populateSourceSelector();
populateThemes(); // Populate theme filter dropdown
loadProviderResultsFromFile(); // Load test results from JSON file and sync to localStorage
initFromUrl();

// Initialize YouTube module
initYouTube();

// Tab switching logic
const tabMovies = document.getElementById('tab-movies');
const tabWatched = document.getElementById('tab-watched');
const tabFavorites = document.getElementById('tab-favorites');
const tabYouTube = document.getElementById('tab-youtube');
const tabRecommended = document.getElementById('tab-recommended');
const movieFilters = document.getElementById('movie-filters');
const youtubeFilters = document.getElementById('youtube-filters');
const movieSearchForm = document.getElementById('form');
const youtubeSearchForm = document.getElementById('yt-form');
const top250Button = document.getElementById('top250-btn');

let isWatchedMode = false;
let isFavoritesMode = false;
let basketView = 'basket'; // 'basket' | 'downvoted' — which list the Basket tab shows

function switchToRecommended() {
  currentApp = 'movies';
  isWatchedMode = false;
  isFavoritesMode = false;
  isSearchMode = false;
  isTop250Mode = false;

  document.getElementById('recommendations-row')?.remove();
  tabMovies.classList.remove('active');
  tabRecommended.classList.add('active');
  tabWatched.classList.remove('active');
  tabFavorites.classList.remove('active');
  tabYouTube.classList.remove('active');
  top250Btn.classList.remove('active');

  movieFilters.style.display = 'none';
  youtubeFilters.style.display = 'none';
  movieSearchForm.style.display = 'none';
  youtubeSearchForm.style.display = 'none';
  top250Button.style.display = 'none';

  renderRecommendationsPage();
}

function switchToMovies() {
  leaveRecommended();
  currentApp = 'movies';
  isWatchedMode = false;
  isFavoritesMode = false;
  tabMovies.classList.add('active');
  tabRecommended.classList.remove('active');
  tabWatched.classList.remove('active');
  tabYouTube.classList.remove('active');
  tabFavorites.classList.remove('active');
  movieFilters.style.display = 'flex';
  youtubeFilters.style.display = 'none';
  movieSearchForm.style.display = 'flex';
  youtubeSearchForm.style.display = 'none';
  top250Button.style.display = 'block';
  // Show movie content
  loadTrending();
}

function switchToYouTube() {
  leaveRecommended();
  document.getElementById('recommendations-row')?.remove();
  currentApp = 'youtube';
  isWatchedMode = false;
  isFavoritesMode = false;
  tabYouTube.classList.add('active');
  tabMovies.classList.remove('active');
  tabRecommended.classList.remove('active');
  tabWatched.classList.remove('active');
  tabFavorites.classList.remove('active');
  youtubeFilters.style.display = 'flex';
  movieFilters.style.display = 'none';
  youtubeSearchForm.style.display = 'flex';
  movieSearchForm.style.display = 'none';
  top250Button.style.display = 'none';
  // Show YouTube content
  activateYouTube();
}

function switchToWatched() {
  leaveRecommended();
  document.getElementById('recommendations-row')?.remove();
  currentApp = 'movies';
  isWatchedMode = true;
  isFavoritesMode = false;
  isSearchMode = false;
  isTop250Mode = false;

  // Update tab active states
  tabMovies.classList.remove('active');
  tabRecommended.classList.remove('active');
  tabWatched.classList.add('active');
  tabYouTube.classList.remove('active');
  tabFavorites.classList.remove('active');
  top250Btn.classList.remove('active');

  // Show movie UI elements but hide filters for watched
  movieFilters.style.display = 'none';
  youtubeFilters.style.display = 'none';
  movieSearchForm.style.display = 'none';
  youtubeSearchForm.style.display = 'none';
  top250Button.style.display = 'none';

  // Load watched movies
  loadWatchedHistory();
}

async function loadWatchedHistory() {
  setLoading(true);
  hideError();

  const watched = getWatchedHistory();

  if (watched.length === 0) {
    main.innerHTML = '<p class="no-results">No watched movies yet. Start watching to build your history!</p>';
    setLoading(false);
    return;
  }

  allMovies = watched;
  filteredMovies = watched;
  displayedCount = 0;
  hasMorePages = false;

  // Clear and display
  main.innerHTML = '';
  const fragment = document.createDocumentFragment();
  watched.forEach((movie, index) => {
    fragment.appendChild(createMovieCard(movie, index));
  });
  main.appendChild(fragment);
  displayedCount = watched.length;

  setLoading(false);
}

function switchToFavorites() {
  leaveRecommended();
  currentApp = 'movies';
  isWatchedMode = false;
  isFavoritesMode = true;
  isSearchMode = false;
  isTop250Mode = false;

  document.getElementById('recommendations-row')?.remove();
  tabMovies.classList.remove('active');
  tabRecommended.classList.remove('active');
  tabWatched.classList.remove('active');
  tabYouTube.classList.remove('active');
  tabFavorites.classList.add('active');
  top250Btn.classList.remove('active');

  movieFilters.style.display = 'none';
  youtubeFilters.style.display = 'none';
  movieSearchForm.style.display = 'none';
  youtubeSearchForm.style.display = 'none';
  top250Button.style.display = 'none';

  loadFavorites();
}

function loadFavorites() {
  setLoading(true);
  hideError();

  const basket = getStarredList();
  const downvoted = getDownvotedList();
  const list = basketView === 'downvoted' ? downvoted : basket;

  main.innerHTML = '';

  // Segmented toggle: Basket | Downvoted (N)
  const seg = document.createElement('div');
  seg.className = 'basket-toggle';
  const mkBtn = (key, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'basket-seg' + (basketView === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { basketView = key; loadFavorites(); });
    return b;
  };
  seg.appendChild(mkBtn('basket', `Basket (${basket.length})`));
  seg.appendChild(mkBtn('downvoted', `Downvoted (${downvoted.length})`));
  main.appendChild(seg);

  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'no-results';
    empty.textContent = basketView === 'downvoted'
      ? 'No downvoted titles. Tap 👎 on any title to steer recommendations away from it.'
      : 'Your basket is empty. Tap ★ on any title to seed recommendations.';
    main.appendChild(empty);
    allMovies = []; filteredMovies = []; displayedCount = 0; hasMorePages = false;
    setLoading(false);
    return;
  }

  allMovies = list;
  filteredMovies = list;
  displayedCount = 0;
  hasMorePages = false;

  const fragment = document.createDocumentFragment();
  list.forEach((movie, index) => fragment.appendChild(createMovieCard(movie, index)));
  main.appendChild(fragment);
  displayedCount = list.length;

  setLoading(false);
}

// Desktop entry point for the Live home (on TV the whole .app-tabs strip is hidden
// and the injected kind nav calls setTvMediaKind). Listeners registered here run
// before the switchTo* handlers below, so leaving Live via any other app tab drops
// the kind back to 'all' first and the 60 s refresh cannot repaint over that tab.
const tabLive = document.getElementById('tab-live');
if (tabLive && !TV_MODE) {
  document.querySelectorAll('.app-tabs .app-tab').forEach(b => {
    if (b !== tabLive) b.addEventListener('click', () => {
      tabLive.classList.remove('active');
      if (tvMediaKind === 'live') { tvMediaKind = 'all'; stopLiveHomeRefresh(); }
    });
  });
  tabLive.addEventListener('click', () => {
    leaveRecommended();
    document.getElementById('recommendations-row')?.remove();
    currentApp = 'movies';
    isWatchedMode = false; isFavoritesMode = false; isSearchMode = false; isTop250Mode = false;
    resetFetchState(); hasMorePages = false; // no grid paging under the live rows
    document.querySelectorAll('.app-tabs .app-tab').forEach(b => b.classList.toggle('active', b === tabLive));
    top250Btn.classList.remove('active');
    [movieFilters, youtubeFilters, movieSearchForm, youtubeSearchForm, top250Button].forEach(el => { if (el) el.style.display = 'none'; });
    setLoading(false); hideError();
    setTvMediaKind('live');
  });
}
tabMovies?.addEventListener('click', switchToMovies);
tabWatched?.addEventListener('click', switchToWatched);
tabFavorites?.addEventListener('click', switchToFavorites);
tabYouTube?.addEventListener('click', switchToYouTube);
tabRecommended?.addEventListener('click', switchToRecommended);

// A profile import just landed (even a re-click that added nothing): open the Basket
// tab so the result is visible. (Must run after the tab elements above are bound —
// switchToFavorites uses them.)
if (importedTitleCount !== null) switchToFavorites();

document.addEventListener('tv-seek', event => {
  if (livePlayer.isActive()) return;
  const delta = Number(event.detail) || 0;
  if (tvPlayCtx && (TV_HLS || tvPlayCtx.src?.remux)) torrentSeekBy(delta);
  else if (Number.isFinite(playerVideo.duration)) playerVideo.currentTime = Math.max(0, Math.min(playerVideo.duration, playerVideo.currentTime + delta));
});
document.addEventListener('tv-seek-to', event => {
  if (livePlayer.isActive()) return;
  const fraction = Math.max(0, Math.min(1, Number(event.detail) || 0));
  if (tvPlayCtx && (TV_HLS || tvPlayCtx.src?.remux)) torrentSeekTo(fraction * torrentDuration);
  else if (Number.isFinite(playerVideo.duration)) playerVideo.currentTime = fraction * playerVideo.duration;
});
function publishTvPlaybackTime() {
  if (!TV_MODE || !playerVideo) return;
  if (livePlayer.isActive()) return;
  document.dispatchEvent(new CustomEvent('tv-playback-time', { detail: {
    position: torrentSeekBase + (playerVideo.currentTime || 0),
    duration: torrentDuration || (Number.isFinite(playerVideo.duration) ? playerVideo.duration : 0),
  } }));
}
playerVideo?.addEventListener('timeupdate', publishTvPlaybackTime);
playerVideo?.addEventListener('durationchange', publishTvPlaybackTime);

document.addEventListener('tv-retry-playback', () => {
  if (livePlayer.isActive()) { livePlayer.retry(); return; }
  if (!currentPlayingMovie) return;
  if (EMBED_SOURCES[currentSourceIndex]?.tvOnly) loadTvStream(currentPlayingMovie, currentSeason, currentEpisode);
  else if (EMBED_SOURCES[currentSourceIndex]?.torrent) loadYtsStream(currentPlayingMovie);
});
