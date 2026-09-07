// Injected only into 111Movies and its descendants under the configured TV app.
(function () {
  if (window.moviesPopupGuardInstalled) return;
  window.moviesPopupGuardInstalled = true;
  function blockOpen(target) {
    try { Object.defineProperty(target, 'open', { value: function () { return null; }, writable: false, configurable: false }); } catch (_) {}
  }
  blockOpen(window);
  function externalTarget(el) {
    var target = (el.getAttribute('target') || '').toLowerCase();
    return target && target !== '_self';
  }
  function cancelNavigation(event) {
    var el = event.target && event.target.closest ? event.target.closest('a[target],area[target],form[target]') : null;
    if (el && externalTarget(el)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  window.addEventListener('click', cancelNavigation, true);
  window.addEventListener('auxclick', cancelNavigation, true);
  window.addEventListener('submit', cancelNavigation, true);
  var submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () { if (!externalTarget(this)) return submit.apply(this, arguments); };
  function inspectFrames() {
    Array.prototype.forEach.call(document.querySelectorAll('iframe'), function (frame) {
      var src = (frame.getAttribute('src') || '').trim();
      if (src && src !== 'about:blank') return;
      if (frame.hasAttribute('srcdoc')) return;
      // Blank ad frames supply a fresh window.open even if the player blocks it.
      try { blockOpen(frame.contentWindow); } catch (_) {}
      var style = getComputedStyle(frame), rect = frame.getBoundingClientRect();
      if (style.position === 'fixed' && Number(style.zIndex) >= 2147480000 && rect.width >= innerWidth * 0.8 && rect.height >= innerHeight * 0.8) {
        frame.style.setProperty('display', 'none', 'important');
        frame.remove();
      }
    });
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(function () { queued = false; inspectFrames(); });
  }
  new MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src', 'srcdoc'] });
  window.addEventListener('resize', schedule);
  inspectFrames();
})();
