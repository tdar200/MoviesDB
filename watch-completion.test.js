import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./script.js', import.meta.url), 'utf8');

test('finishing playback commits watched status and refreshes recommendations immediately', () => {
  const ended = source.match(/playerVideo\.addEventListener\('ended',[\s\S]*?\n\}\);/);
  assert.ok(ended, 'ended handler exists');
  assert.match(ended[0], /flushDwell\(\{ forceWatched: true \}\)/);
  assert.match(ended[0], /onSignalChanged\(\)/);
});

test('closing after meaningful viewing refreshes the mounted recommendation surface', () => {
  const close = source.match(/function closePlayer\(\) \{[\s\S]*?\n\}/);
  assert.ok(close, 'closePlayer exists');
  assert.match(close[0], /const recommendationsChanged = flushDwell\(\)/);
  assert.match(close[0], /if \(recommendationsChanged\) onSignalChanged\(\)/);
});

test('pagehide cannot be mistaken for forced completion', () => {
  assert.match(source, /const forceWatched = options\.forceWatched === true/);
  assert.match(source, /window\.addEventListener\('pagehide', flushDwell\)/);
});
