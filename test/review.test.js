// -----------------------------------------------------------------------------
// The points of the review of milestone 1 (B1, I1-I3, M1-M11), one test each,
// and the reviewer's scenarios S1-S20 that showed them. Each asserts the safe
// behaviour.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PeblarApp } from '../src/app.js';
import { HOUR, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  NOW,
  PASSWORD,
  SERIAL,
  TOKEN,
  ev,
  fakeCharger,
  settle,
  userConfig,
} from './fixtures/fakePeblar.js';

const TOKEN_CFG = { host: HOST, api_token: TOKEN, allow_commands: true };
const PASS_CFG = { host: HOST, password: PASSWORD, allow_commands: true };
const DEVICE = `ext:test-integration:peblar:${SERIAL}`;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

async function setup(t, { config, server = fakeCharger(), store = memoryStore() }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => logs.push(`${l}: ${a.join(' ')}`)]),
  );
  const app = new PeblarApp({
    gladys,
    logger,
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = 100) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(5);
    }
  };
  if (gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  const fire = (role, value = 1) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
    const feature = device.features.find((f) => f.external_id === `${DEVICE}:${role}`);
    return gladys.fake.setValue(device, feature, value);
  };
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = fire(role, value);
    await advance(wait);
    return ack;
  };
  const limits = () => server.patches().map((p) => p.ChargeCurrentLimit);
  const status = () => gladys.fake.connectionStatus;
  return {
    gladys,
    app,
    server,
    charger: server.charger,
    advance,
    logs,
    fire,
    press,
    store,
    limits,
    status,
  };
}

test('B1 (S1): a refused command never cancels the stop sent again', async (t) => {
  const server = fakeCharger({
    patchPlan: (i) => (i === 0 ? { applyAfter: 2500, answerAfter: 2500 } : {}),
  });
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  const current = ctx.fire('set-current', '10');
  await ctx.advance(500);
  const stop = ctx.fire('stop-charge');
  await ctx.advance(500);
  const start = ctx.fire('start-charge');
  await ctx.advance(600);
  const stop2 = ctx.fire('stop-charge');
  await ctx.advance(30 * SECOND);
  assert.equal((await stop).success, true);
  assert.equal((await stop2).success, true);
  assert.equal((await start).success, false, 'refused unsent: still running');
  assert.equal((await current).success, true);
  assert.deepEqual(ctx.limits(), [10_000, 0, 0]);
  assert.equal(ctx.charger.ev.ChargeCurrentLimit, 0, 'the charger ends stopped');
});

test('I1 (S2): a timed-out current landing after a later stop: the stop is reaffirmed', async (t) => {
  const server = fakeCharger({
    patchPlan: (i) => (i === 0 ? { applyAfter: 9000, answerAfter: 60_000 } : {}),
  });
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  const current = ctx.fire('set-current', '10');
  await ctx.advance(6 * SECOND);
  const stop = ctx.fire('stop-charge');
  await ctx.advance(60 * SECOND);
  assert.match((await current).error, /sans confirmation/);
  assert.equal((await stop).success, true);
  assert.equal(ctx.charger.ev.ChargeCurrentLimit, 0, 'the stop wins over a late PATCH');
  assert.ok(ctx.limits().filter((l) => l === 0).length <= 3, 'reaffirmed twice at most');
  assert.ok(ctx.logs.some((l) => /stop sent again/.test(l)));
});

test('I1: no reaffirmation once a newer command left after the stop', async (t) => {
  const server = fakeCharger({
    ev: ev({ CpState: 'State B' }),
    patchPlan: (i) => (i === 0 ? { answerAfter: 60_000 } : {}),
  });
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  await ctx.press('set-current', '10');
  await ctx.press('stop-charge');
  await ctx.advance(61 * SECOND);
  const ack = await ctx.press('start-charge');
  assert.equal(ack.success, true, ack.error);
  await ctx.advance(30 * SECOND);
  assert.ok(ctx.charger.ev.ChargeCurrentLimit > 0, 'the start is never undone');
});

