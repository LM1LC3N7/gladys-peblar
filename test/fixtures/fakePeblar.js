// -----------------------------------------------------------------------------
// A fake Peblar charger behind the transport the integration is given: the
// answers shaped like peblar's test fixtures (made up, never captured from a
// real charger), the API token checked on the local REST API, the login and
// its session cookie on the web API, and the PATCH of the charge current
// limit, which changes the charger like it is expected to. Records every
// request. No network. Delays use setTimeout, so the mocked clock drives them.
// -----------------------------------------------------------------------------

import { ChargerError, ERROR_KINDS } from '../../src/peblar/http.js';

export const HOST = '192.168.1.60';
export const TOKEN = 'a'.repeat(64);
export const PASSWORD = 'correct horse';
export const SERIAL = '23-45-abc-678';
export const NOW = Date.UTC(2026, 9, 19, 18, 0, 0);

/** Charging on three phases: 16 A limit, 11 kW, 34.918 kWh this session. */
export const meter = (over = {}) => ({
  CurrentPhase1: 15_900,
  CurrentPhase2: 16_000,
  CurrentPhase3: 15_800,
  EnergySession: 34_918,
  EnergyTotal: 4_937_323,
  PowerPhase1: 3_650,
  PowerPhase2: 3_680,
  PowerPhase3: 3_640,
  PowerTotal: 10_970,
  VoltagePhase1: 229,
  VoltagePhase2: 230,
  VoltagePhase3: 231,
  ...over,
});

export const ev = (over = {}) => ({
  ChargeCurrentLimit: 16_000,
  ChargeCurrentLimitActual: 16_000,
  ChargeCurrentLimitSource: 'Local REST API',
  CpState: 'State C',
  Force1Phase: false,
  ...over,
});

export const system = (over = {}) => ({
  ActiveErrorCodes: [],
  ActiveWarningCodes: [],
  CellularSignalStrength: null,
  FirmwareVersion: '1.9.0+1+WL-1',
  Force1PhaseAllowed: true,
  PhaseCount: 3,
  ProductPn: '6004-2300-7600',
  ProductSn: '23-45-ABC-678',
  Uptime: 3_514_985,
  WlanSignalStrength: null,
  ...over,
});

export const health = (over = {}) => ({ AccessMode: 'ReadWrite', ApiVersion: '1.0', ...over });

export const userConfig = (over = {}) => ({
  LocalRestApiAccessMode: 'ReadWrite',
  LocalRestApiAllowed: true,
  LocalRestApiEnable: true,
  CurrentCtrlFixedChargeCurrentLimit: 20,
  UserDefinedChargeLimitCurrent: 32,
  ...over,
});

export const systemInfo = (over = {}) => ({
  HwMaxCurrent: 32,
  ProductModelName: 'WLAC1-H11R0WE0ICR00',
  ProductVendorName: 'Peblar',
  ...over,
});

const answer = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The charger. The test may set: `down` (nothing answers), `silent`
 * (connected, no answer), `delays` / `statuses` (by path), `applies` (false:
 * the PATCH changes nothing), `token` / `password` (what it accepts),
 * `bodies` (raw answer by path), `headers` (of an error answer).
 */
export function fakeCharger(over = {}) {
  const charger = {
    token: TOKEN,
    password: PASSWORD,
    cookie: 'session=s1',
    meter: meter(),
    ev: ev(),
    system: system(),
    health: health(),
    user: userConfig(),
    info: systemInfo(),
    delays: {},
    statuses: {},
    bodies: {},
    headers: {},
    applies: true,
    ...over,
  };
  const server = {
    charger,
    /** { host, port, method, path, headers, body, timeoutMs } */
    requests: [],
    paths: () => server.requests.map((r) => `${r.method} ${r.path}`),
    patches: () =>
      server.requests.filter((r) => r.method === 'PATCH').map((r) => JSON.parse(r.body)),
    logins: () => server.requests.filter((r) => r.path === '/api/v1/auth/login'),
    async transport(request) {
      const { method, path, headers = {}, body, timeoutMs } = request;
      server.requests.push(request);
      if (charger.down) {
        throw new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      if (method === 'PATCH' && charger.patchPlan && headers.Authorization === charger.token) {
        // `patchPlan(index)` -> { applyAfter, answerAfter } (ms): the PATCH lands
        // on the charger at applyAfter, whether or when it is answered.
        const value = JSON.parse(body).ChargeCurrentLimit;
        const index = server.patches().length - 1;
        const { applyAfter = 0, answerAfter = 0 } = charger.patchPlan(index) ?? {};
        const apply = () => {
          charger.ev.ChargeCurrentLimit = value;
          if (charger.mirrorUser && value >= 6000) {
            charger.user.UserDefinedChargeLimitCurrent = value / 1000;
          }
        };
        if (applyAfter > 0) {
          setTimeout(apply, applyAfter);
        } else {
          apply();
        }
        if (answerAfter >= timeoutMs) {
          await wait(timeoutMs);
          throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
        }
        if (answerAfter) {
          await wait(answerAfter);
        }
        return answer(200, '');
      }
      const delay = charger.delays[path] ?? charger.delays[method] ?? 0;
      if (charger.silent || delay >= timeoutMs) {
        await wait(timeoutMs);
        throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
      }
      if (delay) {
        await wait(delay);
      }
      const status = charger.statuses[`${method} ${path}`] ?? charger.statuses[path];
      if (status) {
        return answer(status, 'error', charger.headers);
      }
      if (path.startsWith('/api/wlac/v1/')) {
        if (headers.Authorization !== charger.token) {
          return answer(401, 'Unauthorized');
        }
        if (method === 'PATCH' && path === '/api/wlac/v1/evinterface') {
          if (charger.applies) {
            charger.ev.ChargeCurrentLimit = JSON.parse(body).ChargeCurrentLimit;
          }
          return answer(200, '');
        }
        const table = {
          '/api/wlac/v1/meter': charger.meter,
          '/api/wlac/v1/evinterface': charger.ev,
          '/api/wlac/v1/system': charger.system,
          '/api/wlac/v1/health': charger.health,
        };
        return answer(200, charger.bodies[path] ?? table[path] ?? 'not found');
      }
      if (path === '/api/v1/auth/login') {
        return JSON.parse(body).Password === charger.password
          ? answer(200, '', { 'set-cookie': [`${charger.cookie}; Path=/; HttpOnly`] })
          : answer(401, 'Unauthorized');
      }
      if (path.startsWith('/api/v1/')) {
        if (headers.Cookie !== charger.cookie) {
          return answer(401, 'Unauthorized');
        }
        const table = {
          '/api/v1/config/api-token': { ApiToken: charger.token },
          '/api/v1/config/user': charger.user,
          '/api/v1/system/info': charger.info,
        };
        return answer(200, charger.bodies[path] ?? table[path] ?? 'not found');
      }
      return answer(404, 'not found');
    },
  };
  return server;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
