import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recencyWeight, ratingNudge, buildTasteProfile } from './recommendations.js';
import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, extractSeedCandidates, splitGenreKeywordIds, buildDiscoverRequests } from './recommendations.js';
import {
  bayesianRating, qualityMultiplier, recencyMultiplier,
  buildTagVector, profileVector, computeIdf, applyIdf, cosineSim,
  collabScore, scorePool, DOWNVOTE_SCORE_FLOOR,
} from './recommendations.js';

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

test('bayesianRating shrinks a 2-vote 10.0 below a 5000-vote 8.0', () => {
  const hype = bayesianRating(10.0, 2);       // m=500, C=6.5 defaults
  const classic = bayesianRating(8.0, 5000);
  // 2-vote 10.0 is dragged toward 6.5; 5000-vote 8.0 barely moves.
  assert.ok(hype < classic, `expected shrunk hype(${hype}) < classic(${classic})`);
  assert.ok(hype > 6.5 && hype < 6.6, `2-vote 10.0 should sit just above C: ${hype}`);
  assert.ok(classic > 7.8 && classic <= 8.0, `5000-vote 8.0 should stay near R: ${classic}`);
});

test('bayesianRating with zero votes equals the global mean C', () => {
  assert.equal(bayesianRating(9.0, 0), 6.5);
  assert.equal(bayesianRating(0, 0), 6.5);
});

test('bayesianRating respects injected m and C', () => {
  // m=0 => no shrinkage => returns R exactly (v/(v+0)=1).
  assert.equal(bayesianRating(7.3, 100, 0, 6.5), 7.3);
  // v==m => exactly halfway between R and C.
  assert.equal(bayesianRating(8.0, 10, 10, 6.0), 7.0);
});

