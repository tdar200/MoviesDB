#!/usr/bin/env node
// Builds franchises.js: film series ("Part 1, 2, 3") for the TV home's Franchises row.
//   node scripts/build-franchises.mjs            (needs network; TMDB key comes from config.js)
// TMDB groups most series as a "collection" (belongs_to_collection). It has no single Marvel Cinematic Universe collection,
// so that one is assembled from Marvel Studios' (company 420) released films, in release order.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_KEY = /API_KEY:\s*'([0-9a-f]{32})'/.exec(readFileSync(join(root, 'config.js'), 'utf8'))[1];
const BASE = 'https://api.themoviedb.org/3';
const MIN_VOTES = 150; // drops shorts and obscure side entries

// [display name, TMDB collection search query, optional TMDB collection id (pins it when the name search picks a wrong one)]  - most popular first
const SERIES = [
  ['Fast & Furious', 'The Fast and the Furious Collection'], ['Harry Potter', 'Harry Potter Collection'], ['Fantastic Beasts', 'Fantastic Beasts Collection'],
  ['Star Wars', 'Star Wars Collection'], ['The Matrix', 'The Matrix Collection'], ['Shrek', 'Shrek Collection'],
  ['The Lord of the Rings', 'The Lord of the Rings Collection', 119], ['The Hobbit', 'The Hobbit Collection'],
  ['Jurassic Park', 'Jurassic Park Collection'], ['Mission: Impossible', 'Mission: Impossible Collection'],
  ['John Wick', 'John Wick Collection'], ['The Dark Knight Trilogy', 'The Dark Knight Collection'],
  ['Toy Story', 'Toy Story Collection'], ['Pirates of the Caribbean', 'Pirates of the Caribbean Collection'],
  ['Avengers', 'The Avengers Collection'], ['Iron Man', 'Iron Man Collection'], ['Thor', 'Thor Collection'],
  ['Captain America', 'Captain America Collection'], ['Guardians of the Galaxy', 'Guardians of the Galaxy Collection'],
  ['Spider-Man (MCU)', 'Spider-Man (MCU) Collection'], ['Black Panther', 'Black Panther Collection'],
  ['Doctor Strange', 'Doctor Strange Collection'], ['Ant-Man', 'Ant-Man Collection'],
  ['X-Men', 'X-Men Collection'], ['Deadpool', 'Deadpool Collection'], ['Spider-Man', 'Spider-Man Collection'],
  ['James Bond', 'James Bond Collection'], ['Indiana Jones', 'Indiana Jones Collection'],
  ['Back to the Future', 'Back to the Future Collection'], ['Terminator', 'The Terminator Collection'],
  ['Alien', 'Alien Collection', 8091], ['Predator', 'Predator Collection'], ['Rocky', 'Rocky Collection', 1575], ['Creed', 'Creed Collection'],
  ['Planet of the Apes', 'Planet of the Apes (Reboot) Collection'], ['Transformers', 'Transformers Collection'],
  ['Despicable Me', 'Despicable Me Collection'], ['Ice Age', 'Ice Age Collection'],
  ['Kung Fu Panda', 'Kung Fu Panda Collection'], ['How to Train Your Dragon', 'How to Train Your Dragon Collection'],
  ['Madagascar', 'Madagascar Collection'], ['Cars', 'Cars Collection'], ['The Incredibles', 'The Incredibles Collection'],
  ['Finding Nemo', 'Finding Nemo Collection'], ['The Hunger Games', 'The Hunger Games Collection'],
  ['Twilight', 'The Twilight Collection', 33514], ['Divergent', 'The Divergent Series Collection', 283579], ['The Maze Runner', 'The Maze Runner Collection'],
  ['Pitch Perfect', 'Pitch Perfect Collection'], ['The Conjuring', 'The Conjuring Collection', 313086], ['Saw', 'Saw Collection'],
  ['Scream', 'Scream Collection'], ['Halloween', 'Halloween Collection', 91361], ['Insidious', 'Insidious Collection'],
  ['Resident Evil', 'Resident Evil Collection'], ['Jason Bourne', 'The Bourne Collection'], ["Ocean's", "Ocean's Collection"],
  ['Die Hard', 'Die Hard Collection'], ['Lethal Weapon', 'Lethal Weapon Collection'], ['Rambo', 'Rambo Collection'],
  ['The Expendables', 'The Expendables Collection'], ['Taken', 'Taken Collection'], ['Kingsman', 'Kingsman Collection'],
  ['Men in Black', 'Men in Black Collection'], ['Ghostbusters', 'Ghostbusters Collection'], ['Bad Boys', 'Bad Boys Collection'],
  ['Jumanji', 'Jumanji Collection'], ['Home Alone', 'Home Alone Collection'], ['The Hangover', 'The Hangover Collection'],
  ['American Pie', 'American Pie Collection'], ['Austin Powers', 'Austin Powers Collection'], ['Mad Max', 'Mad Max Collection'], ['Avatar', 'Avatar Collection'], ['Star Trek', 'Star Trek: The Original Series Collection'],
  ['Rush Hour', 'Rush Hour Collection'], ['The Godfather', 'The Godfather Collection'], ['Final Destination', 'Final Destination Collection'],
  ['Hotel Transylvania', 'Hotel Transylvania Collection'], ['Paddington', 'Paddington Collection'], ['Evil Dead', 'The Evil Dead Collection', 1960],
];

