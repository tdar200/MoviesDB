// subtitle-tracks.js — discovering subtitle tracks for a TV torrent.
//
// Two kinds of subtitle live in a torrent: standalone .srt/.vtt FILES sitting
// next to the video, and tracks embedded INSIDE the .mkv. YTS movie torrents
// ship the former; almost every TV release ships only the latter, which is why
// the torrent player showed "no subtitles" for shows like Chernobyl — the app
// only ever looked at files. These pure helpers describe embedded tracks and
// give every track a stable id so the client can ask for one back.

// Subtitle codecs that are TEXT and can be turned into WebVTT. Image-based
// subtitles (PGS/VobSub) would need OCR and are deliberately excluded — offered
// as a track they would just show nothing.
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

export function isTextSubCodec(codec) {
  return TEXT_SUB_CODECS.has(String(codec || '').toLowerCase());
}

// From `ffprobe -show_streams` JSON, the text subtitle streams worth offering.
// Keeps the stream's own index (what ffmpeg -map 0:<index> needs) and its
// language/title tags for labelling.
export function parseEmbeddedSubStreams(streams) {
  return (Array.isArray(streams) ? streams : [])
    .filter((s) => s && s.codec_type === 'subtitle' && isTextSubCodec(s.codec_name))
    .map((s) => ({
      streamIndex: s.index,
      codec: s.codec_name,
      lang: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
      title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
      forced: Boolean(s.disposition && s.disposition.forced),
    }));
}

// A human label. Full English name where we know the ISO code, plus any title
// (e.g. "SDH") so a viewer can tell two English tracks apart.
const LANG_NAMES = {
  eng: 'English', en: 'English', spa: 'Spanish', fre: 'French', fra: 'French',
  ger: 'German', deu: 'German', ita: 'Italian', por: 'Portuguese', rus: 'Russian',
  jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', ara: 'Arabic',
  hin: 'Hindi', nld: 'Dutch', pol: 'Polish', tur: 'Turkish', ukr: 'Ukrainian',
};
export function embeddedTrackLabel({ lang, title, forced } = {}) {
  const name = LANG_NAMES[String(lang || '').toLowerCase()] || (lang ? lang.toUpperCase() : 'Subtitle');
  const extra = [title, forced ? 'Forced' : ''].filter(Boolean).join(' ');
  return extra ? `${name} (${extra})` : name;
}

// Stable ids the client passes back to fetch one track. A file track is "f<i>"
// (its index in the torrent file list); an embedded track is "e<fileIndex>:<streamIndex>".
export function fileTrackId(fileIndex) { return `f${fileIndex}`; }
export function embeddedTrackId(fileIndex, streamIndex) { return `e${fileIndex}:${streamIndex}`; }

export function parseTrackId(id) {
  const s = String(id || '');
  let m = /^f(\d+)$/.exec(s);
  if (m) return { kind: 'file', fileIndex: Number(m[1]) };
  m = /^e(\d+):(\d+)$/.exec(s);
  if (m) return { kind: 'embedded', fileIndex: Number(m[1]), streamIndex: Number(m[2]) };
  return null;
}
