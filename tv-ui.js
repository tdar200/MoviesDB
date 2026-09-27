import { orderRowItems } from './tv-rows.mjs';
import { createLiveCard } from './live-ui.js';

// TV presentation shares the existing catalogue, preferences, and player.
// Cards open a details screen (onSelect); the hero can also play directly (onPlay).
const art = 'https://image.tmdb.org/t/p/';
const titleOf = movie => movie.title || movie.name || 'Untitled';
const yearOf = movie => (movie.release_date || movie.first_air_date || '').slice(0, 4);
const kindOf = movie => (movie.media_type === 'tv' || (movie.name && !movie.title) ? 'Series' : 'Film');
const genreNames = {
  12: 'Adventure', 14: 'Fantasy', 16: 'Animation', 18: 'Drama', 27: 'Horror',
  28: 'Action', 35: 'Comedy', 36: 'History', 37: 'Western', 53: 'Thriller',
  80: 'Crime', 99: 'Documentary', 878: 'Sci-Fi', 9648: 'Mystery',
  10749: 'Romance', 10751: 'Family', 10752: 'War', 10759: 'Action',
  10762: 'Kids', 10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi',
  10766: 'Soap', 10767: 'Talk', 10768: 'Politics',
};
const genreOf = movie => genreNames[(movie.genre_ids || [])[0]] || '';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createTvCard(movie, onSelect) {
  if (movie.live) return createLiveCard(movie, onSelect);
  const card = element('button', 'tv-card');
  card.type = 'button';
  card.dataset.movieId = movie.id;
  card.dataset.rating = String(Number(movie.vote_average) || 0);
  const score = Number(movie.vote_average) > 0 ? Number(movie.vote_average).toFixed(1) : '';
  const facts = [yearOf(movie), kindOf(movie), genreOf(movie), score && `${score} stars`].filter(Boolean);
  card.setAttribute('aria-label', [titleOf(movie), ...facts].join(', '));
  const visual = element('span', 'tv-card-visual');
  const image = element('img', 'tv-card-art');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  if (movie.image_url) image.src = movie.image_url;
  else if (movie.backdrop_path || movie.poster_path) image.src = art + 'w500' + (movie.backdrop_path || movie.poster_path);
  image.onerror = () => { card.classList.add('tv-card-noart'); };
  visual.append(image);
  if (score) visual.append(element('span', 'tv-card-badge', `★ ${score}`));
  card.append(visual);
  const caption = element('div', 'tv-card-caption');
  const kicker = [kindOf(movie), genreOf(movie)].filter(Boolean).join('  ·  ');
  const overview = (movie.overview || '').trim() || `Discover why ${titleOf(movie)} belongs on your watchlist.`;
  const footer = element('span', 'tv-card-footer');
  footer.append(
    element('span', 'tv-card-year', yearOf(movie) || 'Featured'),
    element('span', 'tv-card-cta', 'View details  ›'),
  );
  caption.append(
    element('span', 'tv-card-kicker', kicker),
    element('span', 'tv-card-title', titleOf(movie)),
    element('span', 'tv-card-overview', overview),
    footer,
  );
  card.append(caption);
  card.addEventListener('click', () => onSelect(movie));
  return card;
}

// A row of titles: an overflow-hidden rail wrapping a flex track the remote glides.
function buildRow(row, onSelect) {
  const name = row.title || row.key;
  const titles = orderRowItems(row);
  const section = element('section', 'tv-row');
  section.dataset.tvRow = name;
  const rail = element('div', 'tv-rail');
  rail.setAttribute('aria-label', name);
  const track = element('div', 'tv-rail-track');
  titles.forEach(movie => track.append(createTvCard(movie, onSelect)));
  rail.append(track);
  section.append(element('h2', '', name), rail);
  return section;
}

// Append a single row to an already-rendered home (progressive paint).
export function appendTvRow(main, row, onSelect) {
  if (!row || !row.items || !row.items.length) return null;
  const section = buildRow(row, onSelect);
  main.append(section);
  return section;
}

function buildHero(featured, { onSelect, onPlay }) {
  const hero = element('section', 'tv-hero');
  if (featured.backdrop_path) hero.style.backgroundImage = `url("${art}w1280${featured.backdrop_path}")`;
  const copy = element('div', 'tv-hero-copy');
  const heroScore = Number(featured.vote_average) > 0 ? `★ ${Number(featured.vote_average).toFixed(1)}` : '';
  copy.append(
    element('p', 'tv-eyebrow', 'FEATURED'),
    element('h2', '', titleOf(featured)),
    element('p', 'tv-hero-meta', [yearOf(featured), kindOf(featured), genreOf(featured), heroScore].filter(Boolean).join('  ·  ')),
    element('p', 'tv-synopsis', featured.overview || 'Discover something worth watching tonight.'),
  );
  const actions = element('div', 'tv-hero-actions');
  const play = element('button', 'tv-play', '▶  Play');
  play.type = 'button';
  play.addEventListener('click', () => onPlay(featured));
  const info = element('button', 'tv-more-info', 'ℹ  More Info');
  info.type = 'button';
  info.addEventListener('click', () => onSelect(featured));
  actions.append(play, info);
  copy.append(actions);
  hero.append(copy);
  return hero;
}

// Render a hero plus explicit, distinct rows. `rows` is [{key|title, items}].
export function renderTvRows(main, rows, { onSelect, onPlay, featured } = {}) {
  const focused = document.activeElement;
  const restoreId = focused?.dataset.movieId;
  const restoreRow = focused?.closest('[data-tv-row]')?.dataset.tvRow;
  main.textContent = '';
  const populated = rows.filter(r => r.items && r.items.length);
  if (!populated.length && !featured) return;
  const heroTitle = featured || populated[0]?.items[0];
  if (heroTitle) main.append(buildHero(heroTitle, { onSelect, onPlay }));
  for (const row of populated) main.append(buildRow(row, onSelect));
  if (restoreId) {
    const row = Array.from(main.querySelectorAll('[data-tv-row]')).find(r => r.dataset.tvRow === restoreRow);
    const card = Array.from((row || main).querySelectorAll('.tv-card')).find(c => c.dataset.movieId === restoreId);
    card?.focus({ preventScroll: true });
  }
}

// Re-sort an already-rendered endless rail after another page is appended.
export function sortTvTrackByRating(track) {
  if (!track) return;
  // Moving an already-focused card with append() makes webOS Chromium blur it.
  // The remote handler then sees no active card and falls back to the home anchor,
  // which looks like the page suddenly jumped to the top while paging a rail.
  const focused = document.activeElement;
  const restoreFocus = !!(focused && focused.classList?.contains('tv-card') && track.contains(focused));
  Array.from(track.querySelectorAll('.tv-card'))
    .sort((a, b) => (Number(b.dataset.rating) || 0) - (Number(a.dataset.rating) || 0))
    .forEach(card => track.append(card));
  if (restoreFocus && focused.isConnected) focused.focus({ preventScroll: true });
}

// Search / filtered results: one honest "Results" rail, no invented category slices.
export function renderTvBrowse(main, movies, { onSelect, onPlay } = {}) {
  if (!movies.length) { main.textContent = ''; return; }
  renderTvRows(main, [{ key: 'Results', title: 'Results', items: movies }], { onSelect, onPlay, featured: movies[0] });
}
