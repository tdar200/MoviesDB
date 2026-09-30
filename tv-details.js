// tv-details.js — the Netflix-style details screen shown before playback.
//
// A card no longer drops you straight into the video. It opens this full-bleed
// overlay: backdrop, synopsis, cast, and actions (Play, My List, Not interested),
// plus an episode list for series. Play hands off to the app's existing player.
//
// All app-specific behaviour is injected so this file stays decoupled and testable.
import { createTvCard } from './tv-ui.js';
import { youtubeTrailerEvent } from './tv-trailers.js';

const art = 'https://image.tmdb.org/t/p/';
const titleOf = m => m.title || m.name || 'Untitled';
const yearOf = m => (m.release_date || m.first_air_date || '').slice(0, 4);
const isSeries = m => m.media_type === 'tv' || (m.name && !m.title);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// mm:ss or h:mm:ss for the Resume label.
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

// Recommendations lead, similar titles fill any gaps. Identity includes media type
// so a movie and series sharing a numeric TMDB id remain distinct.
export function mergeTitleRecommendations(recommended, similar, current, limit = 20) {
  const out = [];
  const seen = new Set();
  const currentType = current && (current.media_type === 'tv' || (current.name && !current.title)) ? 'tv' : 'movie';
  const currentKey = current && current.id != null ? `${currentType}:${current.id}` : '';
  for (const item of [...(recommended || []), ...(similar || [])]) {
    if (!item || item.id == null) continue;
    const type = item.media_type === 'tv' || (item.name && !item.title) ? 'tv' : currentType;
    const key = `${type}:${item.id}`;
    if (key === currentKey || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, media_type: type });
    if (out.length >= limit) break;
  }
  return out;
}

