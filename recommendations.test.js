import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recencyWeight, ratingNudge, buildTasteProfile } from './recommendations.js';
import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, extractSeedCandidates } from './recommendations.js';

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

test('combineProfiles: genres net (pos - penalty*neg), keep negatives so scoring can penalize', () => {
  const c = combineProfiles(POS, NEG, { penalty: 1 });
  assert.equal(c.genres['878'], 4);
  assert.equal(c.genres['18'], -1);
  assert.equal(c.genres['27'], -5);
});

test('combineProfiles: keywords/people net, drop anything <= 0 so disliked themes never seed', () => {
  const c = combineProfiles(POS, NEG, { penalty: 1 });
  assert.equal(c.keywords['9'].weight, 2);
  assert.equal(c.keywords['7'].weight, 1);
  assert.equal(c.keywords['99'], undefined);
  assert.equal(c.people['5'].weight, 1);
});

test('combineProfiles: penalty scales the negative side', () => {
  const c = combineProfiles(POS, NEG, { penalty: 0.5 });
  assert.equal(c.genres['18'], 0.5);
  assert.equal(c.people['5'].weight, 1.5);
});

test('combineProfiles: positive profile passes through topTitles and mediaTypeBias', () => {
  const c = combineProfiles(POS, NEG, { penalty: 1 });
  assert.equal(c.topTitles[0].id, 1);
  assert.deepEqual(c.mediaTypeBias, { movie: 5, tv: 0 });
});

test('combineProfiles: no negative profile is a pass-through of positives', () => {
  const c = combineProfiles(POS, null, { penalty: 1 });
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
