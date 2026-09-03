// helper-url.js — builds stream-helper URLs for the app: base + path, plus the
// access key when one is known (see helper-auth.js for why it is a query param).
export function buildHelperUrl(base, path, key = '') {
  const url = (base || '').replace(/\/+$/, '') + path;
  if (!key) return url;
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
}

// Resolve the key the same way the helper base is resolved: a ?helperkey=<k>
// query parameter is persisted (?helperkey= with no value clears it), then
// localStorage, else none. `storage` is any localStorage-like object.
export function resolveHelperKey(search, storage) {
  try {
    const q = new URLSearchParams(search || '').get('helperkey');
    if (q !== null) {
      if (q) storage.setItem('streamHelperKey', q);
      else storage.removeItem('streamHelperKey');
    }
    return storage.getItem('streamHelperKey') || '';
  } catch {
    return '';
  }
}
