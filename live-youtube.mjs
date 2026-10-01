// live-youtube.mjs - channels whose only official free stream is a live broadcast on the broadcaster's own
// YouTube channel (HUM, Geo, ARY, Express, Samaa, Dawn ...). They play in the embed player, and the catalog lists one
// only while it is really live AND embeddable, so a row never contains a tile that opens to "This live stream is
// offline" or "Video unavailable".

const CHANNEL_ID = /^UC[\w-]{22}$/;
// YouTube answers EU visitors with a consent page instead of the video page unless a consent cookie is sent.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'en-GB,en;q=0.9',
  cookie: 'CONSENT=YES+1; SOCS=CAI',
};

const assertChannel = id => { if (!CHANNEL_ID.test(String(id || ''))) throw new Error('not a YouTube channel id'); return id; };

export const youtubeLiveUrl = channelId => `https://www.youtube.com/channel/${assertChannel(channelId)}/live`;

// The channel's "current live stream" embed: always the stream that is live now, no video id to keep up to date.
export function youtubeEmbedUrl(channelId) {
  return `https://www.youtube.com/embed/live_stream?channel=${assertChannel(channelId)}&autoplay=1&rel=0&playsinline=1&modestbranding=1`;
}

// A channel's /live page carries the player response of its current live stream. With no live stream it serves
// the ordinary channel page, which has no player response.
export function parseYoutubeLivePage(html) {
  const none = { live: false, embeddable: false, videoId: null };
  const match = /ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var|<\/script>)/s.exec(String(html || ''));
  if (!match) return none;
  let response;
  try { response = JSON.parse(match[1]); } catch { return none; }
  const details = response.videoDetails || {};
  const playability = response.playabilityStatus || {};
  const live = details.isLive === true;
  // A live stream can still refuse embedding (ARY Digital: status UNPLAYABLE), which the embed player cannot show.
  return { live, embeddable: live && playability.status === 'OK' && playability.playableInEmbed === true, videoId: details.videoId || null };
}

// Same contract as the HLS probes in the catalog feed: { status: 'ok', height } keeps the entry listed.
export async function probeYoutubeLive(entry, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let url;
  try { url = youtubeLiveUrl(entry && entry.youtube); } catch { return { status: 'error' }; }
  try {
    const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) return { status: 'error' }; // rate limited or blocked: not proof that it is offline
    const page = parseYoutubeLivePage(await res.text());
    if (!page.live) return { status: 'offline' };
    return page.embeddable ? { status: 'ok', height: Number(entry.height) || 0 } : { status: 'no-embed' };
  } catch { return { status: 'error' }; }
}
