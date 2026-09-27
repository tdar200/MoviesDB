import './tv-polyfills.js'; // must load before the app code (webOS Chromium ~79)
import Hls from 'hls.js';
// ESM imports are hoisted, so this runs AFTER script.js has evaluated; that is fine
// because live-player.mjs reads window.Hls lazily (getHls()) at play time.
// esbuild downlevels hls.js to ES2019 for webOS.
window.Hls = Hls;
import './script.js';
import './youtube.js';
import { installTvRemote } from './tv-remote.js';
installTvRemote();
