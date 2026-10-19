// -----------------------------------------------------------------------------
// The charger -> one Gladys device and its states (pure).
//
// `ext:<selector>:peblar:<serial>`: one device per charger, keyed by its
// serial number (`ProductSn` of the local REST API, in lower case), never by
// its IP address (it may change). The feature roles (the last part of their
// external ids) are published forever: never rename them. Every role is
// always built, whatever the model (a single-phase charger leaves its L2 and
// L3 features empty), so a republished device never loses a feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a charge command.
// Starting and stopping are two `button/push` features, the charging current
// a `text/select` of the whole amperes from 6 A to the ceiling. All three
// refuse unless the configuration allows the commands (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, A and V on `energy-sensor`
// (instantaneous readings, never an index); kWh and A on
// `electrical-vehicle-charge`. The energy of the session and the total
// energy are plain sensors (`last-charge-energy-added`,
// `charge-energy-consumption-total`): never an `index`/`energy` feature, so
// the energy tab never counts them (the charger is behind the main meter).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { CURRENT, FEATURES, PLUGGED_STATES, STATE } from './constants.js';
import { FEATURE_NAMES, STATE_NAMES, STOPPED, word } from './i18n.js';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const power = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.POWER,
  unit: U.WATT,
  min: 0,
  max: 50_000,
});
const current = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.CURRENT,
  unit: U.AMPERE,
  min: 0,
  max: 100,
});
const voltage = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.VOLTAGE,
  unit: U.VOLT,
  min: 0,
  max: 500,
});
const limit = sensor({
  category: C.ELECTRICAL_VEHICLE_CHARGE,
  type: T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT,
  unit: U.AMPERE,
  min: 0,
  max: 80,
});
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 });

/** The features, by role, in display order (set-current gets its options in buildDevice). */
export const DEFINITIONS = {
  [FEATURES.STATUS]: text,
  [FEATURES.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [FEATURES.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [FEATURES.PLUGGED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
  }),
  [FEATURES.POWER]: power,
  [FEATURES.POWER_L1]: power,
  [FEATURES.POWER_L2]: power,
  [FEATURES.POWER_L3]: power,
  [FEATURES.CURRENT_L1]: current,
  [FEATURES.CURRENT_L2]: current,
  [FEATURES.CURRENT_L3]: current,
  [FEATURES.VOLTAGE_L1]: voltage,
  [FEATURES.VOLTAGE_L2]: voltage,
  [FEATURES.VOLTAGE_L3]: voltage,
  [FEATURES.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1000,
  }),
  [FEATURES.TOTAL_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ENERGY_CONSUMPTION_TOTAL,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 10_000_000,
  }),
  [FEATURES.CHARGE_LIMIT]: limit,
  [FEATURES.CHARGE_LIMIT_ACTUAL]: limit,
  [FEATURES.LIMIT_SOURCE]: text,
  [FEATURES.ERROR]: binary,
  [FEATURES.WARNING]: binary,
  [FEATURES.SINGLE_PHASE]: binary,
  [FEATURES.START]: button,
  [FEATURES.STOP]: button,
  [FEATURES.SET_CURRENT]: {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  },
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [FEATURES.START, FEATURES.STOP, FEATURES.SET_CURRENT];

export const chargerIds = (gladys, serial) => gladys.externalIds('peblar', serial);

const SERIAL = '[0-9a-z](?:[0-9a-z-]{0,38}[0-9a-z])?';

/** The serial and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:peblar:(${SERIAL}):([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[2]) ? { serial: match[1], role: match[2] } : undefined;
}

/** The serial of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = new RegExp(`:peblar:(${SERIAL})$`).exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

export function currentOptions(ceiling) {
  const options = [];
  for (let amps = CURRENT.min; amps <= ceiling; amps += 1) {
    options.push({ value: String(amps), label: `${amps} A`, sort_order: amps - CURRENT.min });
  }
  return options;
}

export const deviceName = (charger) =>
  `${charger.vendor ?? 'Peblar'} ${charger.serial.replace(/-/g, '').slice(-4).toUpperCase()}`;

/**
 * The Gladys device of the charger. `ceiling`: the highest current the
 * commands accept now (the select is only an offer: the command checks the
 * ceiling again, and the limit read just before sending).
 */
export function buildDevice(gladys, charger, { ceiling, language }) {
  const ids = chargerIds(gladys, charger.serial);
  const params = [{ name: 'serial_number', value: charger.serial }];
  if (charger.firmware) {
    params.push({ name: 'firmware', value: charger.firmware });
  }
  if (charger.phases) {
    params.push({ name: 'phases', value: String(charger.phases) });
  }
  return {
    name: deviceName(charger),
    external_id: ids.device,
    model: charger.model ?? 'Peblar',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.SET_CURRENT ? { supported_options: currentOptions(ceiling) } : {}),
    })),
    params,
  };
}

