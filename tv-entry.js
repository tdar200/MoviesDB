import './tv-polyfills.js'; // must load before the app code (webOS Chromium ~79)
import Hls from 'hls.js';
window.Hls = Hls; // live-player.mjs reads it lazily; esbuild downlevels hls.js to ES2019 for webOS
import './script.js';
import './youtube.js';
import { installTvRemote } from './tv-remote.js';
installTvRemote();
