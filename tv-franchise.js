// The franchise screen: every part of a film series in release order, numbered Part 1, 2, 3 ... It is a sibling of the
// details screen (same `.tv-details` overlay, so the remote's Back handling and focus restore already treat it as one);
// choosing a part hands over to the normal details screen, and Back from there returns here (see script.js).
import { createTvCard } from './tv-ui.js';
import { franchiseSpan, firstUnfinishedIndex } from './tv-franchises.mjs';

const art = 'https://image.tmdb.org/t/p/';
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createTvFranchise({ onSelectPart, getProgress } = {}) {
  const overlay = el('div', 'tv-details tv-franchise');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const backdrop = el('div', 'tv-details-backdrop');
  const scrim = el('div', 'tv-details-scrim');
  const body = el('div', 'tv-details-body');
  overlay.append(backdrop, scrim, body);
  document.body.append(overlay);

  const isOpen = () => !overlay.hidden;
  const close = () => { overlay.hidden = true; };

  // opts.focusId: the part to put focus on (coming back from that part's details); otherwise the next one you have not finished.
  const open = (franchise, opts = {}) => {
    overlay.hidden = false;
    overlay.scrollTop = 0;
    overlay.setAttribute('aria-label', franchise.title);
    backdrop.style.backgroundImage = franchise.backdrop_path ? `url("${art}w1280${franchise.backdrop_path}")` : 'none';
    body.textContent = '';
    body.append(el('h1', 'tv-details-title', franchise.title));
    body.append(el('div', 'tv-details-meta', franchiseSpan(franchise).label));
    if (franchise.overview) body.append(el('p', 'tv-details-synopsis', franchise.overview));
    const host = el('section', 'tv-details-recommendations tv-franchise-parts');
    host.append(el('h2', 'tv-details-recommendations-heading', 'Watch in order'));
    const rail = el('div', 'tv-rail');
    rail.setAttribute('aria-label', `${franchise.title}, in order`);
    const track = el('div', 'tv-rail-track');
    franchise.parts.forEach((part, i) => {
      track.append(createTvCard(part, chosen => onSelectPart && onSelectPart(chosen, franchise), { rank: i + 1, progress: getProgress ? getProgress(part) : 0 }));
    });
    rail.append(track);
    host.append(rail);
    body.append(host);
    const cards = Array.from(track.querySelectorAll('.tv-card'));
    const wanted = opts.focusId != null ? franchise.parts.findIndex(p => String(p.id) === String(opts.focusId)) : -1;
    const card = cards[wanted >= 0 ? wanted : firstUnfinishedIndex(franchise.parts, getProgress ? p => getProgress({ id: p }) : null)] || cards[0];
    if (!card) return;
    // The remote's focus() also slides the rail so a late part (Marvel's 30th film) is on screen.
    if (window.__tvFocus) window.__tvFocus(card); else card.focus({ preventScroll: true });
  };

  return { el: overlay, open, close, isOpen };
}
