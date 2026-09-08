// Polyfills for the webOS TV browser (Chromium ~79), which predates some DOM APIs
// the shared app code uses. Loaded first by tv-entry.js so everything downstream can
// rely on them. On modern browsers these guards are no-ops.

// replaceChildren (Chrome 86+): used by the recommendations page renderer. Without
// this, the Recommended tab throws "replaceChildren is not a function" on the TV.
(function () {
  if (typeof Element === 'undefined' || Element.prototype.replaceChildren) return;
  function replaceChildren() {
    while (this.firstChild) this.removeChild(this.firstChild);
    if (arguments.length) this.append.apply(this, arguments);
  }
  Element.prototype.replaceChildren = replaceChildren;
  if (typeof DocumentFragment !== 'undefined' && DocumentFragment.prototype && !DocumentFragment.prototype.replaceChildren) {
    DocumentFragment.prototype.replaceChildren = replaceChildren;
  }
  if (typeof Document !== 'undefined' && Document.prototype && !Document.prototype.replaceChildren) {
    Document.prototype.replaceChildren = replaceChildren;
  }
})();