/** The connector, as the core's charging-station category reads it (undefined: unknown). */
export function connectorOf(state) {
  switch (state) {
    case STATE.OFFLINE:
      return CONNECTOR_STATUS.UNAVAILABLE;
    case STATE.NO_EV:
      return CONNECTOR_STATUS.AVAILABLE;
    case STATE.SUSPENDED:
    case STATE.CHARGING:
    case STATE.VENTILATION:
      return CONNECTOR_STATUS.OCCUPIED;
    case STATE.ERROR:
    case STATE.FAULT:
      return CONNECTOR_STATUS.FAULTED;
    default:
      return undefined;
  }
}

/**
 * The charging state (OCPP's chargingState). No vehicle or an error: IDLE, so
 * a scene never keeps reading "charging" after the car left.
 */
export function chargingStateOf(ev) {
  switch (ev?.state) {
    case STATE.CHARGING:
    case STATE.VENTILATION:
      return CHARGING_STATE.CHARGING;
    case STATE.SUSPENDED:
      return ev.limit === 0 ? CHARGING_STATE.PAUSED_BY_CHARGER : CHARGING_STATE.EV_CONNECTED;
    case STATE.NO_EV:
    case STATE.ERROR:
    case STATE.FAULT:
      return CHARGING_STATE.IDLE;
    default:
      return undefined;
  }
}

/** The text of the status feature. */
export function statusText(ev) {
  if (ev?.state === STATE.SUSPENDED && ev.limit === 0) {
    return STOPPED;
  }
  return STATE_NAMES[ev?.state] ?? STATE_NAMES[STATE.UNKNOWN];
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const flag = (value) => (value === undefined ? undefined : value ? 1 : 0);

/**
 * The current values of the charger's device. Offline: only the status and
 * the connector (Gladys keeps the last value of the others).
 */
export function deviceStates(ids, charger, { online, language, ceiling }) {
  if (!online) {
    return [
      { role: FEATURES.STATUS, text: word(STATE_NAMES[STATE.OFFLINE], language) },
      { role: FEATURES.CONNECTOR, state: CONNECTOR_STATUS.UNAVAILABLE },
    ].map(({ role, ...value }) => ({ device_feature_external_id: ids.feature(role), ...value }));
  }
  const states = [];
  // A value outside the bounds of its feature is dropped (Gladys keeps the last one).
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (value !== undefined && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  const ev = charger.ev;
  if (ev) {
    states.push({ role: FEATURES.STATUS, text: word(statusText(ev), language) });
    add(FEATURES.CONNECTOR, connectorOf(ev.state));
    add(FEATURES.CHARGING_STATE, chargingStateOf(ev));
    if (ev.state !== STATE.UNKNOWN && ev.state !== STATE.INVALID) {
      add(FEATURES.PLUGGED, PLUGGED_STATES.has(ev.state) ? 1 : 0);
    }
    if (ev.limit !== undefined) add(FEATURES.CHARGE_LIMIT, round(ev.limit / 1000, 1));
    if (ev.limitActual !== undefined) {
      add(FEATURES.CHARGE_LIMIT_ACTUAL, round(ev.limitActual / 1000, 1));
    }
    if (ev.limitSource) states.push({ role: FEATURES.LIMIT_SOURCE, text: ev.limitSource });
    add(FEATURES.SINGLE_PHASE, flag(ev.singlePhase));
    // The select shows the limit in force when it is one of its options.
    const amps = ev.limit === undefined ? undefined : ev.limit / 1000;
    if (Number.isInteger(amps) && amps >= CURRENT.min && amps <= ceiling) {
      states.push({ role: FEATURES.SET_CURRENT, text: String(amps) });
    }
  }
  const m = charger.meter;
  if (m) {
    if (m.power !== undefined) add(FEATURES.POWER, Math.round(m.power));
    const phases = [
      [FEATURES.POWER_L1, FEATURES.CURRENT_L1, FEATURES.VOLTAGE_L1],
      [FEATURES.POWER_L2, FEATURES.CURRENT_L2, FEATURES.VOLTAGE_L2],
      [FEATURES.POWER_L3, FEATURES.CURRENT_L3, FEATURES.VOLTAGE_L3],
    ];
    for (const [i, [powerRole, currentRole, voltageRole]] of phases.entries()) {
      if (m.powers[i] !== undefined) add(powerRole, Math.round(m.powers[i]));
      if (m.currents[i] !== undefined) add(currentRole, round(m.currents[i], 2));
      if (m.voltages[i] !== undefined) add(voltageRole, Math.round(m.voltages[i]));
    }
    if (m.sessionEnergy !== undefined) add(FEATURES.SESSION_ENERGY, round(m.sessionEnergy, 3));
    // Never 0 (a reset glitch): a plain sensor, yet a chart would show a drop.
    if (m.totalEnergy !== undefined && m.totalEnergy > 0) {
      add(FEATURES.TOTAL_ENERGY, round(m.totalEnergy, 3));
    }
  }
  const s = charger.system;
  if (s) {
    if (s.errors) add(FEATURES.ERROR, s.errors.length > 0 ? 1 : 0);
    if (s.warnings) add(FEATURES.WARNING, s.warnings.length > 0 ? 1 : 0);
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
