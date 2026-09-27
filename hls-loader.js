// Loads hls.js on demand from a separate file so it is not parsed at app start.
// It is ~60% of the TV bundle and only needed once live playback begins.
let pending = null;
export function loadHls(src = 'hls.min.js') {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js did not load')));
    s.onerror = () => { pending = null; reject(new Error('hls.js failed to load')); };
    document.head.appendChild(s);
  });
  return pending;
}
