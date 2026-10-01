// Which audio track of a file the TV should hear. English is the default.
//
// ffmpeg's `-map 0:a:0` takes the FIRST audio track, and multi-audio releases do not list English first: measured on real
// Silo releases, an ITA-ENG MULTI pack lists Italian first, a "Dual" pack Spanish first and an "ENG-Lektor PL" one Polish
// first. The torrent ranking prefers English releases, but a MULTi / Dual one is a good choice only if its English track is
// the one that plays.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ENGLISH_LANGUAGE = /^(eng|en|english)$/i;
const ENGLISH_TITLE = /\benglish\b/i;
// An English commentary or audio-description track is not the film's sound.
const NOT_THE_MAIN_TRACK = /\b(commentary|audio[ ._-]?description|descriptive|narration)\b/i;

const languageOf = stream => String((stream && stream.tags && stream.tags.language) || '');
const titleOf = stream => String((stream && stream.tags && stream.tags.title) || '');

// `streams` are ffprobe's audio streams in file order. Returns the position among the AUDIO streams (what `-map 0:a:N` takes).
export function pickAudioIndex(streams) {
  if (!Array.isArray(streams) || !streams.length) return 0;
  const english = streams
    .map((stream, index) => ({ stream, index }))
    .filter(({ stream }) => ENGLISH_LANGUAGE.test(languageOf(stream)) || ENGLISH_TITLE.test(titleOf(stream)));
  const main = english.find(({ stream }) => !NOT_THE_MAIN_TRACK.test(titleOf(stream))) || english[0];
  if (main) return main.index;
  // No English track at all: keep the release's own default, else the first.
  const marked = streams.findIndex(stream => stream.disposition && Number(stream.disposition.default) === 1);
  return marked >= 0 ? marked : 0;
}

// Probe the audio tracks of a URL or file ahead of starting ffmpeg. Never throws: any failure (a pipe, a dead URL, a slow
// header) means the first track, which is what happened before this module existed.
export async function probeAudioIndex(input, { timeoutMs = 20000 } = {}) {
  const none = { index: 0, streams: [] };
  if (!input || input === 'pipe:0' || /^pipe:/.test(String(input))) return none;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-analyzeduration', '5M', '-probesize', '5M', '-select_streams', 'a',
      '-show_entries', 'stream=index,codec_name:stream_tags=language,title:stream_disposition=default', '-of', 'json', String(input),
    ], { timeout: timeoutMs });
    const streams = (JSON.parse(stdout).streams || []);
    return { index: pickAudioIndex(streams), streams };
  } catch { return none; }
}
