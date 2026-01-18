// Configuration file for the Movie App
// NOTE: For production, use a backend proxy to hide API keys
// This key is still exposed in the browser, but externalized for easier management

export const CONFIG = {
  // TMDB API
  API_KEY: '25292bda4c59c8e881ca8fcd4cd330df',
  BASE_URL: 'https://api.themoviedb.org/3',
  IMAGE_URL: 'https://image.tmdb.org/t/p/w500',

  // OMDb API (for Rotten Tomatoes ratings)
  // Get free key at: http://www.omdbapi.com/apikey.aspx
  // Replace with your own key below:
  OMDB_API_KEY: '',  // <-- ADD YOUR OMDB API KEY HERE
  OMDB_BASE_URL: 'https://www.omdbapi.com',

  // YouTube Data API v3
  // Get free key at: https://console.cloud.google.com/
  // 1. Create project → 2. Enable "YouTube Data API v3" → 3. Create API Key
  YOUTUBE_API_KEY: '',  // <-- ADD YOUR YOUTUBE API KEY HERE
  YOUTUBE_BASE_URL: 'https://www.googleapis.com/youtube/v3',

  // Performance settings
  MAX_PAGES: 10,
  CACHE_DURATION: 300000,  // 5 minutes in milliseconds

  // Filter settings
  MIN_RATING: 0,
  MIN_VOTE_COUNT: 10,
  MIN_YEAR: 1970,
  DEFAULT_LANGUAGE: 'en',
  DEFAULT_MEDIA_TYPE: 'all'
};

export const ENDPOINTS = {
  trending: (page) => `${CONFIG.BASE_URL}/trending/all/week?api_key=${CONFIG.API_KEY}&page=${page}`,
  search: (query) => `${CONFIG.BASE_URL}/search/multi?api_key=${CONFIG.API_KEY}&query=${encodeURIComponent(query)}`,
  videos: (type, id) => `${CONFIG.BASE_URL}/${type}/${id}/videos?api_key=${CONFIG.API_KEY}`,
  // Get external IDs (including IMDB ID) from TMDB
  externalIds: (type, id) => `${CONFIG.BASE_URL}/${type}/${id}/external_ids?api_key=${CONFIG.API_KEY}`,
  // OMDb API for Rotten Tomatoes ratings
  omdb: (imdbId) => `${CONFIG.OMDB_BASE_URL}/?apikey=${CONFIG.OMDB_API_KEY}&i=${imdbId}`,
  omdbSearch: (title, year) => `${CONFIG.OMDB_BASE_URL}/?apikey=${CONFIG.OMDB_API_KEY}&t=${encodeURIComponent(title)}&y=${year}`,
  // Watch providers (streaming services)
  watchProviders: (type, id) => `${CONFIG.BASE_URL}/${type}/${id}/watch/providers?api_key=${CONFIG.API_KEY}`,
  // Credits (for director info)
  credits: (type, id) => `${CONFIG.BASE_URL}/${type}/${id}/credits?api_key=${CONFIG.API_KEY}`,
  // TV show details (seasons/episodes)
  tvDetails: (id) => `${CONFIG.BASE_URL}/tv/${id}?api_key=${CONFIG.API_KEY}`,
  // Season details (episode list)
  seasonDetails: (id, seasonNum) => `${CONFIG.BASE_URL}/tv/${id}/season/${seasonNum}?api_key=${CONFIG.API_KEY}`,
  // Person search (for actor filter)
  searchPerson: (query) => `${CONFIG.BASE_URL}/search/person?api_key=${CONFIG.API_KEY}&query=${encodeURIComponent(query)}`,
  // Popular actors
  popularPeople: (page = 1) => `${CONFIG.BASE_URL}/person/popular?api_key=${CONFIG.API_KEY}&page=${page}`,
  // Discover movies by actor
  discoverMoviesByActor: (personId, page = 1) => `${CONFIG.BASE_URL}/discover/movie?api_key=${CONFIG.API_KEY}&with_cast=${personId}&sort_by=popularity.desc&page=${page}`,
  // Discover TV by actor
  discoverTvByActor: (personId, page = 1) => `${CONFIG.BASE_URL}/discover/tv?api_key=${CONFIG.API_KEY}&with_cast=${personId}&sort_by=popularity.desc&page=${page}`,
  // Person movie credits
  personMovieCredits: (personId) => `${CONFIG.BASE_URL}/person/${personId}/movie_credits?api_key=${CONFIG.API_KEY}`,
  // Person TV credits
  personTvCredits: (personId) => `${CONFIG.BASE_URL}/person/${personId}/tv_credits?api_key=${CONFIG.API_KEY}`,
  // Top rated movies (IMDB Top 250 equivalent)
  topRatedMovies: (page = 1) => `${CONFIG.BASE_URL}/movie/top_rated?api_key=${CONFIG.API_KEY}&page=${page}`,
  // Discover movies with provider, keyword, exclude genres, and language filter
  discoverMovies: (page, providerId, keywordId, excludeGenres, language) => `${CONFIG.BASE_URL}/discover/movie?api_key=${CONFIG.API_KEY}&page=${page}&sort_by=popularity.desc&watch_region=US${providerId ? `&with_watch_providers=${providerId}` : ''}${keywordId ? `&with_keywords=${keywordId}` : ''}${excludeGenres ? `&without_genres=${excludeGenres}` : ''}${language ? `&with_original_language=${language}` : ''}`,
  // Discover TV with provider, keyword, exclude genres, and language filter
  discoverTv: (page, providerId, keywordId, excludeGenres, language) => `${CONFIG.BASE_URL}/discover/tv?api_key=${CONFIG.API_KEY}&page=${page}&sort_by=popularity.desc&watch_region=US${providerId ? `&with_watch_providers=${providerId}` : ''}${keywordId ? `&with_keywords=${keywordId}` : ''}${excludeGenres ? `&without_genres=${excludeGenres}` : ''}${language ? `&with_original_language=${language}` : ''}`
};

