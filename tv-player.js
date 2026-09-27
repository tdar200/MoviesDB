import { installTvSubtitles } from './tv-subtitles.js';

const timeText = value => {
  const seconds = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
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
  const add = (id, text, click) => {
    const button = document.createElement('button'); button.id = id; button.type = 'button'; button.textContent = text; button.onclick = click; actions.append(button); return button;
  };
  const seek = delta => document.dispatchEvent(new CustomEvent('tv-seek', { detail: delta }));
  const rewind = add('tv-rewind', '↶ 10 seconds', () => seek(-10));
  actions.append(playButton);
  const forward = add('tv-forward', '30 seconds ↷', () => seek(30));
  const settings = add('tv-player-settings', 'Audio, subtitles & episodes', () => {
    modal.classList.add('tv-settings-open');
    reveal();
    const options = Array.from(modal.querySelectorAll('.player-header select')).filter(el => el.getClientRects().length);
    (options.find(el => el.id === 'subtitle-select') || options[0])?.focus();
  });
  settings.textContent = 'Playback options'; // No audio-track selector is implemented.
  const retry = add('tv-retry', 'Retry playback', () => document.dispatchEvent(new Event('tv-retry-playback')));
  retry.style.display = 'none';
  const status = document.getElementById('yts-status');
  new MutationObserver(() => {
    const error = status.style.display !== 'none' && status.classList.contains('error');
    retry.style.display = error ? '' : 'none';
    if (error) reveal();
  }).observe(status, { attributes: true, attributeFilter: ['class', 'style'] });
  const next = add('tv-next', 'Next episode →', () => document.getElementById('next-episode').click());
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
    if (s.timeText) hud.querySelector('.tv-player-time').textContent = s.timeText;
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
      if (isLive() && ([412, 417].includes(event.keyCode) || ['MediaRewind', 'MediaFastForward', 'ArrowLeft', 'ArrowRight'].includes(key))) { reveal(); playButton.focus(); return true; }
      if ([412,417].includes(event.keyCode) || ['MediaRewind','MediaFastForward'].includes(key)) { seek(event.keyCode === 412 || key === 'MediaRewind' ? -10 : 30); reveal(); progress.focus(); return true; }
      if (modal.classList.contains('tv-settings-open')) return false;
      const hidden = modal.classList.contains('tv-hud-hidden');
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
