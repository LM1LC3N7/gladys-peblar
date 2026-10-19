// -----------------------------------------------------------------------------
// The Peblar HTTP APIs, ported from peblar 2.1.0 (MIT, frenck/python-peblar):
// the local REST API (`/api/wlac/v1/`, API token in the `Authorization`
// header, sent as is) and the few calls of the web interface API
// (`/api/v1/`, session cookie after a login with the password) this
// integration needs: the API token, the user configuration and the system
// information. Reads are never retried here (the app spaces its new tries,
// peblar's three tries with backoff are not kept); a command is never retried
// at all (it may have reached the charger).
//
// The answers come from the network: only own fields of a plain object are
// read, each with its exact type (a missing or mistyped value is undefined,
// never a default, so that a command is refused rather than decided on a
// guess). JSON.parse keeps `__proto__` as a plain own key: it never reaches a
// prototype, and it is never read.
// -----------------------------------------------------------------------------

import { CP_STATES, LIMITS, PATHS, STATE } from '../constants.js';
import { ChargerError, ERROR_KINDS, request as httpRequest } from './http.js';

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const integer = (value) => (Number.isInteger(value) ? value : undefined);
const bool = (value) => (typeof value === 'boolean' ? value : undefined);
const plain = (data) => data !== null && typeof data === 'object' && !Array.isArray(data);

/** A short text from the charger, without control characters. */
export function text(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.textLength);
}

/** The serial number (`ProductSn`, "00-00-AAA-000") in lower case, else undefined. */
export function serialOf(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const serial = value.trim().toLowerCase();
  return /^[0-9a-z](?:[0-9a-z-]{0,38}[0-9a-z])?$/.test(serial) ? serial : undefined;
}

const notObject = () => new ChargerError(ERROR_KINDS.PROTOCOL, 'Not a JSON object');

/** GET meter -> A, W, V and kWh (the charger gives mA, W, V and Wh). */
export function parseMeter(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const amps = (key) => {
    const value = number(own(data, key));
    return value === undefined ? undefined : value / 1000;
  };
  const kwh = (key) => {
    const value = number(own(data, key));
    return value === undefined ? undefined : value / 1000;
  };
  return {
    currents: [amps('CurrentPhase1'), amps('CurrentPhase2'), amps('CurrentPhase3')],
    powers: [
      number(own(data, 'PowerPhase1')),
      number(own(data, 'PowerPhase2')),
      number(own(data, 'PowerPhase3')),
    ],
    // A phase the charger cannot measure is left out (peblar): undefined, never 0.
    voltages: [
      number(own(data, 'VoltagePhase1')),
      number(own(data, 'VoltagePhase2')),
      number(own(data, 'VoltagePhase3')),
    ],
    power: number(own(data, 'PowerTotal')),
    sessionEnergy: kwh('EnergySession'),
    totalEnergy: kwh('EnergyTotal'),
  };
}

/** GET evinterface -> the charge current limit (mA), the CP state. */
export function parseEvInterface(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const limit = integer(own(data, 'ChargeCurrentLimit'));
  const actual = integer(own(data, 'ChargeCurrentLimitActual'));
  const cp = own(data, 'CpState');
  return {
    limit: limit !== undefined && limit >= 0 ? limit : undefined,
    limitActual: actual !== undefined && actual >= 0 ? actual : undefined,
    limitSource: text(own(data, 'ChargeCurrentLimitSource')),
    state: typeof cp === 'string' && Object.hasOwn(CP_STATES, cp) ? CP_STATES[cp] : STATE.UNKNOWN,
    singlePhase: bool(own(data, 'Force1Phase')),
  };
}

const codes = (value) =>
  Array.isArray(value)
    ? value.slice(0, LIMITS.codes).filter((code) => Number.isInteger(code))
    : undefined;

/** GET system -> serial, firmware, phases, active error and warning codes. */
export function parseSystem(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const phases = integer(own(data, 'PhaseCount'));
  return {
    serial: serialOf(own(data, 'ProductSn')),
    firmware: text(own(data, 'FirmwareVersion')),
    phases: phases === 1 || phases === 3 ? phases : undefined,
    errors: codes(own(data, 'ActiveErrorCodes')),
    warnings: codes(own(data, 'ActiveWarningCodes')),
  };
}

/** GET health -> the access mode of the token ("ReadWrite" or "ReadOnly"). */
export function parseHealth(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const mode = own(data, 'AccessMode');
  return {
    accessMode: mode === 'ReadWrite' || mode === 'ReadOnly' ? mode : undefined,
    apiVersion: text(own(data, 'ApiVersion')),
  };
}

/** A whole number of amperes usable as a bound (6 to 80 A), else undefined. */
const amperes = (value) =>
  Number.isInteger(value) && value >= 6 && value <= 80 ? value : undefined;

