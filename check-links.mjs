#!/usr/bin/env node
// check-links.mjs — live health check for the streaming embed providers.
//
//   npm run check-links            # check every embeddable source
//   node check-links.mjs --json    # machine-readable output
//   node check-links.mjs --all     # include BLOCKED_PROVIDERS too
//
// For each source it requests a real embed URL for a known movie AND a known TV
// episode, follows redirects, and decides whether the response actually looks like
// a playable page (reachable, sane size, has player-ish markup). Exit code is
// non-zero if the DEFAULT source or too many sources are down — so it can gate CI
// or just tell you at a glance what to fix when "the links don't play".
//
// It is NOT a guarantee the video resolves (that needs a headless browser — see
// provider-tester-cli.js) — it's a fast reachability + shape check that catches the
// common failure: a provider domain dying or moving.

import { EMBED_SOURCES, BLOCKED_PROVIDERS } from './embed-sources.js';

// Known-good TMDB ids used as probes.
const MOVIE = { type: 'movie', id: 27205 };              // Inception
const TV = { type: 'tv', id: 1399, season: 1, episode: 1 }; // Game of Thrones S1E1

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 12000;
const CONCURRENCY = 6;
const MIN_PLAYER_BYTES = 3000;      // smaller than this is almost always a stub/error/redirect shell
const PLAYER_HINTS = /hls|m3u8|<video|<iframe|jwplayer|playerjs|player\.|sandbox|source|\.mp4|stream/i;

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const includeBlocked = args.has('--all');

// Probe one URL: returns { ok, status, bytes, finalUrl, looksLikePlayer, error }.
async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    });
    const body = await res.text();
    const bytes = Buffer.byteLength(body);
    return {
      ok: res.ok,
      status: res.status,
      bytes,
      finalUrl: res.url,
      looksLikePlayer: res.ok && bytes >= MIN_PLAYER_BYTES && PLAYER_HINTS.test(body),
      error: null,
    };
  } catch (err) {
    return { ok: false, status: 0, bytes: 0, finalUrl: url, looksLikePlayer: false, error: err.name === 'AbortError' ? 'timeout' : (err.cause?.code || err.message) };
  } finally {
    clearTimeout(t);
  }
}

// Verdict for a source = combine its movie probe and its tv probe.
function verdict(movie, tv) {
  if (movie.looksLikePlayer || tv.looksLikePlayer) return 'OK';
  if (movie.ok || tv.ok) return 'REACHABLE';   // responds 2xx but no player markup — likely broken/anti-bot
  return 'DEAD';                                // no successful response at all
}

export async function checkSource(source) {
  const movieUrl = source.getUrl(MOVIE.type, MOVIE.id);
  const tvUrl = source.getUrl(TV.type, TV.id, TV.season, TV.episode);
  const [movie, tv] = await Promise.all([probe(movieUrl), probe(tvUrl)]);
  return {
    name: source.name,
    verdict: verdict(movie, tv),
    blocked: BLOCKED_PROVIDERS.includes(source.name),
    movie: { url: movieUrl, ...movie },
    tv: { url: tvUrl, ...tv },
  };
}

// Simple concurrency-limited map.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function short(r) {
  if (r.looksLikePlayer) return `player ${(r.bytes / 1024).toFixed(0)}KB`;
  if (r.ok) return `${r.status} ${(r.bytes / 1024).toFixed(0)}KB no-player`;
  return r.error ? `${r.error}` : `HTTP ${r.status}`;
}

async function main() {
  // Only embeddable iframe providers — the torrent source isn't a URL to fetch.
  let sources = EMBED_SOURCES.filter((s) => !s.torrent);
  if (!includeBlocked) sources = sources.filter((s) => !BLOCKED_PROVIDERS.includes(s.name));

  const results = await mapLimit(sources, CONCURRENCY, checkSource);

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const icon = { OK: '✅', REACHABLE: '⚠️ ', DEAD: '❌' };
    console.log(`\nStreaming link health — ${results.length} sources checked (movie=Inception, tv=GoT S1E1)\n`);
    for (const r of results) {
      const tag = r.blocked ? ' [blocked]' : '';
      console.log(`${icon[r.verdict]} ${r.name.padEnd(16)}${tag}`);
      console.log(`     movie: ${short(r.movie)}  → ${r.movie.finalUrl}`);
      console.log(`     tv:    ${short(r.tv)}  → ${r.tv.finalUrl}`);
    }
    const ok = results.filter((r) => r.verdict === 'OK').length;
    const reachable = results.filter((r) => r.verdict === 'REACHABLE').length;
    const dead = results.filter((r) => r.verdict === 'DEAD').length;
    console.log(`\nSummary: ${ok} OK, ${reachable} reachable-but-suspect, ${dead} dead\n`);
  }

  // Exit code: fail if the default (first) source is not OK, or if nothing works.
  const def = results[0];
  const anyOk = results.some((r) => r.verdict === 'OK');
  if (!def || def.verdict !== 'OK') {
    if (!asJson) console.error(`❌ Default source "${def?.name}" is ${def?.verdict} — the app will open on a broken player.`);
    process.exit(1);
  }
  if (!anyOk) process.exit(1);
  process.exit(0);
}

// Only run the CLI when invoked directly (`node check-links.mjs`), not when
// imported by the test file.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(2); });
}
