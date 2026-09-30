import test from 'node:test';
import assert from 'node:assert/strict';
import { startupVerdict, STARTUP_CHECKPOINTS, createStartupBoost, createSourceProber, orderByProbe, startCostMB, costBucket, scaleCheckpoints } from './startup-guard.mjs';

const MB = 1048576;

test('a source that has delivered nothing of ITS file is abandoned early, not after the 90 s HLS deadline', () => {
  assert.equal(startupVerdict({ elapsedMs: 5000, usefulBytes: 0 }), null, 'too early to judge');
  const dead = startupVerdict({ elapsedMs: STARTUP_CHECKPOINTS[0].afterMs, usefulBytes: 0 });
  assert.ok(dead && /no data/i.test(dead.reason));
  assert.equal(startupVerdict({ elapsedMs: STARTUP_CHECKPOINTS[0].afterMs, usefulBytes: 2 * MB }), null, 'data is arriving');
});

test('a trickle that cannot fill a 30 s startup buffer is abandoned at the last checkpoint', () => {
  const last = STARTUP_CHECKPOINTS.at(-1);
  const slow = startupVerdict({ elapsedMs: last.afterMs, usefulBytes: 4 * MB });
  assert.ok(slow && /too slow/i.test(slow.reason));
  assert.equal(startupVerdict({ elapsedMs: last.afterMs, usefulBytes: 14 * MB }), null, 'a healthy swarm is left alone');
  assert.ok(last.afterMs < 40000, 'well inside the old 90 s wait');
});

test('a source that has delivered almost nothing is condemned at the middle checkpoint, not left to the last one', () => {
  // Measured: a 100-seed "alive" source delivered 1.3 MB in 30 s (43 KB/s); it needed no 30 s to judge.
  const mid = STARTUP_CHECKPOINTS[1];
  assert.ok(mid.afterMs > STARTUP_CHECKPOINTS[0].afterMs && mid.afterMs < STARTUP_CHECKPOINTS.at(-1).afterMs);
  assert.ok(startupVerdict({ elapsedMs: mid.afterMs, usefulBytes: 0.7 * MB }), 'a 40 KB/s source fails at the middle checkpoint');
  assert.equal(startupVerdict({ elapsedMs: mid.afterMs, usefulBytes: 4 * MB }), null, 'a 220 KB/s source is still given its chance');
});

test('startup boost lifts the download cap only while a start is pending, then restores it', () => {
  const calls = [];
  const boost = createStartupBoost({ throttle: (rate) => calls.push(rate), baseLimit: 1572864, boostLimit: 6291456 });
  const a = boost.begin();
  const b = boost.begin();
  assert.deepEqual(calls, [6291456], 'boosted once for two concurrent starts');
  a();
  assert.deepEqual(calls, [6291456], 'still boosted while one start is pending');
  b();
  assert.deepEqual(calls, [6291456, 1572864], 'restored when the last start ends');
  b(); // releasing twice must not go negative or re-throttle
  assert.deepEqual(calls, [6291456, 1572864]);
});

test('startup boost is a no-op when downloads are unlimited or the boost is not higher', () => {
  const calls = [];
  createStartupBoost({ throttle: (r) => calls.push(r), baseLimit: -1, boostLimit: 6291456 }).begin()();
  createStartupBoost({ throttle: (r) => calls.push(r), baseLimit: 1572864, boostLimit: 1000000 }).begin()();
  assert.deepEqual(calls, []);
});

test('a boost that is never released restores itself (a crashed start must not leave the cap lifted)', async () => {
  const calls = [];
  const boost = createStartupBoost({ throttle: (r) => calls.push(r), baseLimit: 1572864, boostLimit: 6291456, maxMs: 20 });
  boost.begin();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, [6291456, 1572864]);
});

// ---- candidate health probe ----
const src = (hash, extra = {}) => ({ hash, quality: '1080p', ...extra });
const handle = (readyAfterMs, { fail = false, peers = 5 } = {}) => {
  let destroyed = false;
  return {
    whenReady: () => new Promise((resolve) => setTimeout(() => resolve(!fail && !destroyed), readyAfterMs)),
    peers: () => peers,
    destroy: () => { destroyed = true; },
    get destroyed() { return destroyed; },
  };
};