test('qualityMultiplier maps rating into ~[0.6,1.1] and is monotonic', () => {
  const great = qualityMultiplier(8.0, 5000);
  const meh = qualityMultiplier(4.0, 5000);
  assert.ok(great > meh, `great(${great}) must beat meh(${meh})`);
  assert.ok(great > 0.6 && great <= 1.1, `in range: ${great}`);
  assert.ok(meh >= 0.6 && meh < 1.0, `in range: ${meh}`);
  // A perfect, heavily-voted title approaches the 1.1 ceiling.
  assert.ok(qualityMultiplier(10, 100000) > 1.05);
  // A zero-vote title shrinks fully to C => 0.6 + 0.5*0.65 = 0.925.
  assert.ok(Math.abs(qualityMultiplier(10, 0) - 0.925) < 1e-9);
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

test('generateReasons: rec/similar seed yields "Because you liked <seedTitle>"', () => {
  const cand = {
    genre_ids: [878],
    _seeds: [
      { source: 'rec', type: 'title', id: 1, seedId: 1, seedTitle: 'Inception', rank: 0, weight: 1 },
    ],
  };
  const reasons = generateReasons(cand, PROFILE);
  assert.equal(reasons[0], 'Because you liked Inception');
});

test('generateReasons: collaborative seed leads and dominant title still appends', () => {
  // Has a collaborative similar seed for "Interstellar" AND a person seed (5=Nolan)
  // shared by topTitle Inception -> the "esp. Inception" line still appends.
  const cand = {
    genre_ids: [878],
    _seeds: [
      { source: 'similar', type: 'title', id: 1, seedId: 1, seedTitle: 'Interstellar', rank: 2, weight: 1 },
      { source: 'discover-person', type: 'person', id: 5, name: 'Nolan', weight: 2 },
    ],
  };
  const reasons = generateReasons(cand, PROFILE);
  assert.equal(reasons[0], 'Because you liked Interstellar');
  assert.equal(reasons[1], 'esp. Inception');
});

test('rankCandidates drops already-watched and sorts by score', () => {
  const cands = [
    { id: 1, genre_ids: [878], popularity: 100, vote_average: 8, vote_count: 1000,
      _seeds: [{ source: 'rec', type: 'title', id: 9, seedId: 9, rank: 0, weight: 2 }] },
    { id: 100, genre_ids: [878], popularity: 100, vote_average: 8, vote_count: 1000,
      _seeds: [{ source: 'rec', type: 'title', id: 9, seedId: 9, rank: 0, weight: 2 }] },
    { id: 200, genre_ids: [28], popularity: 1, vote_average: 6, vote_count: 50,
      _seeds: [{ source: 'discover-genre', type: 'genre', id: 28, name: 'Action', rank: 0, weight: 1 }] },
  ];
  const recs = rankCandidates(cands, PROFILE, new Set([1]), 10, NOW);
  assert.equal(recs.length, 2);                          // watched id 1 excluded
  assert.ok(!recs.some((r) => r.movie.id === 1));        // never resurfaces
  assert.ok(recs.every((r) => r.parts && typeof r.score === 'number')); // scorePool shape
  for (let i = 1; i < recs.length; i += 1) {
    assert.ok(recs[i - 1].score >= recs[i].score, 'scores non-increasing');
  }
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


import { groupIntoRows, combineProfiles } from './recommendations.js';

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

const POS = {
  genres: { '878': 4, '18': 2 },
  keywords: { '9': { name: 'time travel', weight: 3 }, '7': { name: 'space', weight: 1 } },
  people: { '5': { name: 'Nolan', weight: 2 } },
  mediaTypeBias: { movie: 5, tv: 0 },
  topTitles: [{ id: 1, title: 'Inception', weight: 3, genreIds: [878], keywordIds: [9], peopleIds: [5], media_type: 'movie' }],
};
const NEG = {
  genres: { '18': 3, '27': 5 },
  keywords: { '9': { name: 'time travel', weight: 1 }, '99': { name: 'gore', weight: 4 } },
  people: { '5': { name: 'Nolan', weight: 1 } },
  mediaTypeBias: { movie: 1, tv: 0 },
  topTitles: [],
};

test('combineProfiles ROCCHIO: genres net (pos - gamma*neg), keep negatives so scoring can penalize', () => {
  const c = combineProfiles(POS, NEG, { gamma: 1 });
  assert.equal(c.genres['878'], 4);   // 4 - 1*0 (not in NEG)
  assert.equal(c.genres['18'], -1);   // 2 - 1*3
  assert.equal(c.genres['27'], -5);   // 0 - 1*5
});

test('combineProfiles ROCCHIO: keywords/people net, drop anything <= 0 so disliked themes never seed', () => {
  const c = combineProfiles(POS, NEG, { gamma: 1 });
  assert.equal(c.keywords['9'].weight, 2);   // 3 - 1*1
  assert.equal(c.keywords['7'].weight, 1);   // 1 - 1*0
  assert.equal(c.keywords['99'], undefined); // 0 - 1*4 <= 0, dropped
  assert.equal(c.people['5'].weight, 1);     // 2 - 1*1
});

test('combineProfiles ROCCHIO: gamma scales the negative side', () => {
  const c = combineProfiles(POS, NEG, { gamma: 0.5 });
  assert.equal(c.genres['18'], 0.5);         // 2 - 0.5*3
  assert.equal(c.people['5'].weight, 1.5);   // 2 - 0.5*1
});

test('combineProfiles ROCCHIO: default gamma is DOWNVOTE_GAMMA=0.15 and does NOT erase a strongly-basketed theme', () => {
  // One downvote shares keyword 9 (time travel) and genre 18 with a strong basket.
  // Old penalty=1.0 behavior: kw9 = 3-1 = 2 (still alive), genre18 = 2-3 = -1 (negative).
  // New default gamma=0.15: the theme stays clearly positive (soft steer, not erase).
  const c = combineProfiles(POS, NEG);
  assert.ok(c.keywords['9'], 'shared keyword must NOT be erased by one downvote');
  assert.ok(Math.abs(c.keywords['9'].weight - (3 - 0.15 * 1)) < 1e-9); // 2.85
  assert.ok(c.genres['18'] > 0, 'shared genre stays positive under soft Rocchio');
  assert.ok(Math.abs(c.genres['18'] - (2 - 0.15 * 3)) < 1e-9);          // 1.55
  // A purely-disliked genre still goes net-negative so scoring can steer away.
  assert.ok(Math.abs(c.genres['27'] - (0 - 0.15 * 5)) < 1e-9);          // -0.75
});

test('combineProfiles ROCCHIO: positive profile passes through topTitles and mediaTypeBias', () => {
  const c = combineProfiles(POS, NEG, { gamma: 1 });
  assert.equal(c.topTitles[0].id, 1);
  assert.deepEqual(c.mediaTypeBias, { movie: 5, tv: 0 });
});

test('combineProfiles ROCCHIO: no negative profile is a pass-through of positives', () => {
  const c = combineProfiles(POS, null, { gamma: 1 });
  assert.equal(c.genres['878'], 4);
  assert.equal(c.keywords['9'].weight, 3);
  assert.equal(c.people['5'].weight, 2);
});

test('scoreCandidate: a candidate in a net-negative genre scores below a neutral one', () => {
  const netProfile = {
    genres: { '878': 4, '27': -5 },                 // like Sci-Fi, dislike Horror
    keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const sciFi = { id: 10, genre_ids: [878], _seeds: [], popularity: 10 };
  const horror = { id: 11, genre_ids: [878, 27], _seeds: [], popularity: 10 };
  assert.ok(scoreCandidate(sciFi, netProfile) > scoreCandidate(horror, netProfile),
    'horror-tagged candidate must score lower due to the negative genre');
});

import { genreHistogram } from './recommendations.js';

test('genreHistogram: each item splits its genres to sum 1, averaged & normalized', () => {
  // Item A: two genres -> 0.5 each. Item B: one genre -> 1.0.
  const items = [
    { id: 1, genre_ids: [878, 28] },
    { id: 2, genre_ids: [878] },
  ];
  const h = genreHistogram(items);
  // Raw per-item contributions: 878 -> 0.5 + 1.0 = 1.5 ; 28 -> 0.5 + 0 = 0.5.
  // Averaged over 2 items: 878 -> 0.75 ; 28 -> 0.25. Already sums to 1.
  assert.ok(Math.abs(h['878'] - 0.75) < 1e-9, `878=${h['878']}`);
  assert.ok(Math.abs(h['28'] - 0.25) < 1e-9, `28=${h['28']}`);
  const total = Object.values(h).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `sum=${total}`);
});

test('genreHistogram: keys are String genre ids; empty/genreless input -> {}', () => {
  assert.deepEqual(genreHistogram([]), {});
  assert.deepEqual(genreHistogram([{ id: 9, genre_ids: [] }]), {});
  const h = genreHistogram([{ id: 1, genre_ids: [18] }]);
  assert.deepEqual(Object.keys(h), ['18']);
  assert.equal(h['18'], 1);
});

import { calibrate } from './recommendations.js';

// Scored helper mirroring scorePool output: { movie, score, parts, reasons }.
// Named `csc` (not `sc`) to avoid a module-scope collision with the pre-existing
// `sc(id, score, {...})` helper added by an earlier item in this overhaul.
function csc(id, genres, score) {
  return { movie: { id, genre_ids: genres, _seeds: [] }, score, parts: {}, reasons: ['r'] };
}

test('calibrate: greedy KL selection tracks the target genre mix', () => {
  // Target wants a 50/50 Sci-Fi(878)/Drama(18) mix. Pool is relevance-sorted but
  // Sci-Fi-heavy at the top; calibration must pull a Drama title up into the top 2.
  const target = { '878': 0.5, '18': 0.5 };
  const pool = [
    csc(1, [878], 0.99),
    csc(2, [878], 0.98),
    csc(3, [18], 0.50),
    csc(4, [878], 0.40),
  ];
  const out = calibrate(pool, target, { lambda: 0.5, limit: 2 });
  const ids = out.map((s) => s.movie.id);
  assert.equal(out.length, 2);
  assert.ok(ids.includes(3), `expected the Drama title pulled in, got ${ids}`);
});

test('calibrate: lambda=0 (pure relevance) keeps the top-scored prefix', () => {
  // lambda is the KL weight; lambda=0 => objective is pure relevance.
  const target = { '878': 0.5, '18': 0.5 };
  const pool = [csc(1, [878], 0.9), csc(2, [878], 0.8), csc(3, [18], 0.1)];
  const out = calibrate(pool, target, { lambda: 0, limit: 2 });
  assert.deepEqual(out.map((s) => s.movie.id), [1, 2]);
});

test('calibrate: returns the whole pool (re-ordered) when limit >= pool size', () => {
  const target = { '878': 1 };
  const pool = [csc(1, [878], 0.9), csc(2, [878], 0.8)];
  const out = calibrate(pool, target, { limit: 10 });
  assert.equal(out.length, 2);
  assert.deepEqual([...out.map((s) => s.movie.id)].sort(), [1, 2]);
});

// --- Stage 1: per-seed collaborative candidate extraction ---

const SEED_ITEM = { id: 27205, title: 'Inception', media_type: 'movie' };

// A trimmed but shape-faithful /movie/27205?append_to_response=recommendations,similar response.
const APPEND_JSON = {
  id: 27205,
  title: 'Inception',
  recommendations: {
    results: [
      // a movie rec
      { id: 155, title: 'The Dark Knight', media_type: 'movie', genre_ids: [18, 28, 80],
        vote_average: 8.5, vote_count: 30000, popularity: 120.5, release_date: '2008-07-16' },
      // a tv rec (mixed media: media_type comes straight from the response)
      { id: 1399, name: 'Game of Thrones', media_type: 'tv', genre_ids: [10765, 18],
        vote_average: 8.4, vote_count: 21000, popularity: 350.0, first_air_date: '2011-04-17' },
    ],
  },
  similar: {
    results: [
      { id: 49026, title: 'The Dark Knight Rises', media_type: 'movie', genre_ids: [28, 80, 18],
        vote_average: 7.8, vote_count: 19000, popularity: 80.0, release_date: '2012-07-16' },
    ],
  },
};

test('extractSeedCandidates tags rec candidates with source:rec and REC_SOURCE_WEIGHT', () => {
  const out = extractSeedCandidates(SEED_ITEM, APPEND_JSON);
  const dk = out.find((c) => c.id === 155);
  assert.equal(dk.media_type, 'movie');
  assert.equal(dk.vote_average, 8.5);
  assert.equal(dk.vote_count, 30000);
  assert.equal(dk.popularity, 120.5);
  assert.deepEqual(dk.genre_ids, [18, 28, 80]);
  assert.equal(dk.release_date, '2008-07-16');
  assert.equal(dk._seeds.length, 1);
  const tag = dk._seeds[0];
  assert.equal(tag.source, 'rec');
  assert.equal(tag.type, 'title');
  assert.equal(tag.id, 27205);          // facet id == producing seed title id for rec/similar
  assert.equal(tag.seedId, 27205);
  assert.equal(tag.seedTitle, 'Inception');
  assert.equal(tag.rank, 0);            // 0-based position in the rec list
  assert.equal(tag.weight, 1.0);        // REC_SOURCE_WEIGHT
});

test('extractSeedCandidates preserves a tv candidate real media_type and rank', () => {
  const out = extractSeedCandidates(SEED_ITEM, APPEND_JSON);
  const got = out.find((c) => c.id === 1399);
  assert.equal(got.media_type, 'tv');
  assert.equal(got.name, 'Game of Thrones');
  assert.equal(got.first_air_date, '2011-04-17');
  assert.equal(got._seeds[0].source, 'rec');
  assert.equal(got._seeds[0].rank, 1); // second in the rec list
});

test('extractSeedCandidates tags similar candidates source:similar weighted below rec', () => {
  const out = extractSeedCandidates(SEED_ITEM, APPEND_JSON);
  const sim = out.find((c) => c.id === 49026);
  assert.equal(sim.media_type, 'movie');
  const tag = sim._seeds[0];
  assert.equal(tag.source, 'similar');
  assert.equal(tag.type, 'title');
  assert.equal(tag.seedId, 27205);
  assert.equal(tag.seedTitle, 'Inception');
  assert.equal(tag.rank, 0);            // 0-based within the similar list
  assert.equal(tag.weight, 0.5);        // SIMILAR_SOURCE_WEIGHT
  assert.ok(tag.weight < out.find((c) => c.id === 155)._seeds[0].weight);
});

test('extractSeedCandidates uses seed media_type when a candidate omits it', () => {
  const tvSeed = { id: 1396, name: 'Breaking Bad', media_type: 'tv' };
  const json = { id: 1396, recommendations: { results: [
    { id: 60059, name: 'Better Call Saul', genre_ids: [18], vote_average: 8.5, vote_count: 5000, popularity: 90 },
  ] }, similar: { results: [] } };
  const out = extractSeedCandidates(tvSeed, json);
  assert.equal(out[0].media_type, 'tv'); // inherited from the tv seed
});

test('extractSeedCandidates returns [] for an empty / fieldless append payload', () => {
  assert.deepEqual(extractSeedCandidates(SEED_ITEM, { id: 27205 }), []);
  assert.deepEqual(extractSeedCandidates(SEED_ITEM, { id: 27205, recommendations: { results: [] }, similar: { results: [] } }), []);
});

test('mergeCandidates accumulates rec+similar title SeedTags from different seeds', () => {
  const merged = mergeCandidates([
    { id: 155, media_type: 'movie', genre_ids: [18, 28, 80],
      _seeds: [{ source: 'rec', type: 'title', id: 27205, seedId: 27205, seedTitle: 'Inception', rank: 0, weight: 1.0 }] },
    { id: 155, media_type: 'movie', genre_ids: [18, 28, 80],
      _seeds: [{ source: 'similar', type: 'title', id: 49051, seedId: 49051, seedTitle: 'The Hobbit', rank: 2, weight: 0.5 }] },
    { id: 1399, media_type: 'tv', genre_ids: [10765, 18],
      _seeds: [{ source: 'rec', type: 'title', id: 27205, seedId: 27205, seedTitle: 'Inception', rank: 1, weight: 1.0 }] },
  ]);
  assert.equal(merged.length, 2);
  const c155 = merged.find((c) => c.id === 155);
  assert.equal(c155.media_type, 'movie');
  assert.equal(c155._seeds.length, 2);
  assert.deepEqual(c155._seeds.map((s) => s.source).sort(), ['rec', 'similar']);
  assert.deepEqual(c155._seeds.map((s) => s.seedId).sort((a, b) => a - b), [27205, 49051]);
  const c1399 = merged.find((c) => c.id === 1399);
  assert.equal(c1399._seeds.length, 1);
  assert.equal(c1399._seeds[0].source, 'rec');
});

const YEAR_MS = 365 * DAY;

test('recencyMultiplier is full (1.0) within RECENCY_FULL_YEARS', () => {
  const brandNew = new Date(NOW).toISOString().slice(0, 10);                 // today
  const oneYearAgo = new Date(NOW - 1 * YEAR_MS).toISOString().slice(0, 10);
  assert.equal(recencyMultiplier(brandNew, NOW), 1);
  assert.equal(recencyMultiplier(oneYearAgo, NOW), 1);
});

test('recencyMultiplier floors very old titles at RECENCY_FLOOR', () => {
  const ancient = '1975-05-25';
  assert.equal(recencyMultiplier(ancient, NOW), 0.85);
});

test('recencyMultiplier decays monotonically between full and floor', () => {
  const fiveYears = new Date(NOW - 5 * YEAR_MS).toISOString().slice(0, 10);
  const fifteenYears = new Date(NOW - 15 * YEAR_MS).toISOString().slice(0, 10);
  const a = recencyMultiplier(fiveYears, NOW);
  const b = recencyMultiplier(fifteenYears, NOW);
  assert.ok(a > b, `closer title (${a}) should beat older (${b})`);
  assert.ok(a < 1 && a > 0.85, `5y is mid-band: ${a}`);
  assert.ok(b >= 0.85 && b < a, `15y nearer floor: ${b}`);
});

test('recencyMultiplier returns full multiplier for missing/unknown date', () => {
  assert.equal(recencyMultiplier(undefined, NOW), 1);
  assert.equal(recencyMultiplier('', NOW), 1);
});

test('buildTagVector emits g: keys for genres, k:/p: only when present', () => {
  const bare = buildTagVector({ id: 1, genre_ids: [878, 28] });
  assert.deepEqual(bare, { 'g:878': 1, 'g:28': 1 });
  // No _keywords/_people on a plain candidate => no k:/p: terms.
  assert.ok(!Object.keys(bare).some((t) => t.startsWith('k:') || t.startsWith('p:')));
});

test('buildTagVector includes keyword/person terms on enriched items', () => {
  const v = buildTagVector({
    id: 2, genre_ids: [878],
    _keywords: [{ id: 9, name: 'time travel' }],
    _people: [{ id: 5, name: 'Nolan' }],
  });
  assert.equal(v['g:878'], 1);
  assert.equal(v['k:9'], 1);
  assert.equal(v['p:5'], 1);
});

test('profileVector maps profile weights to g:/k:/p: term keys', () => {
  const v = profileVector(PROFILE); // PROFILE defined at ~L43 of this file
  assert.equal(v['g:878'], 3);
  assert.equal(v['g:28'], 1);
  assert.equal(v['k:9'], 2);
  assert.equal(v['p:5'], 2);
});

test('profileVector drops non-positive genre weights', () => {
  const netProfile = {
    genres: { '878': 4, '27': -5 }, keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const v = profileVector(netProfile);
  assert.equal(v['g:878'], 4);
  assert.ok(!('g:27' in v), 'disliked genre must not enter the content vector');
});

test('computeIdf: idf = log(N/(1+df)); rare terms outweigh common ones', () => {
  // 4 vectors. g:878 in all 4 (common), g:28 in 1 (rare).
  const vecs = [
    { 'g:878': 1, 'g:28': 1 },
    { 'g:878': 1 },
    { 'g:878': 1 },
    { 'g:878': 1 },
  ];
  const idf = computeIdf(vecs);
  assert.ok(Math.abs(idf['g:878'] - Math.log(4 / (1 + 4))) < 1e-9);
  assert.ok(Math.abs(idf['g:28'] - Math.log(4 / (1 + 1))) < 1e-9);
  assert.ok(idf['g:28'] > idf['g:878'], 'rarer term must carry more idf');
});

test('applyIdf scales each term weight by its idf', () => {
  const idf = { 'g:878': 2, 'k:9': 0.5 };
  const out = applyIdf({ 'g:878': 3, 'k:9': 4 }, idf);
  assert.equal(out['g:878'], 6);
  assert.equal(out['k:9'], 2);
});

test('applyIdf treats terms absent from the idf map as idf 0', () => {
  const out = applyIdf({ 'g:999': 5 }, {});
  assert.equal(out['g:999'], 0);
});

test('cosineSim of identical vectors is 1, orthogonal is 0', () => {
  const a = { 'g:878': 3, 'k:9': 1 };
  assert.ok(Math.abs(cosineSim(a, a) - 1) < 1e-12);
  assert.equal(cosineSim({ 'g:878': 1 }, { 'g:28': 1 }), 0);
});

test('cosineSim returns 0 when either vector is empty', () => {
  assert.equal(cosineSim({}, { 'g:1': 1 }), 0);
  assert.equal(cosineSim({ 'g:1': 1 }, {}), 0);
});

test('cosineSim partial overlap sits strictly between 0 and 1', () => {
  const s = cosineSim({ 'g:1': 1, 'g:2': 1 }, { 'g:1': 1, 'g:3': 1 });
  assert.ok(Math.abs(s - 0.5) < 1e-12, `one shared of two each => 0.5, got ${s}`);
});

test('collabScore sums rec/similar provenance weighted by source and rank', () => {
  const c = { id: 1, _seeds: [
    { source: 'rec', type: 'title', id: 10, rank: 0, weight: 1 },     // 1.0*1/(1+0)=1
    { source: 'similar', type: 'title', id: 11, rank: 1, weight: 1 }, // 0.5*1/(1+1)=0.25
  ] };
  assert.ok(Math.abs(collabScore(c) - 1.25) < 1e-9, `got ${collabScore(c)}`);
});

test('collabScore: rec outranks similar at the same rank and weight', () => {
  const rec = { id: 1, _seeds: [{ source: 'rec', type: 'title', id: 10, rank: 0, weight: 1 }] };
  const sim = { id: 2, _seeds: [{ source: 'similar', type: 'title', id: 10, rank: 0, weight: 1 }] };
  assert.ok(collabScore(rec) > collabScore(sim));
  assert.equal(collabScore(rec), 1.0);
  assert.equal(collabScore(sim), 0.5);
});

test('collabScore ignores non-collaborative (discover/trending) seeds', () => {
  const c = { id: 1, _seeds: [
    { source: 'discover-genre', type: 'genre', id: 28, rank: 0, weight: 5 },
    { source: 'trending', type: 'title', id: 99, rank: 0, weight: 5 },
  ] };
  assert.equal(collabScore(c), 0);
});

test('collabScore is 0 for a candidate with no seeds', () => {
  assert.equal(collabScore({ id: 1, _seeds: [] }), 0);
  assert.equal(collabScore({ id: 2 }), 0);
});

test('collabScore: more contributing seeds accumulate higher', () => {
  const one = { id: 1, _seeds: [{ source: 'rec', type: 'title', id: 10, rank: 0, weight: 1 }] };
  const two = { id: 2, _seeds: [
    { source: 'rec', type: 'title', id: 10, rank: 0, weight: 1 },
    { source: 'rec', type: 'title', id: 11, rank: 0, weight: 1 },
  ] };
  assert.ok(collabScore(two) > collabScore(one));
});

test('scorePool returns Scored items sorted desc with parts and reasons', () => {
  const profile = {
    genres: { '878': 3 }, keywords: { '9': { name: 'tt', weight: 2 } }, people: {},
    mediaTypeBias: { movie: 1, tv: 0 },
    topTitles: [{ id: 1, title: 'Inception', weight: 3, genreIds: [878], keywordIds: [9], peopleIds: [], media_type: 'movie' }],
  };
  const candidates = [
    { id: 100, title: 'Strong', media_type: 'movie', genre_ids: [878], vote_average: 8, vote_count: 5000,
      popularity: 50, release_date: new Date(NOW).toISOString().slice(0, 10),
      _keywords: [{ id: 9, name: 'tt' }], _seeds: [{ source: 'rec', type: 'title', id: 1, rank: 0, weight: 1 }] },
    { id: 200, title: 'Weak', media_type: 'movie', genre_ids: [12], vote_average: 5, vote_count: 10,
      popularity: 1, release_date: '1980-01-01', _seeds: [{ source: 'discover-genre', type: 'genre', id: 12, rank: 0, weight: 1 }] },
  ];
  const out = scorePool(candidates, { profile, now: NOW });
  assert.equal(out.length, 2);
  assert.equal(out[0].movie.id, 100, 'strong collaborative + content + quality wins');
  assert.ok(out[0].score >= out[1].score, 'sorted descending');
  for (const term of ['collab', 'content', 'quality', 'recency']) {
    assert.ok(typeof out[0].parts[term] === 'number', `parts.${term} present`);
  }
  assert.ok(Array.isArray(out[0].reasons) && out[0].reasons.length >= 1, 'reasons attached');
});

test('scorePool: a high-vote great title outranks a low-vote obscure one at equal collab', () => {
  const profile = {
    genres: { '878': 1 }, keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const rd = new Date(NOW).toISOString().slice(0, 10); // identical recency
  // Identical collab seed (same source/rank/weight) and identical genre vector;
  // they differ ONLY in quality (vote_average + vote_count).
  const great = { id: 100, media_type: 'movie', genre_ids: [878], vote_average: 8.2, vote_count: 8000,
    popularity: 10, release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 1, rank: 0, weight: 1 }] };
  const obscure = { id: 200, media_type: 'movie', genre_ids: [878], vote_average: 9.9, vote_count: 6,
    popularity: 10, release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 1, rank: 0, weight: 1 }] };
  const out = scorePool([great, obscure], { profile, now: NOW });
  assert.equal(out[0].movie.id, 100, 'shrunk obscure 9.9/6 must fall below the well-voted 8.2/8000');
});

test('scorePool normalizes collab via min-max across the pool', () => {
  const profile = { genres: {}, keywords: {}, people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [] };
  const rd = new Date(NOW).toISOString().slice(0, 10);
  const hi = { id: 1, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000, popularity: 5,
    release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 9, rank: 0, weight: 1 }] };       // collab 1.0
  const lo = { id: 2, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000, popularity: 5,
    release_date: rd, _seeds: [{ source: 'similar', type: 'title', id: 9, rank: 3, weight: 1 }] };    // collab 0.125
  const out = scorePool([hi, lo], { profile, now: NOW });
  const hiScored = out.find((o) => o.movie.id === 1);
  const loScored = out.find((o) => o.movie.id === 2);
  // Min-max over {1.0, 0.125} => hi.collab===1, lo.collab===0.
  assert.equal(hiScored.parts.collab, 1);
  assert.equal(loScored.parts.collab, 0);
});

