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
import { ChargerError, ERROR_KINDS } from '../src/peblar/http.js';
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
  await ctx.advance(SECOND);
  // At 2.6 s: the current landed at 2.5 s and the first stop was sent again
  // at once (the second stop never cancels that resend: review 2, B1).
  assert.equal(ctx.charger.ev.ChargeCurrentLimit, 0, 'stopped again at 2.6 s');
  // 0.1.2 (nrgkick M5): the second stop, pressed while the first only waits
  // to be sent again, goes itself; then the resend of the first.
  assert.deepEqual(ctx.limits(), [10_000, 0, 0, 0]);
  await ctx.advance(30 * SECOND);
  assert.equal((await stop).success, true);
  assert.equal((await stop2).success, true);
  assert.equal((await start).success, false, 'refused unsent: still running');
  assert.equal((await current).success, true);
  assert.deepEqual(ctx.limits(), [10_000, 0, 0, 0]);
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

test('M11: a refused token shows the charger offline', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  server.charger.token = 'z'.repeat(64);
  await ctx.advance(30 * SECOND, SECOND);
  assert.equal(ctx.gladys.fake.lastState(`${DEVICE}:status`), 'Borne injoignable');
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
});

test('S21: a 429 keeps the charger online; the status says the 429 pause', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  server.charger.statuses['/api/wlac/v1/system'] = 429;
  await ctx.advance(30 * SECOND, SECOND);
  assert.equal(ctx.gladys.fake.lastState(`${DEVICE}:status`), 'En charge');
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.LOCAL);
  assert.match(ctx.status().message.fr, /HTTP 429/);
});

test('S2b: a second stop click never ends the reaffirmation', async (t) => {
  const server = fakeCharger({
    patchPlan: (i) => (i === 0 ? { applyAfter: 9000, answerAfter: 60_000 } : {}),
  });
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  const current = ctx.fire('set-current', '10');
  await ctx.advance(6 * SECOND);
  const stop = ctx.fire('stop-charge');
  await ctx.advance(SECOND);
  const stop2 = ctx.fire('stop-charge');
  await ctx.advance(60 * SECOND);
  assert.match((await current).error, /sans confirmation/);
  assert.equal((await stop).success, true);
  assert.equal((await stop2).success, true);
  assert.equal(ctx.charger.ev.ChargeCurrentLimit, 0, 'the charger ends stopped');
});

test('S2c: no reaffirmation from the fresh read of a Start, nor while it runs', async (t) => {
  const server = fakeCharger({
    patchPlan: (i) => (i === 0 ? { applyAfter: 65_000, answerAfter: 60_000 } : {}),
  });
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  ctx.fire('set-current', '10');
  await ctx.advance(6 * SECOND);
  ctx.fire('stop-charge');
  await ctx.advance(59_400);
  const before = server.requests.length;
  const logsBefore = ctx.logs.length;
  const start = ctx.fire('start-charge');
  await ctx.advance(SECOND);
  await start;
  const sent = server.requests.slice(before).filter((r) => r.method === 'PATCH');
  assert.ok(
    sent.every((r) => JSON.parse(r.body).ChargeCurrentLimit !== 0),
    'no 0 raced the start',
  );
  assert.ok(!ctx.logs.slice(logsBefore).some((l) => /came back after a stop/.test(l)));
});

// --- 0.1.2: points found on the sibling modules (nrgkick I1, M6, M8; openevse B1, M4) ---

