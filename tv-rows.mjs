// tv-rows.mjs — the pure row model behind the TV home screen.
//
// The old TV home sliced one trending page into seven "rows", so the same titles
// reappeared in every rail. This module instead names genuinely distinct TMDB
// feeds and dedupes titles across the whole screen, so a title shows in exactly
// one row (its first, most specific one). Fetching lives in the browser; this
// stays pure and testable.

const TMDB_BASE = 'https://api.themoviedb.org/3';

// The distinct catalogue feeds a Netflix-style home expects. `mediaType`, where
// present, tells the fetch layer to stamp results from movie/tv-only endpoints
// (which omit `media_type`) so playback picks the right path later.
// Genre browse rows, per media kind (TMDB genre ids differ between movie and tv).
const MOVIE_GENRE_ROWS = [
  [28, 'Action'], [35, 'Comedy'], [18, 'Drama'], [878, 'Sci-Fi'], [27, 'Horror'],
  [53, 'Thriller'], [10749, 'Romance'], [16, 'Animation'], [99, 'Documentaries'],
  [14, 'Fantasy'], [80, 'Crime'], [9648, 'Mystery'],
];
const TV_GENRE_ROWS = [
  [10759, 'Action & Adventure'], [35, 'Comedy'], [18, 'Drama'], [10765, 'Sci-Fi & Fantasy'],
  [80, 'Crime'], [9648, 'Mystery'], [16, 'Animation'], [99, 'Documentaries'],
  [10751, 'Family'], [10764, 'Reality'], [10768, 'War & Politics'], [37, 'Western'],
];
// Theme rows use TMDB keyword ids, which work for both movie and tv discover.
const THEME_ROWS = [[9715, 'Superhero'], [4379, 'Time Travel'], [12377, 'Zombies'], [12565, 'Psychological Thrillers']];
// A handful of the big US streaming services (TMDB watch-provider ids).
const PROVIDER_ROWS = [[8, 'On Netflix'], [9, 'On Prime Video'], [337, 'On Disney+'], [1899, 'On Max']];
// Award / prestige rows are curated TMDB lists (verified current). These are the
// reliable source for "winners" — TMDB's award keywords have almost no coverage.
// Emmy winners are supplied separately as a local static collection.
const AWARD_ROWS = [
  [28, 'Oscar Best Picture Winners'],
  [234, 'Golden Globe Winners (Drama)'],
  [229, "Palme d'Or Winners · Cannes"],
  [266, 'Oscar-Winning Documentaries'],
  [43, 'AFI Most Thrilling Films'],
  [10, 'Biggest Blockbusters'],
];

