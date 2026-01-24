import { CONFIG, ENDPOINTS, MOVIE_GENRES, TV_GENRES, THEME_KEYWORDS } from './config.js';
import { initYouTube, activateYouTube } from './youtube.js';

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
  { name: 'VidSrc.cc', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}` : `https://vidsrc.cc/v2/embed/${type}/${id}` },
  { name: 'Videasy', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://player.videasy.net/tv/${id}/${s}/${e}` : `https://player.videasy.net/${type}/${id}` },
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
const IFRAME_BLOCKED_PROVIDERS = [];
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

  // Set to first option (best provider) if results exist, otherwise keep current
  if (testResults.size > 0 && sourcesWithResults[0].percentage !== undefined) {
    currentSourceIndex = sourcesWithResults[0].index;
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
      <img src="${actor.profile_path ? 'https://image.tmdb.org/t/p/w45' + actor.profile_path : 'https://via.placeholder.com/40x40?text=?'}" alt="${actor.name}">
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
    const mediaType = type === 'tv' ? 'series' : 'movie';
    const url = `${CONFIG.OMDB_BASE_URL}/?apikey=${CONFIG.OMDB_API_KEY}&t=${encodeURIComponent(title)}&y=${year}&type=${mediaType}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.Response === 'True') {
      const rtRating = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
      const imdbRating = data.imdbRating !== 'N/A' ? parseFloat(data.imdbRating) : null;
      const rtScore = rtRating ? parseInt(rtRating.Value) : null; // e.g., "85%" -> 85

      const result = {
        imdbRating,
        rtScore,
        imdbId: data.imdbID,
        metascore: data.Metascore !== 'N/A' ? parseInt(data.Metascore) : null
      };

      omdbCache.set(cacheKey, result);
      return result;
    }
  } catch (error) {
    console.error('OMDb fetch error:', error);
  }

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
  } else if (tab === 'trailer' && currentTrailerKey) {
    tabTrailer.classList.add('active');
    tabWatch.classList.remove('active');
    trailerContainer.style.display = 'block';
    watchContainer.style.display = 'none';
    trailerIframe.src = `${YOUTUBE_EMBED_URL}/${currentTrailerKey}?autoplay=1`;
    // Pause main player when switching away
    playerIframe.src = '';
  }
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
  episodes.forEach(ep => {
    const option = document.createElement('option');
    option.value = ep.episode_number;
    option.textContent = `E${ep.episode_number}: ${ep.name || 'Episode ' + ep.episode_number}`;
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

  const embedUrl = getEmbedUrl('tv', currentPlayingMovie.id, season, episode);
  loadIframeSrc(embedUrl);

  // Update title
  const showName = currentPlayingMovie.name || currentPlayingMovie.title || 'Unknown';
  playerTitle.textContent = `${showName} - S${season}E${episode}`;

  // Save watch progress
  saveWatchProgress(currentPlayingMovie.id, season, episode);

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
  // Add to watched history
  addToWatchedHistory(movie);

  const title = movie.title || movie.name || 'Unknown';
  const type = movie.media_type === 'tv' ? 'tv' : 'movie';

  // Store current movie for source switching
  currentPlayingMovie = movie;

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
      const embedUrl = getEmbedUrl(type, movie.id, currentSeason, currentEpisode);
      loadIframeSrc(embedUrl);
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

// Calculate score: (rating - baseline) * log of vote count
// This penalizes lower ratings - only the "above average" portion counts
// Calculate combined score using TMDB rating and RT score
// If RT score is available, combine both for better accuracy
function calculateScore(movie) {
  const voteCount = movie.vote_count || 1;
  const tmdbRating = movie.vote_average || 0;
  const rtScore = movie.rtScore; // 0-100 scale

  // Convert RT score to 0-10 scale if available
  let combinedRating;
  if (rtScore !== null && rtScore !== undefined) {
    const rtRating = rtScore / 10; // Convert 85% -> 8.5
    // Average of TMDB and RT ratings (both on 0-10 scale)
    combinedRating = (tmdbRating + rtRating) / 2;
  } else {
    combinedRating = tmdbRating;
  }

  // Score formula skewed towards vote count:
  // score = (rating - 6.0) * log10(voteCount)^1.5
  // The 1.5 exponent gives more weight to higher vote counts
  const ratingFactor = Math.max(0, combinedRating - 6.0);
  const voteWeight = Math.pow(Math.log10(voteCount + 1), 1.5);
  return ratingFactor * voteWeight;
}

// Sort movies based on selected sort option
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
        // Sort by weighted score with strong recency multiplier
        const currentYearNW = new Date().getFullYear();
        const yearANW = parseInt((a.release_date || a.first_air_date || '0').split('-')[0]) || 0;
        const yearBNW = parseInt((b.release_date || b.first_air_date || '0').split('-')[0]) || 0;
        // Strong recency boost: current year = 5x, -1yr = 4x, -2yr = 3x, -3yr = 2x, older = 1x
        const getBoost = (year) => {
          const diff = currentYearNW - year;
          if (diff <= 0) return 5;
          if (diff === 1) return 4;
          if (diff === 2) return 3;
          if (diff === 3) return 2;
          return 1;
        };
        const adjustedScoreA = a.weightedScore * getBoost(yearANW);
        const adjustedScoreB = b.weightedScore * getBoost(yearBNW);
        return adjustedScoreB - adjustedScoreA;

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
async function fetchMoreTrending(pagesToFetch = 5) {
  if (!hasMorePages) return [];

  const promises = [];
  const startPage = currentApiPage + 1;
  const providerId = currentFilters.provider;
  const themeId = currentFilters.theme;
  const excludeGenres = currentFilters.excludeGenres.length > 0 ? currentFilters.excludeGenres.join(',') : null;
  const language = currentFilters.language || null;
  const mediaType = currentFilters.mediaType;

  // Combine keyword IDs: theme + genre (if genre is keyword-based)
  let keywordId = themeId;
  if (currentFilters.genreIsKeyword && currentFilters.genre > 0) {
    // TMDB supports multiple keywords separated by comma (OR) or pipe (AND)
    keywordId = themeId > 0 ? `${themeId},${currentFilters.genre}` : currentFilters.genre;
  }

  for (let i = 0; i < pagesToFetch; i++) {
    const page = startPage + i;
    if (page > 500) break; // TMDB max pages

    // If provider, keyword, exclude genres, or language filter is active, use discover API
    if (providerId > 0 || keywordId || excludeGenres || language) {
      if (mediaType === 'movie') {
        promises.push(fetchWithErrorHandling(ENDPOINTS.discoverMovies(page, providerId, keywordId, excludeGenres, language)).catch(() => null));
      } else if (mediaType === 'tv') {
        promises.push(fetchWithErrorHandling(ENDPOINTS.discoverTv(page, providerId, keywordId, excludeGenres, language)).catch(() => null));
      } else {
        // For 'all', fetch both movies and TV
        promises.push(fetchWithErrorHandling(ENDPOINTS.discoverMovies(page, providerId, keywordId, excludeGenres, language)).catch(() => null));
        promises.push(fetchWithErrorHandling(ENDPOINTS.discoverTv(page, providerId, keywordId, excludeGenres, language)).catch(() => null));
      }
    } else {
      promises.push(fetchWithErrorHandling(ENDPOINTS.trending(page)).catch(() => null));
    }
  }

  const responses = await Promise.all(promises);
  currentApiPage = startPage + pagesToFetch - 1;

  const newMovies = [];
  responses.forEach(data => {
    if (!data?.results) return;
    if (data.total_pages && currentApiPage >= data.total_pages) {
      hasMorePages = false;
    }
    data.results.forEach(movie => {
      // Deduplicate by ID
      if (!seenIds.has(movie.id)) {
        seenIds.add(movie.id);
        // Add media_type if not present (discover API doesn't include it)
        if (!movie.media_type) {
          movie.media_type = movie.title ? 'movie' : 'tv';
        }
        newMovies.push(movie);
      }
    });
  });

  allMovies = [...allMovies, ...newMovies];
  return newMovies;
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

  // Fetch RT ratings for filtered movies (limit to first 100 to avoid too many API calls)
  const moviesToEnrich = filtered.slice(0, 100);
  await enrichMoviesWithRatings(moviesToEnrich);

  const stats = calculateStats(filtered);
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
  img.src = poster_path ? CONFIG.IMAGE_URL + poster_path : 'https://via.placeholder.com/300x450?text=No+Image';
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
    if (!hasMorePages) return; // No more API pages

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
    await fetchMoreTrending(250); // Fetch first 250 pages (~5000 movies)
    await processAndDisplayMovies(allMovies);
  } catch (error) {
    console.error('Error loading trending movies:', error);
    showError('Failed to load movies. Please try again later.');
  } finally {
    setLoading(false);
  }
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

// Min votes change
minVotesSelect.addEventListener('change', (e) => {
  currentFilters.minVotes = parseInt(e.target.value, 10);
  handleFilterChange();
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
const tabYouTube = document.getElementById('tab-youtube');
const movieFilters = document.getElementById('movie-filters');
const youtubeFilters = document.getElementById('youtube-filters');
const movieSearchForm = document.getElementById('form');
const youtubeSearchForm = document.getElementById('yt-form');
const top250Button = document.getElementById('top250-btn');

let isWatchedMode = false;

function switchToMovies() {
  currentApp = 'movies';
  isWatchedMode = false;
  tabMovies.classList.add('active');
  tabWatched.classList.remove('active');
  tabYouTube.classList.remove('active');
  movieFilters.style.display = 'flex';
  youtubeFilters.style.display = 'none';
  movieSearchForm.style.display = 'flex';
  youtubeSearchForm.style.display = 'none';
  top250Button.style.display = 'block';
  // Show movie content
  loadTrending();
}

function switchToYouTube() {
  currentApp = 'youtube';
  isWatchedMode = false;
  tabYouTube.classList.add('active');
  tabMovies.classList.remove('active');
  tabWatched.classList.remove('active');
  youtubeFilters.style.display = 'flex';
  movieFilters.style.display = 'none';
  youtubeSearchForm.style.display = 'flex';
  movieSearchForm.style.display = 'none';
  top250Button.style.display = 'none';
  // Show YouTube content
  activateYouTube();
}

function switchToWatched() {
  currentApp = 'movies';
  isWatchedMode = true;
  isSearchMode = false;
  isTop250Mode = false;

  // Update tab active states
  tabMovies.classList.remove('active');
  tabWatched.classList.add('active');
  tabYouTube.classList.remove('active');
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

tabMovies?.addEventListener('click', switchToMovies);
tabWatched?.addEventListener('click', switchToWatched);
tabYouTube?.addEventListener('click', switchToYouTube);
