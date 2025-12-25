// YouTube Discovery Module (No API - Direct YouTube Links)

// Current filters
let ytFilters = {
  category: '',
  duration: '',
  uploadDate: '',
  sortBy: 'relevance',
  searchQuery: ''
};

// Category to search query mapping
const CATEGORY_QUERIES = {
  '0': '',
  '28': 'technology programming coding',
  '27': 'educational tutorial learn',
  '24': 'entertainment',
  '20': 'gaming gameplay',
  '10': 'music',
  '22': 'vlog daily',
  '26': 'how to tutorial DIY',
  '1': 'film animation',
  '17': 'sports highlights',
  '23': 'comedy funny'
};

// DOM Elements
let ytMain, ytCategorySelect, ytDurationSelect, ytUploadDateSelect;
let ytSortSelect, ytSearchInput, ytForm;

// Initialize DOM references
function initYouTubeDom() {
  ytMain = document.getElementById('main');
  ytCategorySelect = document.getElementById('yt-category');
  ytDurationSelect = document.getElementById('yt-duration');
  ytUploadDateSelect = document.getElementById('yt-upload-date');
  ytSortSelect = document.getElementById('yt-sort');
  ytSearchInput = document.getElementById('yt-search');
  ytForm = document.getElementById('yt-form');
}

// Build YouTube search URL with filters
function buildYouTubeUrl(query) {
  const baseUrl = 'https://www.youtube.com/results';
  const params = new URLSearchParams();

  // Add search query
  let searchQuery = query || '';

  // Add category keywords if no custom query
  if (!searchQuery && ytFilters.category && CATEGORY_QUERIES[ytFilters.category]) {
    searchQuery = CATEGORY_QUERIES[ytFilters.category];
  }

  if (searchQuery) {
    params.set('search_query', searchQuery);
  }

  // Build sp parameter for filters (YouTube's filter encoding)
  let spFilters = [];

  // Upload date filter
  if (ytFilters.uploadDate && ytFilters.uploadDate !== 'any') {
    switch (ytFilters.uploadDate) {
      case 'hour': spFilters.push('EgIIAQ%253D%253D'); break;  // Last hour
      case 'day': spFilters.push('EgIIAg%253D%253D'); break;   // Today
      case 'week': spFilters.push('EgIIAw%253D%253D'); break;  // This week
      case 'month': spFilters.push('EgIIBA%253D%253D'); break; // This month
      case 'year': spFilters.push('EgIIBQ%253D%253D'); break;  // This year
    }
  }

  // Duration filter
  if (ytFilters.duration && ytFilters.duration !== 'any') {
    switch (ytFilters.duration) {
      case 'short': spFilters.push('EgIYAQ%253D%253D'); break;  // Under 4 min
      case 'medium': spFilters.push('EgIYAw%253D%253D'); break; // 4-20 min
      case 'long': spFilters.push('EgIYAg%253D%253D'); break;   // Over 20 min
    }
  }

  // Sort by
  if (ytFilters.sortBy && ytFilters.sortBy !== 'relevance') {
    switch (ytFilters.sortBy) {
      case 'date': spFilters.push('CAI%253D'); break;      // Upload date
      case 'viewCount': spFilters.push('CAM%253D'); break; // View count
      case 'rating': spFilters.push('CAE%253D'); break;    // Rating
    }
  }

  return `${baseUrl}?${params.toString()}`;
}

// Open YouTube search in new tab
function openYouTubeSearch(query) {
  const url = buildYouTubeUrl(query);
  window.open(url, '_blank');
}

// Create quick search card
function createQuickSearchCard(title, query, icon) {
  const card = document.createElement('div');
  card.className = 'youtube-card yt-quick-search';
  card.setAttribute('tabindex', '0');
  card.setAttribute('role', 'button');
  card.innerHTML = `
    <div class="yt-quick-icon">${icon}</div>
    <div class="yt-quick-info">
      <h3 class="yt-title">${title}</h3>
      <p class="yt-channel">Click to search on YouTube</p>
    </div>
  `;

  card.addEventListener('click', () => openYouTubeSearch(query));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openYouTubeSearch(query);
    }
  });

  return card;
}

// Display YouTube landing page with quick searches
function displayYouTubeLanding() {
  ytMain.innerHTML = '';

  // Quick search suggestions
  const suggestions = [
    { title: 'Trending Tech', query: 'technology news 2025', icon: '💻' },
    { title: 'Programming Tutorials', query: 'programming tutorial beginner', icon: '👨‍💻' },
    { title: 'Science Explained', query: 'science explained documentary', icon: '🔬' },
    { title: 'Hidden Gem Channels', query: 'underrated youtube channels 2025', icon: '💎' },
    { title: 'Learn Something New', query: 'educational interesting facts', icon: '📚' },
    { title: 'Indie Games', query: 'indie game review hidden gem', icon: '🎮' },
    { title: 'Music Discovery', query: 'underrated music artists 2025', icon: '🎵' },
    { title: 'Documentary', query: 'full documentary interesting', icon: '🎬' },
    { title: 'DIY Projects', query: 'DIY tutorial project ideas', icon: '🔧' },
    { title: 'Productivity Tips', query: 'productivity tips life hacks', icon: '⚡' },
    { title: 'Art & Design', query: 'digital art tutorial design', icon: '🎨' },
    { title: 'Finance & Investing', query: 'investing for beginners 2025', icon: '💰' }
  ];

  // Header
  const header = document.createElement('div');
  header.className = 'yt-landing-header';
  header.innerHTML = `
    <h2>YouTube Discovery</h2>
    <p>Search for videos or click a category below to explore</p>
  `;
  ytMain.appendChild(header);

  // Grid of quick searches
  const grid = document.createElement('div');
  grid.className = 'yt-grid';

  suggestions.forEach(({ title, query, icon }) => {
    grid.appendChild(createQuickSearchCard(title, query, icon));
  });

  ytMain.appendChild(grid);
}

// Handle search
function handleYouTubeSearch(e) {
  e.preventDefault();
  const query = ytSearchInput?.value?.trim() || '';
  if (query) {
    ytFilters.searchQuery = query;
    openYouTubeSearch(query);
  }
}

// Handle filter change - update filters and show message
function handleYouTubeFilterChange() {
  // Filters will be applied when user searches
}

// Setup event listeners
function setupYouTubeEventListeners() {
  ytCategorySelect?.addEventListener('change', (e) => {
    ytFilters.category = e.target.value;
  });

  ytDurationSelect?.addEventListener('change', (e) => {
    ytFilters.duration = e.target.value;
  });

  ytUploadDateSelect?.addEventListener('change', (e) => {
    ytFilters.uploadDate = e.target.value;
  });

  ytSortSelect?.addEventListener('change', (e) => {
    ytFilters.sortBy = e.target.value;
  });

  ytForm?.addEventListener('submit', handleYouTubeSearch);
}

// Initialize YouTube module
export function initYouTube() {
  initYouTubeDom();
  setupYouTubeEventListeners();
}

// Load YouTube content (called when switching to YouTube tab)
export function activateYouTube() {
  displayYouTubeLanding();
}

export { ytFilters };