// The curated, media-kind-aware home. `kind` is 'all' | 'movie' | 'tv'. Every row
// is a distinct TMDB feed; each paginates endlessly in the UI. Personal rows
// (Continue Watching, My List) and Recommended are added by the caller.
export function catalogRowDefs(apiKey, base = TMDB_BASE, kind = 'all') {
  const q = `api_key=${apiKey}`;
  const type = kind === 'tv' ? 'tv' : 'movie'; // discover/genre type for this kind
  const mediaType = type; // stamp movie/tv-only feeds so playback picks the right path
  const trendingScope = kind === 'all' ? 'all' : type;
  const newRow = type === 'tv'
    ? { key: 'now_playing', title: 'New Episodes', url: `${base}/tv/on_the_air?${q}&page=1`, mediaType }
    : { key: 'now_playing', title: 'New Releases', url: `${base}/movie/now_playing?${q}&page=1`, mediaType };
  const disc = (extra) => `${base}/discover/${type}?${q}&sort_by=popularity.desc&vote_count.gte=200&${extra}&page=1`;
  const rows = [
    { key: 'trending', title: 'Trending This Week', url: `${base}/trending/${trendingScope}/week?${q}&page=1`, ...(kind === 'all' ? {} : { mediaType }) },
    { key: 'popular', title: kind === 'tv' ? 'Popular Shows' : 'Popular Movies', url: `${base}/${type}/popular?${q}&page=1`, mediaType },
    { key: 'top_rated', title: 'Top Rated', url: `${base}/${type}/top_rated?${q}&page=1`, mediaType },
    newRow,
    { key: 'highly_rated', title: 'Critically Acclaimed', url: `${base}/discover/${type}?${q}&sort_by=vote_average.desc&vote_count.gte=1500&page=1`, mediaType },
  ];
  // "All" is movie-typed above (TMDB genre ids are movie-based), so without this the
  // only non-movie rail would be Trending. Blend in a TV block so shows are actually
  // visible on the default home.
  if (kind === 'all') {
    rows.push(
      { key: 'tv_popular', title: 'Popular Shows', url: `${base}/tv/popular?${q}&page=1`, mediaType: 'tv' },
      { key: 'tv_top', title: 'Top Rated Shows', url: `${base}/tv/top_rated?${q}&page=1`, mediaType: 'tv' },
    );
    [[18, 'Drama Series'], [35, 'Comedy Series'], [80, 'Crime Series'], [10765, 'Sci-Fi & Fantasy Series']].forEach(([id, name]) =>
      rows.push({ key: `tvg${id}`, title: name, url: `${base}/discover/tv?${q}&sort_by=popularity.desc&vote_count.gte=200&with_genres=${id}&page=1`, mediaType: 'tv' }));
  }
  // Award/prestige rows (curated lists — film awards). Skipped under the TV tab
  // since these lists are movies; shown under All and Movies. `list: true` tells the
  // fetch layer the payload is in `items`, not `results`.
  if (kind !== 'tv') AWARD_ROWS.forEach(([id, name]) =>
    rows.push({ key: `l${id}`, title: name, url: `${base}/list/${id}?${q}&page=1`, list: true }));
  (type === 'tv' ? TV_GENRE_ROWS : MOVIE_GENRE_ROWS).forEach(([id, name]) =>
    rows.push({ key: `g${id}`, title: name, url: disc(`with_genres=${id}`), mediaType }));
  THEME_ROWS.forEach(([id, name]) =>
    rows.push({ key: `k${id}`, title: name, url: disc(`with_keywords=${id}`), mediaType }));
  PROVIDER_ROWS.forEach(([id, name]) =>
    rows.push({ key: `p${id}`, title: name, url: disc(`with_watch_providers=${id}&watch_region=US`), mediaType }));
  return rows;
}

// Identity of a title across rows. Movie id 5 and TV id 5 are different titles,
// so the media kind is part of the key. Movie endpoints omit media_type but carry
// `title`; TV endpoints carry `name`.
export function titleKey(item) {
  const kind = item.media_type || (item.name && !item.title ? 'tv' : 'movie');
  return `${kind}:${item.id}`;
}

// Stable rating order for every browse rail. Missing or unrated titles sort last;
// equal ratings retain the source order supplied by the catalogue.
export function sortItemsByRating(items = []) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const difference = (Number(b.item && b.item.vote_average) || 0) - (Number(a.item && a.item.vote_average) || 0);
      return difference || a.index - b.index;
    })
    .map(entry => entry.item);
}

export function orderRowItems(row = {}) {
  const items = Array.isArray(row.items) ? row.items : [];
  return row.key === 'continue' ? items : sortItemsByRating(items);
}

// Filter one row's items against a shared `seen` set, mutating it. Used to dedupe
// rows as they arrive (progressive paint) so a title shows in only its first row.
export function dedupeItems(items, seen) {
  const out = [];
  for (const item of items || []) {
    if (item == null || item.id == null) continue;
    const key = titleKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// Keep each title only in the first row it appears in; drop rows that empty out.
export function dedupeAcrossRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const items = dedupeItems(row.items, seen);
    if (items.length) out.push({ ...row, items });
  }
  return out;
}

// Personal rows built from local signal stores, shown first and only when they
// have content. Callers dedupe the catalogue rows against these.
export function signalRows({ continueWatching = [], myList = [] } = {}, limit = 20) {
  const rows = [];
  if (continueWatching.length) rows.push({ key: 'continue', title: 'Continue Watching', items: continueWatching.slice(0, limit) });
  if (myList.length) rows.push({ key: 'mylist', title: 'My List', items: myList.slice(0, limit) });
  return rows;
}

// Local curated collections shown on the default All home. Keep these separate
// from network row definitions: their items are already complete card snapshots.
export function staticHomeRows(kind, { imdbTop250 = [], emmyWinners = [] } = {}, limit = 12) {
  if (kind !== 'all') return [];
  const rows = [];
  if (imdbTop250.length) rows.push({
    key: 'imdb_top250',
    title: 'IMDb Top 250',
    items: imdbTop250.slice(0, limit),
  });
  if (emmyWinners.length) rows.push({
    key: 'emmy_winners',
    title: 'Emmy Award Winners',
    items: emmyWinners.slice(0, limit),
  });
  return rows;
}
