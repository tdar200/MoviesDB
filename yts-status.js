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
      ? `Could not reach the stream helper at ${remoteBase}. Is it running and reachable over HTTPS?`
      : 'Could not reach the local stream helper. Run "npm start" (not a static server).';
  }

  // The helper answered, so it is running. Its upstream lookup is what failed.
  if (status >= 500) {
    return "Couldn't reach YTS's API — ISPs often block it. The stream helper is fine; try again in a moment.";
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