test('probe: the first-ranked source that answers wins; earlier ones that do not are demoted', async () => {
  const handles = { a: handle(1000), b: handle(20), c: handle(10) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 150 });
  const result = await prober.probe([src('a'), src('b'), src('c')]);
  assert.equal(result.get('a').state, 'slow');
  assert.equal(result.get('b').state, 'alive');
  const ordered = orderByProbe([src('a'), src('b'), src('c')], result);
  assert.deepEqual(ordered.map((s) => s.hash), ['b', 'c', 'a']);
  assert.equal(ordered[0].health, 'alive');
  assert.equal(ordered.at(-1).health, 'slow');
});

test('probe: when the top source is alive the wait is just its own answer time, and the rest are not awaited', async () => {
  const handles = { a: handle(15), b: handle(2000), c: handle(2000) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 1500 });
  const t0 = Date.now();
  const result = await prober.probe([src('a'), src('b'), src('c')]);
  assert.ok(Date.now() - t0 < 300, 'returned without waiting for b and c');
  assert.equal(result.get('a').state, 'alive');
  assert.equal(result.has('b'), false);
  assert.deepEqual(orderByProbe([src('a'), src('b'), src('c')], result).map((s) => s.hash), ['a', 'b', 'c'], 'order untouched when #1 is alive');
});

test('probe: a hard failure (torrent error) is dead; budget-exhausted is slow; nothing alive keeps the static order for slow ones', async () => {
  const handles = { a: handle(10, { fail: true }), b: handle(1000), c: handle(1000) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 80 });
  const result = await prober.probe([src('a'), src('b'), src('c')]);
  assert.equal(result.get('a').state, 'dead');
  assert.equal(result.get('b').state, 'slow');
  const ordered = orderByProbe([src('a'), src('b'), src('c')], result);
  assert.equal(ordered.at(-1).hash, 'a', 'dead goes last');
  assert.equal(ordered[0].hash, 'b', 'all-slow leaves the static order of the rest alone');
});

test('probe: results are cached per hash, so a repeat lookup does not re-open the torrent', async () => {
  let opens = 0;
  const prober = createSourceProber({ open: () => { opens++; return handle(5); }, budgetMs: 100 });
  await prober.probe([src('a')]);
  await prober.probe([src('a')]);
  assert.equal(opens, 1);
});

test('probe: every loser is closed as soon as the decision is made; the adopted winner stays open', async () => {
  // Open probe torrents keep downloading (webtorrent fetches allowed-fast pieces regardless of selection), so they
  // must not linger through the real startup that follows.
  const handles = { a: handle(10), b: handle(10), c: handle(3000) };
  const adopted = [];
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 200, adopt: (hash) => { adopted.push(hash); return true; } });
  await prober.probe([src('a'), src('b'), src('c')]);
  assert.deepEqual(adopted, ['a']);
  assert.equal(handles.a.destroyed, false, 'the winner is playback\'s now');
  assert.equal(handles.b.destroyed, true);
  assert.equal(handles.c.destroyed, true, 'the straggler is torn down at once, not after a hard cap');
});

test('probe: when nobody adopts the winner it is closed too (no leaked torrent)', async () => {
  const handles = { a: handle(10) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 100 });
  await prober.probe([src('a')]);
  assert.equal(handles.a.destroyed, true);
});

test('probe: debrid and hash-less sources are never probed', async () => {
  let opens = 0;
  const prober = createSourceProber({ open: () => { opens++; return handle(1); }, budgetMs: 50 });
  const result = await prober.probe([{ url: 'https://x', debrid: true }, { quality: '1080p' }]);
  assert.equal(opens, 0);
  assert.equal(result.size, 0);
});

