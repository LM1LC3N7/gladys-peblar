// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake charger behind the transport. Timers and Date are mocked:
// the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PeblarApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
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
  system,
} from './fixtures/fakePeblar.js';

const CONFIG = { host: HOST, api_token: TOKEN };
const ALLOWED = { ...CONFIG, allow_commands: true };
const WITH_PASSWORD = { host: HOST, password: PASSWORD };
const DEVICE = `ext:test-integration:peblar:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;

async function setup(
  t,
  { config = CONFIG, server = fakeCharger(), store = memoryStore(), create = true, logs = [] } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new PeblarApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
    const target = device.features.find((f) => f.external_id === feature(role));
    const ack = gladys.fake.setValue(device, target, value);
    await settle();
    await advance(wait, 100);
    return ack;
  };
  return { gladys, app, server, store, advance, logs, press, charger: server.charger };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);

/** No secret anywhere a user or a log reader may see. */
function assertNoSecret({ gladys, logs, store }) {
  const seen = JSON.stringify([logs, gladys.fake.connectionStatus, store.data]);
  assert.ok(!seen.includes(TOKEN), 'the token leaked');
  assert.ok(!seen.includes(PASSWORD), 'the password leaked');
}

test('without an address, the status asks for it and nothing is requested', async (t) => {
  const server = fakeCharger();
  const { gladys } = await setup(t, { config: {}, server });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(server.requests.length, 0);
});

test('an address without a token nor a password: asked for, nothing requested', async (t) => {
  const server = fakeCharger();
  const { gladys } = await setup(t, { config: { host: HOST }, server });
  assert.equal(server.requests.length, 0);
  assert.match(message(gladys).fr, /jeton d'API/);
});

test('one read with the token: the device, its features, then its states', async (t) => {
  const ctx = await setup(t);
  const { gladys, server } = ctx;
  assert.deepEqual(server.paths(), [
    'GET /api/wlac/v1/system',
    'GET /api/wlac/v1/evinterface',
    'GET /api/wlac/v1/meter',
    'GET /api/wlac/v1/health',
  ]);
  assert.ok(server.requests.every((r) => r.headers.Authorization === TOKEN && r.port === 80));
  const device = deviceOf(gladys);
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'Peblar C678');
  assert.deepEqual(device.params, [
    { name: 'serial_number', value: SERIAL },
    { name: 'firmware', value: '1.9.0+1+WL-1' },
    { name: 'phases', value: '3' },
  ]);
  const roles = device.features.map((f) => [
    f.external_id.slice(DEVICE.length + 1),
    f.category,
    f.type,
    f.unit,
    f.read_only,
  ]);
  assert.deepEqual(roles.slice(0, 5), [
    ['status', 'text', 'text', undefined, true],
    ['connector-status', 'charging-station', 'connector-status', undefined, true],
    ['charging-state', 'charging-station', 'charging-state', undefined, true],
    ['plugged', 'electrical-vehicle-charge', 'plugged', undefined, true],
    ['power', 'energy-sensor', 'power', 'watt', true],
  ]);
  assert.deepEqual(roles.slice(-3), [
    ['start-charge', 'button', 'push', undefined, false],
    ['stop-charge', 'button', 'push', undefined, false],
    ['set-current', 'text', 'select', undefined, false],
  ]);
  assert.ok(
    device.features.every((f) => f.type !== 'binary' || f.read_only),
    'never a writable binary',
  );
  assert.ok(
    device.features.every((f) => f.category !== 'switch'),
    'never a switch',
  );
  const select = device.features.at(-1);
  assert.deepEqual(
    [select.supported_options[0].value, select.supported_options.at(-1).value],
    ['6', '16'],
    'the default ceiling is 16 A',
  );

  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.CHARGING);
  assert.equal(last(gladys, 'plugged'), 1);
  assert.equal(last(gladys, 'power'), 10_970);
  assert.equal(last(gladys, 'power-l2'), 3_680);
  assert.equal(last(gladys, 'current-l1'), 15.9);
  assert.equal(last(gladys, 'voltage-l3'), 231);
  assert.equal(last(gladys, 'session-energy'), 34.918);
  assert.equal(last(gladys, 'total-energy'), 4937.323);
  assert.equal(last(gladys, 'charge-limit'), 16);
  assert.equal(last(gladys, 'charge-limit-actual'), 16);
  assert.equal(last(gladys, 'limit-source'), 'Local REST API');
  assert.equal(last(gladys, 'set-current'), '16');
  assert.equal(last(gladys, 'error'), 0);
  assert.equal(last(gladys, 'single-phase'), 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /Peblar C678 : En charge, 10970 W, limite 16 A/);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
  assertNoSecret(ctx);
});

test('the energies are plain sensors: never an index, never a consumption', async (t) => {
  const { gladys, advance } = await setup(t);
  await advance(2 * MINUTE, 10 * SECOND);
  for (const f of deviceOf(gladys).features) {
    assert.ok(
      !(f.category === 'energy-sensor' && ['energy', 'index'].includes(f.type)),
      `${f.external_id} is an energy index`,
    );
    assert.notEqual(f.type, 'daily-consumption');
  }
  assert.deepEqual(gladys.fake.publishedEnergyConsumption, []);
});

test('a single-phase charger: L2 and L3 kept as features, never published', async (t) => {
  const server = fakeCharger({
    meter: { CurrentPhase1: 0, EnergySession: 0, EnergyTotal: 0, PowerPhase1: 0, PowerTotal: 0 },
    system: system({ PhaseCount: 1 }),
  });
  const { gladys } = await setup(t, { server });
  assert.ok(deviceOf(gladys).features.some((f) => f.external_id === feature('current-l3')));
  assert.equal(last(gladys, 'current-l3'), undefined);
  assert.equal(last(gladys, 'voltage-l1'), undefined, 'a voltage not given is not 0');
  assert.equal(last(gladys, 'total-energy'), undefined, 'a total of 0 is never published');
  assert.equal(last(gladys, 'session-energy'), 0);
});

test('CP states: no vehicle, waiting, stopped, faults, unknown', async (t) => {
  const { gladys, advance, charger } = await setup(t);
  const cases = [
    [{ CpState: 'State A' }, 'Aucun véhicule', CONNECTOR_STATUS.AVAILABLE, CHARGING_STATE.IDLE, 0],
    [{ CpState: 'State B' }, 'Véhicule branché, en attente', 1, CHARGING_STATE.EV_CONNECTED, 1],
    [
      { CpState: 'State B', ChargeCurrentLimit: 0 },
      'Véhicule branché, charge arrêtée',
      1,
      CHARGING_STATE.PAUSED_BY_CHARGER,
      1,
    ],
    [{ CpState: 'State F' }, 'Défaut de la borne', CONNECTOR_STATUS.FAULTED, 4, 0],
  ];
  for (const [over, text, connector, charging, plugged] of cases) {
    charger.ev = ev(over);
    await advance(30 * SECOND);
    assert.equal(last(gladys, 'status'), text);
    assert.equal(last(gladys, 'connector-status'), connector, text);
    assert.equal(last(gladys, 'charging-state'), charging, text);
    assert.equal(last(gladys, 'plugged'), plugged, text);
  }
  charger.ev = ev({ CpState: 'State Z' });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'État inconnu');
});

test('unreachable: offline states, badge, spaced new tries', async (t) => {
  const { gladys, server, advance, charger } = await setup(t);
  charger.down = true;
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Borne injoignable');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
  assert.equal(last(gladys, 'power'), 10_970, 'the last power is kept');
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.match(message(gladys).en, /No answer from 192\.168\.1\.60/);
  const before = server.requests.length;
  await advance(29 * SECOND);
  assert.equal(server.requests.length, before, 'never sooner than the interval');
  await advance(SECOND);
  assert.equal(server.requests.length, before + 1);
});

test('a refused token: blocked, kept in /data, tried again after 15 min then 1 h', async (t) => {
  const store = memoryStore();
  const server = fakeCharger({ token: 'b'.repeat(64) });
  const logs = [];
  const ctx = await setup(t, { server, store, logs });
  const { gladys, advance } = ctx;
  assert.equal(server.requests.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /refusé le jeton/);
  assert.equal(store.data.block.mode, 'token');
  await advance(14 * MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, 1, 'no try during the block');
  await advance(MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, 2);
  await advance(59 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 2);
  await advance(2 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 3);
  assertNoSecret(ctx);
});

test('a block survives a restart; new credentials lift it at once', async (t) => {
  const store = memoryStore({ block: { until: NOW + HOUR, mode: 'password', failures: 2 } });
  const server = fakeCharger();
  const { gladys, app } = await setup(t, { server, store, config: WITH_PASSWORD });
  assert.equal(server.requests.length, 0, 'never a login before the end of the block');
  assert.match(message(gladys).fr, /refusé le mot de passe/);
  await app.configUpdated({ host: HOST, api_token: TOKEN });
  await settle();
  assert.equal(store.data.block, null);
  assert.ok(server.requests.length > 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('with the password: login, token, user limit and rated current', async (t) => {
  const server = fakeCharger();
  const ctx = await setup(t, { server, config: { ...WITH_PASSWORD, max_current: 32 } });
  const { gladys } = ctx;
  assert.deepEqual(server.paths().slice(0, 4), [
    'POST /api/v1/auth/login',
    'GET /api/v1/config/api-token',
    'GET /api/v1/config/user',
    'GET /api/v1/system/info',
  ]);
  assert.equal(JSON.parse(server.requests[0].body).Password, PASSWORD);
  assert.equal(server.requests[1].headers.Cookie, 'session=s1');
  const device = deviceOf(gladys);
  assert.equal(device.model, 'WLAC1-H11R0WE0ICR00');
  assert.equal(device.features.at(-1).supported_options.at(-1).value, '20', 'user limit 20 A');
  assertNoSecret(ctx);
});

test('with the password: an expired token logs in once again, never in a loop', async (t) => {
  const server = fakeCharger();
  const { gladys, advance, charger, store } = await setup(t, { server, config: WITH_PASSWORD });
  await advance(10 * MINUTE, MINUTE);
  charger.token = 'c'.repeat(64);
  await advance(MINUTE, 30 * SECOND);
  assert.equal(server.logins().length, 2, 'one new login');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // The charger now refuses every token: a second refusal right after a login blocks.
  charger.statuses['/api/wlac/v1/system'] = 401;
  await advance(30 * SECOND);
  await advance(MINUTE, 10 * SECOND);
  assert.equal(server.logins().length, 2, 'no login within 10 minutes of the last');
  assert.equal(store.data.block.mode, 'password');
});

test('a wrong password: blocked, one login only', async (t) => {
  const server = fakeCharger({ password: 'other' });
  const { gladys, advance, store } = await setup(t, { server, config: WITH_PASSWORD });
  assert.equal(server.logins().length, 1);
  assert.equal(store.data.block.mode, 'password');
  await advance(14 * MINUTE, MINUTE);
  assert.equal(server.logins().length, 1);
  assert.match(message(gladys).en, /refused the password/);
});

test('429: a pause on every path, kept in /data and across a reconnection', async (t) => {
  const server = fakeCharger();
  const store = memoryStore();
  const { gladys, app, advance, charger, press } = await setup(t, {
    server,
    store,
    config: ALLOWED,
  });
  charger.statuses['/api/wlac/v1/system'] = 429;
  charger.headers = { 'retry-after': '600' };
  await advance(30 * SECOND);
  assert.equal(store.data.pause.reason, '429');
  delete charger.statuses['/api/wlac/v1/system'];
  const before = server.requests.length;
  await app.connected({ ...ALLOWED });
  await advance(5 * MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, before, 'no read during the pause');
  const ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /ralentir/);
  assert.match(message(gladys).fr, /HTTP 429/);
});

test('5xx: a pause kept in /data, never shorter than the interval', async (t) => {
  const server = fakeCharger();
  const store = memoryStore();
  const { advance, charger } = await setup(t, { server, store });
  charger.statuses['/api/wlac/v1/evinterface'] = 503;
  await advance(30 * SECOND);
  assert.equal(store.data.pause.reason, '5xx');
  assert.ok(store.data.pause.until >= NOW + 60 * SECOND);
});

test('commands are refused while not allowed, and nothing is sent', async (t) => {
  const { server, press } = await setup(t);
  for (const [role, value] of [
    ['start-charge', 1],
    ['stop-charge', 1],
    ['set-current', '10'],
  ]) {
    const ack = await press(role, value);
    assert.equal(ack.success, false, role);
    assert.match(ack.error, /Autoriser les commandes/);
  }
  assert.deepEqual(server.patches(), []);
});

test('stop: limit 0; already stopped: nothing sent; never limited to one a minute', async (t) => {
  const { server, press, gladys, advance } = await setup(t, { config: ALLOWED });
  let ack = await press('stop-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.patches(), [{ ChargeCurrentLimit: 0 }]);
  await advance(20 * SECOND);
  assert.equal(last(gladys, 'charge-limit'), 0);
  ack = await press('stop-charge');
  assert.equal(ack.success, true);
  assert.equal(server.patches().length, 1, 'already stopped');
});

test('start: refused without a vehicle; sent with one, at the last current', async (t) => {
  const { server, press, charger } = await setup(t, { config: ALLOWED });
  charger.ev = ev({ CpState: 'State A', ChargeCurrentLimit: 0 });
  let ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Aucun véhicule/);
  charger.ev = ev({ CpState: 'State E', ChargeCurrentLimit: 0 });
  ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Erreur/);
  charger.ev = ev({ CpState: 'State B', ChargeCurrentLimit: 0 });
  ack = await press('start-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.patches(), [{ ChargeCurrentLimit: 16_000 }]);
});

test('current: strict value, ceiling, refused while stopped, one change a minute', async (t) => {
  const { server, press, charger } = await setup(t, { config: ALLOWED });
  for (const value of [null, '', ' ', true, 12.5, '1e1', '33']) {
    const ack = await press('set-current', value, 200);
    assert.equal(ack.success, false, JSON.stringify(value));
  }
  let ack = await press('set-current', '20');
  assert.match(ack.error, /entre 6 et 16 A/);
  ack = await press('set-current', '10');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.patches(), [{ ChargeCurrentLimit: 10_000 }]);
  ack = await press('set-current', '12');
  assert.equal(ack.success, false);
  assert.match(ack.error, /moins d'une minute/);
  ack = await press('stop-charge');
  assert.equal(ack.success, true, 'a stop is never held back by the minute');
  charger.ev.ChargeCurrentLimit = 0;
  await press('set-current', '8', 60 * SECOND);
  ack = await press('set-current', '8');
  assert.equal(ack.success, false);
  assert.match(ack.error, /relancerait/);
  assert.deepEqual(server.patches(), [{ ChargeCurrentLimit: 10_000 }, { ChargeCurrentLimit: 0 }]);
});

test('a stop is never held back by a command in flight: sent at once, then again', async (t) => {
  const { server, gladys, advance, charger } = await setup(t, { config: ALLOWED });
  charger.delays.PATCH = 2_500;
  const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
  const target = (role) => device.features.find((f) => f.external_id === feature(role));
  const current = gladys.fake.setValue(device, target('set-current'), '10');
  await advance(500, 100);
  charger.delays.PATCH = 0;
  const stop = gladys.fake.setValue(device, target('stop-charge'), 1);
  await advance(5 * SECOND, 100);
  assert.equal((await stop).success, true, (await stop).error);
  assert.equal((await current).success, true);
  assert.deepEqual(server.patches(), [
    { ChargeCurrentLimit: 10_000 },
    { ChargeCurrentLimit: 0 },
    { ChargeCurrentLimit: 0 },
  ]);
  assert.equal(charger.ev.ChargeCurrentLimit, 0, 'the stop wins');
});

test('a command not answered: "sent, without confirmation", then reads', async (t) => {
  const { server, press, charger } = await setup(t, { config: ALLOWED });
  charger.delays.PATCH = 10 * SECOND;
  const ack = await press('stop-charge', 1, 30 * SECOND);
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  const reads = server.paths().filter((p) => p === 'GET /api/wlac/v1/evinterface').length;
  assert.ok(reads >= 3, 'the fresh read, then the follow-up reads');
});

test('a stop is sent even when the fresh read fails', async (t) => {
  const { server, press, charger } = await setup(t, { config: ALLOWED });
  charger.statuses['GET /api/wlac/v1/evinterface'] = 500;
  const ack = await press('stop-charge', 1, 1_000);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.patches(), [{ ChargeCurrentLimit: 0 }]);
});

test('the option turned off during the fresh read: refused, not sent', async (t) => {
  const { server, gladys, app, advance, charger } = await setup(t, { config: ALLOWED });
  charger.delays['/api/wlac/v1/evinterface'] = 800;
  const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
  const target = device.features.find((f) => f.external_id === feature('stop-charge'));
  const ack = gladys.fake.setValue(device, target, 1);
  await advance(300, 100);
  await app.configUpdated({ ...CONFIG, allow_commands: false });
  await advance(2 * SECOND, 100);
  assert.equal((await ack).success, false);
  assert.match((await ack).error, /Autoriser les commandes/);
  assert.deepEqual(server.patches(), []);
});

test('a read begun before a command left is quarantined', async (t) => {
  const logs = [];
  const { gladys, advance, charger } = await setup(t, { config: ALLOWED, logs });
  charger.delays['/api/wlac/v1/meter'] = 2_000;
  await advance(30 * SECOND, 100);
  // The poll is in its meter read; a stop leaves meanwhile.
  const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
  const target = device.features.find((f) => f.external_id === feature('stop-charge'));
  const ack = gladys.fake.setValue(device, target, 1);
  await advance(3 * SECOND, 100);
  assert.equal((await ack).success, true);
  assert.ok(logs.some((l) => /begun before a command, not applied/.test(l)));
});

test('the reconnection to Gladys republishes the status and the devices', async (t) => {
  const { gladys, app } = await setup(t);
  const count = gladys.fake.discoveredDevices.length;
  await app.connected({ ...CONFIG });
  await settle();
  assert.ok(gladys.fake.discoveredDevices.length >= count);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('another charger at the address: the old device is shown unreachable', async (t) => {
  const { gladys, advance, charger, press } = await setup(t, { config: ALLOWED });
  charger.system = system({ ProductSn: '99-99-ZZZ-999' });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Borne injoignable');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /Plus lue/);
  const ack = await press('stop-charge');
  assert.equal(ack.success, false);
});
