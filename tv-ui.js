// TV presentation shares the existing catalogue, preferences, and player.
// Cards open a details screen (onSelect); the hero can also play directly (onPlay).
const art = 'https://image.tmdb.org/t/p/';
const titleOf = movie => movie.title || movie.name || 'Untitled';
const yearOf = movie => (movie.release_date || movie.first_air_date || '').slice(0, 4);
const kindOf = movie => (movie.media_type === 'tv' || (movie.name && !movie.title) ? 'Series' : 'Film');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createTvCard(movie, onSelect) {
  const card = element('button', 'tv-card');
  card.type = 'button';
  card.dataset.movieId = movie.id;
  card.setAttribute('aria-label', titleOf(movie));
  const image = element('img', 'tv-card-art');
  image.alt = '';
  image.loading = 'lazy';
  if (movie.backdrop_path || movie.poster_path) image.src = art + 'w500' + (movie.backdrop_path || movie.poster_path);
  image.onerror = () => { card.classList.add('tv-card-noart'); };
  card.append(image);
  if (movie.vote_average) card.append(element('span', 'tv-card-badge', '★ ' + movie.vote_average.toFixed(1)));
  const caption = element('div', 'tv-card-caption');
  caption.append(
    element('span', 'tv-card-title', titleOf(movie)),
    element('span', 'tv-card-meta', [yearOf(movie), kindOf(movie)].filter(Boolean).join('  ·  ')),
  );
  card.append(caption);
  card.addEventListener('click', () => onSelect(movie));
  return card;
}

// A row of titles: an overflow-hidden rail wrapping a flex track the remote glides.
function buildRow(name, titles, onSelect) {
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
  const section = buildRow(row.title || row.key, row.items, onSelect);
  main.append(section);
  return section;
}

function buildHero(featured, { onSelect, onPlay }) {
  const hero = element('section', 'tv-hero');
  if (featured.backdrop_path) hero.style.backgroundImage = `url("${art}w1280${featured.backdrop_path}")`;
  const copy = element('div', 'tv-hero-copy');
  copy.append(
    element('p', 'tv-eyebrow', 'FEATURED'),
    element('h2', '', titleOf(featured)),
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
  for (const row of populated) main.append(buildRow(row.title || row.key, row.items, onSelect));
  if (restoreId) {
    const row = Array.from(main.querySelectorAll('[data-tv-row]')).find(r => r.dataset.tvRow === restoreRow);
    const card = Array.from((row || main).querySelectorAll('.tv-card')).find(c => c.dataset.movieId === restoreId);
    card?.focus({ preventScroll: true });
  }
}

// Search / filtered results: one honest "Results" rail, no invented category slices.
export function renderTvBrowse(main, movies, { onSelect, onPlay } = {}) {
  if (!movies.length) { main.textContent = ''; return; }
  renderTvRows(main, [{ key: 'Results', title: 'Results', items: movies }], { onSelect, onPlay, featured: movies[0] });
}
