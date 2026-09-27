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

// The All tab: every category is ONE row that mixes films and shows (a Comedy
// row holds comedy films and comedy series), fetched from a movie and a tv feed
// and merged. [key, title, movie discover params | null, tv discover params | null].
// Vote floors differ per side because series collect far fewer votes than films;
// world and niche rows use lower floors (TMDB barely rates Urdu dramas at all).
const G = (m, t) => [`vote_count.gte=500&${m}`, t && `vote_count.gte=100&${t}`];
const K = (id, m = 300, t = 50) => [`vote_count.gte=${m}&with_keywords=${id}`, `vote_count.gte=${t}&with_keywords=${id}`];
const L = (lang, m = 100, t = 30, extra = '') => [`vote_count.gte=${m}&with_original_language=${lang}${extra}`, `vote_count.gte=${t}&with_original_language=${lang}${extra}`];
const ERA = (from, to) => [`vote_count.gte=1000&primary_release_date.gte=${from}-01-01&primary_release_date.lte=${to}-12-31`, `vote_count.gte=200&first_air_date.gte=${from}-01-01&first_air_date.lte=${to}-12-31`];
const MIXED_ROWS = [
  // TMDB's TV genres pair these up, so the All rows do too (films: either genre).
  ['mg-action', 'Action & Adventure', ...G('with_genres=28|12', 'with_genres=10759')],
  ['mg-comedy', 'Comedy', ...G('with_genres=35', 'with_genres=35')],
  ['mg-drama', 'Drama', ...G('with_genres=18', 'with_genres=18')],
  ['mg-crime', 'Crime', ...G('with_genres=80', 'with_genres=80')],
  ['mg-thriller', 'Thriller', ...G('with_genres=53', 'with_keywords=316362')],
  ['mg-mystery', 'Mystery', ...G('with_genres=9648', 'with_genres=9648')],
  ['mg-horror', 'Horror', ...G('with_genres=27', 'with_keywords=315058')],
  ['mg-romance', 'Romance', ...G('with_genres=10749', 'with_keywords=9840')],
  ['mg-scifi', 'Sci-Fi & Fantasy', ...G('with_genres=878|14', 'with_genres=10765')],
  ['mg-animation', 'Animation', ...G('with_genres=16', 'with_genres=16')],
  ['mg-documentary', 'Documentaries', 'vote_count.gte=100&with_genres=99', 'vote_count.gte=50&with_genres=99'],
  ['mg-family', 'Family', ...G('with_genres=10751', 'with_genres=10751')],
  ['mg-kids', 'Kids', 'vote_count.gte=300&with_genres=16,10751', 'vote_count.gte=50&with_genres=10762'],
  ['mg-history', 'History', ...G('with_genres=36', 'with_keywords=15126')],
  ['mg-war', 'War', ...G('with_genres=10752', 'with_genres=10768')],
  ['mg-western', 'Westerns', 'vote_count.gte=300&with_genres=37', 'vote_count.gte=50&with_genres=37'],
  ['mg-music', 'Music & Musicals', 'vote_count.gte=300&with_genres=10402', 'vote_count.gte=20&with_keywords=4344'],
  ['mg-reality', 'Reality', null, 'vote_count.gte=50&with_genres=10764'],
  ['mk-superhero', 'Superhero', ...K(9715)],
  ['mk-timetravel', 'Time Travel', ...K(4379)],
  ['mk-zombies', 'Zombies', ...K(12377)],
  ['mk-psych', 'Psychological Thrillers', ...K(12565)],
  ['mk-heist', 'Heists', ...K(10051, 300, 20)],
  ['mk-truestory', 'Based on a True Story', ...K(9672, 500, 50)],
  ['mk-space', 'Space', ...K(9882)],
  ['mk-dystopia', 'Dystopian Worlds', ...K(4565)],
  ['mk-serialkiller', 'Serial Killers', ...K(10714)],
  ['mk-martialarts', 'Martial Arts', ...K(779)],
  ['mk-spies', 'Spies', ...K(470, 300, 30)],
  ['mk-survival', 'Survival', ...K(10349)],
  ['mk-sports', 'Sports', ...K(6075)],
  ['mk-cyberpunk', 'Cyberpunk', ...K(12190, 100, 20)],
  ['mk-timeloop', 'Time Loops', ...K(10854, 100, 20)],
  ['mk-christmas', 'Christmas', ...K(207317, 300, 20)],
  ['ml-hi', 'Bollywood & Indian', ...L('hi')],
  ['ml-ko', 'Korean', ...L('ko', 100, 50)],
  ['ml-ja', 'Anime', ...L('ja', 100, 100, '&with_genres=16')],
  // Films need 10 votes (3-vote 10.0s were junk); Urdu dramas barely get rated at all.
  // Films need 10 votes (3-vote 10.0s were junk); Urdu dramas barely get rated at all.
  ['ml-ur', 'Pakistani', ...L('ur', 10, 3)],
  ['ml-tr', 'Turkish', ...L('tr', 100, 20)],
  ['ml-es', 'Spanish-Language', ...L('es', 300, 100)],
  ['ml-fr', 'French', ...L('fr', 300, 30)],
  ['mc-gb', 'British', 'vote_count.gte=500&with_origin_country=GB', 'vote_count.gte=100&with_origin_country=GB'],
  ['me-80s', '80s Classics', ...ERA(1980, 1989)],
  ['me-90s', '90s Classics', ...ERA(1990, 1999)],
  ['me-00s', '2000s Favourites', ...ERA(2000, 2009)],
  ['me-gems', 'Hidden Gems', 'vote_average.gte=7.5&vote_count.gte=300&vote_count.lte=2000', 'vote_average.gte=8&vote_count.gte=100&vote_count.lte=800'],
  ['mp-8', 'On Netflix', 'vote_count.gte=500&with_watch_providers=8&watch_region=US', 'vote_count.gte=200&with_watch_providers=8&watch_region=US'],
  ['mp-9', 'On Prime Video', 'vote_count.gte=500&with_watch_providers=9&watch_region=US', 'vote_count.gte=200&with_watch_providers=9&watch_region=US'],
  ['mp-337', 'On Disney+', 'vote_count.gte=500&with_watch_providers=337&watch_region=US', 'vote_count.gte=200&with_watch_providers=337&watch_region=US'],
  ['mp-1899', 'On Max', 'vote_count.gte=500&with_watch_providers=1899&watch_region=US', 'vote_count.gte=200&with_watch_providers=1899&watch_region=US'],
  ['mp-350', 'On Apple TV+', 'vote_count.gte=100&with_watch_providers=350&watch_region=US', 'vote_count.gte=100&with_watch_providers=350&watch_region=US'],
  ['mp-2303', 'On Paramount+', 'vote_count.gte=500&with_watch_providers=2303&watch_region=US', 'vote_count.gte=200&with_watch_providers=2303&watch_region=US'],
];

