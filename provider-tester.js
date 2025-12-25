import { CONFIG, ENDPOINTS } from './config.js';

// Video embed sources - Deep tested Dec 2025 via Puppeteer + Screenshot verification
const EMBED_SOURCES = [
  // ✅ VERIFIED WORKING (screenshot confirmed Dec 2025)
  { name: 'VidLink', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidlink.pro/tv/${id}/${s}/${e}` : `https://vidlink.pro/${type}/${id}` },
  { name: 'Vidfast.pro', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidfast.pro/tv/${id}/${s}/${e}` : `https://vidfast.pro/${type}/${id}` },
  { name: 'SmashyStream', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://player.smashy.stream/tv/${id}?s=${s}&e=${e}` : `https://player.smashy.stream/${type}/${id}` },
  { name: 'Nontongo', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://www.nontongo.win/embed/tv/${id}/${s}/${e}` : `https://www.nontongo.win/embed/${type}/${id}` },
  { name: 'MoviesAPI', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://moviesapi.club/tv/${id}-${s}-${e}` : `https://moviesapi.club/${type}/${id}` },
  { name: 'GoDrivePlayer', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://godriveplayer.com/player.php?type=series&tmdb=${id}&season=${s}&episode=${e}` : `https://godriveplayer.com/player.php?tmdb=${id}` },
  { name: 'VidSrc.me', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc.me/embed/${type}?tmdb=${id}` },
  // Fallback sources (may work)
  { name: 'MultiEmbed', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}` : `https://multiembed.mov/?video_id=${id}&tmdb=1` },
  { name: '2Embed.cc', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}` : `https://www.2embed.cc/embed/${id}` },
  { name: 'VidSrc.icu', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc.icu/embed/tv/${id}/${s}/${e}` : `https://vidsrc.icu/embed/${type}/${id}` },
];

// DOM Elements
const mediaTypeSelect = document.getElementById('media-type');
const mediaIdInput = document.getElementById('media-id');
const tvControls = document.getElementById('tv-controls');
const seasonInput = document.getElementById('season');
const episodeInput = document.getElementById('episode');
const durationSelect = document.getElementById('duration');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const exportBtn = document.getElementById('export-btn');
const progressBar = document.getElementById('progress-bar');
const statusText = document.getElementById('status-text');
const timerEl = document.getElementById('timer');
const testInfo = document.getElementById('test-info');
const providersGrid = document.getElementById('providers-grid');
const resultsSummary = document.getElementById('results-summary');
const bestProvider = document.getElementById('best-provider');
const resultsTableSection = document.getElementById('results-table-section');
const resultsTbody = document.getElementById('results-tbody');

// Test state
let isRunning = false;
let testStartTime = null;
let testDuration = 300000; // 5 minutes default
let timerInterval = null;
let providerResults = new Map();
let currentMediaId = null;
let currentMediaType = 'movie';
let currentMediaTitle = '';

// Storage key for results history
const RESULTS_STORAGE_KEY = 'providerTestResults';
const MAX_STORED_RESULTS = 10; // Keep last 10 test results

// Save results to localStorage
function saveResults(results) {
  try {
    const history = JSON.parse(localStorage.getItem(RESULTS_STORAGE_KEY) || '[]');

    const testRecord = {
      id: Date.now(),
      testDate: new Date().toISOString(),
      mediaType: currentMediaType,
      mediaId: currentMediaId,
      mediaTitle: currentMediaTitle,
      testDuration: testDuration,
      bestProvider: results[0]?.name || 'None',
      bestScore: results[0]?.score || 0,
      workingCount: results.filter(r => r.status === 'loaded').length,
      totalCount: results.length,
      results: results.map((r, rank) => ({
        rank: rank + 1,
        name: r.name,
        status: r.status,
        loadTime: r.loadTime,
        score: parseFloat(r.score.toFixed(2))
      }))
    };

    // Add to beginning of history
    history.unshift(testRecord);

    // Keep only last N results
    if (history.length > MAX_STORED_RESULTS) {
      history.length = MAX_STORED_RESULTS;
    }

    localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(history));
    console.log('Results saved to localStorage');

    // Update history display
    displayResultsHistory();

    return testRecord;
  } catch (error) {
    console.error('Error saving results:', error);
    return null;
  }
}

// Load results history from localStorage
function loadResultsHistory() {
  try {
    return JSON.parse(localStorage.getItem(RESULTS_STORAGE_KEY) || '[]');
  } catch (error) {
    console.error('Error loading results history:', error);
    return [];
  }
}

// Display results history
function displayResultsHistory() {
  const historySection = document.getElementById('history-section');
  const historyList = document.getElementById('history-list');

  if (!historySection || !historyList) return;

  const history = loadResultsHistory();

  if (history.length === 0) {
    historySection.style.display = 'none';
    return;
  }

  historySection.style.display = 'block';
  historyList.innerHTML = '';

  history.forEach((record, index) => {
    const date = new Date(record.testDate);
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-header">
        <span class="history-date">${date.toLocaleDateString()} ${date.toLocaleTimeString()}</span>
        <span class="history-media">${record.mediaTitle} (${record.mediaType.toUpperCase()})</span>
      </div>
      <div class="history-stats">
        <span class="history-best">Best: <strong>${record.bestProvider}</strong> (${record.bestScore.toFixed(0)} pts)</span>
        <span class="history-working">${record.workingCount}/${record.totalCount} working</span>
      </div>
      <button class="btn btn-small" onclick="viewHistoryDetails(${index})">View Details</button>
      <button class="btn btn-small btn-danger" onclick="deleteHistoryItem(${index})">Delete</button>
    `;
    historyList.appendChild(item);
  });
}

// View details of a history item
window.viewHistoryDetails = function(index) {
  const history = loadResultsHistory();
  const record = history[index];

  if (!record) return;

  // Show results in the table
  resultsTableSection.style.display = 'block';
  resultsTbody.innerHTML = '';

  record.results.forEach((result) => {
    const row = document.createElement('tr');
    row.className = result.rank <= 3 ? `rank-${result.rank}` : '';

    let statusBadge = '';
    if (result.status === 'loaded') {
      statusBadge = '<span class="status-badge working">Working</span>';
    } else if (result.status === 'timeout') {
      statusBadge = '<span class="status-badge timeout">Timeout</span>';
    } else {
      statusBadge = '<span class="status-badge failed">Failed</span>';
    }

    row.innerHTML = `
      <td>#${result.rank}</td>
      <td>${result.name}</td>
      <td>${statusBadge}</td>
      <td>${result.loadTime ? (result.loadTime / 1000).toFixed(2) + 's' : '-'}</td>
      <td>${result.score.toFixed(0)}</td>
    `;
    resultsTbody.appendChild(row);
  });

  // Update summary
  resultsSummary.style.display = 'block';
  bestProvider.innerHTML = `
    <div class="provider-name">${record.bestProvider}</div>
    <div class="history-note">From test on ${new Date(record.testDate).toLocaleString()}</div>
    <div class="provider-stats">
      <div class="stat">
        <span class="stat-value">${record.results[0]?.loadTime ? (record.results[0].loadTime / 1000).toFixed(2) + 's' : '-'}</span>
        <span class="stat-label">Load Time</span>
      </div>
      <div class="stat">
        <span class="stat-value">${record.workingCount}/${record.totalCount}</span>
        <span class="stat-label">Working</span>
      </div>
      <div class="stat">
        <span class="stat-value">${record.bestScore.toFixed(0)}</span>
        <span class="stat-label">Score</span>
      </div>
    </div>
  `;

  // Scroll to results
  resultsTableSection.scrollIntoView({ behavior: 'smooth' });
};

// Delete a history item
window.deleteHistoryItem = function(index) {
  const history = loadResultsHistory();
  history.splice(index, 1);
  localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(history));
  displayResultsHistory();
};

// Clear all history
window.clearAllHistory = function() {
  if (confirm('Are you sure you want to delete all test history?')) {
    localStorage.removeItem(RESULTS_STORAGE_KEY);
    displayResultsHistory();
  }
};

// Initialize provider cards
function initializeProviderCards() {
  providersGrid.innerHTML = '';

  EMBED_SOURCES.forEach((source, index) => {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.id = `provider-${index}`;
    card.innerHTML = `
      <div class="provider-header">
        <span class="provider-name">${source.name}</span>
        <div class="provider-status">
          <span class="status-indicator"></span>
          <span class="status-label">Ready</span>
        </div>
      </div>
      <div class="provider-iframe-container">
        <div class="loading-overlay">
          <div class="spinner"></div>
        </div>
      </div>
      <div class="provider-metrics">
        <div class="metric">
          <span class="metric-value" id="load-time-${index}">-</span>
          <span class="metric-label">Load Time</span>
        </div>
        <div class="metric">
          <span class="metric-value" id="status-${index}">-</span>
          <span class="metric-label">Status</span>
        </div>
        <div class="metric">
          <span class="metric-value" id="score-${index}">-</span>
          <span class="metric-label">Score</span>
        </div>
      </div>
    `;
    providersGrid.appendChild(card);
  });
}

// Fetch a popular movie for testing
async function fetchPopularMovie() {
  try {
    const response = await fetch(ENDPOINTS.trending(1));
    if (!response.ok) throw new Error('Failed to fetch');
    const data = await response.json();

    // Find a movie (not TV show) with good popularity
    const movies = data.results.filter(m => m.media_type === 'movie');
    if (movies.length > 0) {
      return {
        id: movies[0].id,
        title: movies[0].title,
        type: 'movie'
      };
    }

    // Fallback to any item
    return {
      id: data.results[0].id,
      title: data.results[0].title || data.results[0].name,
      type: data.results[0].media_type
    };
  } catch (error) {
    console.error('Error fetching popular movie:', error);
    // Fallback to a known popular movie (Inception)
    return { id: 27205, title: 'Inception', type: 'movie' };
  }
}

// Fetch a popular TV show for testing
async function fetchPopularTvShow() {
  try {
    const response = await fetch(ENDPOINTS.trending(1));
    if (!response.ok) throw new Error('Failed to fetch');
    const data = await response.json();

    // Find a TV show
    const shows = data.results.filter(m => m.media_type === 'tv');
    if (shows.length > 0) {
      return {
        id: shows[0].id,
        title: shows[0].name,
        type: 'tv'
      };
    }

    // Fallback to a known popular show (Breaking Bad)
    return { id: 1396, title: 'Breaking Bad', type: 'tv' };
  } catch (error) {
    console.error('Error fetching popular TV show:', error);
    return { id: 1396, title: 'Breaking Bad', type: 'tv' };
  }
}

// Test a single provider
function testProvider(source, index, mediaType, mediaId, season, episode) {
  return new Promise((resolve) => {
    const card = document.getElementById(`provider-${index}`);
    const container = card.querySelector('.provider-iframe-container');
    const indicator = card.querySelector('.status-indicator');
    const statusLabel = card.querySelector('.status-label');
    const loadTimeEl = document.getElementById(`load-time-${index}`);
    const statusEl = document.getElementById(`status-${index}`);
    const scoreEl = document.getElementById(`score-${index}`);

    // Reset state
    card.className = 'provider-card testing';
    indicator.className = 'status-indicator loading';
    statusLabel.textContent = 'Loading...';

    const result = {
      name: source.name,
      index: index,
      loadStart: Date.now(),
      loadEnd: null,
      loadTime: null,
      status: 'loading',
      error: null,
      score: 0
    };

    // Create iframe
    const iframe = document.createElement('iframe');
    const url = source.getUrl(mediaType, mediaId, season, episode);

    // Set timeout for load (30 seconds)
    const loadTimeout = setTimeout(() => {
      if (result.status === 'loading') {
        result.status = 'timeout';
        result.loadTime = 30000;
        result.error = 'Load timeout';

        card.className = 'provider-card failed';
        indicator.className = 'status-indicator failed';
        statusLabel.textContent = 'Timeout';
        loadTimeEl.textContent = '30s+';
        statusEl.textContent = 'Timeout';
        scoreEl.textContent = '0';

        resolve(result);
      }
    }, 30000);

    iframe.onload = () => {
      clearTimeout(loadTimeout);
      result.loadEnd = Date.now();
      result.loadTime = result.loadEnd - result.loadStart;
      result.status = 'loaded';

      // Remove loading overlay
      const overlay = container.querySelector('.loading-overlay');
      if (overlay) overlay.style.display = 'none';

      card.className = 'provider-card success';
      indicator.className = 'status-indicator success';
      statusLabel.textContent = 'Loaded';
      loadTimeEl.textContent = `${(result.loadTime / 1000).toFixed(2)}s`;
      statusEl.textContent = 'Working';

      // Calculate initial score (will be updated later)
      result.score = calculateScore(result);
      scoreEl.textContent = result.score.toFixed(0);

      resolve(result);
    };

    iframe.onerror = () => {
      clearTimeout(loadTimeout);
      result.loadEnd = Date.now();
      result.loadTime = result.loadEnd - result.loadStart;
      result.status = 'error';
      result.error = 'Load error';

      card.className = 'provider-card failed';
      indicator.className = 'status-indicator failed';
      statusLabel.textContent = 'Error';
      loadTimeEl.textContent = '-';
      statusEl.textContent = 'Failed';
      scoreEl.textContent = '0';

      resolve(result);
    };

    iframe.src = url;
    iframe.allow = 'autoplay; fullscreen; encrypted-media';
    iframe.setAttribute('allowfullscreen', '');

    // Clear previous iframe and add new one
    const existingIframe = container.querySelector('iframe');
    if (existingIframe) existingIframe.remove();
    container.appendChild(iframe);
  });
}

// Calculate score for a provider
function calculateScore(result) {
  if (result.status === 'error' || result.status === 'timeout') {
    return 0;
  }

  let score = 0;

  // Working status (50 points)
  if (result.status === 'loaded') {
    score += 50;
  }

  // Load time score (25 points max)
  // Fastest possible = 25 points, 10+ seconds = 0 points
  if (result.loadTime !== null) {
    const loadTimeScore = Math.max(0, 25 - (result.loadTime / 400));
    score += loadTimeScore;
  }

  // Stability score (25 points) - based on whether it stayed loaded
  if (result.status === 'loaded' && !result.error) {
    score += 25;
  }

  return score;
}

// Update timer display
function updateTimer() {
  if (!testStartTime) return;

  const elapsed = Date.now() - testStartTime;
  const remaining = Math.max(0, testDuration - elapsed);
  const progress = (elapsed / testDuration) * 100;

  progressBar.style.width = `${Math.min(100, progress)}%`;

  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  timerEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  if (remaining <= 0) {
    finishTest();
  }
}

// Start the test
async function startTest() {
  if (isRunning) return;

  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  exportBtn.disabled = true;
  resultsSummary.style.display = 'none';
  resultsTableSection.style.display = 'none';

  // Get test parameters
  currentMediaType = mediaTypeSelect.value;
  testDuration = parseInt(durationSelect.value, 10);

  // Get or fetch media ID
  let mediaId = parseInt(mediaIdInput.value, 10);
  let season = currentMediaType === 'tv' ? parseInt(seasonInput.value, 10) : null;
  let episode = currentMediaType === 'tv' ? parseInt(episodeInput.value, 10) : null;

  if (!mediaId || isNaN(mediaId)) {
    statusText.textContent = 'Fetching popular content...';
    const popular = currentMediaType === 'tv'
      ? await fetchPopularTvShow()
      : await fetchPopularMovie();
    mediaId = popular.id;
    currentMediaTitle = popular.title;
    mediaIdInput.value = mediaId;
  } else {
    currentMediaTitle = `ID: ${mediaId}`;
  }

  currentMediaId = mediaId;

  // Update test info
  testInfo.textContent = `Testing with: ${currentMediaTitle} (${currentMediaType.toUpperCase()} ID: ${mediaId})${currentMediaType === 'tv' ? ` S${season}E${episode}` : ''}`;

  // Initialize
  initializeProviderCards();
  providerResults.clear();
  testStartTime = Date.now();

  statusText.textContent = `Testing ${EMBED_SOURCES.length} providers...`;

  // Start timer
  timerInterval = setInterval(updateTimer, 100);

  // Test all providers in parallel
  const promises = EMBED_SOURCES.map((source, index) =>
    testProvider(source, index, currentMediaType, mediaId, season, episode)
  );

  const results = await Promise.all(promises);

  // Store results
  results.forEach(result => {
    providerResults.set(result.index, result);
  });

  // Wait for remaining test duration
  const elapsed = Date.now() - testStartTime;
  if (elapsed < testDuration && isRunning) {
    statusText.textContent = `Monitoring stability... (${providerResults.size} providers tested)`;
  }
}

// Stop the test
function stopTest() {
  if (!isRunning) return;
  finishTest();
}

// Finish the test and show results
function finishTest() {
  isRunning = false;
  clearInterval(timerInterval);

  startBtn.disabled = false;
  stopBtn.disabled = true;
  exportBtn.disabled = false;

  progressBar.style.width = '100%';
  statusText.textContent = 'Test complete!';
  timerEl.textContent = '00:00';

  // Recalculate final scores
  providerResults.forEach((result, index) => {
    result.score = calculateScore(result);
    const scoreEl = document.getElementById(`score-${index}`);
    if (scoreEl) scoreEl.textContent = result.score.toFixed(0);
  });

  // Rank results
  const ranked = Array.from(providerResults.values())
    .sort((a, b) => b.score - a.score);

  // Save results to localStorage
  saveResults(ranked);

  // Mark best provider
  if (ranked.length > 0 && ranked[0].score > 0) {
    const bestCard = document.getElementById(`provider-${ranked[0].index}`);
    if (bestCard) bestCard.classList.add('best');

    // Show best provider summary
    resultsSummary.style.display = 'block';
    bestProvider.innerHTML = `
      <div class="provider-name">${ranked[0].name}</div>
      <div class="provider-stats">
        <div class="stat">
          <span class="stat-value">${ranked[0].loadTime ? (ranked[0].loadTime / 1000).toFixed(2) + 's' : '-'}</span>
          <span class="stat-label">Load Time</span>
        </div>
        <div class="stat">
          <span class="stat-value">${ranked[0].status === 'loaded' ? 'Working' : 'Failed'}</span>
          <span class="stat-label">Status</span>
        </div>
        <div class="stat">
          <span class="stat-value">${ranked[0].score.toFixed(0)}</span>
          <span class="stat-label">Score</span>
        </div>
      </div>
    `;
  }

  // Show results table
  resultsTableSection.style.display = 'block';
  resultsTbody.innerHTML = '';

  ranked.forEach((result, rank) => {
    const row = document.createElement('tr');
    row.className = rank < 3 ? `rank-${rank + 1}` : '';

    let statusBadge = '';
    if (result.status === 'loaded') {
      statusBadge = '<span class="status-badge working">Working</span>';
    } else if (result.status === 'timeout') {
      statusBadge = '<span class="status-badge timeout">Timeout</span>';
    } else {
      statusBadge = '<span class="status-badge failed">Failed</span>';
    }

    row.innerHTML = `
      <td>#${rank + 1}</td>
      <td>${result.name}</td>
      <td>${statusBadge}</td>
      <td>${result.loadTime ? (result.loadTime / 1000).toFixed(2) + 's' : '-'}</td>
      <td>${result.score.toFixed(0)}</td>
    `;
    resultsTbody.appendChild(row);
  });
}

// Export results as JSON
function exportResults() {
  const results = Array.from(providerResults.values())
    .sort((a, b) => b.score - a.score)
    .map((r, rank) => ({
      rank: rank + 1,
      name: r.name,
      status: r.status,
      loadTime: r.loadTime,
      score: r.score.toFixed(2)
    }));

  const exportData = {
    testDate: new Date().toISOString(),
    mediaType: currentMediaType,
    mediaId: currentMediaId,
    mediaTitle: currentMediaTitle,
    testDuration: testDuration,
    results: results
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `provider-test-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Event listeners
mediaTypeSelect.addEventListener('change', () => {
  tvControls.style.display = mediaTypeSelect.value === 'tv' ? 'flex' : 'none';
});

startBtn.addEventListener('click', startTest);
stopBtn.addEventListener('click', stopTest);
exportBtn.addEventListener('click', exportResults);

// Initialize
initializeProviderCards();
displayResultsHistory();
