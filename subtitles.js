// subtitles.js — the pure parts of the YTS subtitle path: format conversion,
// text decoding, and naming. No I/O, so the helper and the tests share it.
//
// Why conversion is mandatory: YTS torrents ship SubRip (.srt) sidecars, and a
// browser <track> element accepts WebVTT ONLY. Hand Chrome an .srt and it loads
// the track, reports no error, and shows nothing — so the file has to become VTT
// before it ever leaves the helper.
//
// Verified Aug 18, 2026 against real torrents: Predator: Badlands (2025) carries a
// sidecar .srt named after the release plus Subs/English.srt and
// Subs/Forced.eng.srt; Inception (2010) carries a single sidecar.

// Formats a browser can actually render. .sub/.idx (VobSub) and .ass/.ssa are
// deliberately excluded: the first two are bitmap subtitles and the last two carry
// styling a <track> cannot express, so offering any of them yields an empty track.
const SUBTITLE_EXT = /\.(srt|vtt)$/i;

export function isSubtitleFile(path) {
  return SUBTITLE_EXT.test(String(path || ''));
}

// Languages seen in YTS "Subs/" folders. Only used to guess a `srclang` and to
// recognise a language-named file; an unknown name is passed through as the label.
const LANGUAGES = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it',
  portuguese: 'pt', brazilian: 'pt', dutch: 'nl', danish: 'da', swedish: 'sv',
  norwegian: 'no', finnish: 'fi', polish: 'pl', czech: 'cs', hungarian: 'hu',
  romanian: 'ro', greek: 'el', turkish: 'tr', russian: 'ru', ukrainian: 'uk',
  arabic: 'ar', hebrew: 'he', hindi: 'hi', urdu: 'ur', bengali: 'bn',
  chinese: 'zh', japanese: 'ja', korean: 'ko', thai: 'th', vietnamese: 'vi',
  indonesian: 'id', malay: 'ms', farsi: 'fa', persian: 'fa',
};

// Strip a leading UTF-8 BOM, which otherwise lands in front of the WEBVTT
// signature and makes the whole file unparseable.
const stripBom = (s) => s.replace(/^﻿/, '');

// Describe one subtitle file for the picker: { label, lang, forced }.
// YTS names them two ways: `Subs/English.srt` / `Subs/Forced.eng.srt` inside a
// folder, or a sidecar named after the release. A sidecar's filename is the whole
// release string, which is useless as a label, so it becomes plain "English" —
// YTS sidecars are English.
export function subtitleLabel(path) {
  const file = String(path || '').split('/').pop() || '';
  const stem = file.replace(SUBTITLE_EXT, '');
  const forced = /\bforced\b/i.test(stem);

  // Find a language word anywhere in the name (handles "Forced.eng", "English").
  let lang = null;
  let name = null;
  for (const [word, code] of Object.entries(LANGUAGES)) {
    if (new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(stem)) {
      name = word[0].toUpperCase() + word.slice(1);
      lang = code;
      break;
    }
  }
  // Short codes YTS uses on forced tracks, e.g. "Forced.eng.srt".
  if (!name) {
    const short = stem.match(/(^|[^a-z])(eng|spa|fre|ger|ita|por|dut|rus|ara|chi|jpn|kor)([^a-z]|$)/i);
    const SHORT = { eng: ['English', 'en'], spa: ['Spanish', 'es'], fre: ['French', 'fr'], ger: ['German', 'de'], ita: ['Italian', 'it'], por: ['Portuguese', 'pt'], dut: ['Dutch', 'nl'], rus: ['Russian', 'ru'], ara: ['Arabic', 'ar'], chi: ['Chinese', 'zh'], jpn: ['Japanese', 'ja'], kor: ['Korean', 'ko'] };
    if (short) [name, lang] = SHORT[short[2].toLowerCase()];
  }
  // A release-named sidecar (or anything unrecognised): YTS sidecars are English.
  if (!name) { name = 'English'; lang = 'en'; }

  return { label: forced ? `${name} (forced)` : name, lang, forced };
}

// Decode subtitle bytes to text. Tries UTF-8 and falls back to latin1 when the
// bytes are not valid UTF-8 — YTS .srt files are frequently windows-1252, and
// decoding those as UTF-8 silently produces U+FFFD mojibake instead of accents.
export function decodeSubtitle(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('�')) return stripBom(utf8);
  return stripBom(bytes.toString('latin1'));
}

// SRT timestamps are `hh:mm:ss,mmm` (and sometimes `mm:ss,mmm`); WebVTT wants a
// period and is safest with a full hour field.
function normalizeTimestamp(ts) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(ts.trim());
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  const pad = (v, n) => String(v).padStart(n, '0');
  return `${pad(h || 0, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(ms, 3)}`;
}

// Convert SubRip text to WebVTT. Malformed input yields a valid (possibly cue-less)
// VTT rather than throwing: a subtitle file is never worth breaking playback over.
export function srtToVtt(srt) {
  const text = stripBom(String(srt == null ? '' : srt)).replace(/\r\n?/g, '\n');
  const out = ['WEBVTT', ''];

  for (const line of text.split('\n')) {
    const timing = line.match(/^\s*([\d:,.]+)\s*-->\s*([\d:,.]+)(.*)$/);
    if (timing) {
      const start = normalizeTimestamp(timing[1]);
      const end = normalizeTimestamp(timing[2]);
      if (start && end) {
        out.push(`${start} --> ${end}${timing[3] ? timing[3].replace(/\s+$/, '') : ''}`);
        continue;
      }
    }
    // Drop SRT's bare numeric cue counters; keep everything else (cue text and the
    // blank lines that separate cues) exactly as-is.
    if (/^\s*\d+\s*$/.test(line)) continue;
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

// Make display labels unique. Two files in one torrent routinely map to the same
// label (Predator: Badlands has a release-named sidecar AND Subs/English.srt, both
// "English"). Beyond the picker looking broken, identical labels are unusable as a
// selection key - the app must key off `index`, and this only fixes what is shown.
// Colliding entries advertise their size, which is also the useful signal: the
// bigger file is the fuller dialogue track.
export function dedupeTrackLabels(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const counts = new Map();
  for (const t of list) counts.set(t.label, (counts.get(t.label) || 0) + 1);
  return list.map((t) => {
    if ((counts.get(t.label) || 0) < 2) return { ...t };
    const kb = Math.max(1, Math.round((t.bytes || 0) / 1024));
    return { ...t, label: `${t.label} (${kb} KB)` };
  });
}
