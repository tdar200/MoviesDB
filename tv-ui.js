import { orderRowItems, sortItemsByRating, weightedRating } from './tv-rows.mjs';
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

// A tile is a 16:9 picture with the title laid over it, like a streaming home screen:
// a fraction of the DOM the old text-heavy card had (every node is layout on a TV-class
// CPU). The overview and "View details" live on the details screen, not on every tile.
const NEW_DAYS = 21;
const isNewRelease = movie => {
  const d = Date.parse(movie.release_date || movie.first_air_date || '');
  return Number.isFinite(d) && Date.now() - d >= 0 && Date.now() - d < NEW_DAYS * 864e5;
};
// options.rank: 1-based position to print on the tile (Top 10 style); options.progress: 0..1 watched.
export function createTvCard(movie, onSelect, options = {}) {
  if (movie.live) return createLiveCard(movie, onSelect);
  const card = element('button', 'tv-card');
  card.type = 'button';
  card.dataset.movieId = movie.id;
  card.__movie = movie; // read by the app to prefetch the trailer while the tile is focused
  card.dataset.rating = String(Number(movie.vote_average) || 0);
  card.dataset.score = String(weightedRating(movie)); // row order; the star shows the plain rating
  const score = Number(movie.vote_average) > 0 ? Number(movie.vote_average).toFixed(1) : '';
  const facts = [yearOf(movie), kindOf(movie), genreOf(movie), score && `${score} stars`].filter(Boolean);
  card.setAttribute('aria-label', [titleOf(movie), ...facts].join(', '));
  const visual = element('span', 'tv-card-visual');
  const image = element('img', 'tv-card-art');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  // Landscape artwork for a landscape tile; a poster is the fallback (cropped, not stretched).
  if (movie.image_url) image.src = movie.image_url;
  else if (movie.backdrop_path) image.src = art + 'w780' + movie.backdrop_path;
  else if (movie.poster_path) image.src = art + 'w500' + movie.poster_path;
  image.onerror = () => { card.classList.add('tv-card-noart'); };
  visual.append(image);
  if (isNewRelease(movie)) visual.append(element('span', 'tv-card-new', 'NEW'));
  else if (score) visual.append(element('span', 'tv-card-badge', `★ ${score}`));
  if (options.rank) { card.classList.add('tv-card-ranked'); visual.append(element('span', 'tv-card-rank', String(options.rank))); }
  if (options.progress > 0) {
    const bar = element('span', 'tv-card-progress');
    const fill = element('span');
    fill.style.width = `${Math.min(100, Math.max(2, options.progress * 100))}%`;
    bar.append(fill);
    visual.append(bar);
  }
  card.append(visual);
  const caption = element('div', 'tv-card-caption');
  const kicker = [kindOf(movie), genreOf(movie)].filter(Boolean).join('  ·  ');
  caption.append(
    element('span', 'tv-card-title', titleOf(movie)),
    element('span', 'tv-card-kicker', [yearOf(movie), kicker].filter(Boolean).join('  ·  ')),
  );
  card.append(caption);
  card.addEventListener('click', () => onSelect(movie));
  return card;
}

// A row of titles: an overflow-hidden rail wrapping a flex track the remote glides.
// Rows render a window of cards, not all of them: a Channels tab of 22 rows x
// 100 cards put ~1,500 cards (15k DOM nodes, 7k listeners) in the page and made
// every up/down press cost ~370 ms of layout on a TV-class CPU. Like Netflix's
// rails, a row starts with ROW_WINDOW cards and grows by ROW_WINDOW when focus
// comes within ROW_LOOKAHEAD cards of the last rendered one.
export const ROW_WINDOW = 12;
const ROW_LOOKAHEAD = 4;
let rowWindowingInstalled = false;

// Tile options for the n-th card of a row: a rank on the first ten of a ranked row (Trending),
// a watched-progress bar on Continue Watching.
function tileOptions(section, index, movie) {
  const options = {};
  if (section.__ranked && index < 10) options.rank = index + 1;
  if (section.__progressOf) options.progress = section.__progressOf(movie);
  return options;
}
function appendRowCards(section, count) {
  const rest = section.__rest;
  if (!rest || !rest.length) return 0;
  const track = section.querySelector('.tv-rail-track');
  const chunk = rest.splice(0, count);
  const base = track.children.length;
  chunk.forEach((movie, i) => track.append(createTvCard(movie, section.__onSelect, tileOptions(section, base + i, movie))));
  return chunk.length;
}

// Grow the row holding `card` if focus is near its last rendered card.
export function growRowWindow(card) {
  const section = card && card.closest ? card.closest('.tv-row') : null;
  if (!section || !section.__rest || !section.__rest.length) return false;
  const cards = section.querySelectorAll('.tv-card');
  if (Array.prototype.indexOf.call(cards, card) < cards.length - ROW_LOOKAHEAD) return false;
  return appendRowCards(section, ROW_WINDOW) > 0;
}

function installRowWindowing() {
  if (rowWindowingInstalled || typeof document === 'undefined' || !document.addEventListener) return;
  rowWindowingInstalled = true;
  document.addEventListener('focusin', event => {
    const card = event.target && event.target.closest ? event.target.closest('.tv-card') : null;
    if (card) growRowWindow(card);
  });
}

