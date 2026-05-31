import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recencyWeight, ratingNudge, buildTasteProfile } from './recommendations.js';
import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates } from './recommendations.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed clock for deterministic tests

test('recencyWeight decays ~half over 30 days', () => {
  const fresh = recencyWeight(NOW, NOW);
  const month = recencyWeight(NOW - 30 * DAY, NOW);
  assert.equal(fresh, 1);
  assert.ok(month > 0.49 && month < 0.51, `expected ~0.5, got ${month}`);
});

test('recencyWeight defaults to 0.5 when watchedAt missing', () => {
  assert.equal(recencyWeight(undefined, NOW), 0.5);
});

test('ratingNudge maps 0-10 into 0.75..1.25, neutral when missing', () => {
  assert.equal(ratingNudge(0), 1);
  assert.equal(ratingNudge(undefined), 1);
  assert.equal(ratingNudge(10), 1.25);
  assert.equal(ratingNudge(5), 1.0);
});

test('buildTasteProfile aggregates weighted genres, keywords, people', () => {
  const watched = [
    { id: 1, media_type: 'movie', title: 'A', genre_ids: [878, 28], vote_average: 8,
      watchedAt: NOW, _keywords: [{ id: 9, name: 'time travel' }], _people: [{ id: 5, name: 'Nolan' }] },
    { id: 2, media_type: 'tv', name: 'B', genre_ids: [878], vote_average: 6,
      watchedAt: NOW - 60 * DAY, _keywords: [{ id: 9, name: 'time travel' }], _people: [] },
  ];
  const p = buildTasteProfile(watched, NOW);
  assert.ok(p.genres['878'] > p.genres['28']);
  assert.equal(p.keywords['9'].name, 'time travel');
  assert.equal(p.people['5'].name, 'Nolan');
  assert.ok(p.mediaTypeBias.movie > 0 && p.mediaTypeBias.tv > 0);
  assert.equal(p.topTitles[0].id, 1);
  assert.deepEqual(p.topTitles[0].keywordIds, [9]);
});

const PROFILE = {
  genres: { '878': 3, '28': 1 },
  keywords: { '9': { name: 'time travel', weight: 2 } },
  people: { '5': { name: 'Nolan', weight: 2 } },
  mediaTypeBias: { movie: 5, tv: 1 },
  topTitles: [
    { id: 1, title: 'Inception', weight: 3, genreIds: [878], keywordIds: [9], peopleIds: [5], media_type: 'movie' },
  ],
};

test('mergeCandidates dedupes by id and accumulates seeds', () => {
  const merged = mergeCandidates([
    { id: 100, genre_ids: [878], _seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] },
    { id: 100, genre_ids: [878], _seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 2 }] },
    { id: 200, genre_ids: [28], _seeds: [{ type: 'genre', id: 28, name: 'Action', weight: 1 }] },
  ]);
  assert.equal(merged.length, 2);
  const c100 = merged.find((c) => c.id === 100);
  assert.equal(c100._seeds.length, 2);
});

test('scoreCandidate rewards seed weight, genre overlap, popularity', () => {
  const strong = { id: 100, genre_ids: [878], popularity: 100,
    _seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] };
  const weak = { id: 200, genre_ids: [28], popularity: 1,
    _seeds: [{ type: 'genre', id: 28, name: 'Action', weight: 1 }] };
  assert.ok(scoreCandidate(strong, PROFILE) > scoreCandidate(weak, PROFILE));
});

test('generateReasons leads with a taste theme and adds dominant title', () => {
  const cand = { id: 100, genre_ids: [878], popularity: 50,
    _seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 2 }] };
  const reasons = generateReasons(cand, PROFILE);
  assert.ok(reasons.length >= 1 && reasons.length <= 2);
  assert.match(reasons[0], /Sci-Fi|Nolan|most-watched/);
  assert.ok(reasons.join(' ').includes('Inception'));
});

test('generateReasons falls back to genre-only theme without person/keyword', () => {
  const cand = { id: 101, genre_ids: [878], popularity: 5, _seeds: [] };
  const reasons = generateReasons(cand, PROFILE);
  assert.match(reasons[0], /Sci-Fi/);
});

test('generateReasons falls back to generic when nothing matches', () => {
  const cand = { id: 102, genre_ids: [99], popularity: 1, _seeds: [] };
  assert.deepEqual(generateReasons(cand, PROFILE), ['Picked for your taste']);
});

test('generateReasons: single person/keyword match is not labelled a genre', () => {
  // Candidate matches person 5 (Nolan) but none of its genres are in the profile.
  const cand = { id: 103, genre_ids: [99], popularity: 5,
    _seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 2 }] };
  const reasons = generateReasons(cand, PROFILE);
  assert.ok(!/genre/i.test(reasons[0]), `must not call a person a genre: ${reasons[0]}`);
  assert.match(reasons[0], /Nolan/);
});

