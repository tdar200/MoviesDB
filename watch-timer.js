// Accumulates "active" time across start/pause intervals — used to measure how long
// the main video has actually been the focused, foreground Watch tab. Pure and
// deterministic: the caller injects the current time (Date.now()), so accumulation
// can be unit-tested without real clocks, and time spent on the trailer tab or in a
// backgrounded browser tab is simply never started, so it's excluded by construction.
export function createWatchTimer() {
  let active = false;
  let since = 0;
  let accumMs = 0;

  // Time elapsed during the current active interval, guarded against clock skew.
  const interval = (now) => (active ? Math.max(0, now - since) : 0);

  return {
    start(now) {
      if (!active) { active = true; since = now; }
    },
    pause(now) {
      if (active) { accumMs += interval(now); active = false; }
    },
    reset() {
      active = false; since = 0; accumMs = 0;
    },
    elapsed(now) {
      return accumMs + interval(now);
    },
    get isActive() { return active; },
  };
}
