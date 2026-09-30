// startup-guard.mjs — keep a source that cannot start from holding the viewer, and get a good one going fast.
//
// Three independent, dependency-free pieces (the webtorrent client is injected, so they unit-test offline):
//   startupVerdict      abandon a starting source that is not delivering bytes of ITS OWN file
//   createStartupBoost  lift the download cap only while a start is pending (nothing is being uploaded to the
//                       TV yet, so the burst cannot starve playback), then restore it
//   createSourceProber  confirm the top-ranked candidates are alive (metadata arrives) BEFORE the viewer is
//                       sent to one, so a dead swarm is skipped in seconds instead of after a 12-90 s wait

const MB = 1048576;

// Judged on bytes of the target file, not whole-torrent progress: a 10 GB season pack with 20 peers trickling
// in unrelated pieces looked healthy to the old check (peers > 0 and progress > 0.05%) while the bytes ffmpeg
// needed never came. Measured: a healthy source delivers the 12 MB a 30 s HLS startup needs in under 12 s; the second
// checkpoint (8 MB in 30 s, ~270 KB/s) drops sources that could not sustain 1080p (~450 KB/s) and would buffer anyway.
export const STARTUP_CHECKPOINTS = [
  { afterMs: 10000, minBytes: 256 * 1024, reason: 'delivered no data from the swarm' },
  { afterMs: 18000, minBytes: 2.5 * MB, reason: 'is too slow to fill the startup buffer' },
  { afterMs: 30000, minBytes: 8 * MB, reason: 'is too slow to fill the startup buffer' },
];

// A transcode (HEVC -> H.264) reads a smaller input file, so its bar scales down; the clock never does.
export function scaleCheckpoints(checkpoints, factor) {
  return checkpoints.map((cp) => ({ ...cp, minBytes: cp.minBytes * factor }));
}

// elapsedMs counts from the moment the torrent's file was selected (metadata already in hand).
export function startupVerdict({ elapsedMs, usefulBytes, checkpoints = STARTUP_CHECKPOINTS }) {
  for (const cp of checkpoints) {
    if (elapsedMs >= cp.afterMs && (Number(usefulBytes) || 0) < cp.minBytes) return { reason: cp.reason, checkpoint: cp };
  }
  return null;
}

// Reference-counted cap lift. `begin()` returns an idempotent release. If a start crashes without releasing,
// the cap restores itself after maxMs so the box is never left uncapped on the shared Wi-Fi.
export function createStartupBoost({ throttle, baseLimit, boostLimit, maxMs = 60000 }) {
  const active = Number.isFinite(baseLimit) && baseLimit > 0 && Number.isFinite(boostLimit) && boostLimit > baseLimit;
  let pending = 0;
  let timer = null;
  const restore = () => {
    if (!pending && !timer) return;
    pending = 0;
    clearTimeout(timer); timer = null;
    throttle(baseLimit);
  };
  return {
    begin() {
      if (!active) return () => {};
      if (pending++ === 0) {
        throttle(boostLimit);
        timer = setTimeout(restore, maxMs);
        if (timer.unref) timer.unref();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--pending <= 0) restore();
      };
    },
  };
}

// What a start must download before the first picture, in MB. The HLS startup buffer needs ~12 MB of the file
// and webtorrent can only fetch whole pieces (+ half a piece of alignment); an MP4 nearly always also needs its
// moov index from the END of the file (9 of 15 measured), i.e. one more piece. Unknown (null) until metadata.
const STARTUP_HEAD_MB = 12;
export function startCostMB({ pieceLength, isMp4 } = {}) {
  const piece = Number(pieceLength) / MB;
  if (!(piece > 0)) return null;
  return Math.round((Math.ceil(STARTUP_HEAD_MB / piece) + 0.5) * piece + (isMp4 ? piece : 0));
}
// 0 cheap (<= 24 MB: 8 MB pieces or smaller), 1 moderate, 2 expensive (16 MB+ pieces with an MP4, 32 MB pieces).
export const costBucket = (mb) => (mb == null || mb <= 24 ? 0 : mb <= 40 ? 1 : 2);

