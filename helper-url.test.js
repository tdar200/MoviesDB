import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHelperUrl, resolveHelperKey } from './helper-url.js';

test('no key: base + path, same origin when base is empty', () => {
  assert.equal(buildHelperUrl('', '/yts?imdb=tt1'), '/yts?imdb=tt1');
  assert.equal(buildHelperUrl('https://h.example', '/stream?hash=a'), 'https://h.example/stream?hash=a');
  assert.equal(buildHelperUrl('https://h.example/', '/stream?hash=a'), 'https://h.example/stream?hash=a', 'trailing slash on the base must not double up');
});

test('key is appended with the right separator and encoded', () => {
  assert.equal(buildHelperUrl('https://h.example', '/stream?hash=a', 'k1'), 'https://h.example/stream?hash=a&key=k1');
  assert.equal(buildHelperUrl('https://h.example', '/stream-status', 'k1'), 'https://h.example/stream-status?key=k1');
  assert.equal(buildHelperUrl('', '/yts?imdb=tt1', 'a b&c'), '/yts?imdb=tt1&key=a%20b%26c');
});

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('?helperkey=<k> is persisted and returned', () => {
  const s = fakeStorage();
  assert.equal(resolveHelperKey('?helperkey=abc123&type=movie', s), 'abc123');
  assert.equal(s.getItem('streamHelperKey'), 'abc123');
});

test('without the parameter the stored key is used; ?helperkey= (empty) clears it', () => {
  const s = fakeStorage({ streamHelperKey: 'stored' });
  assert.equal(resolveHelperKey('?type=tv', s), 'stored');
  assert.equal(resolveHelperKey('?helperkey=', s), '');
  assert.equal(s.getItem('streamHelperKey'), null);
});

test('no key anywhere resolves to empty, and a throwing storage never breaks the app', () => {
  assert.equal(resolveHelperKey('', fakeStorage()), '');
  assert.equal(resolveHelperKey('?helperkey=x', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} }), '');
});
