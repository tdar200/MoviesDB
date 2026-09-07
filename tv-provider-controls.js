// App-owned controls for the 111Movies player on the TV.
export function installProviderControls() {
  const iframe = document.getElementById('player-iframe');
  const modal = document.getElementById('player-modal');
  const bar = document.createElement('div');
  bar.id = 'tv-provider-controls';
  bar.hidden = true;
  const send = (command, detail = {}) => {
    const origin = iframe.dataset.providerOrigin;
    if (origin) iframe.contentWindow.postMessage({ ...detail, moviesProviderCommand: command }, origin);
  };
  const button = (id, label, command) => {
    const el = document.createElement('button'); el.id = id; el.type = 'button'; el.textContent = label;
    el.onclick = () => send(command); bar.append(el); return el;
  };
  button('tv-provider-backward', '↶ 10s', 'backward');
  const play = button('tv-provider-play', 'Play / pause', 'toggle');
  button('tv-provider-forward', '30s ↷', 'forward');
  const sound = button('tv-provider-sound', 'Sound on', 'unmute');
  const status = document.createElement('span'); status.setAttribute('role', 'status'); bar.append(status);
  document.querySelector('.player-header').append(bar);
  let firstState = true, attempts = 0, lastPosition = 0, lastMuted = true, pendingResume = null, startupTimer;
  function fallback() {
    if (!iframe.dataset.providerOrigin || modal.style.display === 'none') return;
    clearTimeout(startupTimer);
    status.textContent = '111Movies unavailable — switching player…';
    document.dispatchEvent(new CustomEvent('tv-provider-fallback', { detail: { position: lastPosition } }));
  }
  function recover(reason) {
    if (!iframe.dataset.providerOrigin || modal.style.display === 'none') return;
    clearTimeout(startupTimer);
    if (reason === 'manual') attempts = 0;
    // Explicit server exhaustion is terminal; reconnect once for other stalls.
    if (reason === 'servers-unavailable' || attempts >= 1) { fallback(); return; }
    attempts++;
    pendingResume = { position: lastPosition, muted: lastMuted };
    status.textContent = 'Reconnecting 111Movies…';
    firstState = true;
    iframe.src = iframe.src;
    startupTimer = setTimeout(fallback, 45000);
  }
  const retry = button('tv-provider-retry', 'Reconnect', '');
  retry.onclick = () => recover('manual');
  const alternate = button('tv-provider-alternate', 'Use built-in player', '');
  alternate.onclick = fallback;
  new MutationObserver(() => {
    bar.hidden = !iframe.dataset.providerOrigin;
    modal.classList.toggle('tv-provider-active', !bar.hidden);
    firstState = true; attempts = 0; lastPosition = 0; lastMuted = true; pendingResume = null;
    clearTimeout(startupTimer);
    if (!bar.hidden) startupTimer = setTimeout(() => recover('startup-timeout'), 45000);
    status.textContent = bar.hidden ? '' : 'Loading 111Movies…';
  }).observe(iframe, { attributes: true, attributeFilter: ['data-provider-origin'] });
  window.addEventListener('message', event => {
    if (!iframe.dataset.providerOrigin || event.origin !== iframe.dataset.providerOrigin || event.source !== iframe.contentWindow || !event.data?.moviesProvider) return;
    if (event.data.type === 'failure') {
      if (Number.isFinite(event.data.detail?.time) && event.data.detail.time > 0) lastPosition = event.data.detail.time;
      recover(event.data.detail?.reason); return;
    }
    if (event.data.type === 'back') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.getElementById('close-modal').click();
      return;
    }
    if (event.data.type !== 'state' || modal.style.display === 'none') return;
    const state = event.data.detail || {};
    if (pendingResume && state.ready >= 1) {
      send('restore', pendingResume); pendingResume = null; return;
    }
    if (typeof state.muted === 'boolean') lastMuted = state.muted;
    // Metadata alone does not mean the source can play.
    if (state.paused && state.ready >= 3) clearTimeout(startupTimer);
    if (Number.isFinite(state.time) && state.time > 0) {
      if (state.time > lastPosition + 0.1) clearTimeout(startupTimer);
      lastPosition = state.time;
    }
    play.textContent = state.paused ? '▶ Play' : 'Ⅱ Pause';
    if (!state.muted && document.activeElement === sound) play.focus();
    sound.hidden = !state.muted;
    status.textContent = state.ready >= 3 ? '' : 'Loading 111Movies…';
    if (firstState && state.ready >= 3) {
      firstState = false;
      if (document.activeElement.id === 'close-modal') play.focus();
    }
  });
  document.addEventListener('keydown', event => {
    if (bar.hidden || modal.style.display === 'none' || document.querySelector('.tv-picker')) return;
    const command = event.key === 'MediaPlay' || event.keyCode === 415 ? 'play' : event.key === 'MediaPause' || event.keyCode === 19 ? 'pause' : event.key === 'MediaPlayPause' || event.keyCode === 10252 ? 'toggle' : null;
    if (command) { event.preventDefault(); event.stopImmediatePropagation(); send(command); }
  }, true);
}
