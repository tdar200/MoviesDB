// lan-info.test.js — choosing the LAN address the TV should stream from directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLanIPv4, lanBaseUrl, isAdoptableLanBase } from './lan-info.mjs';

test('picks a 192.168 address over a Tailscale/CGNAT one', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlp0s20f3: [{ address: '192.168.0.189', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.116.202.64', family: 'IPv4', internal: false }],
  };
  assert.equal(pickLanIPv4(ifaces), '192.168.0.189');
});

test('prefers 192.168 over 10.x when both present', () => {
  const ifaces = {
    eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    wlan0: [{ address: '192.168.1.50', family: 'IPv4', internal: false }],
  };
  assert.equal(pickLanIPv4(ifaces), '192.168.1.50');
});

test('accepts family reported as the number 4', () => {
  const ifaces = { eth0: [{ address: '192.168.5.5', family: 4, internal: false }] };
  assert.equal(pickLanIPv4(ifaces), '192.168.5.5');
});

test('ignores public and IPv6 addresses, returns null when no LAN address', () => {
  const ifaces = {
    lo: [{ address: '::1', family: 'IPv6', internal: true }],
    eth0: [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
    eth1: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
  };
  assert.equal(pickLanIPv4(ifaces), null);
});

test('lanBaseUrl composes the http base with the real port', () => {
  const ifaces = { wlan0: [{ address: '192.168.0.189', family: 'IPv4', internal: false }] };
  assert.equal(lanBaseUrl(ifaces, 8123), 'http://192.168.0.189:8123');
  assert.equal(lanBaseUrl({}, 8123), null);
});

test('isAdoptableLanBase only trusts private-IP http(s) URLs', () => {
  assert.ok(isAdoptableLanBase('http://192.168.0.189:8123'));
  assert.ok(isAdoptableLanBase('http://10.0.0.5:8123'));
  assert.ok(isAdoptableLanBase('https://172.16.0.1:8123'));
  assert.ok(!isAdoptableLanBase('https://dell-g15.taild19ce1.ts.net')); // public hostname
  assert.ok(!isAdoptableLanBase('http://203.0.113.9:8123'));            // public IP
  assert.ok(!isAdoptableLanBase(''));
  assert.ok(!isAdoptableLanBase(null));
  assert.ok(!isAdoptableLanBase('not a url'));
});