test('scorePool: content cosine rewards profile overlap when collab ties at 0', () => {
  const profile = {
    genres: { '878': 5 }, keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const rd = new Date(NOW).toISOString().slice(0, 10);
  // Both discover-sourced => collab 0 for both; matchGenre overlaps the profile, offGenre does not.
  const matchGenre = { id: 1, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000,
    popularity: 5, release_date: rd, _seeds: [{ source: 'discover-genre', type: 'genre', id: 878, rank: 0, weight: 1 }] };
  const offGenre = { id: 2, media_type: 'movie', genre_ids: [99], vote_average: 7, vote_count: 1000,
    popularity: 5, release_date: rd, _seeds: [{ source: 'discover-genre', type: 'genre', id: 99, rank: 0, weight: 1 }] };
  const out = scorePool([matchGenre, offGenre], { profile, now: NOW });
  assert.equal(out[0].movie.id, 1, 'genre-matching candidate wins on content');
  assert.ok(out[0].parts.content > out.find((o) => o.movie.id === 2).parts.content);
});

test('scorePool honors injected weights (content-only ignores collab)', () => {
  const profile = { genres: { '878': 5 }, keywords: {}, people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [] };
  const rd = new Date(NOW).toISOString().slice(0, 10);
  // collabHi has strong collab but NO content overlap; contentHi has no collab but full content overlap.
  const collabHi = { id: 1, media_type: 'movie', genre_ids: [99], vote_average: 7, vote_count: 1000, popularity: 5,
    release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 9, rank: 0, weight: 1 }] };
  const contentHi = { id: 2, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000, popularity: 5,
    release_date: rd, _seeds: [{ source: 'discover-genre', type: 'genre', id: 878, rank: 0, weight: 1 }] };
  const out = scorePool([collabHi, contentHi], { profile, now: NOW, weights: { collab: 0, content: 1 } });
  assert.equal(out[0].movie.id, 2, 'with collab weight 0, content overlap must decide');
});

