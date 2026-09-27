import './tv-polyfills.js'; // must load before the app code (webOS Chromium ~79)
import { loadHls } from './hls-loader.js';
// hls.js ships as its own file (public/hls.min.js); live-player.mjs awaits it.
// Warm it in the background a few seconds after start so the first play is instant.
window.__loadHls = () => loadHls(window.__hlsSrc || 'hls.min.js');
setTimeout(() => { window.__loadHls().catch(() => {}); }, 4000);
import './script.js';
import './youtube.js';
import { installTvRemote } from './tv-remote.js';
installTvRemote();