export function createTvDetails(deps) {
  const {
    fetchCast, fetchTrailer, fetchTvDetails, fetchSeasonDetails, fetchRecommendations,
    onPlay, getResume, getProgress,
    isStarred, toggleStar, isDownvoted, toggleDownvote, onSignalChanged,
  } = deps;

  const overlay = el('div', 'tv-details');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const backdrop = el('div', 'tv-details-backdrop');
  const trailerHost = el('div', 'tv-details-trailer'); // muted trailer plays over the backdrop
  const scrim = el('div', 'tv-details-scrim');
  // The player needs 3-6 s of its own on the TV; this says so instead of leaving a silent wait.
  const trailerHint = el('div', 'tv-details-trailer-hint', 'Loading trailer\u2026');
  const body = el('div', 'tv-details-body');
  overlay.append(backdrop, trailerHost, scrim, trailerHint, body);
  document.body.append(overlay);

  // The trailer: candidates are tried in order, and the video layer is revealed ONLY once YouTube reports
  // the video playing, so an embed that is blocked, slow or failing never shows as a black box. Once it plays
  // it keeps playing behind the screen while the viewer browses (pausing it mid-browse was bad UX).
  let trailerCleanup = null;
  let trailerWanted = false;
  function stopTrailer() {
    trailerWanted = false;
    if (trailerCleanup) { trailerCleanup(); trailerCleanup = null; }
    trailerHost.textContent = '';
    trailerHost.classList.remove('playing');
    overlay.classList.remove('trailer-loading');
  }
  const TRAILER_GIVE_UP_MS = 14000; // normal start on the TV is 4-6 s
  function startTrailer(keys, token) {
    const tryKey = index => {
      if (token !== openToken || !trailerWanted || index >= keys.length) return;
      const key = keys[index];
      const iframe = document.createElement('iframe');
      iframe.setAttribute('allow', 'autoplay; encrypted-media');
      iframe.setAttribute('frameborder', '0');
      let settled = false;
      let giveUp = null;
      const onMessage = event => {
        if (event.source !== iframe.contentWindow) return;
        let host = '';
        try { host = new URL(event.origin).hostname; } catch (error) { return; }
        if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;
        const seen = youtubeTrailerEvent(event.data);
        if (!seen || settled) return;
        if (seen.kind === 'error') fail();
        else if (seen.value === 1) { settled = true; clearTimeout(giveUp); trailerHost.classList.add('playing'); overlay.classList.remove('trailer-loading'); }
      };
      const cleanup = () => { window.removeEventListener('message', onMessage); clearTimeout(giveUp); };
      function fail() {
        if (settled) return;
        settled = true;
        cleanup();
        iframe.remove();
        trailerHost.classList.remove('playing');
        if (index + 1 >= keys.length) overlay.classList.remove('trailer-loading'); // nothing left to try
        tryKey(index + 1);
      }
      window.addEventListener('message', onMessage);
      trailerCleanup = cleanup;
      // The embed only reports its state to a page that says it is listening.
      iframe.addEventListener('load', () => {
        try {
          const target = iframe.contentWindow;
          target.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
          ['onError', 'onStateChange'].forEach(name => target.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: [name], id: 1, channel: 'widget' }), '*'));
        } catch (error) { /* an unreachable frame just means no events: the give-up timer handles it */ }
      });
      iframe.src = `https://www.youtube.com/embed/${key}?autoplay=1&mute=0&controls=0&rel=0&playsinline=1&loop=1&playlist=${key}&modestbranding=1&iv_load_policy=3&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
      trailerHost.append(iframe);
      overlay.classList.add('trailer-loading');
      giveUp = setTimeout(fail, TRAILER_GIVE_UP_MS);
    };
    tryKey(0);
  }
  // Closing the screen silences the trailer at once (it would otherwise keep playing inside the hidden overlay) but
  // destroys the player when the TV is idle: tearing a YouTube player down is ~350 ms of main-thread work, which
  // showed as a freeze on Back. While the screen is OPEN the trailer keeps playing, whatever you are browsing.
  function retireTrailer() {
    trailerWanted = false;
    if (trailerCleanup) { trailerCleanup(); trailerCleanup = null; }
    trailerHost.classList.remove('playing');
    overlay.classList.remove('trailer-loading');
    const iframe = trailerHost.querySelector('iframe');
    if (!iframe) return;
    try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*'); } catch (error) { /* frame gone */ }
    const destroy = () => { if (!trailerWanted && iframe.parentNode === trailerHost) trailerHost.textContent = ''; };
    if (window.requestIdleCallback) window.requestIdleCallback(destroy, { timeout: 3000 });
    else setTimeout(destroy, 1500);
  }

  let current = null;
  let openToken = 0;
  let metaEl = null; // the year / kind / rating line; a series adds its season count

  const isOpen = () => !overlay.hidden;

  const close = () => {
    overlay.hidden = true;
    current = null;
    openToken++; // cancel any in-flight enrichment
    retireTrailer();
  };

  // opts.trailer === false: returning from the player must not restart the trailer.
  const open = (movie, opts = {}) => {
    current = movie;
    const token = ++openToken;
    const type = isSeries(movie) ? 'tv' : 'movie';
    overlay.hidden = false;
    overlay.scrollTop = 0;
    stopTrailer();
    backdrop.style.backgroundImage = movie.backdrop_path ? `url("${art}w1280${movie.backdrop_path}")` : 'none';

    // Netflix-style: the backdrop shows immediately, then the trailer fades in and
    // autoplays WITH SOUND (mute=0, per the user's request — the TV browser honours
    // unmuted autoplay). If there is no trailer (or it fails on the TV's old
    // browser), the backdrop simply stays.
    if (fetchTrailer && opts.trailer !== false) {
      trailerWanted = true;
      // The app passes the ranked candidate keys (a string still works).
      Promise.resolve(fetchTrailer(type, movie.id)).then(found => {
        const keys = Array.isArray(found) ? found : (found ? [found] : []);
        if (!keys.length || token !== openToken) return;
        startTrailer(keys, token); // no fixed wait: the backdrop is already up and the player needs 3-6 s of its own
      }).catch(() => {});
    }

    body.textContent = '';
    body.append(el('h1', 'tv-details-title', titleOf(movie)));

    const meta = el('div', 'tv-details-meta');
    metaEl = meta;
    const bits = [yearOf(movie), isSeries(movie) ? 'Series' : 'Film'];
    if (movie.vote_average) bits.push('★ ' + movie.vote_average.toFixed(1));
    meta.textContent = bits.filter(Boolean).join('   ·   ');
    body.append(meta);

    body.append(el('p', 'tv-details-synopsis', movie.overview || 'No synopsis available.'));

    // Actions. Play is focused by default so OK on a card, then OK, just plays.
    // If there's saved progress, the primary button Resumes (with the right episode
    // + timestamp) and a second button starts from the beginning.
    const actions = el('div', 'tv-details-actions');
    const isTv = movie.media_type === 'tv' || (movie.name && !movie.title);
    const resume = getResume ? getResume(movie) : null;
    // Where a series stands, even with no resume point (e.g. the last episode finished and
    // the next one is queued): its season opens, its episode is marked, Play says "Continue".
    const progress = isTv && getProgress ? getProgress(movie) : null;
    const reached = progress && progress.season && progress.episode && !(progress.season === 1 && progress.episode === 1) ? progress : null;
    const where = isTv ? (resume && resume.season ? resume : (reached || (progress && progress.season ? progress : null))) : null;
    const resumeLabel = resume
      ? `▶  Resume${isTv && resume.season && resume.episode ? ` · S${resume.season}E${resume.episode}` : ''} · ${fmtTime(resume.positionSec)}`
      : reached ? `▶  Continue · S${reached.season}E${reached.episode}` : '▶  Play';
    const play = el('button', 'tv-details-play', resumeLabel);
    play.type = 'button';
    play.addEventListener('click', () => resume
      ? onPlay(movie, { season: resume.season, episode: resume.episode, startSec: resume.positionSec })
      : reached ? onPlay(movie, { season: reached.season, episode: reached.episode })
        : onPlay(movie));
    let restart = null;
    if (resume) {
      restart = el('button', 'tv-details-restart', '↺  Start from beginning');
      restart.type = 'button';
      restart.addEventListener('click', () => onPlay(movie, isTv ? { season: 1, episode: 1, startSec: 0 } : { startSec: 0 }));
    }
    const list = el('button', 'tv-details-list');
    list.type = 'button';
    const syncList = () => {
      const on = isStarred(movie.id);
      list.textContent = on ? '✓  My List' : '＋  My List';
      list.setAttribute('aria-pressed', String(on));
    };
    const down = el('button', 'tv-details-down');
    down.type = 'button';
    const syncDown = () => {
      const on = isDownvoted(movie.id);
      down.textContent = on ? '✓  Not interested' : '👎  Not interested';
      down.setAttribute('aria-pressed', String(on));
    };
    list.addEventListener('click', () => { toggleStar(movie); syncList(); syncDown(); onSignalChanged && onSignalChanged(); });
    down.addEventListener('click', () => { toggleDownvote(movie); syncDown(); syncList(); onSignalChanged && onSignalChanged(); });
    syncList();
    syncDown();
    actions.append(play, ...(restart ? [restart] : []), list, down);
    body.append(actions);

    const cast = el('p', 'tv-details-cast');
    body.append(cast);

    const episodesHost = el('div', 'tv-details-episodes');
    body.append(episodesHost);

    const recommendationsHost = el('section', 'tv-details-recommendations');
    body.append(recommendationsHost);

    play.focus({ preventScroll: true });

    // Cast, asynchronously; ignore if the overlay moved on.
    if (fetchCast) {
      Promise.resolve(fetchCast(type, movie.id)).then(list => {
        if (token !== openToken) return;
        const names = (list || []).slice(0, 5).map(c => c.name).filter(Boolean);
        if (names.length) cast.textContent = 'Starring: ' + names.join(', ');
      }).catch(() => {});
    }

    if (isSeries(movie) && fetchTvDetails && fetchSeasonDetails) {
      buildEpisodes(movie, episodesHost, token, where);
    }

    if (fetchRecommendations) {
      Promise.resolve(fetchRecommendations(type, movie.id)).then(movies => {
        if (token !== openToken || !movies || !movies.length) return;
        recommendationsHost.append(el('h2', 'tv-details-recommendations-heading', 'More Like This'));
        const rail = el('div', 'tv-rail');
        rail.setAttribute('aria-label', `More like ${titleOf(movie)}`);
        const track = el('div', 'tv-rail-track');
        movies.forEach(item => track.append(createTvCard(item, open)));
        rail.append(track);
        recommendationsHost.append(rail);
      }).catch(() => {});
    }
  };

  async function buildEpisodes(movie, host, token, where) {
    let details;
    try { details = await fetchTvDetails(movie.id); } catch (e) { return; }
    if (token !== openToken || !details || !details.seasons) return;
    const seasons = details.seasons.filter(s => s.season_number > 0);
    if (!seasons.length) return;
    if (metaEl && token === openToken) metaEl.textContent += `   ·   ${seasons.length} Season${seasons.length > 1 ? 's' : ''}`;
    // Open on the season the viewer is in (not always Season 1), when the show has it.
    const inSeason = where && seasons.find(s => s.season_number === where.season);
    let currentSeason = inSeason ? inSeason.season_number : seasons[0].season_number;

    host.append(el('h2', 'tv-details-episodes-heading', 'Episodes'));

    // Up to six seasons fit as chips. More than that is a dropdown: the TV's own picker lists EVERY season with
    // its episode count (a row of 38 chips wrapped into 8 rows, then into one clipped row that hid most of them).
    const SEASON_CHIPS_MAX = 6;
    let chips = null;
    let seasonSelect = null;
    if (seasons.length > SEASON_CHIPS_MAX) {
      seasonSelect = document.createElement('select');
      seasonSelect.className = 'tv-season-select';
      seasonSelect.setAttribute('aria-label', 'Season');
      seasons.forEach(s => {
        const option = document.createElement('option');
        option.value = String(s.season_number);
        const named = s.name && !/^Season \d+$/i.test(s.name) ? `${s.name} (Season ${s.season_number})` : `Season ${s.season_number}`;
        option.textContent = s.episode_count ? `${named}   ·   ${s.episode_count} episodes` : named;
        seasonSelect.append(option);
      });
      seasonSelect.addEventListener('change', () => {
        currentSeason = Number(seasonSelect.value);
        renderSeason(currentSeason);
      });
      host.append(seasonSelect);
    } else if (seasons.length > 1) {
      chips = el('div', 'tv-season-chips');
      seasons.forEach(s => {
        const chip = el('button', 'tv-season-chip', s.name || `Season ${s.season_number}`);
        chip.type = 'button';
        chip.dataset.season = String(s.season_number);
        chip.addEventListener('click', () => {
          currentSeason = s.season_number;
          syncChips();
          renderSeason(currentSeason);
        });
        chips.append(chip);
      });
      host.append(chips);
    }
    const syncChips = () => {
      if (chips) Array.from(chips.children).forEach(c => c.classList.toggle('active', c.dataset.season === String(currentSeason)));
      if (seasonSelect) seasonSelect.value = String(currentSeason);
    };
    syncChips();
    const listHost = el('div', 'tv-details-episode-list');
    host.append(listHost);

    // Quick season changes race: only the latest request may paint, and it clears
    // the list itself, after its await, so two seasons never interleave.
    let seasonRequest = 0;
    async function renderSeason(seasonNumber) {
      const localToken = token;
      const request = ++seasonRequest;
      listHost.textContent = '';
      let season = null;
      try { season = await fetchSeasonDetails(movie.id, seasonNumber); } catch (e) { season = null; }
      if (localToken !== openToken || request !== seasonRequest) return;
      listHost.textContent = '';
      if (!season || !season.episodes || !season.episodes.length) {
        listHost.append(el('p', 'tv-episode-empty', season ? 'No episodes listed for this season yet.' : 'Couldn\u2019t load this season. Choose it again to retry.'));
        return;
      }
      // Episodes are drawn a page at a time (a season can have 25): more arrive as focus nears the end.
      const makeEpisode = ep => {
        const item = el('button', 'tv-episode');
        item.type = 'button';
        item.dataset.episode = String(ep.episode_number);
        item.dataset.season = String(seasonNumber);
        if (where && seasonNumber === where.season && ep.episode_number === where.episode) { item.classList.add('current'); item.setAttribute('aria-current', 'true'); }
        const still = el('div', 'tv-episode-still');
        if (ep.still_path) still.style.backgroundImage = `url("${art}w300${ep.still_path}")`;
        const info = el('div', 'tv-episode-info');
        info.append(
          el('span', 'tv-episode-title', `${ep.episode_number}. ${ep.name || 'Episode ' + ep.episode_number}`),
          el('span', 'tv-episode-overview', ep.overview || ''),
        );
        item.append(still, info);
        item.addEventListener('click', () => onPlay(movie, { season: seasonNumber, episode: ep.episode_number }));
        return item;
      };
      const PAGE = 12;
      const current = where && where.season === seasonNumber ? where.episode : 0;
      const firstPage = Math.max(PAGE, current + 2); // the episode you are on is always drawn
      season.episodes.slice(0, firstPage).forEach(ep => listHost.append(makeEpisode(ep)));
      pendingEpisodes = season.episodes.slice(firstPage);
      pendingMake = makeEpisode;
    }
    let pendingEpisodes = [];
    let pendingMake = null;
    listHost.addEventListener('focusin', event => {
      const item = event.target.closest && event.target.closest('.tv-episode');
      if (!item || !pendingEpisodes.length || !pendingMake) return;
      if (Array.prototype.indexOf.call(listHost.children, item) < listHost.children.length - 3) return;
      pendingEpisodes.splice(0, 12).forEach(ep => listHost.append(pendingMake(ep)));
    });
    renderSeason(currentSeason);
  }

  return { el: overlay, open, close, isOpen };
}