// Probe the top candidates in parallel; answer as soon as the first-ranked LIVE one is known and every
// candidate ranked ahead of it has answered (or the budget ran out).
//   open(hash) -> { whenReady(): Promise<boolean>, peers(): number, destroy() }
//   adopt(hash, handle)  called for the winner so the real playback request finds its metadata already loaded;
//                        return false to decline (the handle is then closed like every other)
// Results per hash: { state: 'alive' | 'slow' | 'dead', peers, at }.
//   alive = metadata arrived; slow = no metadata inside the budget; dead = the torrent errored.
export function createSourceProber({
  open, adopt = () => false, now = Date.now, budgetMs = 3500, graceMs = 800, patienceMs = 1200,
  weight = () => 0, heavyWeight = 40,
  aliveTtlMs = 10 * 60000, deadTtlMs = 3 * 60000, maxProbes = 8,
} = {}) {
  const cache = new Map(); // hash -> { state, peers, at }
  const fresh = (hash) => {
    const hit = cache.get(hash);
    if (!hit) return null;
    return now() - hit.at < (hit.state === 'alive' ? aliveTtlMs : deadTtlMs) ? hit : null;
  };

  async function probe(sources) {
    const list = (Array.isArray(sources) ? sources : []).filter((s) => s && s.hash && !s.debrid).slice(0, maxProbes);
    const startedAt = now();
    const outcomes = new Array(list.length).fill(null);
    const handles = new Array(list.length).fill(null);
    let winner = -1;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });

    const settled = () => {
      const k = outcomes.findIndex((o) => o && o.state === 'alive');
      if (k >= 0 && outcomes.slice(0, k).every(Boolean)) return true;
      return k < 0 && outcomes.every(Boolean);
    };
    const isMp4 = (i) => /\.(mp4|m4v)$/i.test(String(list[i].filename || ''));
    let patienceTimer = null;
    let closed = false; // set once we close our own handles: their late 'not ready' is not evidence of death
    // A live source has answered but something ranked ahead of it has not. Measured: rank 1-3 often never answer
    // (stale index seeds) while #4 answers in 25 ms, and healthy metadata arrives in ~0.5 s (p90 ~3 s), so the
    // earlier ones get a short patience window, not the whole budget. The exception is a candidate with a big swarm
    // (weight >= heavyWeight): answering fast is not the same as a good swarm (a 307-seed pack answered in 1.6 s; a
    // 10-seed copy answered in 0.3 s and then took 87 s to start), so those get the full budget.
    const armPatience = () => {
      clearTimeout(patienceTimer); patienceTimer = null;
      const k = outcomes.findIndex((o) => o && o.state === 'alive');
      if (k < 0) return;
      const heavyPending = list.some((s, j) => j < k && !outcomes[j] && weight(s) >= heavyWeight);
      patienceTimer = setTimeout(resolveDone, Math.max(0, (heavyPending ? budgetMs : patienceMs) - (now() - startedAt)));
    };
    const record = (i, state, peers) => {
      if (closed) return;
      const costMB = state === 'alive' && handles[i] && handles[i].pieceLength
        ? startCostMB({ pieceLength: handles[i].pieceLength(), isMp4: isMp4(i) }) : null;
      outcomes[i] = { state, peers, costMB, at: now() };
      cache.set(list[i].hash, outcomes[i]);
      if (settled()) { resolveDone(); return; }
      armPatience();
    };

    list.forEach((s, i) => {
      const hit = fresh(s.hash);
      if (hit) { outcomes[i] = hit; return; }
      let handle;
      try { handle = open(s.hash); } catch { record(i, 'dead', 0); return; }
      handles[i] = handle;
      handle.whenReady().then((ok) => record(i, ok ? 'alive' : 'dead', ok ? handle.peers() : 0), () => record(i, 'dead', 0));
    });
    if (settled()) resolveDone();

    const timer = setTimeout(resolveDone, budgetMs);
    await done;
    clearTimeout(timer);
    clearTimeout(patienceTimer);

    // The first live source costs a lot to start (huge pieces / MP4 tail)? Give the others a short moment to
    // answer so a cheaper live one can lead. A cheap winner returns at once.
    const first = outcomes.findIndex((o) => o && o.state === 'alive');
    if (first >= 0 && costBucket(outcomes[first].costMB) > 0 && outcomes.some((o, i) => i > first && !o)) {
      const remaining = Math.max(0, Math.min(graceMs, budgetMs - (now() - startedAt)));
      await new Promise((resolve) => {
        const gt = setTimeout(resolve, remaining);
        const poll = setInterval(() => { if (outcomes.every(Boolean)) { clearTimeout(gt); clearInterval(poll); resolve(); } }, 15);
        setTimeout(() => clearInterval(poll), remaining + 20);
      });
    }

    winner = outcomes.findIndex((o) => o && o.state === 'alive');
    const patient = now() - startedAt >= patienceMs - 10;
    const results = new Map();
    outcomes.forEach((o, i) => {
      if (o) { results.set(list[i].hash, o); return; }
      // Still pending. Silent for the whole patience window is slow, ranked before OR after the winner (they all
      // started together). If the decision was immediate (a cheap winner with nothing ahead of it) the rest were
      // simply not awaited: leave them unknown.
      if (winner === -1 || i < winner || patient) {
        const slow = { state: 'slow', peers: 0, at: now() };
        results.set(list[i].hash, slow);
        // Silence only means something when a live source shows the network is fine. With nothing alive
        // (cold DHT, no route) it is not evidence about THESE swarms: do not remember it.
        if (winner !== -1) cache.set(list[i].hash, slow);
      }
    });

    // The winner goes to whoever adopts it (returning anything but false); every other handle is closed right
    // now. Open probe torrents keep downloading random pieces, which would steal bandwidth from the real start.
    let adopted = false;
    if (winner !== -1 && handles[winner]) {
      try { adopted = adopt(list[winner].hash, handles[winner]) !== false; } catch { adopted = false; }
    }
    closed = true;
    handles.forEach((h, i) => { if (h && !(i === winner && adopted)) { try { h.destroy(); } catch { /* already gone */ } } });
    return results;
  }

  return { probe, peek: (hash) => fresh(hash), forget: (hash) => cache.delete(hash) };
}

