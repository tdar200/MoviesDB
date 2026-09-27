import test from 'node:test';
import assert from 'node:assert/strict';
import { sortTvTrackByRating } from './tv-ui.js';

test('endless-row rating sort restores the focused card after webOS blurs it', () => {
  const previousDocument = globalThis.document;
  const body = {};
  let focusOptions = null;
  const focused = {
    dataset: { rating: '5' },
    classList: { contains: name => name === 'tv-card' },
    isConnected: true,
    focus(options) { focusOptions = options; globalThis.document.activeElement = this; },
  };
  const higher = {
    dataset: { rating: '9' },
    classList: { contains: name => name === 'tv-card' },
    isConnected: true,
  };
  const cards = [focused, higher];
  const track = {
    contains: card => cards.includes(card),
    querySelectorAll: () => cards.slice(),
    append(card) {
      cards.splice(cards.indexOf(card), 1);
      cards.push(card);
      globalThis.document.activeElement = body;
    },
  };

  globalThis.document = { activeElement: focused };
  try {
    sortTvTrackByRating(track);
    assert.deepEqual(cards, [higher, focused]);
    assert.equal(globalThis.document.activeElement, focused);
    assert.deepEqual(focusOptions, { preventScroll: true });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