for (const failure of ['503', 'unreachable']) {
  test(`0.1.2 #1: the stop sent again after an overtaken current fails (${failure}): reaffirmed`, async (t) => {
    // The current lands and is confirmed after the stop (a real 2xx: never
    // "unconfirmed"); the stop sent again then fails.
    const server = fakeCharger({
      patchPlan: (i) => (i === 0 ? { applyAfter: 2500, answerAfter: 2500 } : {}),
    });
    const original = server.transport;
    let patches = 0;
    server.transport = async (request) => {
      if (request.method === 'PATCH' && ++patches === 3) {
        server.requests.push(request);
        if (failure === '503') {
          return { status: 503, headers: {}, body: 'busy' };
        }
        throw new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      return original(request);
    };
    const ctx = await setup(t, { config: TOKEN_CFG, server });
    const current = ctx.fire('set-current', '10');
    await ctx.advance(500);
    const stop = ctx.fire('stop-charge');
    await ctx.advance(30 * SECOND);
    assert.equal((await current).success, true);
    assert.equal((await stop).success, true);
    assert.ok(ctx.logs.some((l) => /stop again failed/.test(l)));
    assert.equal(ctx.charger.ev.ChargeCurrentLimit, 0, 'the charge never stays resumed');
    assert.ok(ctx.limits().filter((l) => l === 0).length <= 4, 'reaffirmed twice at most');
  });
}

/** A first run that keeps the serial in /data, then a new app on the same Gladys and store. */
async function restart(t, prepare, config = TOKEN_CFG, next = config) {
  const store = memoryStore();
  const first = await setup(t, { config, store });
  assert.deepEqual(store.data.charger, { address: HOST, serial: SERIAL }, 'serial kept');
  first.app.stop();
  const server = fakeCharger();
  prepare(store, server);
  const app = new PeblarApp({
    gladys: first.gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  t.after(() => app.stop());
  await app.connected(next);
  await settle();
  const device = first.gladys.fake.devices.find((d) => d.external_id === DEVICE);
  const feature = (role) => device.features.find((f) => f.external_id === `${DEVICE}:${role}`);
  return {
    app,
    server,
    advance: first.advance,
    gladys: first.gladys,
    send: (role, value = 1) => app.setValue(device, feature(role), value),
  };
}

for (const [name, prepare] of [
  ['a 5xx pause kept', (store) => (store.data.pause = { until: NOW + 5 * MINUTE, reason: '5xx' })],
  ['a 429 pause kept', (store) => (store.data.pause = { until: NOW + 6 * HOUR, reason: '429' })],
  [
    'a block kept',
    (store) => (store.data.block = { until: NOW + HOUR, mode: 'token', failures: 2 }),
  ],
  ['the charger down at the start', (_store, server) => (server.charger.down = true)],
  [
    'no serial kept (0.1.1) and a 5xx pause',
    (store) => {
      store.data.charger = null;
      store.data.pause = { until: NOW + 5 * MINUTE, reason: '5xx' };
    },
  ],
  // M3: the first restart after the update to 0.1.2, during a block.
  [
    'no serial kept (0.1.1) and a block',
    (store) => {
      store.data.charger = null;
      store.data.block = { until: NOW + HOUR, mode: 'token', failures: 2 };
    },
  ],
]) {
  test(`0.1.2 #2: after a restart with ${name}, the stop goes before any read`, async (t) => {
    const ctx = await restart(t, prepare);
    ctx.server.charger.down = false;
    const before = ctx.server.requests.length;
    await ctx.send('stop-charge');
    assert.deepEqual(ctx.server.paths().slice(before), ['PATCH /api/wlac/v1/evinterface']);
    assert.equal(ctx.server.charger.ev.ChargeCurrentLimit, 0);
    // Start and the current wait for a read (identity and bounds unchecked).
    await assert.rejects(ctx.send('start-charge'), /(première lecture|n'est pas lue)/);
    await assert.rejects(ctx.send('set-current', '10'), /(première lecture|n'est pas lue)/);
    // Shown offline meanwhile, never "another charger" (M3: also without a serial kept).
    assert.doesNotMatch(ctx.gladys.fake.connectionStatus.message.fr, /Plus lue/);
    assert.equal(ctx.gladys.fake.lastState(`${DEVICE}:status`), 'Borne injoignable');
  });
}

// --- 0.1.2, review 1 ---

for (const [name, next, prepare] of [
  ['the token removed', { ...TOKEN_CFG, api_token: '' }, () => {}],
  ['a token refused by the form', { ...TOKEN_CFG, api_token: 'jéton' }, () => {}],
  [
    'an answer without a serial',
    TOKEN_CFG,
    (_store, server) => (server.charger.system.ProductSn = undefined),
  ],
]) {
  test(`0.1.2 I1: the device kept in /data is offline after a restart with ${name}`, async (t) => {
    const ctx = await restart(t, prepare, TOKEN_CFG, next);
    await ctx.advance(SECOND);
    assert.equal(ctx.gladys.fake.lastState(`${DEVICE}:status`), 'Borne injoignable');
    assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
    assert.doesNotMatch(ctx.gladys.fake.connectionStatus.message.fr, /Plus lue/);
  });
}

test('0.1.2 I2: with the password, a login that never reached the charger is not spaced', async (t) => {
  const ctx = await restart(t, (_store, server) => (server.charger.down = true), PASS_CFG);
  assert.equal(ctx.server.logins().length, 1, 'tried at the start, unreachable');
  ctx.server.charger.down = false;
  await ctx.advance(3 * MINUTE, SECOND);
  assert.ok(ctx.server.logins().length >= 2, 'logged in once the charger is back');
  await ctx.send('stop-charge');
  assert.equal(ctx.server.charger.ev.ChargeCurrentLimit, 0);
});

test('0.1.2 I2: the docs and the password field say the limit of the password alone', () => {
  assert.match(read('docs/en.md'), /use the API token/);
  assert.match(read('docs/fr.md'), /utilisez le jeton d'API/);
  const manifest = JSON.parse(read('gladys-assistant-integration.json'));
  const password = manifest.config_schema.find((f) => f.key === 'password');
  assert.match(password.description.fr, /préférez le jeton/);
  assert.match(password.description.en, /prefer the token/);
});

test('0.1.2 M1: a current confirmed before the stop left is never undone later', async (t) => {
  const server = fakeCharger({ patchPlan: (i) => (i === 0 ? { answerAfter: 300 } : {}) });
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  server.charger.delays['/api/wlac/v1/evinterface'] = 500;
  const current = ctx.fire('set-current', '10');
  await ctx.advance(600);
  const stop = ctx.fire('stop-charge');
  await ctx.advance(30 * SECOND);
  assert.equal((await current).success, true);
  assert.equal((await stop).success, true);
  // The user starts the charge again from the Peblar app.
  server.charger.ev.ChargeCurrentLimit = 16_000;
  await ctx.advance(60 * SECOND, SECOND);
  assert.equal(server.charger.ev.ChargeCurrentLimit, 16_000, 'never stopped again');
});

test('0.1.2 M2: a 429 on the stop sent again keeps the watch past the pause', async (t) => {
  const server = fakeCharger({
    patchPlan: (i) => (i === 0 ? { applyAfter: 6000, answerAfter: 60_000 } : {}),
  });
  const original = server.transport;
  let patches = 0;
  server.transport = async (request) => {
    if (request.method === 'PATCH' && ++patches === 3) {
      server.requests.push(request);
      return { status: 429, headers: {}, body: 'slow down' };
    }
    return original(request);
  };
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  ctx.fire('set-current', '10');
  await ctx.advance(500);
  const stop = ctx.fire('stop-charge');
  await ctx.advance(10 * SECOND);
  assert.equal((await stop).success, true);
  assert.equal(server.charger.ev.ChargeCurrentLimit, 10_000, 'the late current landed');
  await ctx.advance(7 * MINUTE, SECOND);
  assert.equal(server.charger.ev.ChargeCurrentLimit, 0, 'reaffirmed after the pause');
});

test('0.1.2 M4 (nrgkick M1): a bound missing from one web answer keeps the last one', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { config: { ...PASS_CFG, max_current: 32 }, server });
  assert.equal(ctx.app.ceiling, 20);
  delete server.charger.user.CurrentCtrlFixedChargeCurrentLimit;
  delete server.charger.info.HwMaxCurrent;
  await ctx.advance(25 * HOUR, 10 * MINUTE);
  assert.equal(ctx.app.ceiling, 20, 'never back to the configured 32 A');
});

test('0.1.2 M4 (nrgkick M2): the minute between two currents survives a restart', async (t) => {
  const ctx = await setup(t, { config: TOKEN_CFG });
  let ack = await ctx.press('set-current', '10');
  assert.equal(ack.success, true, ack.error);
  await ctx.app.configUpdated({ ...TOKEN_CFG, host: 'peblar.local' });
  await ctx.advance(5 * SECOND);
  ack = await ctx.press('set-current', '12');
  assert.equal(ack.success, false);
  assert.match(ack.error, /moins d'une minute/);
});

test('0.1.2 M4 (nrgkick M5): a second stop while the first waits to be sent again goes itself', async (t) => {
  const server = fakeCharger({
    patchPlan: (i) => (i === 0 ? { applyAfter: 2500, answerAfter: 2500 } : {}),
  });
  const ctx = await setup(t, { config: TOKEN_CFG, server });
  ctx.fire('set-current', '10');
  await ctx.advance(500);
  const stop = ctx.fire('stop-charge');
  await ctx.advance(SECOND);
  assert.equal((await stop).success, true);
  const before = ctx.limits().length;
  const stop2 = ctx.fire('stop-charge');
  await ctx.advance(200);
  // Sent at once, not merged with the resend of the first (after 2.5 s).
  assert.deepEqual(ctx.limits().slice(before), [0], 'the second stop was sent itself');
  // The current lands at 2.5 s: the first stop is still sent again at once
  // (review 2, B1), the charge never stays resumed after the acks.
  for (let elapsed = 0; elapsed < 30 * SECOND; elapsed += 100) {
    await ctx.advance(100);
    assert.equal(server.charger.ev.ChargeCurrentLimit, 0, `stopped at +${elapsed + 100} ms`);
  }
  assert.equal((await stop2).success, true);
  assert.deepEqual(ctx.limits().slice(before), [0, 0], 'then the resend of the first');
});

test('0.1.2 #2: a serial kept for another address is never restored', async (t) => {
  const ctx = await restart(t, (store) => {
    store.data.charger = { address: '192.168.1.99', serial: SERIAL };
    store.data.pause = { until: NOW + 5 * MINUTE, reason: '5xx' };
  });
  await assert.rejects(ctx.send('start-charge'), /n'est pas lue/);
  assert.equal(ctx.app.charger.serial, undefined);
});

test('0.1.2 #3: the follow-up reads of several commands are not stacked', async (t) => {
  // The charger ignores the stop: each press sends one, with its follow-up reads.
  const ctx = await setup(t, { config: TOKEN_CFG, server: fakeCharger({ applies: false }) });
  for (let i = 0; i < 4; i += 1) {
    const ack = await ctx.press('stop-charge', 1, SECOND);
    assert.equal(ack.success, true, ack.error);
  }
  assert.ok(ctx.app.charger.followUps.size <= 2, 'one series pending at a time');
  const reads = () => ctx.server.paths().filter((p) => p === 'GET /api/wlac/v1/system').length;
  const before = reads();
  await ctx.advance(25 * SECOND, SECOND);
  assert.ok(reads() - before <= 3, 'two follow-up reads and one poll at most');
});

test('0.1.2 M6: during a 5xx pause, a command refused says "server error"', async (t) => {
  const ctx = await setup(t, { config: TOKEN_CFG });
  ctx.charger.statuses['/api/wlac/v1/system'] = 503;
  await ctx.advance(30 * SECOND, SECOND);
  assert.equal(ctx.store.data.pause.reason, '5xx');
  delete ctx.charger.statuses['/api/wlac/v1/system'];
  const ack = await ctx.press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /erreur serveur/);
  assert.doesNotMatch(ack.error, /ralentir/);
});

test('0.1.2 M8: credentials pasted in the address are ignored and never shown back', async (t) => {
  for (const host of [`admin:s3cret@${HOST}`, `http://admin:s3cret@${HOST}/`]) {
    const server = fakeCharger();
    const ctx = await setup(t, { config: { ...TOKEN_CFG, host }, server });
    const { message } = ctx.status();
    assert.match(message.en, /holds a user name or a password/);
    assert.ok(!JSON.stringify(message).includes('s3cret'));
    assert.equal(server.requests.length, 0);
    ctx.app.stop();
    t.mock.timers.reset();
  }
});
