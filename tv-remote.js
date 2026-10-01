import { installProviderControls } from './tv-provider-controls.js';
import { createTvPlayer, setHudButton } from './tv-player.js';
import { virtualizeRows, hydrateRow } from './tv-ui.js';

const ROW_UPKEEP_DELAY_MS = 140;
const UPKEEP_MIN_SLICE_MS = 12; // another row (~10 ms to empty, 30-50 ms to draw on the TV) only if the slice still has this much
// Spatial focus navigation for LG's D-pad, keyboard, and pointer remote.
const selector = 'button:not(:disabled), a[href], input:not([type="hidden"]):not(:disabled), select:not(:disabled), [tabindex="0"], video[controls]';
const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
const backKeys = ['Escape', 'BrowserBack', 'GoBack'];
export function installTvRemote() {
  document.body.classList.add('tv-mode');
  installProviderControls();
  const modal = document.getElementById('player-modal');
  const detailsOverlays = () => Array.from(document.querySelectorAll('.tv-details'));
  const openDetailsOverlay = () => detailsOverlays().find(o => !o.hidden) || null;
  const detailsOpen = () => !!openDetailsOverlay();
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
    // Focus the first FILTER, not the search box — landing on a text input popped the
    // on-screen keyboard every time the panel opened, blocking the filters behind it.
    if (on) (Array.from(header.querySelectorAll('.filter-select')).find(visible) || Array.from(header.querySelectorAll('input[type="search"]')).find(visible))?.focus();
  };

  // Top nav: All / Movies / TV / Live. Replaces the old view tabs (Recommended/Watched/
  // My List/YouTube), whose content now lives as rows on the home. The old tabs stay
  // in the DOM (hidden) because the rest of the app wires to them by id.
  const kindNav = document.createElement('div');
  kindNav.className = 'tv-kind-nav';
  [['all', 'All'], ['movie', 'Movies'], ['tv', 'TV'], ['live', 'Live'], ['cricket', 'Cricket'], ['channels', 'Channels']].forEach(([kind, label], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'app-tab tv-kind-tab' + (i === 0 ? ' active' : '');
    b.dataset.kind = kind;
    b.textContent = label;
    b.onclick = () => {
      toggleControls(false);
      kindNav.querySelector('.tv-top250-tab')?.classList.remove('active');
      rowMemory.clear(); // another tab has other rows: start them at their first card
      if (window.__setTvMediaKind) window.__setTvMediaKind(kind);
    };
    kindNav.append(b);
  });
  // The tab the viewer was last on (script.js saves it and opens that home).
  let savedKind = null;
  try { savedKind = localStorage.getItem('tvMediaKind'); } catch { /* storage blocked */ }
  const savedTab = Array.from(kindNav.querySelectorAll('.tv-kind-tab')).find(b => b.dataset.kind === savedKind);
  if (savedTab) kindNav.querySelectorAll('.tv-kind-tab').forEach(b => b.classList.toggle('active', b === savedTab));
  const imdbTop250 = document.createElement('button');
  imdbTop250.type = 'button';
  imdbTop250.className = 'app-tab tv-top250-tab';
  imdbTop250.textContent = 'IMDb Top 250';
  imdbTop250.onclick = () => {
    toggleControls(false);
    kindNav.querySelectorAll('.tv-kind-tab').forEach(button => button.classList.remove('active'));
    imdbTop250.classList.add('active');
    document.getElementById('top250-btn').click();
  };
  kindNav.append(imdbTop250);
  const appTabs = document.querySelector('.app-tabs');
  if (appTabs) appTabs.parentNode.insertBefore(kindNav, appTabs);
  // The home focus anchor is now the active kind tab (was #tab-movies).
  const homeAnchor = () => document.querySelector('.tv-kind-tab.active') || document.querySelector('.tv-kind-tab') || document.getElementById('tab-movies');

  // Genre / theme / score / provider are browsable ROWS now, so drop them from the
  // filter dropdowns (kept in the DOM so the app's wiring doesn't break). Media type
  // is the top nav. What's left in the panel: year, language, sort, votes, actor, search.
  ['genre', 'theme', 'min-rating', 'provider', 'exclude-genres-btn', 'media-type'].forEach((id) => {
    document.getElementById(id)?.closest('.filter-group, .exclude-dropdown')?.style.setProperty('display', 'none', 'important');
  });
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

  const nativeVideo = document.getElementById('player-video');
  const playback = document.createElement('button');
  playback.id = 'tv-play-pause';
  playback.type = 'button';
  setHudButton(playback, 'play', 'Play');
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
    setHudButton(playback, nativeVideo.paused ? 'play' : 'pause', nativeVideo.paused ? 'Play' : 'Pause');
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
  // Every row remembers the card you were on, so moving up/down lands on THAT row's own
  // position (its first card if you have never been there) and not on the column you
  // happened to be in. Keyed by row title: the rows of one tab have unique titles.
  const rowMemory = new Map();
  const cardsOf = section => Array.from(section.querySelectorAll('.tv-card'));
  // Row upkeep (draw the rows ahead, empty the ones far behind) runs ONLY once the user has paused for a moment,
  // one row per idle slice, and is cancelled by the next key press. On the TV, drawing a row is ~30-50 ms.
  let upkeepTimer = 0;
  let upkeepIdle = 0;
  const whenIdle = fn => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 600 }) : setTimeout(fn, 40));
  const cancelUpkeep = () => {
    clearTimeout(upkeepTimer);
    if (upkeepIdle && window.cancelIdleCallback) window.cancelIdleCallback(upkeepIdle);
    upkeepIdle = 0;
  };
  const upkeepStep = deadline => {
    upkeepIdle = 0;
    const main = document.getElementById('main');
    const active = document.activeElement;
    const section = active && active.closest ? active.closest('.tv-row') : null;
    if (!main || !section || detailsOpen()) return;
    // One row operation at a time, as many as this idle slice has time for. (One per slice could not keep up on a busy
    // TV: idle slices are scarce, every key press cancels the work, and the leftovers piled up as a bigger DOM.)
    let pending = 0;
    do { pending = virtualizeRows(main, section, 1); }
    while (pending > 0 && deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() > UPKEEP_MIN_SLICE_MS);
    if (pending > 0) upkeepIdle = whenIdle(upkeepStep);
  };
  const scheduleRowUpkeep = () => {
    cancelUpkeep();
    upkeepTimer = setTimeout(() => { upkeepIdle = whenIdle(upkeepStep); }, ROW_UPKEEP_DELAY_MS);
  };

  const rememberedCard = section => {
    const cards = cardsOf(section);
    const memo = rowMemory.get(section.dataset.tvRow);
    if (!memo || !cards.length) return cards[0] || null;
    return cards.find(c => c.dataset.movieId === memo.id) || cards[Math.min(memo.index, cards.length - 1)];
  };
  document.addEventListener('focusin', event => {
    const t = event.target;
    // Not a tile inside an overlay (More Like This, a franchise's parts): focus is restored to the card that OPENED the overlay.
    if (t && t.classList && t.classList.contains('tv-card') && !t.closest('.tv-details')) {
      lastCardFocus = t;
      const section = t.closest('.tv-row');
      if (section && section.dataset.tvRow) rowMemory.set(section.dataset.tvRow, { id: t.dataset.movieId, index: cardsOf(section).indexOf(t) });
    }
  });
  // Capture before async metadata/search rendering can remove the focused card.
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('.tv-card, .tv-play, .tv-more-info');
    if (trigger && !visible(modal)) launchFocus = trigger;
  }, true);
  // Restore focus to the card when the details screen closes without starting playback.
  // Deferred a tick so a details->player handoff lets the modal own focus instead.
  // The card that opened the details; if a background repaint (e.g. the Live
  // home refresh) replaced it meanwhile, find its replacement by id.
  const cardToRestore = () => {
    if (!lastCardFocus) return null;
    if (lastCardFocus.isConnected) return lastCardFocus;
    const id = lastCardFocus.dataset && lastCardFocus.dataset.movieId;
    if (!id) return null;
    return Array.from(document.querySelectorAll('.tv-card')).find(c => c.dataset.movieId === id) || null;
  };
  let detailsWasOpen = false;
  const detailsObserver = new MutationObserver(() => {
    const open = detailsOpen();
    if (open === detailsWasOpen) return;
    detailsWasOpen = open;
    if (!open) setTimeout(() => {
      if (modalOpen() || detailsOpen()) return;
      focus(cardToRestore() || homeAnchor());
    }, 0);
  });
  detailsOverlays().forEach(o => detailsObserver.observe(o, { attributes: true, attributeFilter: ['hidden'] }));
  let modalWasOpen = false;
  const modalOpen = () => visible(modal);
  let cardWait = null;
  const awaitCard = (id, rowTitle, parkedOn) => {
    if (cardWait) cardWait.stop();
    const main = document.getElementById('main');
    const find = () => {
      const cards = Array.from(main.querySelectorAll('.tv-card')).filter(c => c.dataset.movieId === id);
      return cards.find(c => c.closest('[data-tv-row]')?.dataset.tvRow === rowTitle) || cards[0] || null;
    };
    const observer = new MutationObserver(() => {
      if (document.activeElement !== parkedOn || modalOpen() || detailsOpen()) { stop(); return; }
      const card = find();
      if (card && visible(card)) { stop(); focus(card); }
    });
    const timer = setTimeout(() => stop(), 10000);
    function stop() { observer.disconnect(); clearTimeout(timer); if (cardWait && cardWait.stop === stop) cardWait = null; }
    cardWait = { stop };
    observer.observe(main, { childList: true, subtree: true });
  };
  // Netflix-style anchored rail: the focused card holds a fixed left gutter and the
  // whole track glides under it (CSS transitions the transform). Clamped so it never
  // scrolls past the first or last card.
  //
  // Pure arithmetic on layout offsets: a card's offsetLeft/offsetWidth are unaffected by the
  // track's transform, by the focus scale and by an in-flight transition, so no
  // getBoundingClientRect / getComputedStyle per key press (each forced a layout on the TV).
  // The rail's gutter and width are measured once per rail and again only after a resize.
  let railMetrics = new WeakMap();
  const metricsOf = rail => {
    let m = railMetrics.get(rail);
    if (!m) { m = { gutter: parseFloat(getComputedStyle(rail).paddingLeft) || 0, width: rail.clientWidth }; railMetrics.set(rail, m); }
    return m;
  };
  const anchorRail = card => {
    const rail = card.closest('.tv-rail');
    const track = rail && rail.querySelector('.tv-rail-track');
    if (!rail || !track) { card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' }); return; }
    const { gutter, width } = metricsOf(rail);
    const tx = parseFloat(track.dataset.tx || '0');
    const left = card.offsetLeft;
    const right = left + card.offsetWidth;
    // The track starts at the rail's padding edge (the gutter), so the visible window in
    // TRACK coordinates is [0, width - 2 * gutter].
    const span = width - 2 * gutter;
    let next = tx;
    if (left + tx < 0) next = -left;
    else if (right + tx > span) next = span - right;
    // Clamp so the LAST card stops at the gutter (and the first never passes it).
    const last = track.lastElementChild;
    const min = Math.min(0, span - (last.offsetLeft + last.offsetWidth));
    if (next > 0) next = 0;
    if (next < min) next = min;
    if (next !== tx) {
      track.dataset.tx = String(next);
      track.style.transform = `translateX(${next}px)`;
    }
  };
  window.addEventListener('resize', () => { railMetrics = new WeakMap(); });
  // Horizontal moves never change a card's vertical position, so the row is only placed
  // when focus ENTERS it (or comes from outside the rails).
  let lastFocusedRow = null;
  const focus = node => {
    if (!node) return;
    node.focus({ preventScroll: true });
    if (node.classList && node.classList.contains('tv-card')) {
      anchorRail(node);
      const section = node.closest('.tv-row');
      if (!section) { lastFocusedRow = null; node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' }); return; }
      if (section !== lastFocusedRow) {
        lastFocusedRow = section;
        // Like a streaming home: the row you enter sits about a third of the way down with
        // the next row peeking in below it, instead of being pinned to the screen edge.
        // One layout read per row change; the scroll itself glides on the compositor.
        const want = Math.round(window.innerHeight * 0.3);
        const delta = section.getBoundingClientRect().top - want;
        if (Math.abs(delta) > 6) window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: 'smooth' });
        scheduleRowUpkeep(); // keep the page small however deep you go (once you pause, never inside the key press)
      }
    } else {
      lastFocusedRow = null;
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    }
  };
  // Other modules (the Live home's focus restore) must go through this so the
  // rail is re-anchored after a repaint.
  window.__tvFocus = focus;
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
      : (openDetailsOverlay() || document));
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
      // Back from the player re-opens that title's details (script.js closePlayer); they own focus.
      if (detailsOpen()) return;
      const row = Array.from(document.querySelectorAll('[data-tv-row]')).find(r => r.dataset.tvRow === previousRow);
      const matchingCard = scope => Array.from(scope.querySelectorAll('.tv-card')).find(c => c.dataset.movieId === previousMovieId);
      const replacement = previousMovieId && ((row && matchingCard(row)) || matchingCard(document));
      // The home repaints when playback records history, replacing the hero. Its
      // Play / More info buttons carry no title id, so match the new hero control
      // by role rather than dropping the viewer back to the top nav.
      const heroControl = !replacement && previousFocus && !previousFocus.isConnected && previousFocus.classList
        ? ['tv-play', 'tv-more-info'].filter(cls => previousFocus.classList.contains(cls)).map(cls => document.querySelector('#main .' + cls)).find(node => node && visible(node))
        : null;
      const target = previousFocus?.isConnected && visible(previousFocus) ? previousFocus : replacement || heroControl || null;
      focus(target || homeAnchor());
      // Closing the player records the watch and repaints the home, which paints
      // its catalogue rows asynchronously: the card the viewer came from may not
      // exist yet. Park on the nav, then move onto the card once its row arrives,
      // unless the viewer has already moved on (bounded wait).
      if (!target && previousMovieId) awaitCard(previousMovieId, previousRow, homeAnchor());
    }
  }).observe(modal, { attributes: true, attributeFilter: ['style'] });
  document.querySelectorAll('.app-tabs button').forEach(button => button.addEventListener('click', () => {
    toggleControls(false);
    window.scrollTo(0, 0);
  }));
  let moveInFrame = false;
  document.addEventListener('keydown', event => {
    const key = event.key || ({ 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter' })[event.keyCode];
    const active = document.activeElement;
    const editing = /INPUT|TEXTAREA|SELECT/.test(active?.tagName || '');
    if (upkeepTimer || upkeepIdle) scheduleRowUpkeep(); // a key press postpones row upkeep until the user pauses again
    if (tvPlayer.handleKey(event, key, !!picker)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (backKeys.includes(key) || event.keyCode === 461) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (picker) { closePicker(); return; }
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      if (detailsOpen()) { document.dispatchEvent(new CustomEvent('tv-close-details')); return; }
      if (modalOpen()) { document.getElementById('close-modal').click(); return; }
      if (document.body.classList.contains('tv-controls-open')) { toggleControls(false); focus(controls); return; }
      if (active !== homeAnchor()) { focus(homeAnchor()); return; }
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
    // A held arrow key auto-repeats faster than an old TV can lay out and paint.
    // Handle at most one move per frame and drop the surplus repeats, so focus
    // stops where the user lets go instead of racing through a queued backlog.
    if (event.repeat && moveInFrame) return;
    moveInFrame = true;
    requestAnimationFrame(() => { moveInFrame = false; });
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    const sign = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
    const rail = active?.closest('.tv-rail, .rec-scroller');
    // Rail navigation is the overwhelmingly common TV action. Resolve it within
    // the current row before scanning every focusable node and forcing visibility
    // checks/layout across the whole document.
    if (horizontal && rail) {
      const row = Array.from(rail.querySelectorAll(selector));
      const next = row[row.indexOf(active) + sign];
      if (next) focus(next);
      return;
    }
    if (!modalOpen() && !picker && key === 'ArrowDown' && active?.closest('.header-top') && !document.body.classList.contains('tv-controls-open')) {
      focus(document.querySelector('.tv-play') || document.querySelector('#main ' + selector.split(',')[0]));
      return;
    }
    if (!modalOpen() && !picker && key === 'ArrowUp' && active?.classList.contains('tv-play')) {
      focus(document.querySelector('.app-tab.active'));
      return;
    }
    // From the hero's buttons, Down goes to the first row (at the position that row was left).
    if (!modalOpen() && !picker && !detailsOpen() && key === 'ArrowDown' && active?.closest('.tv-hero')) {
      const firstRow = document.querySelector('#main .tv-row');
      if (firstRow) { focus(rememberedCard(firstRow)); return; }
    }
    // Move between catalogue rows by column. Geometry-scoring every focusable
    // card made each up/down press scan 800+ cards once the full home loaded.
    if (!modalOpen() && !picker && !detailsOpen() && !horizontal && active?.classList.contains('tv-card')) {
      const section = active.closest('.tv-row');
      const rows = Array.from(document.querySelectorAll('#main .tv-row'));
      const rowIndex = rows.indexOf(section);
      // The nearest row with tiles. A row with none is still loading (skipped: Down used to do NOTHING on it, which
      // looked like a slow remote) or failed (its Retry button takes focus, so a failed row is not a dead end).
      let targetRow = null;
      let retry = null;
      for (let k = rowIndex + sign; k >= 0 && k < rows.length; k += sign) {
        const candidate = rows[k];
        if (candidate.__dry || candidate.querySelector('.tv-card')) { targetRow = candidate; break; }
        const button = candidate.querySelector('button');
        if (button) { retry = button; break; }
      }
      if (targetRow) {
        hydrateRow(targetRow); // a no-op unless it was emptied
        focus(rememberedCard(targetRow));
      } else if (retry) {
        focus(retry);
      } else if (sign < 0) {
        focus(document.querySelector('.tv-play') || homeAnchor());
      }
      return;
    }
    const items = candidates();
    if (!items.includes(active)) { focus(items[0]); return; }
    const origin = active.getBoundingClientRect();
    const ox = origin.left + origin.width / 2;
    const oy = origin.top + origin.height / 2;
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
  focus(homeAnchor());
}
