// Franchises: film series grouped under one title (Fast & Furious, The Matrix, Shrek, the Marvel Cinematic Universe ...).
// The data is baked into franchises.js by scripts/build-franchises.mjs; this module is the pure logic around it.

const yearOf = part => Number(String(part.release_date || '').slice(0, 4)) || 0;

// "3 films  ·  1999-2003" (plain hyphen: the TV's old font renders the long dashes badly).
export function franchiseSpan(franchise) {
  const years = (franchise.parts || []).map(yearOf).filter(Boolean);
  const count = (franchise.parts || []).length;
  const from = years.length ? Math.min(...years) : 0;
  const to = years.length ? Math.max(...years) : 0;
  const range = !from ? '' : from === to ? String(from) : `${from}-${to}`;
  return { count, from, to, label: [`${count} ${count === 1 ? 'film' : 'films'}`, range].filter(Boolean).join('  ·  ') };
}

// The tile on the home row. media_type 'franchise' stops it being treated as a film or a show; it carries the
// franchise itself so opening it needs no network. No star rating: the tile shows how many films it holds.
export function franchiseCard(franchise) {
  const parts = franchise.parts || [];
  return {
    id: franchise.id,
    title: franchise.title,
    media_type: 'franchise',
    franchise,
    filmCount: parts.length,
    overview: franchise.overview || '',
    backdrop_path: franchise.backdrop_path || null,
    poster_path: franchise.poster_path || null,
    release_date: (parts[0] && parts[0].release_date) || '',
    vote_average: 0,
    vote_count: 0,
    genre_ids: [],
  };
}

// The Franchises row exists on the All and Movies homes: these are films, so not on TV, Live or Channels.
export function franchiseRow(kind, franchises) {
  if (kind !== 'all' && kind !== 'movie') return null;
  if (!Array.isArray(franchises) || !franchises.length) return null;
  return { key: 'franchises', title: 'Franchises', noSort: true, items: franchises.map(franchiseCard) };
}

const FINISHED = 0.9;
// Where the franchise screen puts focus: the first part you have not finished (Part 1 when nothing is watched, and
// back to Part 1 once everything is). `progressOf(partId)` is the watched fraction 0..1.
export function firstUnfinishedIndex(parts, progressOf) {
  if (typeof progressOf !== 'function') return 0;
  const i = (parts || []).findIndex(p => !(Number(progressOf(p.id)) >= FINISHED));
  return i < 0 ? 0 : i;
}
