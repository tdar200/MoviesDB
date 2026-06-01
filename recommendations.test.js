import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recencyWeight, ratingNudge, buildTasteProfile } from './recommendations.js';
import { mergeCandidates, scoreCandidate, generateReasons, rankCandidates, extractSeedCandidates } from './recommendations.js';
import {
  bayesianRating, qualityMultiplier, recencyMultiplier,
  buildTagVector, profileVector, computeIdf, applyIdf, cosineSim,
  collabScore, scorePool,
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