test('rankCandidates drops already-watched and sorts by score', () => {
  const cands = [
    { id: 1, genre_ids: [878], popularity: 100, _seeds: [{ type: 'keyword', id: 9, name: 'tt', weight: 2 }] },
    { id: 100, genre_ids: [878], popularity: 100, _seeds: [{ type: 'keyword', id: 9, name: 'tt', weight: 2 }] },
    { id: 200, genre_ids: [28], popularity: 1, _seeds: [{ type: 'genre', id: 28, name: 'Action', weight: 1 }] },
  ];
  const recs = rankCandidates(cands, PROFILE, new Set([1]), 10);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].movie.id, 100);
  assert.ok(recs[0].score >= recs[1].score);
});

import { engagementBoost } from './recommendations.js';

test('engagementBoost: quick bail trends to minimum', () => {
  assert.equal(engagementBoost(0, 0), 0.4);            // opened, closed instantly
  assert.ok(engagementBoost(60000, 0) > 0.4 && engagementBoost(60000, 0) < 1.0); // 1 min
});

test('engagementBoost: long dwell trends to max', () => {
  assert.equal(engagementBoost(5400000, 0), 2.5);      // 90 min
  assert.ok(engagementBoost(2700000, 0) > 1.5 && engagementBoost(2700000, 0) < 2.5); // 45 min
});

test('engagementBoost: episode depth is a strong signal', () => {
  assert.equal(engagementBoost(0, 20), 2.5);           // 20 episodes saturates
  assert.ok(engagementBoost(0, 5) > 1.0);              // some episodes => above neutral
});

test('engagementBoost: monotonic non-decreasing in dwell past the bail point', () => {
  assert.ok(engagementBoost(3000000, 0) >= engagementBoost(2000000, 0));
});

test('buildTasteProfile applies engagement and star multipliers', () => {
  const base = { id: 1, media_type: 'movie', title: 'A', genre_ids: [878], vote_average: 8, watchedAt: NOW };
  const neutral = buildTasteProfile([{ ...base }], NOW).genres['878'];
  const bailed  = buildTasteProfile([{ ...base, _engagement: { dwellMs: 0, episodes: 0 } }], NOW).genres['878'];
  const engaged = buildTasteProfile([{ ...base, _engagement: { dwellMs: 5400000, episodes: 0 } }], NOW).genres['878'];
  assert.ok(bailed < neutral, 'a quick bail downweights below neutral');
  assert.ok(engaged > neutral, 'a long watch upweights above neutral');
});

test('buildTasteProfile: stars are decay-proof and boosted', () => {
  const old = { id: 2, media_type: 'movie', title: 'B', genre_ids: [28], vote_average: 8, watchedAt: NOW - 365 * DAY };
  const normal  = buildTasteProfile([{ ...old }], NOW).genres['28'];
  const starred = buildTasteProfile([{ ...old, _starred: true }], NOW).genres['28'];
  assert.ok(starred > normal * 5, 'starred old item vastly outweighs decayed normal');
});

test('buildTasteProfile: legacy items (no _engagement/_starred) unchanged', () => {
  const item = { id: 3, media_type: 'movie', title: 'C', genre_ids: [18], vote_average: 7, watchedAt: NOW };
  const w = buildTasteProfile([item], NOW).genres['18'];
  assert.ok(Math.abs(w - 1.1) < 1e-9);
});

test('scoreCandidate rewards aligning with more distinct watched titles', () => {
  const profile = {
    genres: { '878': 1 },
    keywords: {},
    people: {},
    mediaTypeBias: { movie: 5, tv: 0 },
    topTitles: [
      { id: 1, title: 'A', weight: 1, genreIds: [], keywordIds: [9], peopleIds: [] },
      { id: 2, title: 'B', weight: 1, genreIds: [], keywordIds: [12], peopleIds: [] },
      { id: 3, title: 'C', weight: 1, genreIds: [], keywordIds: [13], peopleIds: [] },
    ],
  };
  // Identical base score (same genres, popularity, total seed weight = 3);
  // they differ ONLY in collection breadth: broad spans 3 titles, narrow spans 1.
  const broad = { id: 100, genre_ids: [878], popularity: 10, _seeds: [
    { type: 'keyword', id: 9, name: 'a', weight: 1 },
    { type: 'keyword', id: 12, name: 'b', weight: 1 },
    { type: 'keyword', id: 13, name: 'c', weight: 1 },
  ] };
  const narrow = { id: 200, genre_ids: [878], popularity: 10, _seeds: [
    { type: 'keyword', id: 9, name: 'a', weight: 3 },
  ] };
  assert.ok(scoreCandidate(broad, profile) > scoreCandidate(narrow, profile),
    'breadth across the collection should break the tie at equal base score');
});

import { mergeSignalItems } from './recommendations.js';

