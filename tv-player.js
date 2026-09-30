import { installTvSubtitles } from './tv-subtitles.js';

const timeText = value => {
  const seconds = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
// Transport icons (24x24, filled with currentColor). A button is an icon over a small label.
const ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  back: '<path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.2" font-size="7.4" font-weight="700" text-anchor="middle" fill="currentColor">10</text>',
  forward: '<path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.2" font-size="7.4" font-weight="700" text-anchor="middle" fill="currentColor">30</text>',
  next: '<path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>',
  options: '<path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/>',
  retry: '<path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>',
};
export function setHudButton(button, icon, label) {
  button.innerHTML = `<svg class="tv-hud-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon] || ''}</svg><span class="tv-hud-label">${label}</span>`;
  button.setAttribute('aria-label', label);
  button.title = label;
}

// What the HUD shows in live mode: no progress bar, no seek, a LIVE label.
export function liveHudState(live) {
  return live
    ? { showProgress: false, showSeekButtons: false, timeText: 'LIVE', help: 'OK Play / pause · Back Return' }
    : { showProgress: true, showSeekButtons: true, timeText: null, help: '← → Seek · OK Play / pause · Back Return' };
}
export function createTvPlayer(modal, video, playButton) {
  video.controls = false;
  installTvSubtitles(modal, video);
  const hud = document.createElement('div');
  hud.className = 'tv-player-hud';
  hud.innerHTML = '<h2 id="tv-now-playing"></h2><button id="tv-progress" role="slider" aria-label="Playback position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="tv-progress-fill"></span></button><div class="tv-player-time">0:00 / 0:00</div><div class="tv-player-actions"></div><p class="tv-player-help">← → Seek · OK Play / pause · Back Return</p>';
  modal.querySelector('.modal-content').append(hud);
  const actions = hud.querySelector('.tv-player-actions');
  const add = (id, icon, label, click) => {
    const button = document.createElement('button'); button.id = id; button.type = 'button'; setHudButton(button, icon, label); button.onclick = click; actions.append(button); return button;
  };
  const seek = delta => document.dispatchEvent(new CustomEvent('tv-seek', { detail: delta }));
  const rewind = add('tv-rewind', 'back', 'Back 10s', () => seek(-10));
  actions.append(playButton);
  const forward = add('tv-forward', 'forward', 'Forward 30s', () => seek(30));
  const settings = add('tv-player-settings', 'options', 'Audio & Subtitles', () => {
    modal.classList.add('tv-settings-open');
    reveal();
    const options = Array.from(modal.querySelectorAll('.player-header select')).filter(el => el.getClientRects().length);
    (options.find(el => el.id === 'subtitle-select') || options[0])?.focus();
  });
  const retry = add('tv-retry', 'retry', 'Retry', () => document.dispatchEvent(new Event('tv-retry-playback')));
  retry.style.display = 'none';
  const status = document.getElementById('yts-status');
  new MutationObserver(() => {
    const error = status.style.display !== 'none' && status.classList.contains('error');
    retry.style.display = error ? '' : 'none';
    if (error) reveal();
  }).observe(status, { attributes: true, attributeFilter: ['class', 'style'] });
  const next = add('tv-next', 'next', 'Next Episode', () => document.getElementById('next-episode').click());
  const progress = hud.querySelector('#tv-progress');
  progress.onclick = event => {
    if (!event.clientX) return;
    const rect = progress.getBoundingClientRect();
    document.dispatchEvent(new CustomEvent('tv-seek-to', { detail: (event.clientX - rect.left) / rect.width }));
  };
  let timer;
  let position = 0;
  let duration = 0;
  const isOpen = () => modal.style.display !== 'none' && video.style.display !== 'none';
  function reveal() {
    modal.classList.remove('tv-hud-hidden');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!isOpen() || video.paused || video.readyState < 3 || modal.classList.contains('tv-settings-open') || document.querySelector('.tv-picker')) return;
      modal.classList.add('tv-hud-hidden');
      if (modal.contains(document.activeElement)) document.activeElement.blur();
    }, 4500);
  }
  const isLive = () => modal.dataset.live === '1';
  function applyLiveHud() {
    const s = liveHudState(isLive());
    progress.style.display = s.showProgress ? '' : 'none';
    rewind.style.display = s.showSeekButtons ? '' : 'none';
    forward.style.display = s.showSeekButtons ? '' : 'none';
    hud.querySelector('.tv-player-help').textContent = s.help;
    const time = hud.querySelector('.tv-player-time');
    if (s.timeText) time.textContent = s.timeText;
    else if (time.textContent === 'LIVE') time.textContent = '0:00 / 0:00'; // leaving live: do not keep the label on an embed
    modal.classList.toggle('tv-live', isLive());
  }
  const update = () => {
    applyLiveHud();
    modal.classList.toggle('tv-native-player', video.style.display !== 'none');
    modal.classList.toggle('tv-embed-player', video.style.display === 'none');
    hud.querySelector('#tv-now-playing').textContent = document.getElementById('player-title').textContent;
    next.style.display = document.getElementById('episode-controls').style.display !== 'none' ? '' : 'none';
    next.disabled = document.getElementById('next-episode').disabled;
    if (!isOpen()) { clearTimeout(timer); modal.classList.remove('tv-settings-open', 'tv-hud-hidden'); }
  };
  new MutationObserver(update).observe(modal, { attributes: true, attributeFilter: ['style', 'data-live'] });
  new MutationObserver(update).observe(video, { attributes: true, attributeFilter: ['style'] });
  new MutationObserver(update).observe(document.getElementById('player-title'), { childList: true });
  new MutationObserver(update).observe(document.getElementById('next-episode'), { attributes: true, attributeFilter: ['disabled'] });
  video.addEventListener('playing', reveal);
  video.addEventListener('pause', reveal);
  video.addEventListener('waiting', reveal);
  modal.addEventListener('mousemove', () => { if (isOpen()) reveal(); });
  modal.addEventListener('click', () => { if (isOpen()) reveal(); });
  document.addEventListener('tv-playback-time', event => {
    if (isLive()) return;
    ({ position, duration } = event.detail);
    const percent = duration ? Math.min(100, position / duration * 100) : 0;
    progress.querySelector('span').style.width = `${percent}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(percent)));
    progress.setAttribute('aria-valuetext', `${timeText(position)} of ${timeText(duration)}`);
    hud.querySelector('.tv-player-time').textContent = `${timeText(position)} / ${duration ? timeText(duration) : 'Loading duration…'}`;
  });
  return {
    open() { update(); reveal(); },
    handleKey(event, key, pickerOpen) {
      if (!isOpen() || pickerOpen) return false;
      const back = event.keyCode === 461 || ['Escape', 'GoBack', 'BrowserBack'].includes(key);
      if (back && modal.classList.contains('tv-settings-open')) {
        modal.classList.remove('tv-settings-open'); reveal(); settings.focus(); return true;
      }
      if (back) return false;
      // Live has nothing to seek: media rewind/fast-forward only reveal the HUD.
      if (isLive() && ([412, 417].includes(event.keyCode) || ['MediaRewind', 'MediaFastForward'].includes(key))) { reveal(); playButton.focus(); return true; }
      if ([412,417].includes(event.keyCode) || ['MediaRewind','MediaFastForward'].includes(key)) { seek(event.keyCode === 412 || key === 'MediaRewind' ? -10 : 30); reveal(); progress.focus(); return true; }
      if (modal.classList.contains('tv-settings-open')) return false;
      const hidden = modal.classList.contains('tv-hud-hidden');
      // Live: Left/Right are captured (reveal, no seek) only on the same terms as the
      // on-demand seek below, so with the HUD up they move focus to Retry/settings.
      if (isLive() && (hidden || document.activeElement === progress) && ['ArrowLeft','ArrowRight'].includes(key)) { reveal(); playButton.focus(); return true; }
      if ((hidden || document.activeElement === progress) && ['ArrowLeft','ArrowRight'].includes(key)) {
        seek(key === 'ArrowLeft' ? -10 : 30); reveal(); progress.focus(); return true;
      }
      if (hidden && key === 'Enter') { playButton.click(); reveal(); playButton.focus(); return true; }
      if (hidden && ['ArrowUp','ArrowDown'].includes(key)) { reveal(); playButton.focus(); return true; }
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter'].includes(key)) reveal();
      return false;
    },
  };
}