// A row's feeds. Single-feed rows (Movies/TV tabs, award lists) carry `url`;
// mixed All rows carry `sources`. Each source is { url, mediaType, list? }.
export function rowSources(def) {
  return def.sources || [{ url: def.url, mediaType: def.mediaType, list: def.list }];
}

// The same sources at another page number.
export function rowSourcesAtPage(def, page) {
  return rowSources(def).map(src => ({ ...src, url: /[?&]page=\d+/.test(src.url) ? src.url.replace(/([?&]page=)\d+/, `$1${page}`) : `${src.url}${src.url.includes('?') ? '&' : '?'}page=${page}` }));
}

function allRowDefs(q, base) {
  const src = (path, mediaType) => ({ url: `${base}/${path}${path.includes('?') ? '&' : '?'}${q}&page=1`, mediaType });
  const both = (key, title, movie, tv) => {
    const sources = [];
    if (movie) sources.push(src(`discover/movie?sort_by=vote_average.desc&${movie}`, 'movie'));
    if (tv) sources.push(src(`discover/tv?sort_by=vote_average.desc&${tv}`, 'tv'));
    return { key, title, url: sources[0].url, sources };
  };
  const rows = [
    { key: 'trending', title: 'Trending This Week', url: `${base}/trending/all/week?${q}&page=1` },
    { key: 'popular', title: 'Popular Now', sources: [src('movie/popular', 'movie'), src('tv/popular', 'tv')] },
    { key: 'top_rated', title: 'Top Rated', sources: [src('movie/top_rated', 'movie'), src('tv/top_rated', 'tv')] },
    { key: 'now_playing', title: 'New Releases & Episodes', sources: [src('movie/now_playing', 'movie'), src('tv/on_the_air', 'tv')] },
    both('highly_rated', 'Critically Acclaimed', 'vote_count.gte=1500', 'vote_count.gte=800'),
  ];
  rows.forEach(r => { if (r.sources) r.url = r.sources[0].url; });
  // Award lists are films only by nature (Oscars, Cannes, AFI).
  AWARD_ROWS.forEach(([id, name]) => rows.push({ key: `l${id}`, title: name, url: `${base}/list/${id}?${q}&page=1`, list: true }));
  MIXED_ROWS.forEach(([key, title, movie, tv]) => rows.push(both(key, title, movie, tv)));
  return rows;
}

// The curated, media-kind-aware home. `kind` is 'all' | 'movie' | 'tv'. Every row
// is a distinct TMDB feed; each paginates endlessly in the UI. Personal rows
// (Continue Watching, My List) and Recommended are added by the caller.
export function catalogRowDefs(apiKey, base = TMDB_BASE, kind = 'all') {
  const q = `api_key=${apiKey}`;
  if (kind === 'all') return allRowDefs(q, base);
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
// Vote-weighted rating (the IMDb Top 250 formula): v/(v+m)*R + m/(v+m)*C. A title
// rated by few people is pulled toward the average, so a 9.4 from 900 votes does
// not outrank an 8.7 from 28,000, and series (whose ratings run ~0.4 higher on
// TMDB from fewer, keener voters) no longer crowd films out of mixed rows. Items
// without a vote count (curated static lists) keep their plain rating.
export const WEIGHT_VOTES = 1000;
export const WEIGHT_MEAN = 6.8;
export function weightedRating(item) {
  const r = Number(item && item.vote_average) || 0;
  const v = Number(item && item.vote_count);
  if (!Number.isFinite(v) || v < 0) return r;
  return (v / (v + WEIGHT_VOTES)) * r + (WEIGHT_VOTES / (v + WEIGHT_VOTES)) * WEIGHT_MEAN;
}

export function sortItemsByRating(items = []) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const difference = weightedRating(b.item) - weightedRating(a.item);
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
