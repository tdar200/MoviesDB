// Return a single satisfiable byte range, null for no Range, or false for 416.
export function parseByteRange(header, length) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || length <= 0) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, length - suffix); end = length - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || start > end) return false;
  return { start, end };
}
