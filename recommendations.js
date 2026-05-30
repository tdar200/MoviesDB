// Content-based recommendation engine for the Movies app.
// Pure functions (profile + scoring + reasons) are unit-tested; network/cache
// functions live lower in the file and are exercised manually in the browser.
import { MOVIE_GENRES, TV_GENRES } from './config.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const GENRE_NAMES = new Map();
[...MOVIE_GENRES, ...TV_GENRES].forEach((g) => {
  if (g.id !== 0) GENRE_NAMES.set(g.id, g.name);
});

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30-day half-life

// Newer watched items count more. Returns 1.0 at now, ~0.5 after 30 days.
export function recencyWeight(watchedAt, now) {
  if (!watchedAt) return 0.5;
  const age = Math.max(0, now - watchedAt);
  return Math.pow(0.5, age / HALF_LIFE_MS);
}

// Higher-rated watched titles nudge their signal up. 0-10 → 0.75..1.25.
export function ratingNudge(voteAverage) {
  if (typeof voteAverage !== 'number' || voteAverage <= 0) return 1;
  return 0.75 + (voteAverage / 10) * 0.5;
}

function topNumeric(obj, n) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
  );
}

function topWeighted(obj, n) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1].weight - a[1].weight).slice(0, n)
  );
}

// Build a weighted taste profile from enriched watched items. `now` is injected
// for deterministic testing.
export function buildTasteProfile(enrichedWatched, now) {
  const genres = {};
  const keywords = {};
  const people = {};
  const mediaTypeBias = { movie: 0, tv: 0 };
  const topTitles = [];

  for (const item of enrichedWatched) {
    const w = recencyWeight(item.watchedAt, now) * ratingNudge(item.vote_average);

    (item.genre_ids || []).forEach((id) => {
      genres[id] = (genres[id] || 0) + w;
    });
    (item._keywords || []).forEach((k) => {
      if (!keywords[k.id]) keywords[k.id] = { name: k.name, weight: 0 };
      keywords[k.id].weight += w;
    });
    (item._people || []).forEach((p) => {
      if (!people[p.id]) people[p.id] = { name: p.name, weight: 0 };
      people[p.id].weight += w;
    });

    const mt = item.media_type === 'tv' ? 'tv' : 'movie';
    mediaTypeBias[mt] += w;
    topTitles.push({
      id: item.id,
      title: item.title || item.name || '',
      weight: w,
      genreIds: item.genre_ids || [],
      keywordIds: (item._keywords || []).map((k) => k.id),
      peopleIds: (item._people || []).map((p) => p.id),
      media_type: mt,
    });
  }

  return {
    genres: topNumeric(genres, 15),
    keywords: topWeighted(keywords, 30),
    people: topWeighted(people, 20),
    mediaTypeBias,
    topTitles: topTitles.sort((a, b) => b.weight - a.weight),
  };
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Merge Discover result lists, deduping by id and accumulating seed provenance.
export function mergeCandidates(taggedCandidates) {
  const byId = new Map();
  for (const c of taggedCandidates) {
    const key = String(c.id);
    if (byId.has(key)) {
      byId.get(key)._seeds.push(...(c._seeds || []));
    } else {
      byId.set(key, { ...c, _seeds: [...(c._seeds || [])] });
    }
  }
  return [...byId.values()];
}

// Score a candidate: seed provenance + profile genre overlap + light popularity prior.
export function scoreCandidate(candidate, profile) {
  let score = 0;
  for (const seed of candidate._seeds || []) score += seed.weight;
  for (const gid of candidate.genre_ids || []) {
    const gw = profile.genres[String(gid)];
    if (gw) score += gw * 0.5;
  }
  const pop = candidate.popularity || 0;
  score += Math.log10(pop + 1) * 0.1;
  return score;
}

// Up to 2 human-readable reasons. Prefers "Because you watched <title>" when the
// candidate's strongest seed (person/keyword) is shared with a watched title.
export function generateReasons(candidate, profile) {
  const reasons = [];
  const seeds = [...(candidate._seeds || [])].sort((a, b) => b.weight - a.weight);
  const topSeed = seeds.find((s) => s.type === 'person' || s.type === 'keyword');

  if (topSeed) {
    const shared = profile.topTitles.find((t) =>
      topSeed.type === 'person'
        ? t.peopleIds.includes(topSeed.id)
        : t.keywordIds.includes(topSeed.id)
    );
    if (shared && shared.title) reasons.push(`Because you watched ${shared.title}`);
    else if (topSeed.type === 'person') reasons.push(`Features ${topSeed.name}`);
    else reasons.push(capitalize(topSeed.name));
  }

  if (reasons.length < 2) {
    const matchedGenres = (candidate.genre_ids || [])
      .filter((id) => profile.genres[String(id)])
      .map((id) => GENRE_NAMES.get(id))
      .filter(Boolean);
    if (matchedGenres.length) reasons.push(matchedGenres.slice(0, 2).join(' · '));
  }

  return reasons.slice(0, 2);
}

// Score, drop already-watched, sort desc, take top `limit`.
export function rankCandidates(candidates, profile, watchedIds, limit = 20) {
  const watched = new Set([...watchedIds].map(String));
  return candidates
    .filter((c) => !watched.has(String(c.id)))
    .map((c) => ({ movie: c, score: scoreCandidate(c, profile), reasons: generateReasons(c, profile) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