// Media types
export const MEDIA_TYPES = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'TV Shows' }
];

// Movie genres (from TMDB)
// Some entries use keyword IDs (type: 'keyword') for sub-genre filtering
export const MOVIE_GENRES = [
  { id: 0, name: 'All Genres' },
  { id: 28, name: 'Action' },
  { id: 10759, name: 'Action & Adventure' },
  { id: 12, name: 'Adventure' },
  { id: 9951, name: 'Alien', type: 'keyword' },
  { id: 16, name: 'Animation' },
  { id: 818, name: 'Based on Novel', type: 'keyword' },
  { id: 9672, name: 'Based on True Story', type: 'keyword' },
  { id: 35, name: 'Comedy' },
  { id: 10683, name: 'Coming of Age', type: 'keyword' },
  { id: 80, name: 'Crime' },
  { id: 99, name: 'Documentary' },
  { id: 18, name: 'Drama' },
  { id: 4565, name: 'Dystopia', type: 'keyword' },
  { id: 10751, name: 'Family' },
  { id: 14, name: 'Fantasy' },
  { id: 36, name: 'History' },
  { id: 27, name: 'Horror' },
  { id: 10762, name: 'Kids' },
  { id: 10402, name: 'Music' },
  { id: 9648, name: 'Mystery' },
  { id: 10763, name: 'News' },
  { id: 10764, name: 'Reality' },
  { id: 9748, name: 'Revenge', type: 'keyword' },
  { id: 14544, name: 'Robot', type: 'keyword' },
  { id: 10749, name: 'Romance' },
  { id: 878, name: 'Sci-Fi' },
  { id: 10765, name: 'Sci-Fi & Fantasy' },
  { id: 10766, name: 'Soap' },
  { id: 9882, name: 'Space', type: 'keyword' },
  { id: 9715, name: 'Superhero', type: 'keyword' },
  { id: 10349, name: 'Survival', type: 'keyword' },
  { id: 10767, name: 'Talk' },
  { id: 53, name: 'Thriller' },
  { id: 4379, name: 'Time Travel', type: 'keyword' },
  { id: 10770, name: 'TV Movie' },
  { id: 10752, name: 'War' },
  { id: 10768, name: 'War & Politics' },
  { id: 37, name: 'Western' },
  { id: 12377, name: 'Zombie', type: 'keyword' }
];

// Theme keywords (from TMDB) - for filtering by specific themes
export const THEME_KEYWORDS = [
  { id: 0, name: 'All Themes' },
  // === UNIQUE / RARE / HIDDEN GEMS ===
  { id: 6158, name: 'Cult Classic' },
  { id: 360713, name: 'Indie Film' },
  { id: 318182, name: 'Arthouse' },
  { id: 293336, name: 'Experimental' },
  { id: 9887, name: 'Surrealism' },
  { id: 9807, name: 'Film Noir' },
  { id: 207268, name: 'Neo-Noir' },
  { id: 12565, name: 'Psychological Thriller' },
  { id: 157171, name: 'Nonlinear Timeline' },
  { id: 275311, name: 'Plot Twist' },
  { id: 362567, name: 'Mind-Bending' },
  { id: 9706, name: 'Anthology' },
  { id: 181324, name: 'Existentialism' },
  { id: 279822, name: 'Minimalist' },
  { id: 1353, name: 'Underground' },
  { id: 212737, name: 'Philosophical' },
  // === SCI-FI / FANTASY ===
  { id: 9882, name: 'Space' },
  { id: 2964, name: 'Future' },
  { id: 4565, name: 'Dystopia' },
  { id: 4379, name: 'Time Travel' },
  { id: 14544, name: 'Robot' },
  { id: 9951, name: 'Alien' },
  { id: 9715, name: 'Superhero' },
  { id: 12377, name: 'Zombie' },
  // === GENERAL ===
  { id: 10349, name: 'Survival' },
  { id: 9748, name: 'Revenge' },
  { id: 818, name: 'Based on Novel' },
  { id: 10683, name: 'Coming of Age' },
  { id: 11322, name: 'Female Protagonist' },
  { id: 9672, name: 'Based on True Story' }
];

