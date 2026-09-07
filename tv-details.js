// tv-details.js — the Netflix-style details screen shown before playback.
//
// A card no longer drops you straight into the video. It opens this full-bleed
// overlay: backdrop, synopsis, cast, and actions (Play, My List, Not interested),
// plus an episode list for series. Play hands off to the app's existing player.
//
// All app-specific behaviour is injected so this file stays decoupled and testable.
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

export function createTvDetails(deps) {
  const {
    fetchCast, fetchTrailer, fetchTvDetails, fetchSeasonDetails,
    onPlay,
    isStarred, toggleStar, isDownvoted, toggleDownvote, onSignalChanged,
  } = deps;

  const overlay = el('div', 'tv-details');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const backdrop = el('div', 'tv-details-backdrop');
  const trailerHost = el('div', 'tv-details-trailer'); // muted trailer plays over the backdrop
  const scrim = el('div', 'tv-details-scrim');
  const body = el('div', 'tv-details-body');
  overlay.append(backdrop, trailerHost, scrim, body);
  document.body.append(overlay);

  function stopTrailer() { trailerHost.textContent = ''; }

  let current = null;
  let openToken = 0;

  const isOpen = () => !overlay.hidden;

  const close = () => {
    overlay.hidden = true;
    current = null;
    openToken++; // cancel any in-flight enrichment
    stopTrailer();
  };

  const open = movie => {
    current = movie;
    const token = ++openToken;
    const type = isSeries(movie) ? 'tv' : 'movie';
    overlay.hidden = false;
    overlay.scrollTop = 0;
    stopTrailer();
    backdrop.style.backgroundImage = movie.backdrop_path ? `url("${art}w1280${movie.backdrop_path}")` : 'none';

    // Netflix-style: the backdrop shows immediately, then the trailer fades in and
    // autoplays muted. Muted autoplay is allowed; if there is no trailer (or it
    // fails on the TV's old browser), the backdrop simply stays.
    if (fetchTrailer) {
      Promise.resolve(fetchTrailer(type, movie.id)).then(key => {
        if (!key || token !== openToken) return;
        setTimeout(() => {
          if (token !== openToken) return;
          const iframe = document.createElement('iframe');
          iframe.setAttribute('allow', 'autoplay; encrypted-media');
          iframe.setAttribute('frameborder', '0');
          iframe.src = `https://www.youtube.com/embed/${key}?autoplay=1&mute=0&controls=0&rel=0&playsinline=1&loop=1&playlist=${key}&modestbranding=1&iv_load_policy=3`;
          trailerHost.append(iframe);
          trailerHost.classList.add('playing');
        }, 1200);
      }).catch(() => {});
    }

    body.textContent = '';
    body.append(el('h1', 'tv-details-title', titleOf(movie)));

    const meta = el('div', 'tv-details-meta');
    const bits = [yearOf(movie), isSeries(movie) ? 'Series' : 'Film'];
    if (movie.vote_average) bits.push('★ ' + movie.vote_average.toFixed(1));
    meta.textContent = bits.filter(Boolean).join('   ·   ');
    body.append(meta);

    body.append(el('p', 'tv-details-synopsis', movie.overview || 'No synopsis available.'));

    // Actions. Play is focused by default so OK on a card, then OK, just plays.
    const actions = el('div', 'tv-details-actions');
    const play = el('button', 'tv-details-play', '▶  Play');
    play.type = 'button';
    play.addEventListener('click', () => onPlay(movie));
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
    actions.append(play, list, down);
    body.append(actions);

    const cast = el('p', 'tv-details-cast');
    body.append(cast);

    const episodesHost = el('div', 'tv-details-episodes');
    body.append(episodesHost);

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
      buildEpisodes(movie, episodesHost, token);
    }
  };

  async function buildEpisodes(movie, host, token) {
    let details;
    try { details = await fetchTvDetails(movie.id); } catch (e) { return; }
    if (token !== openToken || !details || !details.seasons) return;
    const seasons = details.seasons.filter(s => s.season_number > 0);
    if (!seasons.length) return;
    let currentSeason = seasons[0].season_number;

    host.append(el('h2', 'tv-details-episodes-heading', 'Episodes'));

    // Season chips: focusable, remote-friendly, no cross-module picker needed.
    // Shown only when the series actually has more than one season.
    let chips = null;
    if (seasons.length > 1) {
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
      if (!chips) return;
      Array.from(chips.children).forEach(c => c.classList.toggle('active', c.dataset.season === String(currentSeason)));
    };
    syncChips();
    const listHost = el('div', 'tv-details-episode-list');
    host.append(listHost);

    async function renderSeason(seasonNumber) {
      const localToken = token;
      listHost.textContent = '';
      let season;
      try { season = await fetchSeasonDetails(movie.id, seasonNumber); } catch (e) { return; }
      if (localToken !== openToken || !season || !season.episodes) return;
      season.episodes.forEach(ep => {
        const item = el('button', 'tv-episode');
        item.type = 'button';
        item.dataset.episode = String(ep.episode_number);
        item.dataset.season = String(seasonNumber);
        const still = el('div', 'tv-episode-still');
        if (ep.still_path) still.style.backgroundImage = `url("${art}w300${ep.still_path}")`;
        const info = el('div', 'tv-episode-info');
        info.append(
          el('span', 'tv-episode-title', `${ep.episode_number}. ${ep.name || 'Episode ' + ep.episode_number}`),
          el('span', 'tv-episode-overview', ep.overview || ''),
        );
        item.append(still, info);
        item.addEventListener('click', () => onPlay(movie, { season: seasonNumber, episode: ep.episode_number }));
        listHost.append(item);
      });
    }
    renderSeason(currentSeason);
  }

  return { el: overlay, open, close, isOpen };
}
