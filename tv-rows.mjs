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
export function catalogRowDefs(apiKey, base = TMDB_BASE) {
  const q = `api_key=${apiKey}`;
  const genre = (id) => `${base}/discover/movie?${q}&with_genres=${id}&sort_by=popularity.desc&vote_count.gte=200&page=1`;
  return [
    { key: 'trending', title: 'Trending This Week', url: `${base}/trending/all/week?${q}&page=1` },
    { key: 'popular', title: 'Popular Right Now', url: `${base}/movie/popular?${q}&page=1`, mediaType: 'movie' },
    { key: 'top_rated', title: 'Top Rated', url: `${base}/movie/top_rated?${q}&page=1`, mediaType: 'movie' },
    { key: 'now_playing', title: 'New Releases', url: `${base}/movie/now_playing?${q}&page=1`, mediaType: 'movie' },
    { key: 'action', title: 'Action & Adventure', url: genre(28), mediaType: 'movie' },
    { key: 'comedy', title: 'Comedies', url: genre(35), mediaType: 'movie' },
    { key: 'drama', title: 'Dramas', url: genre(18), mediaType: 'movie' },
    { key: 'scifi', title: 'Sci-Fi & Fantasy', url: genre(878), mediaType: 'movie' },
  ];
}

// Identity of a title across rows. Movie id 5 and TV id 5 are different titles,
// so the media kind is part of the key. Movie endpoints omit media_type but carry
// `title`; TV endpoints carry `name`.
export function titleKey(item) {
  const kind = item.media_type || (item.name && !item.title ? 'tv' : 'movie');
  return `${kind}:${item.id}`;
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
