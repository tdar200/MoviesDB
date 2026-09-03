// remote-helper.test.js — the torrent sources on the DEPLOYED site.
//
// Vercel / GitHub Pages cannot run stream-server.mjs (WebTorrent needs a long-lived
// process), so the deployed page talks to a helper on another origin, named by
// CONFIG.STREAM_HELPER_BASE (or ?helper= / localStorage per device). That makes
// every helper request cross-origin, which needs three things to hold:
//   1. an https base with no path and no trailing slash (the page is https, so an
//      http helper would be blocked as mixed content; helperUrl() concatenates);
//   2. the helper's JSON, stream and subtitle responses carry
//      Access-Control-Allow-Origin;
//   3. the <video> is in CORS mode (crossorigin="anonymous"), because browsers
//      silently drop a cross-origin subtitle <track> otherwise — found the hard
//      way: no error, captions just never appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONFIG } from './config.js';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('./stream-server.mjs', import.meta.url), 'utf8');

test('STREAM_HELPER_BASE is empty (same origin) or a bare https origin', () => {
  const base = CONFIG.STREAM_HELPER_BASE;
  assert.match(base, /^(|https:\/\/[A-Za-z0-9.-]+(:\d+)?)$/, `got ${JSON.stringify(base)} — needs https, no path, no trailing slash`);
});

test('player <video> is in CORS mode so cross-origin subtitle tracks load', () => {
  const tag = html.match(/<video[^>]*\bid=["']player-video["'][^>]*>/i)?.[0];
  assert.ok(tag, 'no <video id="player-video"> in index.html');
  assert.match(tag, /\bcrossorigin=["']anonymous["']/i, `player video needs crossorigin="anonymous", got: ${tag}`);
});

// Every handler the page calls cross-origin must set the CORS header. Slice each
// handler's body out of the source and look for it there.
function handlerBody(name) {
  const start = server.search(new RegExp(`(async )?function ${name}\\b`));
  assert.ok(start >= 0, `stream-server.mjs has no ${name}()`);
  const rest = server.slice(start + 1);
  const next = rest.search(/\n(async )?function \w+\(/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('helper handlers used by the page send Access-Control-Allow-Origin', () => {
  for (const name of ['handleYts', 'handleTvTorrents', 'handleSubtitleList', 'handleSubtitleFile', 'handleStream', 'handleStreamStatus']) {
    assert.match(handlerBody(name), /access-control-allow-origin/i, `${name} must send access-control-allow-origin`);
  }
});

// The helper is published to the public internet (Tailscale Funnel), so its API
// must be gated on the access key BEFORE any route runs, and the page must send
// the key on every helper URL.
test('stream-server checks the access key before routing, and the app sends it', () => {
  const routing = server.slice(server.indexOf('http.createServer('));
  const check = routing.indexOf('helperRequestAllowed(');
  const firstRoute = routing.indexOf("url.pathname === '/yts'");
  assert.ok(check >= 0, 'stream-server.mjs must call helperRequestAllowed()');
  assert.ok(firstRoute > check, 'the key check must run before the first API route');
  assert.match(server, /process\.env\.HELPER_KEY/, 'the key comes from the HELPER_KEY environment variable');
  const js = readFileSync(new URL('./script.js', import.meta.url), 'utf8');
  assert.match(js, /buildHelperUrl\(STREAM_HELPER_BASE, path, STREAM_HELPER_KEY\)/, 'helperUrl() must append the key');
  assert.match(js, /resolveHelperKey\(location\.search/, 'the key must be picked up from ?helperkey=');
});