// ---- startup cost: webtorrent can only read whole PIECES ----
// Measured: a 12 MB startup read plus an MP4's tail needs whole pieces. 8 MB pieces: 7-16 s. 32 MB pieces (season
// packs): 45-52 s for the same swarm quality, which is the "stuck at Buffering 2%" on the TV.
test('startup cost grows with piece size and with an MP4 (whose moov index is usually at the END)', () => {
  const mb = 1048576;
  assert.equal(startCostMB({ pieceLength: 8 * mb, isMp4: false }), 20);
  assert.equal(startCostMB({ pieceLength: 8 * mb, isMp4: true }), 28);
  assert.equal(startCostMB({ pieceLength: 32 * mb, isMp4: true }), 80);
  assert.equal(startCostMB({}), null, 'unknown until metadata');
  assert.deepEqual([20, 28, 48, 80, null].map(costBucket), [0, 1, 2, 2, 0]);
});

const sized = (readyAfterMs, pieceMB) => ({ ...handle(readyAfterMs), pieceLength: () => pieceMB * 1048576 });

test('probe: a live source with huge pieces waits a short grace so a cheaper live one can lead', async () => {
  const handles = { a: sized(10, 32), b: sized(60, 8), c: sized(3000, 8) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 1000, graceMs: 300 });
  const list = [src('a', { filename: 'Show.S01E01.mp4' }), src('b', { filename: 'Show.S01E01.mkv' }), src('c')];
  const result = await prober.probe(list);
  assert.equal(result.get('a').costMB, 80);
  assert.equal(result.get('b').costMB, 20);
  // cheap live first; an unverified source next (a coin-flip on a ~15 s start beats a certain ~45 s one);
  // the verified-but-expensive 32 MB-piece MP4 stays available, last.
  assert.deepEqual(orderByProbe(list, result).map((s) => s.hash), ['b', 'c', 'a']);
});

test('probe: a cheap live winner returns at once, with no grace wait', async () => {
  const handles = { a: sized(10, 8), b: sized(2000, 8) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 1500, graceMs: 800 });
  const t0 = Date.now();
  await prober.probe([src('a', { filename: 'x.mkv' }), src('b', { filename: 'y.mkv' })]);
  assert.ok(Date.now() - t0 < 200);
});

test('ordering never crosses a quality boundary: a cheap 720p does not jump a live 1080p', async () => {
  const handles = { a: sized(10, 32), b: sized(20, 8) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 500, graceMs: 200 });
  const list = [src('a', { filename: 'x.mp4', quality: '1080p' }), src('b', { filename: 'y.mkv', quality: '720p' })];
  const result = await prober.probe(list);
  assert.deepEqual(orderByProbe(list, result).map((s) => s.hash), ['a', 'b']);
});

// ---- latency: do not wait out the whole budget because a higher-ranked candidate is dead ----
test('probe: once a live source has answered, dead-looking earlier candidates get only a short patience window', async () => {
  // Measured: rank 1-3 frequently never answer (stale index seeds) while #4 answers in 25 ms.
  const handles = { a: handle(5000), b: handle(5000), c: handle(5000), d: handle(25), e: handle(5000) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 3000, patienceMs: 120 });
  const t0 = Date.now();
  const list = ['a', 'b', 'c', 'd', 'e'].map((h) => src(h));
  const result = await prober.probe(list);
  const took = Date.now() - t0;
  assert.ok(took < 600, `decided after the patience window, not the 3 s budget (took ${took} ms)`);
  assert.equal(result.get('d').state, 'alive');
  // Silent for the whole patience window = slow, whether it was ranked before OR after the live one.
  assert.deepEqual(['a', 'b', 'c', 'e'].map((h) => result.get(h).state), ['slow', 'slow', 'slow', 'slow']);
  assert.deepEqual(orderByProbe(list, result).map((s) => s.hash), ['d', 'a', 'b', 'c', 'e']);
});

test('probe: an earlier candidate that answers inside the patience window still wins by rank', async () => {
  const handles = { a: handle(60), b: handle(10) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 2000, patienceMs: 300 });
  const result = await prober.probe([src('a'), src('b')]);
  assert.equal(result.get('a').state, 'alive');
  assert.deepEqual(orderByProbe([src('a'), src('b')], result).map((s) => s.hash), ['a', 'b']);
});

