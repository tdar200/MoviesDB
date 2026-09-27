// live-ui.js — the live match / channel card. Same shell as the film card
// (button.tv-card with data-movie-id so the remote's row/column navigation and
// focus restore work unchanged), different visual: two badges and a score.
import { kickoffLabel } from './live-home.mjs';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function badgeText(live) {
  if (live.state === 'in') return live.clock ? `LIVE ${live.clock}` : 'LIVE';
  if (live.state === 'post') return 'FT';
  return kickoffLabel(live.kickoff, Date.now()).time || 'Soon';
}

export function createLiveCard(card, onSelect) {
  const live = card.live || {};
  const isChannel = card.kind === 'channel';
  const button = element('button', 'tv-card tv-card-live' + (isChannel ? ' tv-card-channel' : ''));
  button.type = 'button';
  button.dataset.movieId = card.id;
  button.dataset.rating = '0';
  const noStream = !isChannel && live.hasStream === false;
  if (noStream) button.classList.add('tv-card-nostream');
  if (live.state === 'in') button.classList.add('tv-card-onair');

  const visual = element('span', 'tv-card-visual');
  if (isChannel) {
    const image = element('img', 'tv-card-art tv-card-logo');
    image.alt = '';
    image.loading = 'lazy';
    if (card.image_url) image.src = card.image_url;
    image.onerror = () => { button.classList.add('tv-card-noart'); };
    visual.append(image);
  } else {
    const teams = element('span', 'tv-live-teams');
    const badge = (url, name) => {
      const img = element('img', 'tv-live-badge');
      img.alt = name || '';
      img.loading = 'lazy';
      if (url) img.src = url; else img.classList.add('tv-live-badge-missing');
      return img;
    };
    const score = live.state === 'pre' || live.homeScore == null || live.awayScore == null ? 'vs' : `${live.homeScore} - ${live.awayScore}`;
    teams.append(badge(live.homeBadge, live.homeName), element('span', 'tv-live-score', score), badge(live.awayBadge, live.awayName));
    visual.append(teams);
    visual.append(element('span', 'tv-card-badge', badgeText(live)));
  }
  button.append(visual);

  const caption = element('div', 'tv-card-caption');
  const kicker = isChannel ? 'Channel' : (live.league || 'Football');
  const label = isChannel ? '' : kickoffLabel(live.kickoff, Date.now()).relative;
  const details = isChannel ? '24/7 sports channel' : [label, (live.broadcasters || []).slice(0, 2).join(', ')].filter(Boolean).join('  ·  ') || 'Football';
  const footer = element('span', 'tv-card-footer');
  footer.append(
    element('span', 'tv-card-year', isChannel ? 'Live' : live.state === 'in' ? 'In play' : live.state === 'post' ? 'Finished' : 'Upcoming'),
    element('span', 'tv-card-cta', noStream ? 'No stream yet' : 'Watch  ›'),
  );
  caption.append(element('span', 'tv-card-kicker', kicker), element('span', 'tv-card-title', card.title), element('span', 'tv-card-overview', details), footer);
  button.append(caption);
  button.setAttribute('aria-label', [card.title, kicker, details].filter(Boolean).join(', '));
  button.addEventListener('click', () => onSelect(card));
  return button;
}