// TMDB's collections are incomplete in three ways, found by auditing every series against an independent title search:
//  - a sequel is simply not linked to its collection (The Matrix Resurrections has no collection at all),
//  - a series is split into several collections (Star Trek: three; Alien: four; Planet of the Apes: old and new),
//  - a spin-off sits in a collection of its own (Minions, Rogue One).
// `merge`: collections to fold in, by exact name.  `include`: films to add, by TMDB id or { title, year }.
const OPTIONS = {
  'The Matrix': { include: [624860] },                                                       // The Matrix Resurrections
  'Star Wars': { include: [330459, 348350, 12180] },                                         // Rogue One, Solo, The Clone Wars (2008)
  'The Lord of the Rings': { include: [839033] },                                            // The War of the Rohirrim
  'John Wick': { include: [{ title: 'Ballerina', year: 2025 }] },
  'X-Men': { merge: ['The Wolverine Collection'] },                                          // Origins: Wolverine, The Wolverine, Logan
  'Alien': { merge: ['Prometheus Collection', 'Alien: Romulus Collection', 'AVP Collection'] },
  'Predator': { merge: ['AVP Collection'], include: [1376434] },                             // Predator: Killer of Killers
  'Planet of the Apes': { merge: ['Planet of the Apes (Original) Collection'], include: [869] }, // 1968-1973 and Burton's 2001
  'Transformers': { include: [698687, 667538, { title: 'Bumblebee', year: 2018 }] },
  'Despicable Me': { merge: ['Minions Collection'] },
  'How to Train Your Dragon': { include: [1087192] },                                        // the 2025 live-action film
  'Madagascar': { include: [270946] },                                                       // Penguins of Madagascar
  'The Hunger Games': { include: [695721] },                                                 // The Ballad of Songbirds & Snakes
  'Halloween': { merge: ['Halloween (Rob Zombie Series) Collection'] },
  'Resident Evil': { include: [460458, 1423191] },                                           // Welcome to Raccoon City, Resident Evil (2026)
  "Ocean's": { include: [402900, 299] },                                                     // Ocean's Eight, Ocean's Eleven (1960)
  'Men in Black': { include: [479455] },                                                     // Men in Black: International
  'Ghostbusters': { include: [43074] },                                                      // Ghostbusters (2016)
  'Home Alone': { include: [654974] },                                                       // Home Sweet Home Alone
  'Star Trek': { merge: ['Star Trek: The Next Generation Collection', 'Star Trek: Alternate Reality Collection'] },
  'Evil Dead': { include: [109428, 713704, 1212763] },                                       // Evil Dead (2013), Evil Dead Rise, Evil Dead Burn
};
const RENAME = { 'Spider-Man': 'Spider-Man (Sam Raimi)' };  // the Raimi trilogy, not every Spider-Man film

