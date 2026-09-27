import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperRequestAllowed, isHelperApiPath, isPrivateStaticPath, HELPER_API_PATHS } from './helper-auth.js';

const sp = (q) => new URLSearchParams(q);

test('every torrent/file endpoint is an API path; the app files are not', () => {
  for (const p of ['/yts', '/movie-torrents', '/tv-torrents', '/subtitles', '/subtitle', '/stream', '/stream-status', '/stream-stop']) assert.ok(isHelperApiPath(p), p);
  for (const p of ['/', '/index.html', '/script.js', '/config.js', '/stream.js', '/yts-status.js']) assert.ok(!isHelperApiPath(p), p);
  assert.equal(HELPER_API_PATHS.length, 11);
});

test('no key configured: everything is allowed (local npm start)', () => {
  assert.ok(helperRequestAllowed({ pathname: '/stream', searchParams: sp('hash=abc'), requiredKey: '' }));
  assert.ok(helperRequestAllowed({ pathname: '/stream', searchParams: sp('hash=abc'), requiredKey: undefined }));
});

test('key configured: API paths need exactly that key', () => {
  const k = 'a1b2c3d4e5f6';
  assert.ok(helperRequestAllowed({ pathname: '/yts', searchParams: sp(`imdb=tt1&key=${k}`), requiredKey: k }));
  assert.ok(!helperRequestAllowed({ pathname: '/yts', searchParams: sp('imdb=tt1'), requiredKey: k }), 'missing key');
  assert.ok(!helperRequestAllowed({ pathname: '/yts', searchParams: sp('imdb=tt1&key=wrong'), requiredKey: k }), 'wrong key');
  assert.ok(!helperRequestAllowed({ pathname: '/yts', searchParams: sp(`key=${k}x`), requiredKey: k }), 'longer key');
  assert.ok(!helperRequestAllowed({ pathname: '/yts', searchParams: sp(`key=${k.slice(0, -1)}`), requiredKey: k }), 'shorter key');
});

test('key configured: the static app is still served without it', () => {
  for (const p of ['/', '/index.html', '/script.js']) assert.ok(helperRequestAllowed({ pathname: p, searchParams: sp(''), requiredKey: 'secret' }), p);
});

test('a request with no query at all is handled', () => {
  assert.ok(!helperRequestAllowed({ pathname: '/stream', searchParams: undefined, requiredKey: 'secret' }));
  assert.ok(helperRequestAllowed({ pathname: '/index.html', searchParams: undefined, requiredKey: 'secret' }));
});

test('every /live/* path needs the key, other static paths stay open', () => {
  assert.equal(isHelperApiPath('/live/matches'), true);
  assert.equal(isHelperApiPath('/live/hls'), true);
  assert.equal(isHelperApiPath('/live/seg'), true);
  assert.equal(isHelperApiPath('/liveness.html'), false);
  assert.equal(helperRequestAllowed({ pathname: '/live/seg', searchParams: new URLSearchParams(''), requiredKey: 'k' }), false);
  assert.equal(helperRequestAllowed({ pathname: '/live/seg', searchParams: new URLSearchParams('key=k'), requiredKey: 'k' }), true);
});

test('debrid-proxy, transcode and lan-info need the key (open proxy / GPU transcode on the public Funnel)', () => {
  for (const p of ['/debrid-proxy', '/transcode', '/lan-info']) {
    assert.equal(isHelperApiPath(p), true, p);
    assert.equal(helperRequestAllowed({ pathname: p, searchParams: new URLSearchParams(''), requiredKey: 'k' }), false, p);
  }
});

test('static server refuses dot-files and dot-directories (.env*, .git, .vercel)', () => {
  for (const p of ['/.env.local', '/.git/HEAD', '/.vercel/project.json', '/.claude/x', '/channels/.hidden', '/a/.git/config']) {
    assert.equal(isPrivateStaticPath(p), true, p);
  }
  for (const p of ['/', '/index.html', '/tv.html', '/tv-bundle.js', '/channels/fast.json', '/public/hls.min.js']) {
    assert.equal(isPrivateStaticPath(p), false, p);
  }
});