test('mergeSignalItems unions watched + starred and annotates each', () => {
  const watched = [
    { id: 1, media_type: 'movie', title: 'A', genre_ids: [878], vote_average: 8, watchedAt: 111 },
    { id: 2, media_type: 'tv', name: 'B', genre_ids: [18], vote_average: 7, watchedAt: 222 },
  ];
  const starred = {
    2: { id: 2, media_type: 'tv', name: 'B', genre_ids: [18], vote_average: 7, starredAt: 9 },
    3: { id: 3, media_type: 'movie', title: 'C', genre_ids: [28], vote_average: 6, starredAt: 9 },
  };
  const engagement = { 1: { dwellMs: 5000, episodes: 0, opens: 1 } };
  const items = mergeSignalItems(watched, starred, engagement);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(items.length, 3);
  assert.equal(byId[1]._starred, false);
  assert.deepEqual(byId[1]._engagement, { dwellMs: 5000, episodes: 0, opens: 1 });
  assert.equal(byId[2]._starred, true);
  assert.equal(byId[3]._starred, true);
  assert.equal(byId[3]._engagement, null);
});

import { groupIntoRows } from './recommendations.js';

// Helper to build a ranked rec quickly.
function gr(id, { seeds = [], genres = [], score = 1 } = {}) {
  return { movie: { id, genre_ids: genres, _seeds: seeds }, score, reasons: ['r'] };
}

const GROUP_PROFILE = {
  genres: { '878': 5, '28': 3, '18': 1 },                 // 878=Sci-Fi, 28=Action, 18=Drama
  keywords: { '9': { name: 'time travel', weight: 2 } },
  people: { '5': { name: 'Nolan', weight: 4 }, '7': { name: 'Villeneuve', weight: 2 } },
  mediaTypeBias: { movie: 5, tv: 0 },
  topTitles: [
    { id: 1, title: 'Inception', weight: 3, genreIds: [878], keywordIds: [9], peopleIds: [5], media_type: 'movie' },
  ],
};

test('groupIntoRows: top picks row is first and capped', () => {
  const ranked = Array.from({ length: 30 }, (_, i) => gr(1000 + i, { genres: [878] }));
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { topCount: 20 });
  assert.equal(rows[0].kind, 'top');
  assert.equal(rows[0].title, 'Top picks for you');
  assert.equal(rows[0].recs.length, 20);
});

test('groupIntoRows: "Because you watched" groups by shared keyword/person seed', () => {
  const ranked = [
    gr(10, { seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] }),
    gr(11, { seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 4 }] }),
    gr(12, { seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] }),
    gr(13, { seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 4 }] }),
    gr(14, { seeds: [{ type: 'genre', id: 99, name: 'Doc', weight: 1 }] }), // unrelated
  ];
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { topCount: 0, minItems: 4 });
  const titleRow = rows.find((r) => r.kind === 'title');
  assert.equal(titleRow.title, 'Because you watched Inception');
  assert.equal(titleRow.recs.length, 4); // ids 10,11,12,13 — not the unrelated 14
});

test('groupIntoRows: drops rows with fewer than minItems', () => {
  const ranked = [
    gr(10, { seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] }),
    gr(11, { seeds: [{ type: 'keyword', id: 9, name: 'time travel', weight: 2 }] }),
  ]; // only 2 match the title — below minItems 4
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { topCount: 0, minItems: 4 });
  assert.equal(rows.find((r) => r.kind === 'title'), undefined);
});

test('groupIntoRows: genre row labelled from config and deduped against earlier rows', () => {
  // 4 sci-fi recs share the Nolan person seed (claimed by the title row first),
  // plus 4 fresh sci-fi recs with no person seed for the genre row.
  const ranked = [
    ...[20, 21, 22, 23].map((id) => gr(id, { genres: [878], seeds: [{ type: 'person', id: 5, name: 'Nolan', weight: 4 }] })),
    ...[30, 31, 32, 33].map((id) => gr(id, { genres: [878] })),
  ];
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { topCount: 0, minItems: 4 });
  const genreRow = rows.find((r) => r.kind === 'genre');
  assert.equal(genreRow.title, 'More Sci-Fi');
  // 20-23 were claimed by the "Because you watched" row; only 30-33 remain.
  assert.deepEqual(genreRow.recs.map((r) => r.movie.id), [30, 31, 32, 33]);
});

test('groupIntoRows: "More from <Person>" groups by person seed', () => {
  const ranked = [10, 11, 12, 13].map((id) =>
    gr(id, { seeds: [{ type: 'person', id: 7, name: 'Villeneuve', weight: 2 }] }));
  // No topTitles person 7 and no genre match, so these land in the person row.
  const profile = { ...GROUP_PROFILE, topTitles: [], genres: {} };
  const rows = groupIntoRows(ranked, profile, { topCount: 0, minItems: 4 });
  const personRow = rows.find((r) => r.kind === 'person');
  assert.equal(personRow.title, 'More from Villeneuve');
  assert.equal(personRow.recs.length, 4);
});

test('groupIntoRows: total rows never exceed maxRows', () => {
  const ranked = Array.from({ length: 40 }, (_, i) => gr(2000 + i, { genres: [878] }));
  const rows = groupIntoRows(ranked, GROUP_PROFILE, { maxRows: 2 });
  assert.ok(rows.length <= 2);
});
