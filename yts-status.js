// yts-status.js — turning a failed /yts lookup into something true.
//
// The helper answering "502" and the helper not being there at all are completely
// different problems with completely different fixes, and the app used to report
// both as 'Could not reach the local stream helper. Run "npm start"'. Telling
// someone to start a server they are already running sends them to debug the one
// thing that is working. The 502 case is almost always YTS's own API being
// blocked by the ISP (UK ISPs block the YTS domains under court order), which a
// retry often clears.

export function describeYtsLookupFailure({ networkError = false, status = 0, remoteBase = '' } = {}) {
  // Nothing answered: the helper really is absent/unreachable.
  if (networkError) {
    return remoteBase
      ? `Could not reach the stream helper at ${remoteBase}. Is it running and reachable over HTTPS? If the browser asked to allow this site to access your local network, choose Allow and try again.`
      : 'Could not reach the local stream helper. Run "npm start" (not a static server).';
  }

  // The helper answered, so it is running. Its upstream lookup is what failed.
  if (status >= 500) {
    return "Couldn't reach YTS's API — ISPs often block it. The stream helper is fine; try again in a moment.";
  }

  // The helper is published with an access key and this browser has none (or a
  // stale one). The key travels in the shared link as ?helperkey=<key>.
  if (status === 401 || status === 403) {
    return 'This stream helper needs an access key. Open the app from the link you were given (it ends in ?helperkey=...) and try again.';
  }

  if (status) {
    return `The stream helper rejected the YTS lookup (HTTP ${status}).`;
  }

  return 'The YTS lookup failed for an unknown reason.';
}

// The TMDB -> IMDb id step, which runs before YTS is ever contacted. A failed
// request tells us nothing about whether the title has an IMDb id, so saying
// "no IMDb id" there is a guess presented as a fact - and it reads to the user as
// "this movie isn't on YTS" when the torrents may be sitting right there.
export function describeImdbLookupFailure({ requestFailed = false } = {}) {
  if (requestFailed) {
    return "Couldn't look this title up on TMDB (rate limit or connection). Try again in a moment.";
  }
  return 'TMDB has no IMDb id for this title, so YTS cannot be searched for it.';
}

// The TV equivalent. `/tv-torrents` failures used to collapse to one sentence
// blaming the volunteer index, so a 401 from the helper's own access-key gate —
// which happens to every browser holding a stale key after the key is rotated —
// read as "a third party is down, wait it out" and hid the actual one-click fix.
// Only 5xx is genuinely the index's fault; keep that wording exactly there.
export function describeTvTorrentFailure({ networkError = false, status = 0, remoteBase = '' } = {}) {
  if (networkError) return describeYtsLookupFailure({ networkError: true, remoteBase });

  if (status === 401 || status === 403) {
    return 'This stream helper needs an access key. Open the app from the link you were given (it ends in ?helperkey=...) and try again.';
  }

  if (status >= 500) {
    return "Couldn't reach the torrent index — it's a volunteer service and does go down. Try again in a moment.";
  }

  if (status) return `The stream helper rejected the episode lookup (HTTP ${status}).`;

  return 'The episode lookup failed for an unknown reason.';
}
