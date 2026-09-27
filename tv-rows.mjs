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

// Extra browse rows for the All tab only: [key, title, type, discover params].
// All run highest-rated first; the vote floors are per row because world-cinema
// feeds have far fewer votes (Urdu dramas barely have any on TMDB).
const ALL_EXTRA_ROWS = [
  ['xg12', 'Adventure', 'movie', 'with_genres=12&vote_count.gte=500'],
  ['xg10751', 'Family Movies', 'movie', 'with_genres=10751&vote_count.gte=500'],
  ['xg36', 'History', 'movie', 'with_genres=36&vote_count.gte=500'],
  ['xg10752', 'War Movies', 'movie', 'with_genres=10752&vote_count.gte=500'],
  ['xg37', 'Westerns', 'movie', 'with_genres=37&vote_count.gte=300'],
  ['xg10402', 'Music & Musicals', 'movie', 'with_genres=10402&vote_count.gte=300'],
  ['xtg10759', 'Action & Adventure Series', 'tv', 'with_genres=10759&vote_count.gte=200'],
  ['xtg9648', 'Mystery Series', 'tv', 'with_genres=9648&vote_count.gte=200'],
  ['xtg16', 'Animated Series', 'tv', 'with_genres=16&vote_count.gte=200'],
  ['xtg10764', 'Reality TV', 'tv', 'with_genres=10764&vote_count.gte=50'],
  ['xtg10762', 'Kids TV', 'tv', 'with_genres=10762&vote_count.gte=50'],
  ['xtg10768', 'War & Politics Series', 'tv', 'with_genres=10768&vote_count.gte=50'],
  ['xk10051', 'Heist Movies', 'movie', 'with_keywords=10051&vote_count.gte=300'],
  ['xk9672', 'Based on a True Story', 'movie', 'with_keywords=9672&vote_count.gte=500'],
  ['xk9882', 'Space', 'movie', 'with_keywords=9882&vote_count.gte=300'],
  ['xk4565', 'Dystopian Worlds', 'movie', 'with_keywords=4565&vote_count.gte=300'],
  ['xk10714', 'Serial Killers', 'movie', 'with_keywords=10714&vote_count.gte=300'],
  ['xk779', 'Martial Arts', 'movie', 'with_keywords=779&vote_count.gte=300'],
  ['xk470', 'Spies', 'movie', 'with_keywords=470&vote_count.gte=300'],
  ['xk10349', 'Survival', 'movie', 'with_keywords=10349&vote_count.gte=300'],
  ['xk6075', 'Sports Movies', 'movie', 'with_keywords=6075&vote_count.gte=300'],
  ['xk12190', 'Cyberpunk', 'movie', 'with_keywords=12190&vote_count.gte=100'],
  ['xk10854', 'Time Loops', 'movie', 'with_keywords=10854&vote_count.gte=100'],
  ['xk207317', 'Christmas Movies', 'movie', 'with_keywords=207317&vote_count.gte=300'],
  ['xlhi', 'Bollywood', 'movie', 'with_original_language=hi&vote_count.gte=100'],
  ['xlko', 'Korean Dramas', 'tv', 'with_original_language=ko&with_genres=18&vote_count.gte=100'],
  ['xlja', 'Anime Series', 'tv', 'with_original_language=ja&with_genres=16&vote_count.gte=100'],
  ['xlur', 'Pakistani Dramas', 'tv', 'with_original_language=ur&vote_count.gte=3'],
  ['xcgb', 'British TV', 'tv', 'with_origin_country=GB&vote_count.gte=200'],
  ['xles', 'Spanish-Language Films', 'movie', 'with_original_language=es&vote_count.gte=300'],
  ['xd80', '80s Classics', 'movie', 'primary_release_date.gte=1980-01-01&primary_release_date.lte=1989-12-31&vote_count.gte=1000'],
  ['xd90', '90s Classics', 'movie', 'primary_release_date.gte=1990-01-01&primary_release_date.lte=1999-12-31&vote_count.gte=1000'],
  ['xgems', 'Hidden Gems', 'movie', 'vote_average.gte=7.5&vote_count.gte=300&vote_count.lte=2000'],
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
  // Category rows run highest-rated first. The vote floor keeps a title rated 10
  // by three people from leading a row; series get a lower floor (fewer votes).
  const disc = (extra) => `${base}/discover/${type}?${q}&sort_by=vote_average.desc&vote_count.gte=${type === 'tv' ? 200 : 500}&${extra}&page=1`;
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
    [[18, 'Drama Series'], [35, 'Comedy Series'], [80, 'Crime Series'], [10765, 'Sci-Fi & Fantasy Series'], [99, 'Documentary Series']].forEach(([id, name]) =>
      rows.push({ key: `tvg${id}`, title: name, url: `${base}/discover/tv?${q}&sort_by=vote_average.desc&vote_count.gte=200&with_genres=${id}&page=1`, mediaType: 'tv' }));
  }
  // Award/prestige rows (curated lists — film awards). Skipped under the TV tab
  // since these lists are movies; shown under All and Movies. `list: true` tells the
  // fetch layer the payload is in `items`, not `results`.
  if (kind !== 'tv') AWARD_ROWS.forEach(([id, name]) =>
    rows.push({ key: `l${id}`, title: name, url: `${base}/list/${id}?${q}&page=1`, list: true }));
  (type === 'tv' ? TV_GENRE_ROWS : MOVIE_GENRE_ROWS).forEach(([id, name]) =>
    rows.push({ key: `g${id}`, title: name, url: disc(`with_genres=${id}`), mediaType }));
  if (kind === 'all') ALL_EXTRA_ROWS.forEach(([key, title, t, params]) =>
    rows.push({ key, title, url: `${base}/discover/${t}?${q}&sort_by=vote_average.desc&${params}&page=1`, mediaType: t }));
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
  return row.key === 'continue' || row.noSort === true ? items : sortItemsByRating(items);
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