// TV genres (from TMDB)
export const TV_GENRES = [
  { id: 0, name: 'All Genres' },
  { id: 10759, name: 'Action & Adventure' },
  { id: 16, name: 'Animation' },
  { id: 35, name: 'Comedy' },
  { id: 80, name: 'Crime' },
  { id: 99, name: 'Documentary' },
  { id: 18, name: 'Drama' },
  { id: 10751, name: 'Family' },
  { id: 10762, name: 'Kids' },
  { id: 9648, name: 'Mystery' },
  { id: 10763, name: 'News' },
  { id: 10764, name: 'Reality' },
  { id: 10765, name: 'Sci-Fi & Fantasy' },
  { id: 10766, name: 'Soap' },
  { id: 10767, name: 'Talk' },
  { id: 10768, name: 'War & Politics' },
  { id: 37, name: 'Western' }
];

// YouTube API Endpoints
export const YOUTUBE_ENDPOINTS = {
  // Search videos
  search: (query, params = {}) => {
    const baseUrl = `${CONFIG.YOUTUBE_BASE_URL}/search?key=${CONFIG.YOUTUBE_API_KEY}&part=snippet&type=video&maxResults=50`;
    let url = `${baseUrl}&q=${encodeURIComponent(query)}`;
    if (params.categoryId) url += `&videoCategoryId=${params.categoryId}`;
    if (params.duration) url += `&videoDuration=${params.duration}`;
    if (params.publishedAfter) url += `&publishedAfter=${params.publishedAfter}`;
    if (params.order) url += `&order=${params.order}`;
    if (params.pageToken) url += `&pageToken=${params.pageToken}`;
    return url;
  },
  // Get video details (statistics, duration)
  videoDetails: (videoIds) => `${CONFIG.YOUTUBE_BASE_URL}/videos?key=${CONFIG.YOUTUBE_API_KEY}&part=snippet,statistics,contentDetails&id=${videoIds.join(',')}`,
  // Get trending/popular videos by category
  trending: (categoryId, pageToken) => {
    let url = `${CONFIG.YOUTUBE_BASE_URL}/videos?key=${CONFIG.YOUTUBE_API_KEY}&part=snippet,statistics,contentDetails&chart=mostPopular&maxResults=50&regionCode=US`;
    if (categoryId && categoryId !== 0) url += `&videoCategoryId=${categoryId}`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    return url;
  },
  // Search channels
  searchChannels: (query) => `${CONFIG.YOUTUBE_BASE_URL}/search?key=${CONFIG.YOUTUBE_API_KEY}&part=snippet&type=channel&q=${encodeURIComponent(query)}&maxResults=10`
};

// YouTube Video Categories
export const YOUTUBE_CATEGORIES = [
  { id: 0, name: 'All Categories' },
  { id: 28, name: 'Science & Technology' },
  { id: 27, name: 'Education' },
  { id: 24, name: 'Entertainment' },
  { id: 20, name: 'Gaming' },
  { id: 10, name: 'Music' },
  { id: 22, name: 'People & Blogs' },
  { id: 25, name: 'News & Politics' },
  { id: 26, name: 'Howto & Style' },
  { id: 1, name: 'Film & Animation' },
  { id: 17, name: 'Sports' },
  { id: 19, name: 'Travel & Events' },
  { id: 23, name: 'Comedy' }
];

// YouTube Duration Options
export const YOUTUBE_DURATIONS = [
  { value: 'any', name: 'Any Duration' },
  { value: 'short', name: 'Short (< 4 min)' },
  { value: 'medium', name: 'Medium (4-20 min)' },
  { value: 'long', name: 'Long (> 20 min)' }
];

// YouTube Upload Date Options
export const YOUTUBE_UPLOAD_DATES = [
  { value: 'any', name: 'Any Time' },
  { value: 'hour', name: 'Last Hour' },
  { value: 'day', name: 'Last 24 Hours' },
  { value: 'week', name: 'This Week' },
  { value: 'month', name: 'This Month' },
  { value: 'year', name: 'This Year' }
];

// YouTube Sort Options
export const YOUTUBE_SORT_OPTIONS = [
  { value: 'gem', name: 'Hidden Gem Score' },
  { value: 'likeRatio', name: 'Like Ratio' },
  { value: 'commentRatio', name: 'Comment Ratio' },
  { value: 'date', name: 'Upload Date' },
  { value: 'viewCount', name: 'View Count' }
];
