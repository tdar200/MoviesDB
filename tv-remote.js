import { installProviderControls } from './tv-provider-controls.js';
import { createTvPlayer } from './tv-player.js';
// Spatial focus navigation for LG's D-pad, keyboard, and pointer remote.
const selector = 'button:not(:disabled), a[href], input:not([type="hidden"]):not(:disabled), select:not(:disabled), [tabindex="0"], video[controls]';
const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
const backKeys = ['Escape', 'BrowserBack', 'GoBack'];
export function installTvRemote() {
  document.body.classList.add('tv-mode');
  installProviderControls();
  const modal = document.getElementById('player-modal');
  const detailsOverlay = document.querySelector('.tv-details');
  const detailsOpen = () => !!detailsOverlay && !detailsOverlay.hidden;
  const header = document.querySelector('header');
  document.getElementById('close-modal').textContent = '‹ Back';
  document.getElementById('player-fullscreen').textContent = 'Fullscreen';
  document.getElementById('source-select').setAttribute('aria-label', 'Playback source');
  const controls = document.createElement('button');
  controls.id = 'tv-browse-controls';
  controls.textContent = 'Search & filters';
  controls.setAttribute('aria-expanded', 'false');
  document.querySelector('.header-top').append(controls);
  const toggleControls = on => {
    document.body.classList.toggle('tv-controls-open', on);
    controls.setAttribute('aria-expanded', String(on));
  };
  controls.onclick = () => {
    const on = !document.body.classList.contains('tv-controls-open');
    toggleControls(on);
    if (on) Array.from(header.querySelectorAll('input[type="search"]')).find(visible)?.focus();
  };
  const searchNotice = document.createElement('div');
  searchNotice.className = 'tv-search-notice';
  const searchLabel = document.createElement('span');
  const clearSearch = document.createElement('button');
  clearSearch.id = 'tv-clear-search';
  clearSearch.type = 'button';
  clearSearch.textContent = 'Clear search';
  searchNotice.append(searchLabel, clearSearch);
  header.append(searchNotice);
  const syncSearchNotice = () => {
    const query = new URLSearchParams(location.search).get('q') || '';
    searchNotice.hidden = !query;
    searchLabel.textContent = query ? `Search results for “${query}”` : '';
  };
  clearSearch.onclick = () => {
    if (visible(modal)) return;
    const url = new URL(location.href);
    url.searchParams.delete('q');
    location.href = url.href;
  };
  new MutationObserver(syncSearchNotice).observe(document.getElementById('main'), { childList: true });
  window.addEventListener('popstate', syncSearchNotice);
  syncSearchNotice();

  // Clear-filters button inside the filter panel: one press resets to the home view.
  // Shown only while a filter/search is actually active.
  const FILTER_PARAMS = ['type', 'genre', 'rating', 'votes', 'year', 'lang', 'sort', 'provider', 'theme', 'exclude', 'q', 'actor'];
  const clearFilters = document.createElement('button');
  clearFilters.id = 'tv-clear-filters';
  clearFilters.type = 'button';
  clearFilters.textContent = 'Clear filters';
  document.getElementById('movie-filters')?.append(clearFilters);
  const syncClearFilters = () => {
    const q = new URLSearchParams(location.search);
    clearFilters.hidden = !FILTER_PARAMS.some(p => q.has(p));
  };
  clearFilters.onclick = () => {
    const url = new URL(location.href);
    FILTER_PARAMS.forEach(p => url.searchParams.delete(p));
    location.href = url.href;
  };
  new MutationObserver(syncClearFilters).observe(document.getElementById('main'), { childList: true });
  window.addEventListener('popstate', syncClearFilters);
  syncClearFilters();

  const hint = document.createElement('div');
  hint.className = 'tv-remote-hint';
  hint.textContent = '↑ ↓ ← →  Browse     OK  Select     Back  Return';
  document.body.append(hint);
  const nativeVideo = document.getElementById('player-video');
  const playback = document.createElement('button');
  playback.id = 'tv-play-pause';
  playback.type = 'button';
  playback.textContent = 'Play / pause';
  playback.style.display = 'none';
  playback.onclick = () => {
    if (nativeVideo.paused) nativeVideo.play().catch(() => {});
    else nativeVideo.pause();
  };
  document.querySelector('.player-controls').append(playback);
  let nativeWasVisible = false;
  const syncPlayback = () => {
    const nowVisible = visible(nativeVideo);
    if (nowVisible && !nativeWasVisible) setTimeout(() => {
      if (visible(nativeVideo) && visible(playback)) playback.focus();
    }, 0);
    nativeWasVisible = nowVisible;
    playback.style.display = visible(nativeVideo) ? '' : 'none';
    playback.textContent = nativeVideo.paused ? '▶ Play' : 'Ⅱ Pause';
  };
  new MutationObserver(syncPlayback).observe(nativeVideo, { attributes: true, attributeFilter: ['style'] });
  nativeVideo.addEventListener('play', syncPlayback);
  nativeVideo.addEventListener('pause', syncPlayback);
  const tvPlayer = createTvPlayer(modal, nativeVideo, playback);
  let previousFocus = null;
  let previousMovieId = null;
  let previousRow = null;
  let launchFocus = null;
  // The last card the user was on, tracked however focus arrived (D-pad or pointer).
  // Used to return focus after the details screen or player closes.
  let lastCardFocus = null;
  document.addEventListener('focusin', event => {
    const t = event.target;
    if (t && t.classList && t.classList.contains('tv-card')) lastCardFocus = t;
  });
  // Capture before async metadata/search rendering can remove the focused card.
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('.tv-card, .tv-play, .tv-more-info');
    if (trigger && !visible(modal)) launchFocus = trigger;
  }, true);
  // Restore focus to the card when the details screen closes without starting playback.
  // Deferred a tick so a details->player handoff lets the modal own focus instead.
  let detailsWasOpen = false;
  if (detailsOverlay) new MutationObserver(() => {
    const open = detailsOpen();
    if (open === detailsWasOpen) return;
    detailsWasOpen = open;
    if (!open) setTimeout(() => {
      if (modalOpen() || detailsOpen()) return;
      focus(lastCardFocus && lastCardFocus.isConnected ? lastCardFocus : document.getElementById('tab-movies'));
    }, 0);
  }).observe(detailsOverlay, { attributes: true, attributeFilter: ['hidden'] });
  let modalWasOpen = false;
  const modalOpen = () => visible(modal);
  // Netflix-style anchored rail: the focused card holds a fixed left gutter and the
  // whole track glides under it (CSS transitions the transform). Clamped so it never
  // scrolls past the first or last card.
  const anchorRail = card => {
    const rail = card.closest('.tv-rail');
    const track = rail && rail.querySelector('.tv-rail-track');
    if (!rail || !track) { card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' }); return; }
    const gutter = 12;
    const tx = parseFloat(track.dataset.tx || '0');
    const delta = (rail.getBoundingClientRect().left + gutter) - card.getBoundingClientRect().left;
    let next = tx + delta;
    const min = Math.min(0, rail.clientWidth - track.scrollWidth);
    if (next > 0) next = 0;
    if (next < min) next = min;
    track.dataset.tx = String(next);
    track.style.transform = `translateX(${next}px)`;
  };
  const focus = node => {
    if (!node) return;
    node.focus({ preventScroll: true });
    if (node.classList && node.classList.contains('tv-card')) {
      anchorRail(node);
      node.scrollIntoView({ block: 'nearest', behavior: 'auto' }); // vertical only; horizontal is the transform
    } else {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    }
  };
  let picker = null;
  let pickerSelect = null;
  const closePicker = () => {
    if (!picker) return;
    picker.remove();
    picker = null;
    focus(pickerSelect);
  };
  const openPicker = select => {
    pickerSelect = select;
    picker = document.createElement('div');
    picker.className = 'tv-picker';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-modal', 'true');
    picker.setAttribute('aria-label', select.getAttribute('aria-label') || 'Choose an option');
    const heading = document.createElement('h2');
    heading.textContent = select.getAttribute('aria-label') || 'Choose an option';
    picker.append(heading);
    Array.from(select.options).forEach(option => {
      if (option.disabled || option.hidden) return;
      const button = document.createElement('button');
      button.textContent = (option.selected ? '✓  ' : '') + option.textContent;
      button.dataset.value = option.value;
      button.onclick = () => {
        select.value = option.value;
        closePicker();
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      picker.append(button);
    });
    document.body.append(picker);
    focus(Array.from(picker.querySelectorAll('button')).find(b => b.dataset.value === select.value) || picker.querySelector('button'));
  };
  const candidates = () => {
    const scope = picker
      || (modalOpen() ? (modal.classList.contains('tv-settings-open') ? modal.querySelector('.player-header') : modal)
      : (detailsOpen() ? detailsOverlay : document));
    return Array.from(scope.querySelectorAll(selector)).filter(visible);
  };
  new MutationObserver(() => {
    const open = modalOpen();
    if (open === modalWasOpen) return;
    modalWasOpen = open;
    if (open) {
      previousFocus = launchFocus || document.activeElement;
      launchFocus = null;
      previousMovieId = previousFocus?.dataset.movieId;
      previousRow = previousFocus?.closest('[data-tv-row]')?.dataset.tvRow;
      tvPlayer.open();
      focus(visible(nativeVideo) ? playback : document.getElementById('close-modal'));
    } else {
      const row = Array.from(document.querySelectorAll('[data-tv-row]')).find(r => r.dataset.tvRow === previousRow);
      const matchingCard = scope => Array.from(scope.querySelectorAll('.tv-card')).find(c => c.dataset.movieId === previousMovieId);
      const replacement = previousMovieId && ((row && matchingCard(row)) || matchingCard(document));
      focus(previousFocus?.isConnected && visible(previousFocus) ? previousFocus : replacement || document.getElementById('tab-movies'));
    }
  }).observe(modal, { attributes: true, attributeFilter: ['style'] });
  document.querySelectorAll('.app-tabs button').forEach(button => button.addEventListener('click', () => {
    toggleControls(false);
    window.scrollTo(0, 0);
  }));
  document.addEventListener('keydown', event => {
    const key = event.key || ({ 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter' })[event.keyCode];
    const active = document.activeElement;
    const editing = /INPUT|TEXTAREA|SELECT/.test(active?.tagName || '');
    if (tvPlayer.handleKey(event, key, !!picker)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (backKeys.includes(key) || event.keyCode === 461) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (picker) { closePicker(); return; }
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      if (detailsOpen()) { document.dispatchEvent(new CustomEvent('tv-close-details')); return; }
      if (modalOpen()) { document.getElementById('close-modal').click(); return; }
      if (document.body.classList.contains('tv-controls-open')) { toggleControls(false); focus(controls); return; }
      if (active !== document.getElementById('tab-movies')) { focus(document.getElementById('tab-movies')); return; }
      if (window.webOS?.platformBack) window.webOS.platformBack();
      else if (/web0?os/i.test(navigator.userAgent)) window.close();
      return;
    }
    const video = document.getElementById('player-video');
    if (modalOpen() && video && visible(video) && ([415, 19, 10252].includes(event.keyCode) || ['MediaPlay', 'MediaPause', 'MediaPlayPause'].includes(key))) {
      event.preventDefault();
      if (key === 'MediaPause' || event.keyCode === 19 || ((!['MediaPlay'].includes(key) && event.keyCode !== 415) && !video.paused)) video.pause();
      else video.play().catch(() => {});
      return;
    }
    if (active?.tagName === 'SELECT' && key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
      openPicker(active);
      return;
    }
    // Text inputs keep horizontal cursor editing; selects use a remote option list.
    if (editing && active?.tagName !== 'SELECT' && !['ArrowDown', 'ArrowUp'].includes(key)) return;
    if (key === 'Tab' && (modalOpen() || picker)) {
      const items = candidates();
      const index = items.indexOf(active);
      event.preventDefault();
      focus(items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
    // Native video controls and the custom seek slider own horizontal seeking.
    if ((active?.tagName === 'VIDEO' || active?.id === 'ts-bar') && ['ArrowLeft', 'ArrowRight'].includes(key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const items = candidates();
    if (!modalOpen() && !picker && key === 'ArrowDown' && active?.closest('.header-top') && !document.body.classList.contains('tv-controls-open')) {
      focus(document.querySelector('.tv-play') || document.querySelector('#main ' + selector.split(',')[0]));
      return;
    }
    if (!modalOpen() && !picker && key === 'ArrowUp' && active?.classList.contains('tv-play')) {
      focus(document.querySelector('.app-tab.active'));
      return;
    }
    if (!items.includes(active)) { focus(items[0]); return; }
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    const sign = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
    const origin = active.getBoundingClientRect();
    const ox = origin.left + origin.width / 2;
    const oy = origin.top + origin.height / 2;
    const rail = active.closest('.tv-rail, .rec-scroller');
    if (horizontal && rail) {
      const row = Array.from(rail.querySelectorAll(selector)).filter(visible);
      focus(row[row.indexOf(active) + sign]);
      return;
    }
    let best = null;
    let bestScore = Infinity;
    for (const item of items) {
      if (item === active || active.contains(item) || item.contains(active)) continue;
      const rect = item.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - ox;
      const dy = rect.top + rect.height / 2 - oy;
      const primary = (horizontal ? dx : dy) * sign;
      const secondary = Math.abs(horizontal ? dy : dx);
      if (primary < 8) continue;
      const score = primary + secondary * 3;
      if (score < bestScore) { bestScore = score; best = item; }
    }
    focus(best);
  }, true);
  focus(document.getElementById('tab-movies'));
}
