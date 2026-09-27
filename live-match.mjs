// live-match.mjs — join ESPN fixtures to source-adapter matches and order them.
//
// Sources name teams loosely ("Man Utd", "Wolves", "Inter", flag emoji, tag
// characters), so both sides are normalised before comparing, and kick-offs
// only need to agree to within 30 minutes. Fixtures with no stream are kept
// (greyed on the TV) so the schedule is complete; source matches ESPN does not
// know are kept too, with their state derived from kick-off.

const ALIASES = {
  'man utd': 'manchester united', 'manchester utd': 'manchester united', 'man united': 'manchester united',
  'man city': 'manchester city',
  'wolves': 'wolverhampton wanderers', 'wolverhampton': 'wolverhampton wanderers',
  'inter': 'inter milan', 'internazionale': 'inter milan', 'inter milano': 'inter milan',
  'spurs': 'tottenham hotspur', 'tottenham': 'tottenham hotspur',
  'psg': 'paris saint germain', 'paris sg': 'paris saint germain',
  'atletico de madrid': 'atletico madrid', 'atletico': 'atletico madrid',
  'newcastle': 'newcastle united', 'west ham': 'west ham united', 'leeds': 'leeds united',
  'nottm forest': 'nottingham forest', "nott'm forest": 'nottingham forest',
  'brighton': 'brighton and hove albion', 'brighton hove albion': 'brighton and hove albion',
  'bayern': 'bayern munich', 'fc bayern munchen': 'bayern munich', 'bayern munchen': 'bayern munich',
  'barca': 'barcelona', 'fc barcelona': 'barcelona',
  'real': 'real madrid', 'juve': 'juventus',
  'republic of ireland': 'ireland', 'rep of ireland': 'ireland', 'ireland republic': 'ireland',
};
// Club-name furniture that differs between feeds. Single letters are NOT stripped
// (a team literally named "B" in tests, "W" in women's feeds would vanish).
const SUFFIXES = /\b(fc|cf|afc|sc|ac|as|ss|us|sv|bk|if|fk|cd|sd|ud|women|u21|u23)\b/g;

export function normaliseTeam(name) {
  let s = String(name || '')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[️‍]/g, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[s] || s;
}

const LEAGUE_PRIORITY = [
  [/premier league/i, 1], [/champions league/i, 2], [/europa league/i, 3], [/conference league/i, 4],
  [/la ?liga/i, 5], [/serie a\b/i, 6], [/bundesliga/i, 7], [/ligue 1/i, 8],
  [/fa cup/i, 9], [/carabao|league cup|efl cup/i, 10],
  [/nations league|world cup|european championship|\beuro\b/i, 11], [/friendl/i, 12],
];
export function leaguePriority(name) {
  const s = String(name || '');
  if (/women|wsl|feminin|femenina/i.test(s)) return 50;
  for (const [re, p] of LEAGUE_PRIORITY) if (re.test(s)) return p;
  return 50;
}

const LIVE_WINDOW_MS = 130 * 60_000;
export function deriveState(kickoffIso, nowMs) {
  const k = Date.parse(kickoffIso || '');
  if (!Number.isFinite(k) || nowMs < k) return 'pre';
  return nowMs - k < LIVE_WINDOW_MS ? 'in' : 'post';
}

export function selectTodayFixtures(fixtureLists, nowMs) {
  const byId = new Map();
  for (const list of fixtureLists) for (const f of list || []) byId.set(f.id, f);
  const lo = nowMs - 3 * 3_600_000, hi = nowMs + 26 * 3_600_000;
  return Array.from(byId.values()).filter(f => { const k = Date.parse(f.kickoff); return k >= lo && k <= hi; });
}

const JOIN_WINDOW_MS = 30 * 60_000;
function sameTeams(fx, sm) {
  const fh = normaliseTeam(fx.home.name), fa = normaliseTeam(fx.away.name);
  const sh = normaliseTeam(sm.home), sa = normaliseTeam(sm.away);
  if (!fh || !fa || !sh || !sa) return false;
  return (fh === sh && fa === sa) || (fh === sa && fa === sh);
}
function closeKickoff(a, b) {
  const x = Date.parse(a || ''), y = Date.parse(b || '');
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= JOIN_WINDOW_MS;
}

export function joinFixtures(fixtures, sourceMatches, { now = Date.now() } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const out = [];
  const claimed = new Set();
  for (const fx of fixtures) {
    const sources = [];
    for (const sm of sourceMatches) {
      // A source that only says "LIVE" (no kick-off) joins a fixture that is in play.
      // Also a fixture about to start: sources say LIVE once pre-match coverage begins.
      const soon = fx.state === 'pre' && Date.parse(fx.kickoff) - nowMs <= 90 * 60_000;
      const liveNoTime = !sm.kickoff && sm.status === 'in' && (fx.state === 'in' || soon);
      // ESPN fixtures are football; a cricket India v Pakistan must not join one.
      if ((sm.sport || 'football') !== 'football') continue;
      if (claimed.has(sm) || !sameTeams(fx, sm) || !(liveNoTime || closeKickoff(fx.kickoff, sm.kickoff))) continue;
      claimed.add(sm);
      sources.push({ adapter: sm.adapter, sourceId: sm.sourceId });
    }
    out.push({
      id: fx.id,
      title: `${fx.home.name} vs ${fx.away.name}`,
      league: fx.league.name,
      kickoff: fx.kickoff,
      state: fx.state,
      clock: fx.clock,
      home: { name: fx.home.name, logo: fx.home.logo, score: fx.home.score },
      away: { name: fx.away.name, logo: fx.away.logo, score: fx.away.score },
      broadcasters: fx.broadcasters || [],
      sources,
      hasStream: sources.length > 0,
      priority: leaguePriority(fx.league.name),
      poster: null,
      sport: 'football',
    });
  }
  for (const sm of sourceMatches) {
    if (claimed.has(sm)) continue;
    out.push({
      id: `src:${sm.adapter}:${sm.sourceId}`,
      title: sm.title || `${sm.home} vs ${sm.away}`,
      league: sm.league || 'Other',
      kickoff: sm.kickoff,
      state: sm.status === 'in' ? 'in' : deriveState(sm.kickoff, nowMs),
      clock: null,
      home: { name: sm.home, logo: null, score: null },
      away: { name: sm.away, logo: null, score: null },
      broadcasters: [],
      sources: [{ adapter: sm.adapter, sourceId: sm.sourceId }],
      hasStream: true,
      priority: leaguePriority(sm.league),
      poster: sm.poster || null,
      sport: sm.sport || 'football',
    });
  }
  return out;
}

const STATE_RANK = { in: 0, pre: 1, post: 2 };
export function sortMatches(list) {
  return list.slice().sort((a, b) => {
    const s = (STATE_RANK[a.state] ?? 1) - (STATE_RANK[b.state] ?? 1);
    if (s) return s;
    if (a.state === 'pre') {
      const k = Date.parse(a.kickoff || '') - Date.parse(b.kickoff || '');
      if (k) return k;
    }
    const p = (a.priority ?? 50) - (b.priority ?? 50);
    if (p) return p;
    return Date.parse(a.kickoff || '') - Date.parse(b.kickoff || '');
  });
}
