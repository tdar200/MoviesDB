// Trailer helpers for the TV details screen (pure, so they are unit-tested).

// Long-running shows often have no Trailer or Teaser on TMDB (Grey's Anatomy lists a single Clip),
// so after those come the other YouTube video types, rather than showing nothing.
const FALLBACK_TYPES = ['Clip', 'Featurette', 'Behind the Scenes', 'Opening Credits', 'Bloopers'];
const tierOf = type => (type === 'Trailer' || type === 'Teaser' ? 0 : 1 + (FALLBACK_TYPES.includes(type) ? FALLBACK_TYPES.indexOf(type) : FALLBACK_TYPES.length));

// YouTube keys worth trying, best first: official trailers/teasers, then the fallbacks. `limit` keeps the
// list short (each failed candidate costs a few seconds before the next is tried).
export function rankTrailerVideos(results, limit = 3) {
  const videos = (Array.isArray(results) ? results : []).filter(video => video && video.site === 'YouTube' && video.key);
  videos.sort((a, b) => {
    const tier = tierOf(a.type) - tierOf(b.type);
    if (tier) return tier;
    if (!!a.official !== !!b.official) return a.official ? -1 : 1;
    if (tierOf(a.type) === 0 && a.type !== b.type) return a.type === 'Trailer' ? -1 : 1;
    return 0;
  });
  const keys = [];
  for (const video of videos) if (!keys.includes(video.key)) keys.push(video.key);
  return keys.slice(0, limit);
}

// What the YouTube embed tells its parent once the page has sent the `listening` handshake:
// the player state (1 = playing, 3 = buffering, ...) or an error (101 / 150 = embedding disabled).
export function youtubeTrailerEvent(data) {
  let message = data;
  if (typeof data === 'string') {
    try { message = JSON.parse(data); } catch (error) { return null; }
  }
  if (!message || typeof message !== 'object') return null;
  if (message.event === 'onError') return { kind: 'error', value: message.info };
  if (message.event === 'onStateChange') return { kind: 'state', value: message.info };
  if (message.event === 'infoDelivery' && message.info && message.info.playerState !== undefined) return { kind: 'state', value: message.info.playerState };
  return null;
}
