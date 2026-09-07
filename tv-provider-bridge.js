// Injected only into the original 111Movies player on the configured TV.
(function () {
  // webOS Chrome 79 ignores the provider's inset shorthand. Its fixed root
  // collapses to 0 x 0 while the media clock continues to advance.
  function installLayoutFallback() {
    if (document.getElementById('movies-provider-layout')) return;
    var style = document.createElement('style');
    style.id = 'movies-provider-layout';
    style.textContent = '.inset-0{top:0;right:0;bottom:0;left:0}.inset-x-0{left:0;right:0}.inset-y-0{top:0;bottom:0}';
    document.documentElement.appendChild(style);
  }
  if (window.CSS && !window.CSS.supports('inset', '0px')) {
    if (document.documentElement) installLayoutFallback();
    else document.addEventListener('DOMContentLoaded', installLayoutFallback, { once: true });
  }
  if (window.moviesProviderBridgeInstalled) return;
  window.moviesProviderBridgeInstalled = true;
  if (navigator.mediaSession && typeof navigator.mediaSession.setPositionState !== 'function') {
    navigator.mediaSession.setPositionState = function () {};
  }
  var parentOrigin = window.moviesCompat.parentOrigin;
  function send(type, detail) { parent.postMessage({ moviesProvider: true, type: type, detail: detail }, parentOrigin); }
  function video() { return document.querySelector('video'); }
  function control(command, detail) {
    var v = video();
    if (!v) return;
    if (command === 'toggle') { if (v.paused) v.play().catch(function () {}); else v.pause(); }
    if (command === 'play') v.play().catch(function () {});
    if (command === 'pause') v.pause();
    if (command === 'backward' || command === 'forward') v.currentTime = Math.max(0, Math.min(isFinite(v.duration) ? v.duration - 1 : Infinity, v.currentTime + (command === 'backward' ? -10 : 30)));
    if (command === 'restore' && detail && typeof detail.position === 'number' && isFinite(detail.position)) {
      v.currentTime = Math.max(0, Math.min(isFinite(v.duration) ? v.duration - 1 : Infinity, detail.position));
      if (typeof detail.muted === 'boolean') v.muted = detail.muted;
    }
    if (command === 'unmute') { v.muted = false; v.volume = 1; }
  }
  if (!window.moviesPopupGuardInstalled) window.open = function () { return null; };
  window.addEventListener('message', function (event) {
    if (event.origin !== parentOrigin || event.source !== parent || !event.data || !event.data.moviesProviderCommand) return;
    control(event.data.moviesProviderCommand, event.data);
  });
  window.addEventListener('keydown', function (event) {
    var key = event.key;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (event.keyCode === 461 || key === 'Escape' || key === 'GoBack' || key === 'BrowserBack') {
      event.preventDefault(); event.stopImmediatePropagation(); send('back'); return;
    }
    var command = key === 'Enter' || key === ' ' ? 'toggle' : key === 'ArrowLeft' ? 'backward' : key === 'ArrowRight' ? 'forward' : key === 'MediaPlay' || event.keyCode === 415 ? 'play' : key === 'MediaPause' || event.keyCode === 19 ? 'pause' : null;
    if (command) { event.preventDefault(); event.stopImmediatePropagation(); control(command); }
  }, true);
  var healthSamples = [], failureSent = false;
  var lastVideo, lastTime = -1, stalledTicks = 0, recoveries = 0;
  setInterval(function () {
    var v = video();
    // Some webOS decoders freeze when the provider restores a saved position,
    // despite readyState=4 and paused=false. A transport restart recovers them.
    if (v !== lastVideo) { lastVideo = v; lastTime = -1; stalledTicks = 0; recoveries = 0; }
    if (v && !document.hidden && !v.paused && !v.ended && !v.seeking && v.readyState >= 3) {
      if (Math.abs(v.currentTime - lastTime) < 0.1) stalledTicks++;
      else { stalledTicks = 0; recoveries = 0; }
      if (stalledTicks >= 8 && recoveries < 2) {
        stalledTicks = 0; recoveries++;
        v.pause(); v.play().catch(function () {});
      }
    } else stalledTicks = 0;
    lastTime = v ? v.currentTime : -1;
    var terminal = /all servers are currently unavailable|no backup servers available|something went wrong loading the player/i.test(document.body ? document.body.innerText : '');
    // Failed media elements commonly remain paused; still report exhaustion.
    if (!document.hidden && terminal && !failureSent) {
      failureSent = true;
      send('failure', { reason: 'servers-unavailable', time: v ? v.currentTime : 0 });
    }
    if (!document.hidden && (!v || !v.paused) && !(v && v.ended)) {
      healthSamples.push({ time: v ? v.currentTime : 0, rate: v ? v.playbackRate || 1 : 1, frames: v && v.webkitDecodedFrameCount });
      if (healthSamples.length > 31) healthSamples.shift();
      var first = healthSamples[0], progress = v ? v.currentTime - first.time : 0;
      // A seek is a discontinuity, not evidence of healthy playback.
      if (progress < 0 || progress > healthSamples.length * 3) healthSamples = [];
      var stalled = healthSamples.length >= 31 && (progress < 15 * first.rate || (typeof first.frames === 'number' && v && v.webkitDecodedFrameCount === first.frames));
      if ((terminal || stalled) && !failureSent) {
        failureSent = true;
        send('failure', { reason: terminal ? 'servers-unavailable' : 'stalled', time: v ? v.currentTime : 0 });
      }
    } else healthSamples = [];

    send('state', v ? { time: v.currentTime, duration: isFinite(v.duration) ? v.duration : 0, paused: v.paused, muted: v.muted, ready: v.readyState } : { ready: 0 });
  }, 1000);
})();