const get = async (path, params = {}) => {
  const url = new URL(BASE + path);
  url.searchParams.set('api_key', API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${path} -> rate limited`);
};

const today = new Date().toISOString().slice(0, 10);
const slimPart = p => ({
  id: p.id, title: p.title, release_date: p.release_date, poster_path: p.poster_path || null, backdrop_path: p.backdrop_path || null,
  overview: p.overview || '', vote_average: Math.round((p.vote_average || 0) * 10) / 10, vote_count: p.vote_count || 0,
  genre_ids: p.genre_ids || [], media_type: 'movie',
});
// A film released in the last 18 months may not have 150 votes yet; it still belongs to its series.
const recentCutoff = new Date(Date.now() - 548 * 864e5).toISOString().slice(0, 10);
const usable = p => !p.adult && p.release_date && p.release_date <= today && p.poster_path
  && (p.vote_count >= MIN_VOTES || (p.release_date >= recentCutoff && p.vote_count >= 10));
const byRelease = (a, b) => a.release_date.localeCompare(b.release_date) || a.id - b.id;

async function movieById(id) {
  const d = await get(`/movie/${id}`);
  if (!d || !d.id) throw new Error(`movie ${id} not found`);
  return { ...d, genre_ids: (d.genres || []).map(g => g.id) };
}
async function movieByTitle({ title, year }) {
  const r = await get('/search/movie', { query: title, year: String(year) });
  const hit = (r.results || []).find(m => m.title.toLowerCase().includes(title.toLowerCase()));
  if (!hit) throw new Error(`"${title}" (${year}) not found`);
  return movieById(hit.id);
}
async function collectionParts(id) { return ((await get(`/collection/${id}`)).parts || []); }
async function collectionByName(name) {
  const r = await get('/search/collection', { query: name });
  const hit = (r.results || []).find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!hit) throw new Error(`collection "${name}" not found`);
  return collectionParts(hit.id);
}

async function fromCollection([name, query, pinnedId]) {
  const hit = pinnedId ? { id: pinnedId } : ((await get('/search/collection', { query })).results || [])[0];
  if (!hit) return { name, error: 'no collection found' };
  const detail = await get(`/collection/${hit.id}`);
  const opt = OPTIONS[name] || {};
  const raw = [...(detail.parts || [])];
  for (const m of opt.merge || []) raw.push(...await collectionByName(m));
  const extra = [];
  for (const inc of opt.include || []) extra.push(typeof inc === 'number' ? await movieById(inc) : await movieByTitle(inc));
  const seen = new Set();
  // Explicitly included films skip the vote filter: they were chosen by hand.
  const all = [...raw.filter(usable), ...extra.filter(p => !p.adult && p.release_date && p.release_date <= today && p.poster_path)]
    .filter(p => !seen.has(p.id) && seen.add(p.id));
  const parts = all.map(slimPart).sort(byRelease);
  return { name: RENAME[name] || name, tmdbName: detail.name + ((opt.merge || []).length ? ` + ${opt.merge.length} merged` : '') + (extra.length ? ` + ${extra.length} added` : ''), collectionId: detail.id, overview: detail.overview || '', backdrop_path: detail.backdrop_path, poster_path: detail.poster_path, parts };
}

// The MCU, in release order. Marvel Studios' company list also holds shorts, specials, animation and pre-MCU films
// (Ultimate Avengers 2, Ghost Rider, Team Thor ...), so the franchise is this explicit list matched against it.
const MCU_TITLES = ['Iron Man', 'The Incredible Hulk', 'Iron Man 2', 'Thor', 'Captain America: The First Avenger', 'The Avengers', 'Iron Man 3',
  'Thor: The Dark World', 'Captain America: The Winter Soldier', 'Guardians of the Galaxy', 'Avengers: Age of Ultron', 'Ant-Man',
  'Captain America: Civil War', 'Doctor Strange', 'Guardians of the Galaxy Vol. 2', 'Spider-Man: Homecoming', 'Thor: Ragnarok', 'Black Panther',
  'Avengers: Infinity War', 'Ant-Man and the Wasp', 'Captain Marvel', 'Avengers: Endgame', 'Spider-Man: Far From Home', 'Black Widow',
  'Shang-Chi and the Legend of the Ten Rings', 'Eternals', 'Spider-Man: No Way Home', 'Doctor Strange in the Multiverse of Madness',
  'Thor: Love and Thunder', 'Black Panther: Wakanda Forever', 'Ant-Man and the Wasp: Quantumania', 'Guardians of the Galaxy Vol. 3', 'The Marvels',
  'Deadpool & Wolverine', 'Captain America: Brave New World', 'Thunderbolts*', 'The Fantastic 4: First Steps', 'Spider-Man: Brand New Day'];
async function marvel() {
  const found = [];
  for (let page = 1; page <= 5; page++) {
    const d = await get('/discover/movie', { with_companies: '420', sort_by: 'primary_release_date.asc', 'primary_release_date.gte': '2008-04-01', 'primary_release_date.lte': today, 'vote_count.gte': String(MIN_VOTES), page: String(page), include_adult: 'false' });
    found.push(...(d.results || []));
    if (page >= d.total_pages) break;
  }
  const clean = found.filter(usable).filter(p => MCU_TITLES.includes(p.title)).map(slimPart).sort(byRelease);
  const missing = MCU_TITLES.filter(t => !clean.some(p => p.title === t));
  if (missing.length) console.log('  (MCU titles not found/released yet:', missing.join(', '), ')');
  const best = [...clean].filter(p => p.backdrop_path).sort((a, b) => b.vote_count - a.vote_count)[0];
  return { name: 'Marvel Cinematic Universe', tmdbName: 'Marvel Studios (company 420), MCU film list', collectionId: 'mcu', overview: 'Every film of the Marvel Cinematic Universe, in the order it was released.', backdrop_path: best && best.backdrop_path, poster_path: best && best.poster_path, parts: clean };
}

const results = [await marvel()];
for (const series of SERIES) {
  try { results.push(await fromCollection(series)); } catch (e) { results.push({ name: series[0], error: String(e.message) }); }
}
const kept = [];
for (const r of results) {
  const minParts = r.collectionId === 'mcu' ? 15 : 3;
  const ok = !r.error && r.parts.length >= minParts && r.poster_path;
  console.log(`${ok ? 'OK  ' : 'SKIP'} ${r.name.padEnd(28)} ${(r.tmdbName || '').padEnd(46)} ${r.error ? r.error : r.parts.length + ' parts: ' + r.parts.slice(0, 3).map(p => p.title).join(' / ') + (r.parts.length > 3 ? ' ...' : '')}`);
  if (!ok) continue;
  const bd = r.backdrop_path || (r.parts.find(p => p.backdrop_path) || {}).backdrop_path || null;
  kept.push({ id: `franchise:${r.collectionId}`, collectionId: r.collectionId, title: r.name, overview: r.overview, backdrop_path: bd, poster_path: r.poster_path, parts: r.parts });
}
const header = `// Generated by scripts/build-franchises.mjs (TMDB collections). Snapshot: ${today}. Do not edit by hand: re-run the script.\n// Order = row order (most popular first). Each franchise's parts are in release order: that order IS "Part 1, 2, 3".\n`;
writeFileSync(join(root, 'franchises.js'), `${header}export const FRANCHISES_SNAPSHOT_DATE = '${today}';\nexport const FRANCHISES = ${JSON.stringify(kept, null, 1)};\n`);
console.log(`\nwrote franchises.js: ${kept.length} franchises, ${kept.reduce((n, f) => n + f.parts.length, 0)} parts`);
