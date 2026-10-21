// -----------------------------------------------------------------------------
// Peblar constants, manifest keys, limits and timings.
//
// A Peblar charger (Rocksolid / Business) has two HTTP APIs on port 80, as
// peblar (MIT, frenck/python-peblar 2.1.0, the library of Home Assistant's
// Peblar integration) reads them:
//   - the local REST API, `/api/wlac/v1/`, with an API token sent as is in
//     the `Authorization` header: meter, EV interface (charge current limit,
//     CP state), system (serial, errors), health (access mode);
//   - the web interface API, `/api/v1/`, behind the password of the web
//     interface (a session cookie): the API token, the user configuration
//     (installation limit) and the system information (rated current).
// Starting and stopping the charge, and the charging current, all go through
// one field: `ChargeCurrentLimit` of the EV interface, in mA (0 pauses the
// charge, as Home Assistant's "Charge" switch does).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 80;

export const PATHS = {
  rest: {
    meter: '/api/wlac/v1/meter',
    evInterface: '/api/wlac/v1/evinterface',
    system: '/api/wlac/v1/system',
    health: '/api/wlac/v1/health',
  },
  web: {
    login: '/api/v1/auth/login',
    apiToken: '/api/v1/config/api-token',
    user: '/api/v1/config/user',
    systemInfo: '/api/v1/system/info',
  },
};

/**
 * The charging current, in whole amperes: never below 6 A (IEC 61851, the
 * lowest current a vehicle accepts), never above the ceiling of the
 * configuration (16 A by default, 32 A at most) nor the limits the charger
 * gives when the password is known (installation limit, rated
 * current). 0 is never a current: it is "stop".
 */
export const CURRENT = {
  min: 6,
  max: 32,
  defaultCeiling: 16,
  /** Start sends the last current seen above 0, else this one. */
  startDefault: 6,
};

/** The CP state of the EV interface (IEC 61851), as peblar's CPState. */
export const CP_STATES = {
  'State A': 'no_ev',
  'State B': 'suspended',
  'State C': 'charging',
  'State D': 'ventilation',
  'State E': 'error',
  'State F': 'fault',
  'State Invalid': 'invalid',
  'unknown state': 'unknown',
};

/** Our states: the CP states, plus `offline` (no answer). */
export const STATE = {
  NO_EV: 'no_ev',
  SUSPENDED: 'suspended',
  CHARGING: 'charging',
  VENTILATION: 'ventilation',
  ERROR: 'error',
  FAULT: 'fault',
  INVALID: 'invalid',
  UNKNOWN: 'unknown',
  OFFLINE: 'offline',
};

/** A vehicle is plugged in (B, C, D): the only states where a start is sent. */
export const PLUGGED_STATES = new Set([STATE.SUSPENDED, STATE.CHARGING, STATE.VENTILATION]);

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'plugged',
  POWER: 'power',
  POWER_L1: 'power-l1',
  POWER_L2: 'power-l2',
  POWER_L3: 'power-l3',
  CURRENT_L1: 'current-l1',
  CURRENT_L2: 'current-l2',
  CURRENT_L3: 'current-l3',
  VOLTAGE_L1: 'voltage-l1',
  VOLTAGE_L2: 'voltage-l2',
  VOLTAGE_L3: 'voltage-l3',
  SESSION_ENERGY: 'session-energy',
  TOTAL_ENERGY: 'total-energy',
  CHARGE_LIMIT: 'charge-limit',
  CHARGE_LIMIT_ACTUAL: 'charge-limit-actual',
  LIMIT_SOURCE: 'limit-source',
  ERROR: 'error',
  WARNING: 'warning',
  SINGLE_PHASE: 'single-phase',
  START: 'start-charge',
  STOP: 'stop-charge',
  SET_CURRENT: 'set-current',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** The answers are a few hundred bytes; the user configuration about 2 KB. */
  responseBytes: 64 * 1024,
  /** Longest text kept from an answer (model, firmware, limit source). */
  textLength: 60,
  /** API token and password: printable ASCII, bounded. */
  secretMin: 1,
  secretMax: 256,
  /** Session cookies kept from the login answer. */
  cookies: 4,
  cookieBytes: 4096,
  /** Error and warning codes kept from the system answer. */
  codes: 32,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (peblar waits 8 s; a LAN charger answers in well under 1 s). */
  readTimeout: 5 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429: Retry-After bounded to 1 min .. 6 h, 5 min without. A 5xx pauses as a failed read. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** Token or password refused: new tries 15 min, 1 h, then every 6 h (kept in /data). */
  authBackoff: [15 * MINUTE, HOUR, 6 * HOUR],
  /** A login (password) at most this often, whatever happens. */
  loginMinInterval: 10 * MINUTE,
  /** Health (access mode of the token): read again every hour. */
  slowRefresh: HOUR,
  /** User configuration and system information (web API, a login): at the start, then every 24 h. */
  webRefresh: 24 * HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads the charger at most this often. */
  testCooldown: 10 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the command
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 1.5 s at most, and 0.3 s left to send after it. */
  commandReadMax: 1_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until the limit moves to what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** A stop reaffirmed at most this often while its guard holds (a late command landing after it). */
  stopReasserts: 2,
  /** A watched stop whose resend got a 429: watched until the first read after the pause, 10 min at most. */
  stopWatchMax: 10 * MINUTE,
  /** One change of the charging current (start included) a minute; a stop is never limited. */
  currentMinInterval: MINUTE,
};