test('I2 (S3, S3b): the ceiling never reads the user-defined limit (it mirrors the writes)', async (t) => {
  const server = fakeCharger({
    mirrorUser: true,
    patchPlan: () => ({}),
    ev: ev({ ChargeCurrentLimit: 0, CpState: 'State B' }),
    user: userConfig({ CurrentCtrlFixedChargeCurrentLimit: 25, UserDefinedChargeLimitCurrent: 32 }),
  });
  const ctx = await setup(t, { config: { ...PASS_CFG, max_current: 32 }, server });
  let ack = await ctx.press('start-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.limits(), [6000]);
  await ctx.advance(HOUR + MINUTE, 10 * SECOND);
  const select = ctx.gladys.fake.discoveredDevices.at(-1).features.at(-1);
  assert.equal(select.supported_options.at(-1).value, '25', 'installation limit, not 6 A');
  ack = await ctx.press('set-current', '16');
  assert.equal(ack.success, true, ack.error);
});

test('I3 (S4b): a corrected password logs in at once', async (t) => {
  const server = fakeCharger({ password: 'right one' });
  const ctx = await setup(t, { config: { ...PASS_CFG, password: 'wrong one' }, server });
  assert.equal(ctx.store.data.block.mode, 'password');
  await ctx.advance(2 * MINUTE, SECOND);
  await ctx.app.configUpdated({ ...PASS_CFG, password: 'right one' });
  await ctx.advance(5 * SECOND, SECOND);
  assert.equal(ctx.status().connected, true);
  assert.equal(server.logins().length, 2);
});

test('I3 (S5, S5b): an interval change only reschedules: no login, data and stop go on', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: PASS_CFG, server });
  await ctx.advance(2 * MINUTE, 10 * SECOND);
  await ctx.app.configUpdated({ ...PASS_CFG, poll_interval: 60 });
  await ctx.advance(10 * SECOND, SECOND);
  assert.equal(ctx.status().connected, true);
  assert.equal(server.logins().length, 1);
  const reads = server.paths().filter((p) => p === 'GET /api/wlac/v1/system').length;
  await ctx.advance(59 * SECOND, SECOND);
  assert.equal(
    server.paths().filter((p) => p === 'GET /api/wlac/v1/system').length,
    reads + 1,
    'one read in the new minute',
  );
  const ack = await ctx.press('stop-charge');
  assert.equal(ack.success, true, ack.error);
});

test('I3 (S20): a reconnection with a new interval keeps the session', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: PASS_CFG, server });
  await ctx.advance(MINUTE, 10 * SECOND);
  await ctx.app.connected({ ...PASS_CFG, poll_interval: 45 });
  await ctx.advance(10 * SECOND, SECOND);
  assert.equal(ctx.status().connected, true);
  assert.equal(server.logins().length, 1);
});

test('I3: a reconnection with new credentials lifts the block, like a save', async (t) => {
  const server = fakeCharger({ password: 'right one' });
  const ctx = await setup(t, { config: { ...PASS_CFG, password: 'wrong one' }, server });
  assert.ok(ctx.store.data.block);
  await ctx.app.connected({ ...PASS_CFG, password: 'right one' });
  await ctx.advance(5 * SECOND, SECOND);
  assert.equal(ctx.store.data.block, null);
  assert.equal(ctx.status().connected, true);
});

test('I3: a new address resets the login spacing', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: PASS_CFG, server });
  await ctx.app.configUpdated({ ...PASS_CFG, host: 'peblar.local' });
  await ctx.advance(5 * SECOND, SECOND);
  assert.equal(server.logins().length, 2, 'logged in at once at the new address');
});

test('M1 (S6): a limit under 6 A is "stopped": a current is refused, start sends', async (t) => {
  const server = fakeCharger({ ev: ev({ ChargeCurrentLimit: 3000, CpState: 'State B' }) });
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  assert.equal(ctx.gladys.fake.lastState(`${DEVICE}:status`), 'Véhicule branché, charge arrêtée');
  let ack = await ctx.press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /relancerait/);
  ack = await ctx.press('start-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.limits(), [6000]);
});

