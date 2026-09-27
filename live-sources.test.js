import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceRegistry, withHostFailover } from './live-sources.mjs';

test('registry lists adapters in order and finds them by name', () => {
  const a = { name: 'a' }, b = { name: 'b' };
  const reg = createSourceRegistry([a, b]);
  assert.deepEqual(reg.list(), [a, b]);
  assert.equal(reg.get('b'), b);
  assert.equal(reg.get('zzz'), null);
});

test('withHostFailover moves to the next host on a network error and remembers the winner', async () => {
  const hosts = ['https://dead.example', 'https://alive.example'];
  const tried = [];
  const fn = async host => { tried.push(host); if (host.includes('dead')) { const e = new Error('getaddrinfo ENOTFOUND dead.example'); e.code = 'ENOTFOUND'; throw e; } return 'ok'; };
  const failover = withHostFailover(hosts);
  assert.equal(await failover(fn), 'ok');
  assert.deepEqual(tried, ['https://dead.example', 'https://alive.example']);
  tried.length = 0;
  assert.equal(await failover(fn), 'ok');
  assert.deepEqual(tried, ['https://alive.example'], 'the good host is tried first next time');
});

test('withHostFailover rethrows non-network errors immediately and the last network error when all hosts fail', async () => {
  const failover = withHostFailover(['https://a.example', 'https://b.example']);
  await assert.rejects(() => failover(async () => { throw new Error('Nuvio 500'); }), /Nuvio 500/);
  let n = 0;
  await assert.rejects(() => failover(async () => { n++; throw new TypeError('fetch failed'); }), /fetch failed/);
  assert.equal(n, 2);
});
