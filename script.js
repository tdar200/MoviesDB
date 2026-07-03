import { CONFIG, ENDPOINTS, MOVIE_GENRES, TV_GENRES, THEME_KEYWORDS } from './config.js';
import { initYouTube, activateYouTube } from './youtube.js';
import { getRecommendations, getRecommendationRows, clearRecommendationCache } from './recommendations.js';
import { createWatchTimer } from './watch-timer.js';
import { calculateScore, newestWeightedScore } from './scoring.js';

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
const playerTitle = document.getElementById('player-title');
const closeModalBtn = document.getElementById('close-modal');
const watchContainer = document.getElementById('watch-container');
const trailerContainer = document.getElementById('trailer-container');
const tabWatch = document.getElementById('tab-watch');
const tabTrailer = document.getElementById('tab-trailer');

// Video embed sources - Updated Jan 18, 2026
// Only includes providers that passed testing (see provider-results.json)
const EMBED_SOURCES = [
  { name: 'Videasy', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://player.videasy.net/tv/${id}/${s}/${e}` : `https://player.videasy.net/${type}/${id}` },
  { name: 'VidSrc.cc', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}` : `https://vidsrc.cc/v2/embed/${type}/${id}` },
  { name: 'VidLink', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidlink.pro/tv/${id}/${s}/${e}` : `https://vidlink.pro/${type}/${id}` },
  { name: 'Nontongo', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://www.nontongo.win/embed/tv/${id}/${s}/${e}` : `https://www.nontongo.win/embed/${type}/${id}` },
  // The providers below failed testing but kept as fallbacks
  { name: 'VidSrc.to', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc.to/embed/tv/${id}/${s}/${e}` : `https://vidsrc.to/embed/${type}/${id}` },
  { name: 'Embed.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://embed.su/embed/tv/${id}/${s}/${e}` : `https://embed.su/embed/${type}/${id}` },
  { name: 'Autoembed.cc', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/${type}/${id}` },
  { name: 'SuperEmbed', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}` : `https://multiembed.mov/?video_id=${id}&tmdb=1` },
  { name: 'VidSrcMe.ru', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrcme.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrcme.ru/embed/movie?tmdb=${id}` },
  { name: 'VidSrcMe.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrcme.su/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrcme.su/embed/movie?tmdb=${id}` },
  { name: 'VidSrc-Me.ru', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc-me.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc-me.ru/embed/movie?tmdb=${id}` },
  { name: 'VidSrc-Me.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc-me.su/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc-me.su/embed/movie?tmdb=${id}` },
  { name: 'VidSrc-Embed.ru', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc-embed.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc-embed.ru/embed/movie?tmdb=${id}` },
  { name: 'VidSrc-Embed.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc-embed.su/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc-embed.su/embed/movie?tmdb=${id}` },
  { name: 'Vsrc.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vsrc.su/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vsrc.su/embed/movie?tmdb=${id}` },
];
let currentSourceIndex = 0;
const YOUTUBE_EMBED_URL = 'https://www.youtube.com/embed';

// Providers that block iframe embedding - will open in new tab instead
const IFRAME_BLOCKED_PROVIDERS = ['VidSrc.cc'];
// Providers that are completely blocked/down - exclude from list
const BLOCKED_PROVIDERS = [];

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
function flushDwell() {
  if (!dwellTitleId) return;
  watchTimer.pause(Date.now());
  const watchMs = watchTimer.elapsed(Date.now());
  if (watchMs > 0) {
    recordDwell(dwellTitleId, watchMs);
    if (dwellMovie && watchMs >= watchedThresholdMs()) addToWatchedHistory(dwellMovie);
    clearRecommendationCache();
  }
  watchTimer.reset();
  dwellTitleId = null;
  dwellMovie = null;
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
    progress[showId] = { season, episode, timestamp: Date.now() };
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
    // Keep max 100 items
    localStorage.setItem(WATCHED_HISTORY_KEY, JSON.stringify(filtered.slice(0, 100)));
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
// Toggle star for a movie; returns the new starred state.
function toggleStar(movie) {
  const store = getStarredStore();
  if (Object.prototype.hasOwnProperty.call(store, movie.id)) {
    delete store[movie.id];
    saveStarredStore(store);
    clearRecommendationCache();
    return false;
  }
  // Remove from downvoted if present — mutually exclusive with the basket.
  const downvoted = getDownvotedStore();
  if (Object.prototype.hasOwnProperty.call(downvoted, movie.id)) {
    delete downvoted[movie.id];
    saveDownvotedStore(downvoted);
  }
  store[movie.id] = {
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
    starredAt: Date.now(),
  };
  saveStarredStore(store);
  clearRecommendationCache();
  return true;
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

// Assemble the explicit signal input the engine consumes: the starred basket (positive),
// the downvoted set (negative steer), and watched ids (exclude-only).
function buildSignalItems() {
  return {
    basket: getStarredList(),
    downvoted: getDownvotedList(),
    watchedIds: getWatchedHistory().map((m) => m.id),
  };
}

// Populate source selector with test results percentages
function populateSourceSelector() {
  sourceSelect.innerHTML = '';
  const testResults = getProviderTestResults();

  // Create array with sources and their percentages for sorting
  const sourcesWithResults = EMBED_SOURCES.map((source, index) => ({
    source,
    index,
    percentage: testResults.get(source.name)
  }));

  // Sort by percentage (highest first), then by name for those without results
  if (testResults.size > 0) {
    sourcesWithResults.sort((a, b) => {
      // Both have percentages - sort by percentage desc
      if (a.percentage !== undefined && b.percentage !== undefined) {
        return b.percentage - a.percentage;
      }
      // One has percentage - it goes first
      if (a.percentage !== undefined) return -1;
      if (b.percentage !== undefined) return 1;
      // Neither has percentage - maintain original order
      return a.index - b.index;
    });
  }

  // Providers to always include regardless of test results
  const alwaysInclude = ['VidSrc.cc', 'Videasy', 'VidLink', 'Nontongo', 'VidSrc.to', 'Embed.su', 'Autoembed.cc', 'SuperEmbed', 'VidSrcMe.ru', 'VidSrcMe.su', 'VidSrc-Me.ru', 'VidSrc-Me.su', 'VidSrc-Embed.ru', 'VidSrc-Embed.su', 'Vsrc.su'];

  sourcesWithResults.forEach(({ source, index, percentage }) => {
    // Skip completely blocked providers
    if (BLOCKED_PROVIDERS.includes(source.name)) {
      return;
    }

    // Skip providers that failed the test (0% or very low playback)
    // Unless they're in the always include list
    if (testResults.size > 0 && (percentage === undefined || percentage < 50)) {
      if (!alwaysInclude.includes(source.name)) {
        return; // Don't show failed/untested providers when we have test data
      }
    }

    const option = document.createElement('option');
    option.value = index;

    // Check if we have test results for this provider
    const isBlocked = IFRAME_BLOCKED_PROVIDERS.includes(source.name);
    if (percentage !== undefined && percentage > 0) {
      option.textContent = `${source.name} (${percentage}%)${isBlocked ? ' ↗' : ''}`;
    } else {
      option.textContent = `${source.name}${isBlocked ? ' ↗' : ''}`;
    }

    // Mark iframe-blocked providers with data attribute
    if (isBlocked) {
      option.dataset.newTab = 'true';
    }

    sourceSelect.appendChild(option);
  });

  // Set default to highest-scoring provider that is iframe-loadable
  if (testResults.size > 0) {
    const firstUsable = sourcesWithResults.find(s =>
      s.percentage !== undefined &&
      !BLOCKED_PROVIDERS.includes(s.source.name) &&
      !IFRAME_BLOCKED_PROVIDERS.includes(s.source.name)
    );
    if (firstUsable) currentSourceIndex = firstUsable.index;
  }
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
    const response = await fetch(ENDPOINTS.watchProviders(type, id));
    if (!response.ok) return null;
    const data = await response.json();

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
    const response = await fetch(ENDPOINTS.credits(type, id));
    if (!response.ok) return null;
    const data = await response.json();

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
    const response = await fetch(ENDPOINTS.searchPerson(query));
    if (!response.ok) return [];
    const data = await response.json();

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
      const movieResponse = await fetch(ENDPOINTS.personMovieCredits(actorId));
      if (movieResponse.ok) {
        const movieData = await movieResponse.json();
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
      const tvResponse = await fetch(ENDPOINTS.personTvCredits(actorId));
      if (tvResponse.ok) {
        const tvData = await tvResponse.json();
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

    const movies = await fetchByActor(currentFilters.actorId, currentFilters.mediaType);
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

// Fetch Top 250 movies from TMDB
async function fetchTop250() {
  const movies = [];
  const pages = 13; // 13 pages * 20 = 260 movies, we'll take first 250

  try {
    const promises = [];
    for (let page = 1; page <= pages; page++) {
      promises.push(fetchWithErrorHandling(ENDPOINTS.topRatedMovies(page)).catch(() => null));
    }

    const responses = await Promise.all(promises);
    responses.forEach(data => {
      if (data?.results) {
        data.results.forEach(movie => {
          if (movies.length < 250) {
            movies.push({ ...movie, media_type: 'movie' });
          }
        });
      }
    });
  } catch (error) {
    console.error('Error fetching Top 250:', error);
  }

  return movies;
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
      if (Date.now() - t < 24 * 60 * 60 * 1000) {
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
    const response = await fetch(ENDPOINTS.videos(type, id));
    if (!response.ok) return null;
    const data = await response.json();

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
  const source = EMBED_SOURCES[currentSourceIndex];
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

// Change video source
function changeSource(newIndex) {
  currentSourceIndex = newIndex;
  sourceSelect.value = newIndex; // Keep dropdown in sync

  if (currentPlayingMovie) {
    const type = currentPlayingMovie.media_type === 'tv' ? 'tv' : 'movie';
    let url;

    if (type === 'tv' && currentTvData) {
      url = getEmbedUrl(type, currentPlayingMovie.id, currentSeason, currentEpisode);
    } else {
      url = getEmbedUrl(type, currentPlayingMovie.id);
    }

    console.log('Switching to source:', EMBED_SOURCES[newIndex].name, 'URL:', url);

    // Clear and reload
    playerIframe.src = '';
    setTimeout(() => loadIframeSrc(url), 50);
  }
}

// Fetch TV show details (seasons)
async function fetchTvDetails(tvId) {
  try {
    const response = await fetch(ENDPOINTS.tvDetails(tvId));
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error('Error fetching TV details:', error);
    return null;
  }
}

// Fetch season details (episodes)
async function fetchSeasonDetails(tvId, seasonNum) {
  try {
    const response = await fetch(ENDPOINTS.seasonDetails(tvId, seasonNum));
    if (!response.ok) return null;
    return await response.json();
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

async function openPlayer(movie) {
  // Begin engagement capture for this title. Watched status is NOT set on open — it is
  // committed later by flushDwell() once enough active watch-tab time has accrued.
  flushDwell(); // flush any prior session that didn't close cleanly (may mark it watched)
  dwellTitleId = movie.id;
  dwellMovie = movie;
  activePlayerTab = 'watch';
  watchTimer.reset();
  recordOpen(movie.id);

  const title = movie.title || movie.name || 'Unknown';
  const type = movie.media_type === 'tv' ? 'tv' : 'movie';

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
      } else {
        const embedUrl = getEmbedUrl(type, movie.id, currentSeason, currentEpisode);
        loadIframeSrc(embedUrl);
      }
      playerTitle.textContent = `${title} - S${currentSeason}E${currentEpisode}`;

      updateNavButtons();
    } else {
      // Fallback if no season data
      const embedUrl = getEmbedUrl(type, movie.id);
      loadIframeSrc(embedUrl);
      playerTitle.textContent = title;
      episodeControls.style.display = 'none';
    }
  } else {
    // Movie - no episode controls
    episodeControls.style.display = 'none';
    const embedUrl = getEmbedUrl(type, movie.id);
    loadIframeSrc(embedUrl);
    playerTitle.textContent = title;
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
  playerModalOpen = false;
  flushDwell();
  playerModal.style.display = 'none';
  playerIframe.src = '';
  trailerIframe.src = '';
  currentTrailerKey = null;
  currentPlayingMovie = null;
  currentTvData = null;
  currentSeasonData = null;
  document.body.style.overflow = '';
}

// Show/hide loading state
function setLoading(isLoading) {
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

// Fetch with error handling
async function fetchWithErrorHandling(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
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

    // Media type filter
    if (currentFilters.mediaType !== 'all' && movie.media_type !== currentFilters.mediaType) {
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

async function fetchMoreTrending(pagesToFetch = 5) {
  if (!hasMorePages) return [];

  const providerId = currentFilters.provider;
  const themeId = currentFilters.theme;
  const excludeGenres = currentFilters.excludeGenres.length > 0 ? currentFilters.excludeGenres.join(',') : null;
  const language = currentFilters.language || null;
  const mediaType = currentFilters.mediaType;
  const minVotes = currentFilters.minVotes || null;

  // Combine keyword IDs: theme + genre (if genre is keyword-based)
  let keywordId = themeId;
  if (currentFilters.genreIsKeyword && currentFilters.genre > 0) {
    keywordId = themeId > 0 ? `${themeId},${currentFilters.genre}` : currentFilters.genre;
  }

  // Use discover API if any filter is active
  const useDiscoverApi = providerId > 0 || keywordId || excludeGenres || language || minVotes;

  // Fetch in batches to avoid TMDB rate limiting (40 req/10s)
  const BATCH_SIZE = 10; // Requests per batch
  const BATCH_DELAY = 300; // ms between batches
  const allNewMovies = [];
  let totalPagesAvailable = Infinity;

  for (let batchStart = 0; batchStart < pagesToFetch && hasMorePages; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, pagesToFetch);
    const promises = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const page = currentApiPage + 1 + i;
      if (page > 500 || page > totalPagesAvailable) break; // TMDB max pages or no more data

      if (useDiscoverApi) {
        if (mediaType === 'movie') {
          promises.push(fetchWithErrorHandling(ENDPOINTS.discoverMovies(page, providerId, keywordId, excludeGenres, language, minVotes)).catch(() => null));
        } else if (mediaType === 'tv') {
          promises.push(fetchWithErrorHandling(ENDPOINTS.discoverTv(page, providerId, keywordId, excludeGenres, language, minVotes)).catch(() => null));
        } else {
          // For 'all', fetch both movies and TV
          promises.push(fetchWithErrorHandling(ENDPOINTS.discoverMovies(page, providerId, keywordId, excludeGenres, language, minVotes)).catch(() => null));
          promises.push(fetchWithErrorHandling(ENDPOINTS.discoverTv(page, providerId, keywordId, excludeGenres, language, minVotes)).catch(() => null));
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
// well-rated low-buzz release can never appear no matter how the client sorts. This pass pulls
// rating-sorted discover pages (vote floor 300, last 3 years) with the same active filters and
// merges them into the pool so "good but not famous" titles are sortable at all.
const GEM_PAGES_PER_TYPE = 5;
const GEM_WINDOW_YEARS = 3;

async function fetchQualityGems(pagesPerType = GEM_PAGES_PER_TYPE) {
  const providerId = currentFilters.provider;
  const excludeGenres = currentFilters.excludeGenres.length > 0 ? currentFilters.excludeGenres.join(',') : null;
  const language = currentFilters.language || null;
  const mediaType = currentFilters.mediaType;
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
function resetFetchState() {
  allMovies = [];
  filteredMovies = [];
  displayedCount = 0;
  currentApiPage = 0;
  hasMorePages = true;
  seenIds.clear();
}

// Process and display movies with current filters
async function processAndDisplayMovies(movies, isSearch = false) {
  const filtered = applyFilters(movies, isSearch);

  // Enrich the provisional top 100 (per the active sort), not the first 100 in fetch
  // order: fetch order is trending/popularity, so rank contenders outside it would
  // never receive their IMDb/RT cross-check. Rank with TMDB-only scores first, enrich
  // the titles about to be displayed, then re-sort with the enriched ratings.
  // sortMovies returns copies, so map the top ids back to the pool objects and enrich
  // those in place - enrichment then persists across re-renders like before.
  const stats = calculateStats(filtered);
  const provisional = sortMovies(filtered, stats).slice(0, 100);
  const topKeys = new Set(provisional.map(m => `${m.media_type}:${m.id}`));
  await enrichMoviesWithRatings(filtered.filter(m => topKeys.has(`${m.media_type}:${m.id}`)));

  filteredMovies = sortMovies(filtered, stats);
  displayedCount = 0;
  main.innerHTML = '';

  if (filteredMovies.length === 0) {
    const noResults = document.createElement('p');
    noResults.className = 'no-results';
    noResults.textContent = 'No movies found matching your filters.';
    main.appendChild(noResults);
    return;
  }

  loadMoreMovies();
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

  // Only show on the Movies home/browse view — not search, Top 250, or Watched.
  if (isSearchMode || isTop250Mode || isWatchedMode || isFavoritesMode) return;

  const items = buildSignalItems();
  if (items.basket.length === 0) return; // basket-primary cold-start: nothing to recommend

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
    ({ rows } = await getRecommendationRows(items, { limit: 60, onRow: onStream }));
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

// A star toggle bound to a movie. Stops click propagation so it never triggers play.
function createStarButton(movie) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'star-btn';
  const sync = () => {
    const on = isStarred(movie.id);
    btn.classList.toggle('starred', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    btn.title = on ? 'Remove from favorites' : 'Add to favorites';
    btn.innerHTML = on ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
  };
  sync();
  btn.addEventListener('resync', sync); // re-render when a sibling downvote toggles state
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStar(movie);
    sync();
    const down = btn.parentElement?.querySelector('.down-btn');
    if (down) down.dispatchEvent(new CustomEvent('resync'));
    if (isFavoritesMode) loadFavorites();
    onSignalChanged();
  });
  // Keep keyboard activation on the star from bubbling to the card's play handler.
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  });
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
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDownvote(movie);
    sync();
    const star = btn.parentElement?.querySelector('.star-btn');
    if (star) star.dispatchEvent(new CustomEvent('resync'));
    onSignalChanged();
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  });
  return btn;
}

// Create movie card element
function createMovieCard(movie, index) {
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
    
    await fetchMoreTrending(pagesToFetch);
    await fetchQualityGems();
    await processAndDisplayMovies(allMovies);
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

// Source selector change
sourceSelect.addEventListener('change', (e) => {
  changeSource(parseInt(e.target.value, 10));
});

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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && playerModal.style.display === 'flex') {
    closePlayer();
  }
});

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
  } else {
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

tabMovies?.addEventListener('click', switchToMovies);
tabWatched?.addEventListener('click', switchToWatched);
tabFavorites?.addEventListener('click', switchToFavorites);
tabYouTube?.addEventListener('click', switchToYouTube);
tabRecommended?.addEventListener('click', switchToRecommended);
