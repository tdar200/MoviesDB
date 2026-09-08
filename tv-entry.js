import './tv-polyfills.js'; // must load before the app code (webOS Chromium ~79)
import './script.js';
import './youtube.js';
import { installTvRemote } from './tv-remote.js';
installTvRemote();
