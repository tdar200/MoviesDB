// live-fixtures.mjs — today's football fixtures from ESPN's public scoreboard.
//
// One call per date returns every league ESPN covers with UTC kick-off, live
// clock, scores, team logos and broadcaster names. No key, but the Akamai front
// answers 403 to curl-like user agents, so we always send a browser UA.
// Pure mapper + a small cache; fetch and clock are injectable for tests.

export const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// ESPN numeric league id (from event.uid "s:600~l:<id>~e:<event>") -> slug/name.
// Verified 2026-09-27 against each league's own scoreboard endpoint.
export const ESPN_LEAGUES = {
  700: { slug: 'eng.1', name: 'Premier League' },
  775: { slug: 'uefa.champions', name: 'UEFA Champions League' },
  776: { slug: 'uefa.europa', name: 'UEFA Europa League' },
  20296: { slug: 'uefa.europa.conf', name: 'UEFA Conference League' },
  740: { slug: 'esp.1', name: 'LaLiga' },
  730: { slug: 'ita.1', name: 'Serie A' },
  720: { slug: 'ger.1', name: 'Bundesliga' },
  710: { slug: 'fra.1', name: 'Ligue 1' },
  3918: { slug: 'eng.fa', name: 'FA Cup' },
  3920: { slug: 'eng.league_cup', name: 'Carabao Cup' },
  2395: { slug: 'uefa.nations', name: 'UEFA Nations League' },
  606: { slug: 'fifa.world', name: 'FIFA World Cup' },
  786: { slug: 'fifa.worldq.uefa', name: 'World Cup Qualifying (UEFA)' },
  781: { slug: 'uefa.euro', name: 'UEFA European Championship' },
  3922: { slug: 'fifa.friendly', name: 'International Friendly' },
  3914: { slug: 'eng.2', name: 'EFL Championship' },
  725: { slug: 'ned.1', name: 'Eredivisie' },
  715: { slug: 'por.1', name: 'Primeira Liga' },
  735: { slug: 'sco.1', name: 'Scottish Premiership' },
  770: { slug: 'usa.1', name: 'MLS' },
  3946: { slug: 'tur.1', name: 'Süper Lig' },
  21231: { slug: 'ksa.1', name: 'Saudi Pro League' },
  8097: { slug: 'eng.w.1', name: "Women's Super League" },
};

export function leagueFromUid(uid) {
  const m = /~l:(\d+)/.exec(uid || '');
  if (!m) return { id: null, slug: null, name: 'Other' };
  const id = Number(m[1]);
  const known = ESPN_LEAGUES[id];
  return { id, slug: known ? known.slug : null, name: known ? known.name : 'Other' };
}

export function espnScoreboardUrl(date) {
  return `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${date.replace(/-/g, '')}&limit=300`;
}

function team(competitor, state) {
  const t = (competitor && competitor.team) || {};
  const score = state === 'pre' || competitor?.score == null || competitor.score === '' ? null : Number(competitor.score);
  return {
    name: t.displayName || t.name || '',
    shortName: t.shortDisplayName || t.abbreviation || t.displayName || '',
    logo: t.logo || null,
    score: Number.isFinite(score) ? score : null,
  };
}

export function normaliseEspnEvent(event) {
  const comp = (event.competitions && event.competitions[0]) || {};
  const competitors = comp.competitors || [];
  const status = (event.status && event.status.type) || {};
  const state = ['pre', 'in', 'post'].includes(status.state) ? status.state : 'pre';
  let clock = null;
  if (state === 'in') clock = status.shortDetail || (event.status && event.status.displayClock) || null;
  if (state === 'post') clock = 'FT';
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0];
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1];
  const names = new Set();
  for (const b of comp.broadcasts || []) for (const n of b.names || []) if (n) names.add(n);
  for (const g of comp.geoBroadcasts || []) { const n = g.media && g.media.shortName; if (n) names.add(n); }
  const kickoff = event.date ? new Date(event.date).toISOString().replace(/\.000Z$/, 'Z') : null;
  return {
    id: `espn:${event.id}`,
    league: leagueFromUid(event.uid),
    kickoff,
    state,
    clock,
    home: team(home, state),
    away: team(away, state),
    broadcasters: Array.from(names),
  };
}

const LIVE_TTL_MS = 60_000;
const IDLE_TTL_MS = 600_000;

export function createFixturesFeed({ fetchImpl = fetch, now = Date.now, userAgent = CHROME_UA } = {}) {
  const cache = new Map(); // date -> { at, fixtures }
  async function fetchFixtures(date) {
    const hit = cache.get(date);
    if (hit) {
      const ttl = hit.fixtures.some(f => f.state === 'in') ? LIVE_TTL_MS : IDLE_TTL_MS;
      if (now() - hit.at < ttl) return hit.fixtures;
    }
    const res = await fetchImpl(espnScoreboardUrl(date), { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    const data = await res.json();
    const fixtures = (data.events || []).map(normaliseEspnEvent).filter(f => f.kickoff);
    cache.set(date, { at: now(), fixtures });
    return fixtures;
  }
  return { fetchFixtures };
}