test('probe: looks at eight candidates by default', async () => {
  let opened = 0;
  const prober = createSourceProber({ open: () => { opened++; return handle(2000); }, budgetMs: 40 });
  await prober.probe(Array.from({ length: 12 }, (_, i) => src(`h${i}`)));
  assert.equal(opened, 8);
});

test('probe: when NOTHING answers, silence is uninformative - it is not cached, so the next lookup probes again', async () => {
  let opens = 0;
  const prober = createSourceProber({ open: () => { opens++; return handle(5000); }, budgetMs: 40 });
  const first = await prober.probe([src('a'), src('b')]);
  assert.deepEqual([...first.values()].map((r) => r.state), ['slow', 'slow']);
  await prober.probe([src('a'), src('b')]);
  assert.equal(opens, 4, 'both lookups opened both torrents (a cold DHT is not eight dead swarms)');
  assert.equal(prober.peek('a'), null);
});

test('probe: a silent source IS cached as slow when a live one proves the network works', async () => {
  const handles = { a: handle(5000), b: handle(10) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 60, patienceMs: 30 });
  await prober.probe([src('a'), src('b')]);
  assert.equal(prober.peek('a').state, 'slow');
  assert.equal(prober.peek('b').state, 'alive');
});

test('the watchdog reasons read as a clause after "This source"', () => {
  for (const cp of STARTUP_CHECKPOINTS) assert.match(`This source ${cp.reason}.`, /^This source (delivered no data|is too slow)/);
});

test('probe: a heavily-seeded candidate that has not answered yet is worth the full budget (answering fast is not a good swarm)', async () => {
  // Measured: the 307-seed Chernobyl pack answers in ~1.6 s; a 10-seed copy answers in 0.3 s and then took 87 s to start.
  const handles = { big: handle(400), small: handle(20) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 1500, patienceMs: 100, weight: (s) => s.seeds, heavyWeight: 40 });
  const list = [src('big', { seeds: 307 }), src('small', { seeds: 10 })];
  const t0 = Date.now();
  const result = await prober.probe(list);
  assert.equal(result.get('big').state, 'alive', 'waited for the big swarm');
  assert.ok(Date.now() - t0 >= 350 && Date.now() - t0 < 900);
  assert.deepEqual(orderByProbe(list, result).map((s) => s.hash), ['big', 'small']);
});

test('probe: a lightly-seeded candidate that is silent is not waited for', async () => {
  const handles = { light: handle(5000), other: handle(20) };
  const prober = createSourceProber({ open: (hash) => handles[hash], budgetMs: 1500, patienceMs: 100, weight: (s) => s.seeds, heavyWeight: 40 });
  const t0 = Date.now();
  await prober.probe([src('light', { seeds: 9 }), src('other', { seeds: 20 })]);
  assert.ok(Date.now() - t0 < 500);
});

test('the second startup checkpoint demands a rate that can sustain 1080p, not just any trickle', () => {
  assert.ok(STARTUP_CHECKPOINTS.at(-1).minBytes >= 8 * 1048576);
});

test('a transcode (HEVC) start needs fewer bytes: its input bitrate is about half an H.264 1080p', () => {
  const half = scaleCheckpoints(STARTUP_CHECKPOINTS, 0.5);
  assert.equal(half.length, STARTUP_CHECKPOINTS.length);
  assert.equal(half.at(-1).minBytes, STARTUP_CHECKPOINTS.at(-1).minBytes / 2);
  assert.deepEqual(half.map((c) => c.afterMs), STARTUP_CHECKPOINTS.map((c) => c.afterMs), 'the clock is not scaled, only the bar');
  // 5 MB at 30 s: too slow for H.264, fine for a transcode.
  const at = STARTUP_CHECKPOINTS.at(-1).afterMs;
  assert.ok(startupVerdict({ elapsedMs: at, usefulBytes: 5 * MB }));
  assert.equal(startupVerdict({ elapsedMs: at, usefulBytes: 5 * MB, checkpoints: half }), null);
});