test('scorePool: absent dislikeVector is inert (no penalty applied)', () => {
  const profile = { genres: { '878': 5 }, keywords: {}, people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [] };
  const rd = new Date(NOW).toISOString().slice(0, 10);
  const c = { id: 1, media_type: 'movie', genre_ids: [878], vote_average: 7, vote_count: 1000, popularity: 5,
    release_date: rd, _seeds: [{ source: 'rec', type: 'title', id: 9, rank: 0, weight: 1 }] };
  const withOpt = scorePool([c], { profile, now: NOW, dislikeVector: undefined })[0].score;
  const without = scorePool([c], { profile, now: NOW })[0].score;
  assert.equal(withOpt, without, 'dislikeVector:undefined must not change the score');
});

test('scorePool: disliked-vector overlap lowers a strong positive but never zeros it', () => {
  const profile = {
    genres: { '878': 4, '28': 3 },
    keywords: { '9': { name: 'time travel', weight: 3 } },
    people: {}, mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  // Strong positive candidate: liked genres + keyword + a strong rec seed.
  const cand = {
    id: 50, media_type: 'movie', genre_ids: [878, 28], popularity: 100,
    vote_average: 8, vote_count: 1000,
    _keywords: [{ id: 9, name: 'time travel' }],
    _seeds: [{ source: 'rec', type: 'title', id: 1, rank: 0, weight: 3 }],
  };
  // Disliked vector overlaps both genres and the keyword on the candidate.
  const dislikeVector = { 'g:878': 5, 'g:28': 5, 'k:9': 5 };

  const base = scorePool([cand], { profile, now: NOW })[0].score;
  const penalized = scorePool([cand], { profile, now: NOW, dislikeVector })[0].score;

  assert.ok(penalized < base, 'overlap with the disliked vector must lower the score');
  assert.ok(penalized > base * DOWNVOTE_SCORE_FLOOR,
    `a strong positive must keep most of its score (> floor*base=${base * DOWNVOTE_SCORE_FLOOR}), got ${penalized}`);
  assert.ok(penalized > 0, 'penalty is bounded — never zeroes a strong positive');
});

test('scorePool: no disliked vector is a pass-through (back-compat)', () => {
  const profile = {
    genres: { '878': 4 }, keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const cand = { id: 51, media_type: 'movie', genre_ids: [878], popularity: 10, vote_average: 7, vote_count: 100, _seeds: [] };
  const plain = scorePool([cand], { profile, now: NOW })[0].score;
  assert.equal(scorePool([cand], { profile, now: NOW, dislikeVector: undefined })[0].score, plain);
  assert.equal(scorePool([cand], { profile, now: NOW, dislikeVector: null })[0].score, plain);
});

test('scorePool: a candidate NOT overlapping the disliked vector is unpenalized', () => {
  const profile = {
    genres: { '878': 4 }, keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const dislikeVector = { 'g:27': 5 }; // dislikes Horror only
  const cand = { id: 52, media_type: 'movie', genre_ids: [878], popularity: 10, vote_average: 7, vote_count: 100, _seeds: [] };
  assert.equal(
    scorePool([cand], { profile, now: NOW, dislikeVector })[0].score,
    scorePool([cand], { profile, now: NOW })[0].score
  );
});

test('scorePool: a genre in every candidate (negative idf) keeps content in [0,1] and preserves ranking', () => {
  // Drama(18) appears in ALL candidates => df=N => idf(g:18) < 0. SciFi(878) is rare.
  // The same idf weights profile and candidate, so the shared drama term contributes
  // profW*idf^2 (>=0): content must stay in [0,1] and the scifi-matching candidate must win.
  const profile = {
    genres: { '18': 2, '878': 2 }, keywords: {}, people: {},
    mediaTypeBias: { movie: 1, tv: 0 }, topTitles: [],
  };
  const rd = new Date(NOW).toISOString().slice(0, 10);
  const base = {
    media_type: 'movie', vote_average: 7, vote_count: 1000, popularity: 5, release_date: rd,
    _seeds: [{ source: 'rec', type: 'title', id: 9, rank: 0, weight: 1 }], // equal collab across the pool
  };
  const both = { ...base, id: 1, genre_ids: [18, 878] };
  const dramaOnlyA = { ...base, id: 2, genre_ids: [18] };
  const dramaOnlyB = { ...base, id: 3, genre_ids: [18] };
  const out = scorePool([both, dramaOnlyA, dramaOnlyB], { profile, now: NOW });
  for (const o of out) {
    assert.ok(o.parts.content >= 0 && o.parts.content <= 1, `content in [0,1], got ${o.parts.content}`);
  }
  assert.equal(out[0].movie.id, 1, 'rare-term match wins despite the ubiquitous genre having negative idf');
});

import { itemSim } from './recommendations.js';

test('itemSim: identical id short-circuits to 1', () => {
  const a = { id: 5, genre_ids: [878], _seeds: [{ source: 'rec', type: 'title', id: 1, seedId: 1, rank: 0, weight: 1 }] };
  const b = { id: 5, genre_ids: [28], _seeds: [{ source: 'rec', type: 'title', id: 2, seedId: 2, rank: 0, weight: 1 }] };
  assert.equal(itemSim(a, b), 1);
});

test('itemSim: 0.6*genreJaccard + 0.4*provenanceJaccard', () => {
  // genres: A={878,28}, B={878} => |∩|=1,|∪|=2 => 0.5
  // provenance seed-ids: A={11,22}, B={22} => |∩|=1,|∪|=2 => 0.5
  const a = { id: 1, genre_ids: [878, 28], _seeds: [
    { source: 'rec', type: 'title', id: 11, seedId: 11, rank: 0, weight: 1 },
    { source: 'similar', type: 'title', id: 22, seedId: 22, rank: 0, weight: 1 },
  ] };
  const b = { id: 2, genre_ids: [878], _seeds: [
    { source: 'rec', type: 'title', id: 22, seedId: 22, rank: 0, weight: 1 },
  ] };
  assert.ok(Math.abs(itemSim(a, b) - (0.6 * 0.5 + 0.4 * 0.5)) < 1e-9);
});

test('itemSim: disjoint genres and provenance => 0', () => {
  const a = { id: 1, genre_ids: [878], _seeds: [{ source: 'rec', type: 'title', id: 11, seedId: 11, rank: 0, weight: 1 }] };
  const b = { id: 2, genre_ids: [28], _seeds: [{ source: 'rec', type: 'title', id: 22, seedId: 22, rank: 0, weight: 1 }] };
  assert.equal(itemSim(a, b), 0);
});

test('itemSim: discover/trending provenance is ignored (only rec/similar count)', () => {
  // Two discover candidates share the same discover-genre facet id but have NO rec/similar
  // provenance => provenance Jaccard is empty∪empty=0; only genre overlap drives similarity.
  // genres: A={878}, B={878} => genreJ=1 => itemSim = 0.6*1 + 0.4*0 = 0.6.
  const a = { id: 1, genre_ids: [878], _seeds: [{ source: 'discover-genre', type: 'genre', id: 878, name: 'Sci-Fi', rank: 0, weight: 1 }] };
  const b = { id: 2, genre_ids: [878], _seeds: [{ source: 'discover-genre', type: 'genre', id: 878, name: 'Sci-Fi', rank: 1, weight: 1 }] };
  assert.ok(Math.abs(itemSim(a, b) - 0.6) < 1e-9);
});

test('itemSim: no genres and no provenance on either side => 0 (no NaN)', () => {
  const a = { id: 1, genre_ids: [], _seeds: [] };
  const b = { id: 2, genre_ids: [], _seeds: [] };
  assert.equal(itemSim(a, b), 0);
});

import { mmrRerank } from './recommendations.js';

// Intra-list diversity = mean pairwise (1 - itemSim) over the output list.
function ild(list, simFn) {
  const items = list.map((s) => s.movie);
  let sum = 0, pairs = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      sum += 1 - simFn(items[i], items[j]);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : sum / pairs;
}

function sc(id, score, { genres = [], seeds = [] } = {}) {
  return { movie: { id, genre_ids: genres, _seeds: seeds }, score, parts: {}, reasons: [] };
}

test('mmrRerank: near-duplicate high-score items collapse to one', () => {
  // Two near-dupes: identical genres + identical provenance => itemSim = 1 > NEAR_DUP_SIM.
  const seedsA = [{ source: 'rec', type: 'title', id: 1, seedId: 1, rank: 0, weight: 1 }];
  const scored = [
    sc(10, 1.0, { genres: [878, 28], seeds: seedsA }),
    sc(11, 0.99, { genres: [878, 28], seeds: seedsA }),   // near-dup of 10
    sc(20, 0.8, { genres: [18], seeds: [{ source: 'rec', type: 'title', id: 2, seedId: 2, rank: 0, weight: 1 }] }),
  ];
  const out = mmrRerank(scored, { lambda: 0.8, limit: 10, simFn: itemSim });
  const ids = out.map((r) => r.movie.id);
  assert.ok(ids.includes(10), 'best representative survives');
  assert.ok(!ids.includes(11), 'near-duplicate is collapsed away');
  assert.ok(ids.includes(20));
});

test('mmrRerank: no seedId exceeds PER_SEED_CAP in the output', () => {
  // 6 candidates all from seedId 7; cap is 3.
  const fromSeed7 = (id, score) => sc(id, score, {
    genres: [878], seeds: [{ source: 'rec', type: 'title', id: 7, seedId: 7, rank: 0, weight: 1 }],
  });
  const scored = [
    fromSeed7(1, 1.0), fromSeed7(2, 0.95), fromSeed7(3, 0.9),
    fromSeed7(4, 0.85), fromSeed7(5, 0.8), fromSeed7(6, 0.75),
  ];
  const out = mmrRerank(scored, { lambda: 0.8, perSeedCap: 3, limit: 10, simFn: itemSim });
  const fromSeed = out.filter((r) => (r.movie._seeds || []).some((s) => s.seedId === 7)).length;
  assert.ok(fromSeed <= 3, `expected <= PER_SEED_CAP from seed 7, got ${fromSeed}`);
});

test('mmrRerank: lambda=1 reproduces pure-relevance order', () => {
  // Distinct ids/genres so no near-dup collapse; only ordering is tested.
  const scored = [
    sc(1, 0.9, { genres: [1] }),
    sc(2, 0.7, { genres: [2] }),
    sc(3, 0.5, { genres: [3] }),
  ];
  const out = mmrRerank(scored, { lambda: 1, limit: 10, simFn: itemSim });
  assert.deepEqual(out.map((r) => r.movie.id), [1, 2, 3]);
});

test('mmrRerank: omitting or out-of-range lambda throws (never a silent empty result)', () => {
  const scored = [sc(1, 0.9, { genres: [1] })];
  assert.throws(() => mmrRerank(scored, { limit: 5, simFn: itemSim }), /lambda/);
  assert.throws(() => mmrRerank(scored, { lambda: 2, limit: 5, simFn: itemSim }), /lambda/);
  assert.throws(() => mmrRerank(scored, { lambda: NaN, limit: 5, simFn: itemSim }), /lambda/);
});

test('mmrRerank: discover candidates (no rec/similar seed) are uncapped', () => {
  // 6 discover-genre candidates with no rec/similar provenance: PER_SEED_CAP must NOT apply
  // to them (seedTitleIds empty), so all 6 survive (distinct genres => no near-dup collapse).
  const disc = (id, score, g) => sc(id, score, {
    genres: [g], seeds: [{ source: 'discover-genre', type: 'genre', id: 99, name: 'X', rank: 0, weight: 1 }],
  });
  const scored = [disc(1, 1.0, 1), disc(2, 0.9, 2), disc(3, 0.8, 3), disc(4, 0.7, 4), disc(5, 0.6, 5), disc(6, 0.5, 6)];
  const out = mmrRerank(scored, { lambda: 0.8, perSeedCap: 3, limit: 10, simFn: itemSim });
  assert.equal(out.length, 6, 'discover candidates are not seed-capped');
});

test('mmrRerank: lower lambda raises intra-list diversity', () => {
  // A cluster of three similar high-score sci-fi items + two distinct lower-score items.
  // High lambda keeps the similar cluster up top (low ILD); low lambda interleaves the
  // diverse items earlier (higher ILD). Distinct seedIds so the per-seed cap never bites.
  const sciSeed = (id, score) => sc(id, score, {
    genres: [878, 28], seeds: [{ source: 'rec', type: 'title', id: id, seedId: id, rank: 0, weight: 1 }],
  });
  const build = () => [
    sciSeed(1, 1.0), sciSeed(2, 0.95), sciSeed(3, 0.9),
    sc(4, 0.6, { genres: [18], seeds: [{ source: 'rec', type: 'title', id: 4, seedId: 4, rank: 0, weight: 1 }] }),
    sc(5, 0.55, { genres: [99], seeds: [{ source: 'rec', type: 'title', id: 5, seedId: 5, rank: 0, weight: 1 }] }),
  ];
  const hi = mmrRerank(build(), { lambda: 0.95, limit: 3, simFn: itemSim });
  const lo = mmrRerank(build(), { lambda: 0.3, limit: 3, simFn: itemSim });
  assert.ok(ild(lo, itemSim) > ild(hi, itemSim),
    `lower lambda should raise ILD: lo=${ild(lo, itemSim)} hi=${ild(hi, itemSim)}`);
});

test('splitGenreKeywordIds routes type:keyword config ids to keywords, real genres to genres', () => {
  // Dystopia 4565 and Time Travel 4379 are type:'keyword' in MOVIE_GENRES.
  // 878 (Sci-Fi) and 28 (Action) are real genre ids.
  const out = splitGenreKeywordIds([878, 4565, 28, 4379]);
  assert.deepEqual(out.genres, [878, 28]);
  assert.deepEqual(out.keywords, [4565, 4379]);
});

test('splitGenreKeywordIds: all-genre input yields empty keywords', () => {
  const out = splitGenreKeywordIds([878, 28, 18]);
  assert.deepEqual(out.genres, [878, 28, 18]);
  assert.deepEqual(out.keywords, []);
});

test('splitGenreKeywordIds: coerces string ids to Numbers and preserves order', () => {
  const out = splitGenreKeywordIds(['4379', '18']);
  assert.deepEqual(out.genres, [18]);
  assert.deepEqual(out.keywords, [4379]);
});

test('splitGenreKeywordIds: empty input yields empty buckets', () => {
  const out = splitGenreKeywordIds([]);
  assert.deepEqual(out.genres, []);
  assert.deepEqual(out.keywords, []);
});

const DISC_PROFILE = {
  genres: { '878': 3, '28': 2 },
  keywords: { '4379': { name: 'Time Travel', weight: 2 } }, // type:'keyword' config id
  people: { '5': { name: 'Nolan', weight: 2 } },
  mediaTypeBias: { movie: 5, tv: 1 },
  topTitles: [],
};
const NEG_PROFILE = {
  genres: { '27': 1 },                                   // Horror -> without_genres
  keywords: { '12377': { name: 'Zombie', weight: 1 } },  // Zombie -> without_keywords
  people: {},
  mediaTypeBias: { movie: 1, tv: 0 },
  topTitles: [],
};

test('buildDiscoverRequests runs for BOTH media types', () => {
  const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
  const movieReqs = reqs.filter((r) => r.url.includes('/discover/movie?'));
  const tvReqs = reqs.filter((r) => r.url.includes('/discover/tv?'));
  assert.ok(movieReqs.length > 0, 'expected movie discover requests');
  assert.ok(tvReqs.length > 0, 'expected tv discover requests');
});

test('buildDiscoverRequests paginates pages 1-2 by default', () => {
  const reqs = buildDiscoverRequests(DISC_PROFILE, null, {});
  assert.ok(reqs.some((r) => r.url.includes('page=1')), 'expected a page=1 request');
  assert.ok(reqs.some((r) => r.url.includes('page=2')), 'expected a page=2 request');
});

test('buildDiscoverRequests OR-combines top genres into one with_genres facet (pipe)', () => {
  const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
  const genreReq = reqs.find((r) => r.seed.type === 'genre' && r.url.includes('/discover/movie?'));
  assert.ok(genreReq, 'expected a genre discover request');
  // 878 and 28 OR-combined; tolerate raw or %7C-encoded pipe.
  assert.ok(
    genreReq.url.includes('with_genres=878%7C28') || genreReq.url.includes('with_genres=878|28'),
    `expected piped genres, got ${genreReq.url}`,
  );
});

test('buildDiscoverRequests routes type:keyword facet to with_keywords, never with_genres', () => {
  const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
  const kwReq = reqs.find((r) => r.seed.type === 'keyword' && r.seed.id === 4379);
  assert.ok(kwReq, 'expected a keyword discover request for 4379');
  assert.ok(kwReq.url.includes('with_keywords=4379'), `got ${kwReq.url}`);
  // Time Travel (4379) must NOT leak into any with_genres list.
  assert.ok(!reqs.some((r) => r.url.includes('with_genres') && r.url.includes('4379')),
    'keyword id 4379 leaked into with_genres');
});

test('buildDiscoverRequests seeds carry source:discover-* and the producing facet id', () => {
  const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
  const genreSeed = reqs.find((r) => r.seed.source === 'discover-genre').seed;
  const kwSeed = reqs.find((r) => r.seed.source === 'discover-keyword').seed;
  const personSeed = reqs.find((r) => r.seed.source === 'discover-person').seed;
  assert.equal(genreSeed.type, 'genre');
  assert.equal(kwSeed.type, 'keyword');
  assert.equal(kwSeed.id, 4379);
  assert.equal(personSeed.type, 'person');
  assert.equal(personSeed.id, 5);
});

test('buildDiscoverRequests applies CONFIG gates: vote_count.gte and date window', () => {
  const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
  // CONFIG.MIN_VOTE_COUNT = 10, CONFIG.MIN_YEAR = 1970, CONFIG.MIN_RATING = 0 (omitted).
  assert.ok(reqs.every((r) => r.url.includes('vote_count.gte=10')), 'all reqs gated by min votes');
  const movieReq = reqs.find((r) => r.url.includes('/discover/movie?'));
  const tvReq = reqs.find((r) => r.url.includes('/discover/tv?'));
  assert.ok(movieReq.url.includes('primary_release_date.gte=1970-01-01'), `got ${movieReq.url}`);
  assert.ok(tvReq.url.includes('first_air_date.gte=1970-01-01'), `got ${tvReq.url}`);
  // MIN_RATING is 0 -> no vote_average gate.
  assert.ok(reqs.every((r) => !r.url.includes('vote_average.gte')), 'no vote_average gate at MIN_RATING=0');
});

test('buildDiscoverRequests builds without_genres/without_keywords from the negative profile', () => {
  const reqs = buildDiscoverRequests(DISC_PROFILE, NEG_PROFILE, { pages: 1 });
  assert.ok(reqs.every((r) => r.url.includes('without_genres=27')),
    'expected Horror 27 in without_genres on every request');
  assert.ok(reqs.every((r) => r.url.includes('without_keywords=12377')),
    'expected Zombie 12377 in without_keywords on every request');
});

test('buildDiscoverRequests: a genre both liked (net-positive) and downvoted is never self-excluded', () => {
  // 878 is positively steered AND present in the negative profile -> must NOT land in without_genres
  // (a with_genres=878 & without_genres=878 query returns [] from TMDB — silent degradation).
  const neg = { genres: { '878': 2, '27': 1 }, keywords: {}, people: {} };
  const reqs = buildDiscoverRequests(DISC_PROFILE, neg, { pages: 1 });
  const genreReq = reqs.find((r) => r.seed.source === 'discover-genre');
  assert.ok(genreReq.url.includes('with_genres=878'), 'genre 878 is positively steered');
  assert.ok(!/without_genres=[^&]*878/.test(genreReq.url),
    `liked genre 878 must not be self-excluded: ${genreReq.url}`);
  assert.ok(/without_genres=[^&]*27/.test(genreReq.url), 'the disliked-only genre 27 is still excluded');
});

test('buildDiscoverRequests omits without_* when no negative profile', () => {
  const reqs = buildDiscoverRequests(DISC_PROFILE, null, { pages: 1 });
  assert.ok(reqs.every((r) => !r.url.includes('without_genres')), 'no without_genres without neg');
  assert.ok(reqs.every((r) => !r.url.includes('without_keywords')), 'no without_keywords without neg');
});
