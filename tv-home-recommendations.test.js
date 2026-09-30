import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./script.js', import.meta.url), 'utf8');
const start = source.indexOf('// Recommended row: use the same aggregate taste engine');
const end = source.indexOf('const defs = catalogRowDefs', start);
const homeRecommendationBlock = source.slice(start, end);
const imdbStart = source.indexOf('// Surface the complete IMDb and Emmy collections directly on All');
const imdbEnd = source.indexOf('// Recommended row:', imdbStart);
const imdbHomeBlock = source.slice(imdbStart, imdbEnd);

test('TV home recommendations use the full signal set, not only the latest watched title', () => {
  assert.ok(start >= 0 && end > start, 'TV home recommendation block is present');
  assert.match(homeRecommendationBlock, /const signals = buildSignalItems\(\);/,
    'the home rail reads the full signal set');
  assert.match(homeRecommendationBlock,
    /getRecommendations\(signals, \{ limit:/,
    'the home rail invokes the aggregate recommendation pipeline');
  assert.doesNotMatch(homeRecommendationBlock, /recSeed|\/recommendations\?/,
    'the latest-title TMDB shortcut cannot regress');
});

test('TV home recommendation rail targets 120 cards (10x the standard 12-card row)', () => {
  assert.match(source, /const TV_HOME_RECOMMENDATION_LIMIT = TV_HOME_CARD_LIMIT \* 10;/);
  assert.match(homeRecommendationBlock,
    /getRecommendations\(signals, \{ limit: TV_HOME_RECOMMENDATION_LIMIT \* 2 \}/,
    'the pipeline requests enough candidates before media-kind filtering');
  assert.match(homeRecommendationBlock, /\.slice\(0, TV_HOME_RECOMMENDATION_LIMIT\)/,
    'the rendered recommendation rail is capped at 120, not 12');
});

test('All renders the complete IMDb and Emmy rails without cross-row dedupe', () => {
  assert.ok(imdbStart >= 0 && imdbEnd > imdbStart, 'IMDb All-screen block is present');
  assert.match(imdbHomeBlock, /Math\.max\(IMDB_TOP_250\.length, EMMY_WINNERS\.length\)/,
    'the static rails receive their complete collections');
  assert.match(imdbHomeBlock, /appendTvRow\(holder, row, onSelect\)/,
    'the complete collection is rendered');
  // They sit BELOW the top category rows (a first row of all-time classics read as "new
  // releases" full of Shawshank), placed right after the weighted-rating row.
  assert.match(source, /if \(def\.key === 'weighted_top'\) staticSections\.splice\(0\)\.forEach\(section => main\.append\(section\)\);/,
    'the static rails are placed after the top category rows, not above Trending');
  assert.doesNotMatch(imdbHomeBlock, /dedupeItems|\.slice\(/,
    'watched titles and ranks are not removed from the IMDb collection');
});

test('a profile with no taste signal gets no unpersonalised Recommended row', () => {
  assert.match(homeRecommendationBlock,
    /const hasTasteSignal = signals\.basket\.length > 0 \|\| signals\.watched\.length > 0 \|\| signals\.seen\.length > 0;/,
    'the cold-start pool must not be labelled "for you" or swallow the catalogue rows');
});

test('TV signal changes patch Continue Watching / My List in place instead of repainting the home or mounting desktop recommendation UI', () => {
  const start = source.indexOf('function onSignalChanged()');
  const end = source.indexOf('function refreshTvPersonalRows()', start);
  const block = source.slice(start, end);
  assert.match(block, /if \(TV_MODE && tvHomeIsCurrent\(\)\)/);
  assert.match(block, /refreshTvPersonalRows\(\)/);
  assert.match(block, /return;/);
  // A full repaint threw away the rail positions, row windows and focus the viewer had.
  const tvBranch = block.slice(block.indexOf('if (TV_MODE && tvHomeIsCurrent())'), block.indexOf('return;'));
  assert.doesNotMatch(tvBranch, /renderTvHome/, 'the TV branch must not rebuild the whole home');
  const refresh = source.slice(end, source.indexOf('// Render the full themed Recommendation page', end));
  assert.match(refresh, /syncPersonalRows\(main, personal/);
  assert.doesNotMatch(refresh, /renderTvHome/);
});
