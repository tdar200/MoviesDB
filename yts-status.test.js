// yts-status.test.js — what the user is told when a YTS lookup fails.
//
// The bug this pins down: the app collapsed every failed /yts response to null and
// showed 'Could not reach the local stream helper. Run "npm start"' — even when the
// helper was running fine and had answered with a 502 because YTS's own API was
// unreachable (UK ISPs block the YTS domains). Telling someone to start a server
// they are already running sends them down the wrong path entirely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeYtsLookupFailure, describeImdbLookupFailure } from './yts-status.js';

test('a real network error means the helper itself is not there', () => {
  const msg = describeYtsLookupFailure({ networkError: true });
  assert.match(msg, /npm start/);
});

test('a remote helper base names that base instead of npm start', () => {
  const msg = describeYtsLookupFailure({ networkError: true, remoteBase: 'https://helper.example' });
  assert.match(msg, /helper\.example/);
  assert.doesNotMatch(msg, /npm start/);
});

test('a 5xx from the helper must NOT tell the user to run npm start', () => {
  const msg = describeYtsLookupFailure({ status: 502 });
  assert.doesNotMatch(msg, /npm start/i, 'the helper answered, so it is plainly running');
  assert.match(msg, /YTS/, 'should name YTS as the thing that failed');
});

test('a 5xx mentions ISP blocking, the actual cause on UK connections', () => {
  assert.match(describeYtsLookupFailure({ status: 502 }), /block/i);
});

test('other non-OK statuses still produce a non-empty message', () => {
  for (const status of [400, 404, 418]) {
    const msg = describeYtsLookupFailure({ status });
    assert.ok(msg && msg.length > 10, `status ${status} produced: ${msg}`);
    assert.doesNotMatch(msg, /undefined|NaN/);
  }
});

test('every branch returns a plain string', () => {
  for (const args of [{ networkError: true }, { status: 502 }, { status: 404 }, {}]) {
    assert.equal(typeof describeYtsLookupFailure(args), 'string');
  }
});

// ---- TMDB -> IMDb id resolution ----
//
// YTS is indexed by IMDb id, so the app must first ask TMDB for one. That request
// failing (a 429 storm, a dropped connection) is transient and retryable; a title
// genuinely having no IMDb id is permanent. Both used to say "No IMDb id for this
// title - YTS unavailable", which reads as "this movie isn't on YTS" and sends the
// user looking for a torrent that is in fact sitting right there.

test('a failed TMDB request does not claim the title lacks an IMDb id', () => {
  const msg = describeImdbLookupFailure({ requestFailed: true });
  assert.doesNotMatch(msg, /no imdb id/i, 'we never learned whether it has one');
  assert.match(msg, /again|retry|moment/i, 'should read as transient');
});

test('a title that really has no IMDb id says so plainly', () => {
  const msg = describeImdbLookupFailure({ requestFailed: false });
  assert.match(msg, /IMDb/);
  assert.doesNotMatch(msg, /again|retry/i, 'nothing to retry - this one is permanent');
});

test('the two IMDb outcomes never produce the same message', () => {
  assert.notEqual(
    describeImdbLookupFailure({ requestFailed: true }),
    describeImdbLookupFailure({ requestFailed: false })
  );
});
