// embed-sources.js — the single source of truth for streaming embed providers.
//
// Imported by both the app (script.js) and the live link-checker (check-links.mjs),
// so the checker can never drift from what the app actually tries to play.
//
// Each source has a `getUrl(type, id, season, episode)` that returns the embed URL
// for a TMDB id. `type` is 'movie' or 'tv'; season/episode apply to tv only.

// Video embed sources - Updated Jul 18, 2026
// Ordered BEST -> WORST. This array order IS the ranking shown in the app's
// source dropdown (populateSourceSelector renders it top-to-bottom), and index 0
// is the default source.
//
// Ranking basis: what loads reliably in a REAL browser first (this is the
// authority — automated playback ≠ user experience: VixSrc streamed under
// headless Chrome but serves the user a Cloudflare "you have been blocked" page,
// so it is NOT a good default). Mainstream/proven providers lead; providers that
// stream but are prone to Cloudflare/anti-bot friction sit just below; reachable
// fallbacks and duplicate-backend mirrors last. Dead hosts stay in
// BLOCKED_PROVIDERS (hidden).
export const EMBED_SOURCES = [
  // Tier 1 — mainstream, load cleanly in a normal browser, stream under test.
  { name: 'Videasy', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://player.videasy.to/tv/${id}/${s}/${e}` : `https://player.videasy.to/${type}/${id}` },
  { name: 'VidLink', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidlink.pro/tv/${id}/${s}/${e}` : `https://vidlink.pro/${type}/${id}` },
  { name: 'VidFast', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidfast.pro/tv/${id}/${s}/${e}` : `https://vidfast.pro/${type}/${id}` },
  // Tier 2 — stream under test but can hit Cloudflare/anti-bot friction in-browser
  // (VixSrc has shown a "you have been blocked" page), so they trail the mainstream.
  { name: '111Movies', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://111movies.com/tv/${id}/${s}/${e}` : `https://111movies.com/${type}/${id}` },
  { name: 'VixSrc', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vixsrc.to/tv/${id}/${s}/${e}` : `https://vixsrc.to/${type}/${id}` },
  // Tier 3 — reachable real-user fallbacks (serve a player page).
  { name: 'VidSrc.to', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc.to/embed/tv/${id}/${s}/${e}` : `https://vidsrc.to/embed/${type}/${id}` },
  { name: 'Nontongo', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://www.nontongo.win/embed/tv/${id}/${s}/${e}` : `https://www.nontongo.win/embed/${type}/${id}` },
  { name: 'SuperEmbed', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}` : `https://multiembed.mov/?video_id=${id}&tmdb=1` },
  { name: 'VidSrcMe.ru', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrcme.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrcme.ru/embed/movie?tmdb=${id}` },
  { name: 'Vsrc.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vsrc.su/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vsrc.su/embed/movie?tmdb=${id}` },
  // Tier 4 — mirrors of the same (vsembed) backend as above; kept as redundant fallbacks.
  { name: 'VidSrc-Me.ru', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc-me.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc-me.ru/embed/movie?tmdb=${id}` },
  { name: 'VidSrc-Me.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc-me.su/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc-me.su/embed/movie?tmdb=${id}` },
  { name: 'VidSrc-Embed.ru', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc-embed.ru/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc-embed.ru/embed/movie?tmdb=${id}` },
  { name: 'VidSrc-Embed.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc-embed.su/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrc-embed.su/embed/movie?tmdb=${id}` },
  // Dead — hidden via BLOCKED_PROVIDERS, kept for reference / possible revival.
  { name: 'VidSrc.cc', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}` : `https://vidsrc.cc/v2/embed/${type}/${id}` },
  { name: 'Embed.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://embed.su/embed/tv/${id}/${s}/${e}` : `https://embed.su/embed/${type}/${id}` },
  { name: 'Autoembed.cc', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}` : `https://player.autoembed.cc/embed/${type}/${id}` },
  { name: 'VidSrcMe.su', getUrl: (type, id, s, e) => type === 'tv' && s && e ? `https://vidsrcme.su/embed/tv?tmdb=${id}&season=${s}&episode=${e}` : `https://vidsrcme.su/embed/movie?tmdb=${id}` },
  // YTS torrent source. Not an iframe embed: streamed through the local helper
  // (stream-server.mjs) into a native <video>. Movies only; requires `npm start`.
  { name: 'YTS (Torrent)', torrent: true, movieOnly: true, getUrl: () => '' },
];

// Providers that block iframe embedding - will open in new tab instead
export const IFRAME_BLOCKED_PROVIDERS = ['VidSrc.cc'];

// Providers that are completely blocked/down - exclude from list
// Verified dead Jul 18, 2026 (DNS/connection failure against a known title):
export const BLOCKED_PROVIDERS = ['VidSrc.cc', 'Embed.su', 'Autoembed.cc', 'VidSrcMe.su'];