// Order after probing:
//   - verified-dead sources go last; once a live one exists, so do the ones that never answered
//   - within a quality group (the static ranking already groups them; a cheap 720p never jumps a live 1080p)
//     live sources with a cheaper startup lead, then everything unprobed (unknown = moderate), then the dear ones
//   - the static ranking breaks every remaining tie
// Every probed source is stamped with its health (and live ones with the estimated startup cost).
export function orderByProbe(sources, results) {
  const list = Array.isArray(sources) ? sources : [];
  if (!results || !results.size) return list;
  const info = (s) => results.get(s.hash);
  const anyAlive = [...results.values()].some((r) => r.state === 'alive');
  const demote = (s) => { const r = info(s); return !!r && (r.state === 'dead' || (anyAlive && r.state === 'slow')); };
  // Groups in first-appearance order: the list arrives sorted by quality, so this IS the quality order.
  const groups = new Map();
  list.forEach((s) => { if (!groups.has(s.quality)) groups.set(s.quality, groups.size); });
  const bucket = (s) => { const r = info(s); return r && r.state === 'alive' ? costBucket(r.costMB) : 1; };
  const keep = list.map((s, i) => ({ s, i })).filter(({ s }) => !demote(s))
    .sort((a, b) => (groups.get(a.s.quality) - groups.get(b.s.quality)) || (bucket(a.s) - bucket(b.s)) || (a.i - b.i)).map(({ s }) => s);
  const stamp = (s) => { const r = info(s); return r ? { ...s, health: r.state, ...(r.costMB != null ? { startCostMB: r.costMB } : {}) } : s; };
  return [...keep, ...list.filter(demote)].map(stamp);
}