/** GET config/user (web API) -> the installation limit and the REST API settings. */
export function parseUserConfig(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const mode = own(data, 'LocalRestApiAccessMode');
  return {
    // The installation limit, never UserDefinedChargeLimitCurrent: the charger
    // may mirror into it the limit written through the REST API, so a bound
    // read from it would ratchet down at each command.
    installMax: amperes(own(data, 'CurrentCtrlFixedChargeCurrentLimit')),
    restAllowed: bool(own(data, 'LocalRestApiAllowed')),
    restEnabled: bool(own(data, 'LocalRestApiEnable')),
    restAccessMode: mode === 'ReadWrite' || mode === 'ReadOnly' ? mode : undefined,
  };
}

/** GET system/info (web API) -> the rated current and the model. */
export function parseSystemInfo(data) {
  if (!plain(data)) {
    throw notObject();
  }
  return {
    hardwareMax: amperes(own(data, 'HwMaxCurrent')),
    model: text(own(data, 'ProductModelName')),
    vendor: text(own(data, 'ProductVendorName')),
  };
}

/** GET config/api-token (web API) -> the API token, else a protocol error. */
export function parseToken(data) {
  const token = plain(data) ? own(data, 'ApiToken') : undefined;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(token)) {
    throw new ChargerError(ERROR_KINDS.PROTOCOL, 'No API token in the answer');
  }
  return token;
}

/** The `name=value` of the session cookies of a login answer, bounded, else undefined. */
export function cookieOf(header) {
  const lines = (Array.isArray(header) ? header : header === undefined ? [] : [header])
    .filter((line) => typeof line === 'string')
    .slice(0, LIMITS.cookies);
  const pairs = [];
  for (const line of lines) {
    const pair = line.split(';', 1)[0].trim();
    if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}=[\x21-\x3a\x3c-\x7e]{0,1024}$/.test(pair)) {
      pairs.push(pair);
    }
  }
  const cookie = pairs.join('; ');
  return cookie !== '' && cookie.length <= LIMITS.cookieBytes ? cookie : undefined;
}

/** Retry-After (seconds or an HTTP date) in ms, else undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  if (/^\s*\d+\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The error of a non-2xx answer (the body is never kept: it may echo a secret). */
function statusError(response, now) {
  if (response.status === 429) {
    return new ChargerError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status: 429,
      retryAfter: retryAfterOf(response.headers?.['retry-after'], now),
    });
  }
  if (response.status === 401 || response.status === 403) {
    return new ChargerError(ERROR_KINDS.AUTH, `HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return new ChargerError(ERROR_KINDS.HTTP, `HTTP ${response.status}`, {
    status: response.status,
  });
}

/** The reason of an error for a log or a message: its kind and status, never the answer. */
export function errorReason(err) {
  if (
    err?.kind === ERROR_KINDS.HTTP ||
    err?.kind === ERROR_KINDS.RATE_LIMITED ||
    err?.kind === ERROR_KINDS.AUTH
  ) {
    return `HTTP ${err.status}`;
  }
  return err?.kind ?? 'error';
}

const ok = (response) => response.status >= 200 && response.status <= 299;

function json(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Not JSON');
  }
}

export class PeblarClient {
  constructor({ transport = httpRequest, now = Date.now } = {}) {
    this.transport = transport;
    this.now = now;
  }

  async exchange(address, options) {
    const response = await this.transport({ ...address, ...options });
    if (!ok(response)) {
      throw statusError(response, this.now());
    }
    return response;
  }

  /** GET on the local REST API with the token -> the JSON answer. */
  async rest(address, token, path, { timeoutMs }) {
    return json(
      await this.exchange(address, {
        method: 'GET',
        path,
        headers: { Authorization: token },
        timeoutMs,
      }),
    );
  }

  /**
   * PATCH evinterface `{ ChargeCurrentLimit }` (mA), never retried.
   * `startBy`: refused unsent (LATE) after it. The value is checked by the caller.
   */
  async setLimit(address, token, milliamps, { startBy, timeoutMs }) {
    if (!Number.isInteger(milliamps) || milliamps < 0) {
      throw Object.assign(new Error('Bad charge current limit'), { notSent: true });
    }
    if (this.now() > startBy) {
      throw new ChargerError(ERROR_KINDS.LATE, 'Too late to send');
    }
    await this.exchange(address, {
      method: 'PATCH',
      path: PATHS.rest.evInterface,
      headers: { Authorization: token },
      body: JSON.stringify({ ChargeCurrentLimit: milliamps }),
      timeoutMs,
    });
  }

  /** POST auth/login (web API) -> the session cookie. A wrong password is AUTH. */
  async login(address, password, { timeoutMs }) {
    const response = await this.exchange(address, {
      method: 'POST',
      path: PATHS.web.login,
      body: JSON.stringify({ Password: password, PersistentSession: false }),
      timeoutMs,
    });
    const cookie = cookieOf(response.headers?.['set-cookie']);
    if (!cookie) {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'No session cookie');
    }
    return cookie;
  }

  /** GET on the web API with the session cookie -> the JSON answer. */
  async web(address, cookie, path, { timeoutMs }) {
    return json(
      await this.exchange(address, {
        method: 'GET',
        path,
        headers: { Cookie: cookie },
        timeoutMs,
      }),
    );
  }
}
