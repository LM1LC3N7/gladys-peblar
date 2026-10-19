import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialsKey, normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4, host names, ports, pasted URLs', () => {
  assert.deepEqual(parseAddress('192.168.1.60'), { host: '192.168.1.60', port: 80 });
  assert.deepEqual(parseAddress(' http://Peblar.local:8080/api '), {
    host: 'peblar.local',
    port: 8080,
  });
  for (const bad of ['', '1.2.3', '999.1.1.1', 'a b', 'host:0', 'host:70000', '-x.local']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('defaults: commands off, 16 A ceiling, 30 s, French', () => {
  const c = normalizeConfig();
  assert.equal(c.address, undefined);
  assert.equal(c.auth, undefined);
  assert.equal(c.allowCommands, false);
  assert.equal(c.maxCurrent, 16);
  assert.equal(c.pollInterval, 30);
  assert.equal(c.language, 'fr');
});

test('only true allows the commands', () => {
  for (const value of [false, 'false', 1, 'yes', 'TRUE', null, undefined]) {
    assert.equal(normalizeConfig({ allow_commands: value }).allowCommands, false, String(value));
  }
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
});

test('the token wins over the password; bad secrets are refused', () => {
  assert.deepEqual(normalizeConfig({ api_token: ' tok ', password: 'pw' }).auth, {
    mode: 'token',
    token: 'tok',
  });
  assert.deepEqual(normalizeConfig({ password: 'pw' }).auth, { mode: 'password', password: 'pw' });
  const bad = normalizeConfig({ api_token: 'é'.repeat(3) });
  assert.equal(bad.auth, undefined);
  assert.equal(bad.badSecret, true);
  assert.equal(normalizeConfig({ api_token: 'x'.repeat(257) }).auth, undefined);
  assert.notEqual(
    credentialsKey(normalizeConfig({ password: 'a' })),
    credentialsKey(normalizeConfig({ password: 'b' })),
  );
});

test('bounds: ceiling 6..32 A (whole amperes, rounded down), interval 10..600 s', () => {
  assert.equal(normalizeConfig({ max_current: 40 }).maxCurrent, 32);
  assert.equal(normalizeConfig({ max_current: 2 }).maxCurrent, 6);
  assert.equal(normalizeConfig({ max_current: '20.9' }).maxCurrent, 20);
  assert.equal(normalizeConfig({ max_current: '' }).maxCurrent, 16);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 30);
});

test('only known keys are read', () => {
  const c = normalizeConfig(
    JSON.parse('{"__proto__": {"allow_commands": true}, "host": "10.0.0.2"}'),
  );
  assert.equal(c.allowCommands, false);
  assert.equal({}.allow_commands, undefined);
  assert.equal(c.address.host, '10.0.0.2');
});
