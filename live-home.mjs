// live-home.mjs — pure row model for the Live home. Turns /live/matches and
// /live/channels payloads into card objects the TV rail already knows how to
// lay out (id, title, image_url) plus a `live` block the live card renders.

function pad(n) { return String(n).padStart(2, '0'); }

export function kickoffLabel(kickoffIso, nowMs) {
  const k = Date.parse(kickoffIso || '');
  if (!Number.isFinite(k)) return { time: '', relative: '' };
  const d = new Date(k);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const mins = Math.round((k - nowMs) / 60_000);
  let relative = '';
  if (mins > 0) {
    if (mins < 60) relative = `in ${mins}m`;
    else relative = mins % 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `in ${mins / 60}h`;
  } else if (mins < 0) relative = `started ${-mins}m ago`;
  return { time, relative };
}

export function matchToCard(m, nowMs) {
  return {
    id: m.id,
    title: m.title,
    image_url: m.poster || null,
    kind: 'match',
    vote_average: 0,
    live: {
      state: m.state, clock: m.clock || null, kickoff: m.kickoff || null, league: m.league || 'Other',
      homeName: m.home.name, awayName: m.away.name, homeScore: m.home.score, awayScore: m.away.score,
      homeBadge: m.home.logo || null, awayBadge: m.away.logo || null,
      hasStream: m.hasStream !== false, broadcasters: m.broadcasters || [],
    },
    raw: m,
  };
}

export function channelToCard(c) {
  return { id: `ch:${c.id}`, title: c.name, image_url: c.logo || null, kind: 'channel', vote_average: 0, live: { state: 'channel' }, raw: c };
}

const RECENT_POST_MS = 2 * 3_600_000 + 130 * 60_000; // finished within the last ~2 h

export function buildLiveRows(matches, channels, nowMs) {
  const live = [], today = [];
  for (const m of matches || []) {
    if (m.state === 'in') live.push(matchToCard(m, nowMs));
    else if (m.state === 'pre') today.push(matchToCard(m, nowMs));
    else if (m.state === 'post' && nowMs - Date.parse(m.kickoff || '') < RECENT_POST_MS) today.push(matchToCard(m, nowMs));
  }
  const rows = [
    { key: 'live-now', title: 'Live now', items: live, noSort: true },
    { key: 'today', title: 'Today', items: today, noSort: true },
    { key: 'channels', title: 'Channels', items: (channels || []).map(channelToCard), noSort: true },
  ];
  return rows.filter(r => r.items.length);
}

// After a 60 s refresh re-renders the rows, put focus back on the same card so
// the remote does not fall to <body>. Ids come from data-movie-id.
export function restoreFocusById(id) {
  if (!id || typeof document === 'undefined') return false;
  const safe = String(id).replace(/["\\]/g, '\\$&');
  const card = document.querySelector(`.tv-card[data-movie-id="${safe}"]`);
  if (!card) return false;
  card.focus({ preventScroll: true });
  return true;
}
