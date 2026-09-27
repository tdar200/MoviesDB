// live-details.mjs — the details screen for a live match: badges, score or
// kick-off, league, broadcasters, and a stream picker. Same overlay shell as
// tv-details.js (class tv-details + hidden attribute) so the remote's Back
// handling and focus restore treat it identically.
import { kickoffLabel } from './live-home.mjs';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createLiveDetails({ fetchStreams, onPlay, now = Date.now }) {
  const overlay = el('div', 'tv-details tv-details-live');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const body = el('div', 'tv-details-body');
  overlay.append(el('div', 'tv-details-backdrop tv-live-details-backdrop'), el('div', 'tv-details-scrim'), body);
  document.body.append(overlay);

  let current = null;
  let token = 0;
  const isOpen = () => !overlay.hidden;
  const close = () => { overlay.hidden = true; current = null; token++; };

  function renderStreams(match, streams, t) {
    if (t !== token) return;
    const host = body.querySelector('.tv-live-streams');
    host.textContent = '';
    if (!streams.length) {
      host.append(el('p', 'tv-live-nostream', match.state === 'post' ? 'No stream for this match.' : 'No stream yet. Streams usually appear about ten minutes before kick-off.'));
      const refresh = el('button', 'tv-details-play', '↻  Refresh');
      refresh.id = 'tv-live-refresh';
      refresh.type = 'button';
      refresh.addEventListener('click', () => load(match, t));
      host.append(refresh);
      refresh.focus();
      return;
    }
    const play = el('button', 'tv-details-play', '▶  Play');
    play.id = 'tv-live-play';
    play.type = 'button';
    play.addEventListener('click', () => onPlay(match, streams, 0));
    host.append(play);
    const list = el('div', 'tv-live-stream-list');
    streams.forEach((s, i) => {
      const b = el('button', 'tv-live-stream', [s.label, s.language, s.quality].filter(Boolean).join('  ·  ') + (s.health && s.health !== 'ok' ? ' · may not work' : ''));
      b.type = 'button';
      b.dataset.index = String(i);
      b.addEventListener('click', () => onPlay(match, streams, i));
      list.append(b);
    });
    host.append(el('h3', 'tv-live-streams-title', `${streams.length} stream${streams.length === 1 ? '' : 's'}`), list);
    play.focus();
  }

  async function load(match, t) {
    const host = body.querySelector('.tv-live-streams');
    host.textContent = '';
    host.append(el('p', 'tv-live-nostream', 'Finding streams…'));
    let streams = [];
    try { streams = (await fetchStreams(match)) || []; } catch { streams = []; }
    // The helper already sorts ok-first; a client re-sort by rank must never lift
    // a timeout/error stream above an ok one.
    const healthKey = s => (s.health && s.health !== 'ok' ? 1 : 0);
    renderStreams(match, streams.slice().sort((a, b) => healthKey(a) - healthKey(b) || (b.rank || 0) - (a.rank || 0)), t);
  }

  async function open(match) {
    current = match;
    const t = ++token;
    overlay.hidden = false;
    overlay.scrollTop = 0;
    body.textContent = '';
    body.append(el('h1', 'tv-details-title', match.title));
    const { time, relative } = kickoffLabel(match.kickoff, now());
    const bits = [match.league];
    if (match.state === 'in') bits.push(match.clock ? `LIVE ${match.clock}` : 'LIVE');
    else if (match.state === 'post') bits.push('Full time');
    else bits.push([time, relative].filter(Boolean).join(' · '));
    body.append(el('div', 'tv-details-meta', bits.filter(Boolean).join('   ·   ')));
    const teams = el('div', 'tv-live-details-teams');
    const side = (t2, cls) => {
      const wrap = el('div', 'tv-live-details-team ' + cls);
      const img = el('img', 'tv-live-details-badge'); img.alt = ''; if (t2.logo) img.src = t2.logo;
      wrap.append(img, el('span', 'tv-live-details-name', t2.name));
      return wrap;
    };
    const score = match.state === 'pre' || match.home.score == null || match.away.score == null ? 'vs' : `${match.home.score} - ${match.away.score}`;
    teams.append(side(match.home, 'home'), el('span', 'tv-live-details-score', score), side(match.away, 'away'));
    body.append(teams);
    if (match.broadcasters && match.broadcasters.length) body.append(el('p', 'tv-live-broadcasters', 'On TV: ' + match.broadcasters.join(', ')));
    body.append(el('div', 'tv-live-streams'));
    await load(match, t);
  }

  return { el: overlay, open, close, isOpen };
}