test('M2 (S7): a stop during a 429 pause is one request', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  server.charger.statuses['/api/wlac/v1/system'] = 429;
  server.charger.headers = { 'retry-after': '600' };
  await ctx.advance(30 * SECOND, SECOND);
  delete server.charger.statuses['/api/wlac/v1/system'];
  const before = server.requests.length;
  const ack = await ctx.press('stop-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.paths().slice(before), ['PATCH /api/wlac/v1/evinterface']);
});

test('M3 (S8): the commands turned off after an accepted stop never drop its resend', async (t) => {
  const server = fakeCharger({
    patchPlan: (i) => (i === 0 ? { applyAfter: 2500, answerAfter: 2500 } : {}),
  });
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  ctx.fire('set-current', '10');
  await ctx.advance(500);
  const stop = ctx.fire('stop-charge');
  await ctx.advance(500);
  await ctx.app.configUpdated({ ...TOKEN_CFG, allow_commands: false });
  await ctx.advance(30 * SECOND);
  assert.equal((await stop).success, true);
  assert.equal(ctx.charger.ev.ChargeCurrentLimit, 0);
});

test('M4 (S12): a 403 on a write keeps the token: a stop still goes', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: PASS_CFG, server });
  server.charger.statuses['PATCH /api/wlac/v1/evinterface'] = 403;
  let ack = await ctx.press('set-current', '10');
  assert.match(ack.error, /HTTP 403/);
  delete server.charger.statuses['PATCH /api/wlac/v1/evinterface'];
  ack = await ctx.press('stop-charge');
  assert.equal(ack.success, true, ack.error);
  assert.equal(server.logins().length, 1);
});

test('M5 (S13): a REST API turned off is said before the block', async (t) => {
  const server = fakeCharger({ user: userConfig({ LocalRestApiEnable: false }) });
  server.charger.statuses['/api/wlac/v1/system'] = 401;
  const ctx = await setup(t, { config: PASS_CFG, server });
  assert.match(ctx.status().message.en, /^The local REST API of the charger is off/);
  assert.match(ctx.status().message.en, /refused the password/);
});

test('M6 (S18): a 429 during the login stops the cycle at once', async (t) => {
  const server = fakeCharger();
  server.charger.statuses['/api/v1/config/user'] = 429;
  server.charger.headers = { 'retry-after': '600' };
  await setup(t, { config: PASS_CFG, server });
  const paths = server.paths();
  assert.deepEqual(paths.slice(paths.indexOf('GET /api/v1/config/user') + 1), []);
});

test('M7: the web API is read at the start, then every 24 h', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: PASS_CFG, server });
  const webReads = () => server.paths().filter((p) => p === 'GET /api/v1/config/user').length;
  assert.equal(webReads(), 1);
  await ctx.advance(23 * HOUR, 10 * MINUTE);
  assert.equal(webReads(), 1);
  await ctx.advance(2 * HOUR, 10 * MINUTE);
  assert.equal(webReads(), 2);
  assert.ok(server.logins().length <= 2);
});

test('M8: no flag left that nothing reads', () => {
  assert.doesNotMatch(read('src/app.js'), /loginBlocked/);
});

test('M9, M10: the docs say the token-only ceiling and the clear HTTP', () => {
  assert.match(read('docs/en.md'), /16\s+A\s+by\s+default/);
  assert.match(read('docs/en.md'), /in\s+clear,\s+over\s+HTTP/);
  assert.match(read('docs/fr.md'), /16\s+A\s+par\s+défaut/);
  assert.match(read('docs/fr.md'), /en\s+clair,\s+en\s+HTTP/);
  assert.match(read('docs/en.md'), /token\s+only/i);
  assert.match(read('docs/fr.md'), /jeton\s+seul/i);
});

test('M11: any failure shows the charger offline (429 and refused token included)', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  server.charger.statuses['/api/wlac/v1/system'] = 429;
  await ctx.advance(30 * SECOND, SECOND);
  assert.equal(ctx.gladys.fake.lastState(`${DEVICE}:status`), 'Borne injoignable');
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
});
