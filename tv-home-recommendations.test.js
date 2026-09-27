import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./script.js', import.meta.url), 'utf8');
const start = source.indexOf('// Recommended row: use the same aggregate taste engine');
const end = source.indexOf('const defs = catalogRowDefs', start);
const homeRecommendationBlock = source.slice(start, end);
const imdbStart = source.indexOf('// Surface the complete IMDb and Emmy collections directly on All');
const imdbEnd = source.indexOf('// Append one endless row', imdbStart);
const imdbHomeBlock = source.slice(imdbStart, imdbEnd);

test('TV home recommendations use the full signal set, not only the latest watched title', () => {
  assert.ok(start >= 0 && end > start, 'TV home recommendation block is present');
  assert.match(homeRecommendationBlock,
    /getRecommendations\(buildSignalItems\(\), \{ limit:/,
    'the home rail invokes the aggregate recommendation pipeline');
  assert.doesNotMatch(homeRecommendationBlock, /recSeed|\/recommendations\?/,
    'the latest-title TMDB shortcut cannot regress');
});

test('TV home recommendation rail targets 120 cards (10x the standard 12-card row)', () => {
  assert.match(source, /const TV_HOME_RECOMMENDATION_LIMIT = TV_HOME_CARD_LIMIT \* 10;/);
  assert.match(homeRecommendationBlock,
    /getRecommendations\(buildSignalItems\(\), \{ limit: TV_HOME_RECOMMENDATION_LIMIT \* 2 \}/,
    'the pipeline requests enough candidates before media-kind filtering');
  assert.match(homeRecommendationBlock, /\.slice\(0, TV_HOME_RECOMMENDATION_LIMIT\)/,
    'the rendered recommendation rail is capped at 120, not 12');
});

test('All renders the complete IMDb and Emmy rails without cross-row dedupe', () => {
  assert.ok(imdbStart >= 0 && imdbEnd > imdbStart, 'IMDb All-screen block is present');
  assert.match(imdbHomeBlock, /Math\.max\(IMDB_TOP_250\.length, EMMY_WINNERS\.length\)/,
    'the static rails receive their complete collections');
  assert.match(imdbHomeBlock, /appendTvRow\(main, row, onSelect\)/,
    'the complete collection is rendered');
  assert.doesNotMatch(imdbHomeBlock, /dedupeItems|\.slice\(/,
    'watched titles and ranks are not removed from the IMDb collection');
});

test('TV signal changes rebuild the TV home instead of mounting desktop recommendation UI', () => {
  const start = source.indexOf('function onSignalChanged()');
  const end = source.indexOf('// Render the full themed Recommendation page', start);
  const block = source.slice(start, end);
  assert.match(block, /if \(TV_MODE && tvHomeIsCurrent\(\)\)/);
  assert.match(block, /renderTvHome\(lastTrendingSeed\)/);
  assert.match(block, /return;/);
});