function buildRow(row, onSelect) {
  installRowWindowing();
  const name = row.title || row.key;
  const titles = orderRowItems(row);
  const section = element('section', 'tv-row');
  section.dataset.tvRow = name;
  const rail = element('div', 'tv-rail');
  rail.setAttribute('aria-label', name);
  const track = element('div', 'tv-rail-track');
  section.__ranked = row.key === 'trending';
  section.__progressOf = typeof row.progressOf === 'function' ? row.progressOf : null;
  titles.slice(0, ROW_WINDOW).forEach((movie, i) => track.append(createTvCard(movie, onSelect, tileOptions(section, i, movie))));
  section.__rest = titles.slice(ROW_WINDOW);
  section.__onSelect = onSelect;
  section.__total = titles.length;
  rail.append(track);
  section.append(element('h2', '', name), rail);
  return section;
}

// Continue Watching and My List are the only rows that depend on what the viewer has
// watched or starred. When that changes, patch just those two rows in place: a row whose
// titles did not change is left alone (focus, rail position and all), and every catalogue
// row keeps its cards, rail position and row window. Rebuilding the whole home for this
// threw away the viewer's place, which is why Back "went home".
const PERSONAL_TITLES = ['Continue Watching', 'My List'];
export function syncPersonalRows(main, personal, { onSelect } = {}) {
  const idsOf = section => Array.prototype.map.call(section.querySelectorAll('.tv-card'), c => c.dataset.movieId)
    .concat((section.__rest || []).map(m => String(m.id))).join(',');
  const children = Array.prototype.slice.call(main.children);
  const existing = new Map();
  children.forEach(el => { if (el.classList && el.classList.contains('tv-row') && PERSONAL_TITLES.includes(el.dataset.tvRow)) existing.set(el.dataset.tvRow, el); });
  let anchor = children.find(el => el.classList && el.classList.contains('tv-hero')) || null;
  const kept = new Set();
  for (const row of (personal || []).filter(r => r.items && r.items.length)) {
    let section = existing.get(row.title);
    const wanted = orderRowItems(row).map(m => String(m.id)).join(',');
    if (!section || idsOf(section) !== wanted) {
      const fresh = buildRow(row, onSelect);
      if (section) section.replaceWith(fresh);
      section = fresh;
    }
    // Personal rows sit first, right under the hero, in the order Continue Watching then My List.
    const before = anchor ? anchor.nextSibling : main.firstChild;
    if (section !== before) main.insertBefore(section, before);
    kept.add(section);
    anchor = section;
  }
  existing.forEach(section => { if (!kept.has(section)) section.remove(); });
}

// Append a single row to an already-rendered home (progressive paint).
export function appendTvRow(main, row, onSelect) {
  if (!row || !row.items || !row.items.length) return null;
  const section = buildRow(row, onSelect);
  main.append(section);
  return section;
}

function buildHero(featured, { onSelect, onPlay, eyebrow = 'FEATURED' }) {
  const hero = element('section', 'tv-hero');
  if (featured.backdrop_path) hero.style.backgroundImage = `url("${art}w1280${featured.backdrop_path}")`;
  const copy = element('div', 'tv-hero-copy');
  const heroScore = Number(featured.vote_average) > 0 ? `★ ${Number(featured.vote_average).toFixed(1)}` : '';
  copy.append(
    element('p', 'tv-eyebrow', eyebrow),
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

// Add the first cached category's hero without rebuilding rows or moving focus.
export function ensureTvHero(main, featured, actions) {
  if (!featured) return;
  const existing = main.querySelector('.tv-hero');
  if (!existing) main.prepend(buildHero(featured, actions));
  else if (existing.dataset.provisional === '1' && !existing.contains(document.activeElement)) {
    existing.replaceWith(buildHero(featured, actions));
  }
}

// Render a hero plus explicit, distinct rows. `rows` is [{key|title, items}].
export function renderTvRows(main, rows, { onSelect, onPlay, featured, eyebrow } = {}) {
  const focused = document.activeElement;
  const restoreId = focused?.dataset.movieId;
  const restoreRow = focused?.closest('[data-tv-row]')?.dataset.tvRow;
  main.textContent = '';
  const populated = rows.filter(r => r.items && r.items.length);
  if (!populated.length && !featured) return;
  const heroTitle = featured || populated[0]?.items[0];
  if (heroTitle) main.append(buildHero(heroTitle, { onSelect, onPlay, eyebrow }));
  for (const row of populated) main.append(buildRow(row, onSelect));
  if (restoreId) {
    const row = Array.from(main.querySelectorAll('[data-tv-row]')).find(r => r.dataset.tvRow === restoreRow);
    const card = Array.from((row || main).querySelectorAll('.tv-card')).find(c => c.dataset.movieId === restoreId);
    card?.focus({ preventScroll: true });
  }
}

// Add another page to the end of an endless rail, best rated first within the page.
// Cards already in the rail never move. Re-sorting the whole track slotted a new
// page's better-rated titles in among, and ahead of, the cards the viewer had
// already scrolled past, so the row changed under them every time it paged.
export function appendTvCards(track, items, onSelect, makeCard = createTvCard) {
  if (!track) return;
  sortItemsByRating(items).forEach(movie => track.append(makeCard(movie, onSelect)));
}

// Search / filtered results: one honest "Results" rail, no invented category slices.
export function renderTvBrowse(main, movies, { onSelect, onPlay } = {}) {
  if (!movies.length) { main.textContent = ''; return; }
  renderTvRows(main, [{ key: 'Results', title: 'Results', items: movies }], { onSelect, onPlay, featured: movies[0] });
}
