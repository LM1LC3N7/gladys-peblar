// -----------------------------------------------------------------------------
// The integration: the Peblar charger typed in the configuration (one IP
// address, an API token or the password of its web interface), one read of
// it every poll interval, its Gladys device and states, the transport badge,
// the "Test the connection" button, and the three commands (start, stop,
// charging current), refused unless the configuration allows them. index.js
// only wires the SDK handlers to it.
//
// Commands follow the rules learnt on the previous modules (and the approved
// KEBA and TechnoVE modules):
//   - decided on a fresh read of the EV interface only, never on the state
//     kept in memory, and refused when a value they need is missing;
//   - the "Allow the commands" option is checked on arrival and again right
//     before sending;
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//   - a command that may have reached the charger (silence, a 5xx) is never
//     answered "not sent": "sent, without confirmation", then spaced reads;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time, never retried; one current change a minute;
//   - "Stop charging" is never held back: not by a command in flight (it goes
//     at once, and once more when that command settles), not by the minute
//     between two currents, not by a 429 pause, not by a failed fresh read;
//   - a read that began before the last command was sent may show the state
//     before it: quarantined, never applied nor published.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, credentialsKey, normalizeConfig } from './config.js';
import { CURRENT, FEATURES, PATHS, PRESSED, SECOND, STATE, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  chargerIds,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  statusText,
} from './devices.js';
import { ERRORS, STATE_NAMES, T, age, summaryOf, word } from './i18n.js';
import {
  PeblarClient,
  errorReason,
  parseEvInterface,
  parseHealth,
  parseMeter,
  parseSystem,
  parseSystemInfo,
  parseToken,
  parseUserConfig,
} from './peblar/client.js';
import { ERROR_KINDS } from './peblar/http.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const both = (en, fr) => ({ en, fr });
const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** No login allowed yet (the last one is too recent): never a loop of logins. */
const LOGIN_WAIT = 'login_wait';
/** A pause began in this cycle: it stops at once. */
const PAUSED = 'paused';
/** A limit below 6 A: the charge is stopped (0, or a value no vehicle accepts). */
const STOPPED_BELOW = CURRENT.min * 1000;

const freshCharger = () => ({
  serial: undefined,
  firmware: undefined,
  phases: undefined,
  model: undefined,
  vendor: undefined,
  hardwareMax: undefined,
  installMax: undefined,
  restEnabled: undefined,
  accessMode: undefined,
  ev: undefined,
  meter: undefined,
  system: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
  healthAt: -Infinity,
  webAt: -Infinity,
  /** When the last request that writes left, resends included (a read begun before it is quarantined). */
  lastSentAt: -Infinity,
  /** When the last command of a user left (resends of a stop excluded). */
  lastCommandAt: -Infinity,
  /** Until then, a command not confirmed may still land (a stop sent meanwhile is reaffirmed). */
  unconfirmedUntil: -Infinity,
  /** When the last current change (start included) left: one a minute. */
  lastCurrentAt: -Infinity,
  /** The last limit seen above 0, in whole amperes: what a start sends again. */
  lastAmps: undefined,
});

export class PeblarApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'peblar' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new PeblarClient({ transport, now });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    this.charger = freshCharger();
    this.generation = 0;
    this.started = false;
    this.pausedUntil = 0;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** Memory only, never logged nor stored: the token got with the password, its session cookie. */
    this.token = undefined;
    this.cookie = undefined;
    this.lastLoginAt = -Infinity;
    /** The command in flight: { role, sentAt, overtaken, again, promise } (a stop aside). */
    this.inFlight = undefined;
    /** `${serial}:limit` -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.charger.running;
    this.config = normalizeConfig(raw);
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    // A pause survives a restart and a new configuration.
    if (this.memory.pause) {
      this.pausedUntil = Math.max(this.pausedUntil, this.memory.pause.until);
    }
    this.charger = freshCharger();
    this.token = undefined;
    this.cookie = undefined;
    // Restarted for a new address or new credentials: they may log in at once.
    this.lastLoginAt = -Infinity;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.config.address || !this.config.auth) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1]);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.charger.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.charger.followUps.clear();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.charger.timer) {
      this.timers.clearTimeout(this.charger.timer);
      this.charger.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states. Pauses, blocks and the token stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.liftBlockOnNewCredentials(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address or new credentials restart (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalidHost !== this.config.invalidHost ||
      credentialsKey(next) !== credentialsKey(this.config)
    );
  }

  /** New credentials saved (or given at a reconnection) lift a block at once. */
  async liftBlockOnNewCredentials(raw) {
    if (credentialsKey(normalizeConfig(raw)) !== credentialsKey(this.config) && this.memory.block) {
      this.memory.block = null;
      await this.saveMemory();
    }
  }

  /** A new interval: the next read follows it, without a restart (no new login). */
  rescheduleOnNewInterval(previous) {
    const c = this.charger;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      this.config.auth &&
      !c.running &&
      c.online !== false
    ) {
      this.schedule();
    }
  }

  /**
   * New address or credentials restart (new credentials lift a block at
   * once); the interval, the option, the ceiling and the language apply at
   * once.
   */
  async configUpdated(raw = {}) {
    await this.liftBlockOnNewCredentials(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Peblar commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (
      this.config.language !== previous.language ||
      this.config.maxCurrent !== previous.maxCurrent ||
      this.config.allowCommands !== previous.allowCommands
    ) {
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  // --- Credentials -----------------------------------------------------------

  get blocked() {
    return Boolean(this.memory.block) && this.now() < this.memory.block.until;
  }

  /** The token to send now, without any login (commands), else undefined. */
  currentToken() {
    if (this.blocked) {
      return undefined;
    }
    return this.config.auth?.mode === 'token' ? this.config.auth.token : this.token;
  }

  get loginAllowed() {
    return this.now() - this.lastLoginAt >= TIMINGS.loginMinInterval;
  }

  /**
   * The token of the polling: the configured one, or the one read with the
   * password (a login at most every 10 minutes, whatever happens).
   */
  async credential() {
    const token = this.currentToken();
    if (token || this.config.auth.mode === 'token') {
      return token;
    }
    if (!this.loginAllowed) {
      const err = new Error('Login not allowed yet');
      err.kind = LOGIN_WAIT;
      throw err;
    }
    this.lastLoginAt = this.now();
    const address = this.config.address;
    try {
      this.cookie = await this.client.login(address, this.config.auth.password, {
        timeoutMs: TIMINGS.readTimeout,
      });
      this.token = parseToken(
        await this.client.web(address, this.cookie, PATHS.web.apiToken, {
          timeoutMs: TIMINGS.readTimeout,
        }),
      );
    } catch (err) {
      this.cookie = undefined;
      this.token = undefined;
      err.login = true;
      throw err;
    }
    this.logger.info('Peblar: logged in, API token read');
    await this.readWeb();
    return this.token;
  }

  /**
   * The user configuration and the system information (web API), with the
   * session cookie: the bounds of the current and the model. Never blocks
   * the main data; a refused cookie is only dropped.
   */
  async readWeb() {
    const c = this.charger;
    c.webAt = this.now();
    if (!this.cookie) {
      return;
    }
    const address = this.config.address;
    for (const [path, parse, apply] of [
      [
        PATHS.web.user,
        parseUserConfig,
        (u) => {
          c.installMax = u.installMax;
          c.restEnabled = u.restAllowed === false ? false : u.restEnabled;
        },
      ],
      [
        PATHS.web.systemInfo,
        parseSystemInfo,
        (i) => {
          c.hardwareMax = i.hardwareMax;
          c.model = i.model ?? c.model;
          c.vendor = i.vendor ?? c.vendor;
        },
      ],
    ]) {
      try {
        apply(
          parse(
            await this.client.web(address, this.cookie, path, { timeoutMs: TIMINGS.readTimeout }),
          ),
        );
      } catch (err) {
        if (err.kind === ERROR_KINDS.AUTH) {
          this.cookie = undefined;
        }
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
        }
        this.logger.warn(`Peblar web API ${path}: ${errorReason(err)}`);
        return;
      }
    }
  }

  /** A token or a password refused: the tries are spaced (15 min, 1 h, 6 h), kept in /data. */
  async authFailed(mode) {
    const failures = (this.memory.block?.failures ?? 0) + 1;
    const wait = TIMINGS.authBackoff[Math.min(failures - 1, TIMINGS.authBackoff.length - 1)];
    this.memory.block = { until: this.now() + wait, mode, failures };
    this.token = undefined;
    this.cookie = undefined;
    await this.saveMemory();
    this.logger.warn(
      `Peblar: ${mode === 'token' ? 'API token' : 'password'} refused; next try in ${Math.round(wait / 60000)} min`,
    );
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  get paused() {
    return this.now() < this.pausedUntil;
  }

  /**
   * The next read: after a pause or a block (never sooner than the interval),
   * after its backoff, else the interval.
   */
  schedule(delay) {
    const c = this.charger;
    this.clearTimer();
    let wait;
    if (this.paused) {
      wait = Math.max(this.pausedUntil - this.now(), this.interval);
    } else if (this.blocked) {
      wait = Math.max(this.memory.block.until - this.now(), this.interval);
    } else {
      wait = delay ?? (c.online === false ? c.wait : this.interval);
    }
    const generation = this.generation;
    c.timer = this.timers.setTimeout(
      () => {
        c.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('Peblar refresh failed'));
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const c = this.charger;
    if (!c.running) {
      c.running = this.run().finally(() => {
        c.running = undefined;
      });
    }
    return c.running;
  }

  async run() {
    const generation = this.generation;
    const c = this.charger;
    if (this.paused || this.blocked) {
      await this.updateStatus();
      this.schedule();
      return;
    }
    let delay;
    try {
      const token = await this.credential();
      if (generation !== this.generation) {
        return;
      }
      if (this.paused) {
        // A 429 during the login: nothing more in this cycle.
        throw Object.assign(new Error('Paused'), { kind: PAUSED });
      }
      const startedAt = this.now();
      const read = await this.readRest(token);
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= c.lastSentAt) {
        // Begun before a command left: it may show the state before it.
        this.logger.debug('Peblar: read begun before a command, not applied');
      } else {
        this.applyRead(read);
        if (this.memory.block) {
          this.memory.block = null;
          await this.saveMemory();
        }
        await this.readSlow(token);
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      delay = await this.failed(err);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** System (identity), EV interface and meter, one after the other. */
  async readRest(token) {
    const address = this.config.address;
    const get = (path) =>
      this.client.rest(address, token, path, { timeoutMs: TIMINGS.readTimeout });
    const system = parseSystem(await get(PATHS.rest.system));
    const ev = parseEvInterface(await get(PATHS.rest.evInterface));
    const meter = parseMeter(await get(PATHS.rest.meter));
    return { system, ev, meter };
  }

  /** Health (access mode of the token) every hour, the web API every 24 h; never blocking. */
  async readSlow(token) {
    const c = this.charger;
    if (this.now() - c.healthAt >= TIMINGS.slowRefresh) {
      c.healthAt = this.now();
      try {
        const health = parseHealth(
          await this.client.rest(this.config.address, token, PATHS.rest.health, {
            timeoutMs: TIMINGS.readTimeout,
          }),
        );
        c.accessMode = health.accessMode;
      } catch (err) {
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
        }
        this.logger.warn(`Peblar health: ${errorReason(err)}`);
      }
    }
    if (this.paused) {
      // A 429 just now: nothing more in this cycle.
      return;
    }
    if (this.config.auth.mode === 'password' && this.now() - c.webAt >= TIMINGS.webRefresh) {
      if (!this.cookie && this.loginAllowed) {
        this.lastLoginAt = this.now();
        try {
          this.cookie = await this.client.login(this.config.address, this.config.auth.password, {
            timeoutMs: TIMINGS.readTimeout,
          });
        } catch (err) {
          c.webAt = this.now();
          if (err.kind === ERROR_KINDS.AUTH) {
            await this.authFailed('password');
          }
          this.logger.warn(`Peblar login: ${errorReason(err)}`);
          return;
        }
      }
      await this.readWeb();
    }
  }

  /** A read answered: the charger as read, and the guard it may lift. */
  applyRead({ system, ev, meter }) {
    const c = this.charger;
    c.online = true;
    c.failures = 0;
    c.wait = undefined;
    if (!system.serial) {
      c.error = 'no_id';
      return;
    }
    c.error = undefined;
    if (c.serial && c.serial !== system.serial) {
      // Another charger answers at this address: the old device is no longer read.
      this.logger.warn('Peblar: another charger answers at this address');
      Object.assign(c, {
        hardwareMax: undefined,
        installMax: undefined,
        model: undefined,
        lastAmps: undefined,
        healthAt: -Infinity,
        webAt: -Infinity,
      });
    }
    c.serial = system.serial;
    c.firmware = system.firmware ?? c.firmware;
    c.phases = system.phases ?? c.phases;
    c.system = system;
    this.applyEv(ev);
    c.meter = meter;
  }

  /** fromCommand: the fresh read of a command (never reaffirms a stop: it would race it). */
  applyEv(ev, { fromCommand = false } = {}) {
    const c = this.charger;
    c.ev = ev;
    if (ev.limit !== undefined && ev.limit >= CURRENT.min * 1000) {
      c.lastAmps = Math.floor(ev.limit / 1000);
    }
    if (c.serial) {
      this.observe(c.serial, ev.limit, { fromCommand });
    }
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const c = this.charger;
    const reason = errorReason(err);
    if (err.kind === PAUSED) {
      return undefined;
    }
    if (
      err.kind === ERROR_KINDS.AUTH &&
      this.config.auth.mode === 'password' &&
      !err.login &&
      this.loginAllowed
    ) {
      // The token got with the password expired (the charger restarted): one
      // new login, now (at most one every 10 minutes).
      this.token = undefined;
      this.cookie = undefined;
      this.logger.info('Peblar: API token refused, logging in again');
      return 0;
    }
    if (err.kind === LOGIN_WAIT) {
      // Not read: offline states and badge.
      c.online = false;
      c.error = LOGIN_WAIT;
      return Math.max(this.interval, TIMINGS.loginMinInterval - (this.now() - this.lastLoginAt));
    }
    if (err.kind === ERROR_KINDS.AUTH) {
      // Not read until new credentials or the end of the block: offline.
      c.online = false;
      if (this.config.auth.mode === 'token') {
        await this.authFailed('token');
        return undefined;
      }
      // The password refused, or a token refused right after a login.
      await this.authFailed('password');
      return undefined;
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      // The charger answers: it stays online, the status shows the 429 pause.
      await this.pause(err);
      this.logger.warn(`Peblar: ${reason}, pause`);
      return undefined;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(c.failures, TIMINGS.backoff.length - 1)],
    );
    c.failures += 1;
    c.online = false;
    c.wait = wait;
    c.error = reason;
    if (err.kind === ERROR_KINDS.HTTP && err.status >= 500) {
      // A 5xx: a pause of the same length, kept in /data.
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.memory.pause = { until: this.pausedUntil, reason: '5xx' };
      await this.saveMemory();
    }
    this.logger.warn(`Peblar: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** A 429: every path waits but a stop (polling, button, commands), kept in /data. */
  async pause(err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.memory.pause = { until: this.pausedUntil, reason: '429' };
    await this.saveMemory();
  }

  pauseMessage() {
    if (!this.paused) {
      return undefined;
    }
    const wait = age(this.pausedUntil - this.now());
    return this.memory.pause?.reason === '5xx' ? T.serverError(wait) : T.rateLimited(wait);
  }

  /** The highest current the commands accept now. */
  get ceiling() {
    const c = this.charger;
    return Math.min(this.config.maxCurrent, c.installMax ?? Infinity, c.hardwareMax ?? Infinity);
  }

  summary() {
    const c = this.charger;
    return summaryOf(
      {
        name: `${c.vendor ?? 'Peblar'} ${c.serial.replace(/-/g, '').slice(-4).toUpperCase()}`,
        state: c.ev?.state,
        power: c.meter?.power === undefined ? undefined : Math.round(c.meter.power),
        limit: c.ev?.limit === undefined ? undefined : Math.round(c.ev.limit / 100) / 10,
      },
      c.ev ? statusText(c.ev) : undefined,
    );
  }

  /** `[connected, message, plain]`; `plain`: the summary without "Connected". */
  status() {
    const c = this.charger;
    if (!this.config.address) {
      return [false, this.config.invalidHost ? T.invalidHost(this.config.invalidHost) : T.noHost];
    }
    if (!this.config.auth) {
      return [false, this.config.badSecret ? T.badSecret : T.noAuth];
    }
    const pause = this.pauseMessage();
    if (pause) {
      return [false, pause];
    }
    if (this.blocked) {
      const wait = age(this.memory.block.until - this.now());
      const refused =
        this.memory.block.mode === 'token' ? T.tokenRefused(wait) : T.passwordRefused(wait);
      // The REST API turned off is the likely cause of a refused token: said first.
      return [false, c.restEnabled === false ? join(T.restDisabled, refused) : refused];
    }
    if (c.error === LOGIN_WAIT) {
      return [false, T.loginWait(age(TIMINGS.loginMinInterval - (this.now() - this.lastLoginAt)))];
    }
    if (c.online === false) {
      const wait = age(c.wait ?? this.interval);
      return [
        false,
        c.error === ERROR_KINDS.UNREACHABLE || c.error === ERROR_KINDS.TIMEOUT
          ? T.unreachable(addressKey(this.config.address), wait)
          : T.failing(c.error ?? 'error', wait),
      ];
    }
    if (c.online === undefined) {
      return [false, T.connecting];
    }
    if (c.error === 'no_id' || !c.serial) {
      return [false, T.noId];
    }
    let summary = this.summary();
    if (c.restEnabled === false) {
      summary = join(summary, T.restDisabled);
    }
    if (c.accessMode === 'ReadOnly' && this.config.allowCommands) {
      summary = join(summary, T.readOnlyToken);
    }
    return [true, T.connected(summary), summary];
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    const [connected, message, plain] = this.status();
    const orphans = this.orphans();
    if (orphans.length === 0) {
      await this.setStatus(connected, message);
      return;
    }
    const names = orphans
      .map((serial) => {
        const device = (this.gladys.devices ?? []).find(
          (d) => d.external_id === chargerIds(this.gladys, serial).device,
        );
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${serial})`
          : serial;
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.otherCharger(names)));
  }

  // --- Gladys ----------------------------------------------------------------

  /** The charger read with a valid serial, else undefined. */
  known() {
    const c = this.charger;
    return c.serial && c.ev ? c : undefined;
  }

  /**
   * The serials of the devices created in Gladys that the charger read is not
   * (another charger at this address, an address changed, or no answer since
   * the start). Empty while a first read is still under way.
   */
  orphans() {
    const c = this.charger;
    if (c.online === undefined && !this.blocked && this.config.address && this.config.auth) {
      return [];
    }
    const serials = [];
    for (const device of this.gladys.devices ?? []) {
      const serial = parseDeviceId(device?.external_id);
      if (
        serial &&
        serial !== c.serial &&
        chargerIds(this.gladys, serial).device === device.external_id
      ) {
        serials.push(serial);
      }
    }
    return serials;
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const c = this.known();
    if (!c) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, c, { ceiling: this.ceiling, language: this.config.language }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    const push = (serial, charger, online) => {
      const states = deviceStates(chargerIds(this.gladys, serial), charger, {
        online,
        language: this.config.language,
        ceiling: this.ceiling,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    };
    const c = this.known();
    if (c) {
      push(c.serial, c, c.online !== false);
    }
    // A created device the charger read is not: unreachable, never left "charging".
    for (const serial of this.orphans()) {
      push(serial, {}, false);
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    const c = this.known();
    if (c && created.has(chargerIds(this.gladys, c.serial).device)) {
      entries.push({
        external_id: chargerIds(this.gladys, c.serial).device,
        transport: c.online === false ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.LOCAL,
      });
    }
    for (const serial of this.orphans()) {
      entries.push({
        external_id: chargerIds(this.gladys, serial).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  async testConnection() {
    if (!this.config.address || !this.config.auth || this.paused || this.blocked) {
      return this.status()[1];
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    this.lastTestAt = this.now();
    // A read now (a read in progress is joined).
    await this.tick();
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, strictly: null, '', ' ', true or 1.5 are never
   * read as a number. Throws a refusal when it is not valid.
   */
  commandValue(role, value) {
    if (role === FEATURES.START || role === FEATURES.STOP) {
      if (value === PRESSED || value === String(PRESSED)) {
        return PRESSED;
      }
      throw this.refusal(ERRORS.badButton);
    }
    const amps =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)
          ? Number(value.trim())
          : NaN;
    if (!Number.isInteger(amps)) {
      throw this.refusal(ERRORS.badCurrent);
    }
    if (amps < CURRENT.min || amps > CURRENT.max) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, CURRENT.max));
    }
    return amps;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.commandValue(target.role, value);
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (target.serial !== this.charger.serial) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    const { role } = target;
    const previous = this.inFlight;
    if (previous && role === FEATURES.STOP && previous.role === FEATURES.STOP) {
      // A stop already under way: this one shares its outcome.
      return previous.promise;
    }
    // One command at a time: a busy charger refuses at once, but a stop is
    // never held back: it goes now, and once more when the other one settles.
    if (previous && role !== FEATURES.STOP) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = {
      role,
      sentAt: undefined,
      overtaken: previous?.promise,
      again: undefined,
      promise: undefined,
    };
    this.inFlight = entry;
    entry.promise = this.command(target, wanted, received, entry);
    const release = () => {
      if (this.inFlight === entry) {
        this.inFlight = undefined;
      }
    };
    try {
      return await entry.promise;
    } finally {
      // A stop to send again keeps the charger busy until it is done (the
      // ack does not wait for it): a newer start is refused meanwhile.
      if (entry.again) {
        entry.again.finally(release);
      } else {
        release();
      }
    }
  }

  /** The checks before sending, on the latest configuration. */
  checkBeforeSend(generation, serial, role) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (generation !== this.generation || this.charger.serial !== serial) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    if (role !== FEATURES.STOP) {
      if (this.paused) {
        throw this.refusal(ERRORS.paused(age(this.pausedUntil - this.now())));
      }
      const since = this.now() - this.charger.lastCurrentAt;
      if (since < TIMINGS.currentMinInterval) {
        throw this.refusal(ERRORS.tooOften(age(TIMINGS.currentMinInterval - since)));
      }
    }
    if (!this.currentToken()) {
      throw this.refusal(ERRORS.noCredentials);
    }
    if (this.charger.accessMode === 'ReadOnly') {
      throw this.refusal(ERRORS.readOnlyToken);
    }
  }

  /** A stop arrived after `entry` started: anything but a stop gives way. */
  stopArrived(entry) {
    return entry.role !== FEATURES.STOP && this.inFlight !== entry;
  }

  /** What to send (`limit` in mA), from the EV interface just read; undefined when already so. */
  plan(role, wanted, ev, serial, entry) {
    const guarded = this.guardActive(serial);
    if (role === FEATURES.STOP) {
      // A command still in flight is pending too: never "already stopped" over it.
      if (ev?.limit === 0 && !guarded && !entry.overtaken && !this.unconfirmed) {
        return undefined;
      }
      return { limit: 0, from: ev?.limit };
    }
    if (ev.limit === undefined) {
      throw this.refusal(ERRORS.missing);
    }
    const ceiling = this.ceiling;
    if (role === FEATURES.START) {
      if (ev.state === STATE.NO_EV) {
        throw this.refusal(ERRORS.noVehicle);
      }
      if (![STATE.SUSPENDED, STATE.CHARGING, STATE.VENTILATION].includes(ev.state)) {
        throw this.refusal(ERRORS.fault(STATE_NAMES[ev.state] ?? STATE_NAMES[STATE.UNKNOWN]));
      }
      if (ev.limit >= STOPPED_BELOW && !guarded) {
        return undefined;
      }
      const amps = Math.max(
        CURRENT.min,
        Math.min(this.charger.lastAmps ?? CURRENT.startDefault, ceiling),
      );
      return { limit: amps * 1000, from: ev.limit };
    }
    if (wanted > ceiling) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, ceiling));
    }
    const guard = this.guards.get(`${serial}:limit`);
    if (ev.limit < STOPPED_BELOW && !(guarded && guard.expected >= STOPPED_BELOW)) {
      // A current while stopped would start the charge again: Start does that.
      throw this.refusal(ERRORS.stopped);
    }
    if (ev.limit === wanted * 1000 && !guarded) {
      return undefined;
    }
    return { limit: wanted * 1000, from: ev.limit };
  }

  async command({ serial, role }, wanted, received, entry) {
    const generation = this.generation;
    const isStop = role === FEATURES.STOP;
    const sendBy = received + TIMINGS.commandSendBy;
    const c = this.charger;
    this.checkBeforeSend(generation, serial, role);
    const address = this.config.address;

    // The state just before acting, never the one in memory. For a stop, a
    // failed read never holds it back: it is sent anyway.
    let fresh;
    const readBudget = Math.min(
      TIMINGS.commandReadMax,
      sendBy - TIMINGS.commandMinSend - this.now(),
    );
    // During a pause, a stop is one request: no fresh read.
    if (readBudget >= TIMINGS.commandMinRead && !(isStop && this.paused)) {
      const readStart = this.now();
      try {
        fresh = parseEvInterface(
          await this.client.rest(address, this.currentToken(), PATHS.rest.evInterface, {
            timeoutMs: readBudget,
          }),
        );
      } catch (err) {
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
          this.updateStatus().catch(() => {});
        }
        if (!isStop) {
          throw this.refusal(ERRORS.unknownState(errorReason(err)));
        }
        this.logger.warn(`Peblar: stop sent without a fresh read (${errorReason(err)})`);
      }
      if (generation !== this.generation) {
        throw this.refusal(ERRORS.unknownCharger);
      }
      // Applied only when no command left during the read.
      if (fresh && readStart > c.lastSentAt) {
        this.applyEv(fresh, { fromCommand: true });
        // Shown in the background: the ack never waits for Gladys.
        this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
      }
    } else if (!isStop) {
      throw this.refusal(ERRORS.tooSlow);
    }

    const plan = this.plan(role, wanted, fresh, serial, entry);
    if (!plan) {
      return;
    }
    // The option may have been turned off during the read: checked again.
    this.checkBeforeSend(generation, serial, role);
    if (this.stopArrived(entry)) {
      throw this.refusal(ERRORS.stopMeanwhile);
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const timeoutMs = Math.max(200, received + TIMINGS.commandAnswerBy - this.now());
    const previousCurrentAt = c.lastCurrentAt;
    c.lastSentAt = this.now();
    c.lastCommandAt = this.now();
    entry.sentAt = this.now();
    if (!isStop) {
      c.lastCurrentAt = this.now();
    }
    this.logger.info(`Peblar: ${role} (limit ${plan.limit} mA)`);
    try {
      await this.client.setLimit(address, this.currentToken(), plan.limit, {
        startBy: sendBy,
        timeoutMs,
      });
    } catch (err) {
      const reason = errorReason(err);
      this.logger.warn(`Peblar: ${role} failed (${reason})`);
      if (err.kind === ERROR_KINDS.LATE || err.kind === ERROR_KINDS.UNREACHABLE || err.notSent) {
        // Nothing left: the minute between two currents is not spent.
        c.lastCurrentAt = previousCurrentAt;
        throw this.refusal(err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
        throw this.refusal(ERRORS.refused(reason));
      }
      if (err.kind === ERROR_KINDS.AUTH) {
        if (this.config.auth.mode === 'password' && err.status === 401) {
          // The token expired: the next read logs in again. A 403 (a write
          // refused) keeps it: a stop must stay possible.
          this.token = undefined;
        }
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      if (err.kind === ERROR_KINDS.HTTP && err.status < 500) {
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      // A 5xx, a silence, a broken answer or any other error after the
      // transport started: it may have reached the charger.
      if (!isStop) {
        // It may still land later, even after a stop: a stop sent within
        // the next 90 s is reaffirmed if a read shows a current again.
        c.unconfirmedUntil = this.now() + TIMINGS.guard;
      }
      this.guard(serial, plan, isStop && this.unconfirmed ? entry.sentAt : undefined);
      this.followUp();
      this.stopAgain(serial, entry, plan);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.guard(serial, plan, isStop && this.unconfirmed ? entry.sentAt : undefined);
    this.followUp();
    this.stopAgain(serial, entry, plan);
  }

  /**
   * A stop that overtook a command still in flight (a start or a current may
   * land after it): sent once more when that command settles. No state read:
   * it repeats a stop already decided.
   */
  stopAgain(serial, entry, plan) {
    if (!entry.overtaken || plan.limit !== 0) {
      return;
    }
    // Kept in entry.again: the stop holds the charger (inFlight) until it ends.
    entry.again = entry.overtaken
      .catch(() => {})
      .then(async () => {
        // Only the charger and the token are checked: the stop was accepted,
        // turning the option off since never cancels it.
        if (this.charger.lastCommandAt > entry.sentAt) {
          // A newer command really left since this stop: its intent wins.
          this.logger.info('Peblar: stop not sent again (newer command sent)');
          return;
        }
        const token = this.currentToken();
        if (!token || this.charger.serial !== serial) {
          return;
        }
        this.logger.warn('Peblar: stop sent again after the command in flight');
        this.charger.lastSentAt = this.now();
        await this.client.setLimit(this.config.address, token, 0, {
          startBy: Infinity,
          timeoutMs: TIMINGS.readTimeout,
        });
        this.guard(serial, plan, this.unconfirmed ? entry.sentAt : undefined);
      })
      .catch(async (err) => {
        this.logger.warn(`Peblar: stop again failed (${errorReason(err)})`);
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
          await this.updateStatus();
        }
      })
      .catch(() => {});
  }

  /** Spaced reads after a command: its effect, then a check (each a new read). */
  followUp() {
    const generation = this.generation;
    const c = this.charger;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        c.followUps.delete(handle);
        if (generation === this.generation) {
          // A read under way began before the command: wait for it, then read again.
          Promise.resolve(c.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Peblar refresh failed'));
        }
      }, delay);
      c.followUps.add(handle);
    }
  }

  // --- Guard -----------------------------------------------------------------------

  /** A command not confirmed may still land on the charger. */
  get unconfirmed() {
    return this.now() < this.charger.unconfirmedUntil;
  }

  /**
   * After a command, until the charger shows it: a new command is always
   * sent, never answered "already so" on a state that may not show the
   * previous one yet. The start state is kept: a read equal to it lifts
   * nothing until a move was seen. `reassertFrom`: a stop sent while another
   * command was not confirmed (the time it left): its guard holds the whole
   * 90 s and reaffirms the stop (see observe).
   */
  guard(serial, plan, reassertFrom) {
    const key = `${serial}:limit`;
    const held = this.guards.get(key);
    // A stop sent again keeps the reaffirmation of the stop it repeats.
    const keep = held?.reassertFrom !== undefined && plan.limit === 0 && this.guardActive(serial);
    this.guards.set(key, {
      from: plan.from,
      expected: plan.limit,
      moved: false,
      until: keep ? held.until : this.now() + TIMINGS.guard,
      // A second stop click renews the reaffirmation from its own time.
      reassertFrom: keep ? (reassertFrom ?? held.reassertFrom) : reassertFrom,
      reasserts: keep ? held.reasserts : 0,
    });
  }

  guardActive(serial) {
    const key = `${serial}:limit`;
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read of the limit, through the guard: never lifted on an unknown value. */
  observe(serial, limit, { fromCommand = false } = {}) {
    if (!this.guardActive(serial) || limit === undefined) {
      return;
    }
    const key = `${serial}:limit`;
    const guard = this.guards.get(key);
    if (limit !== guard.from) {
      guard.moved = true;
    }
    if (guard.reassertFrom !== undefined) {
      // A stop to reaffirm: the guard holds its 90 s. A current read again
      // while no command left since the stop is a late command landing
      // after it: the stop is sent again, twice at most.
      if (
        limit > 0 &&
        !fromCommand &&
        !(this.inFlight && this.inFlight.role !== FEATURES.STOP) &&
        this.charger.lastCurrentAt <= guard.reassertFrom &&
        guard.reasserts < TIMINGS.stopReasserts
      ) {
        guard.reasserts += 1;
        this.reassertStop(serial);
      }
      return;
    }
    if (guard.moved && limit === guard.expected) {
      this.guards.delete(key);
    }
  }

  /** Sends the stop again (a late command landed after it). No read, no option check. */
  reassertStop(serial) {
    const token = this.currentToken();
    if (!token || this.charger.serial !== serial) {
      return;
    }
    this.logger.warn('Peblar: a current came back after a stop, stop sent again');
    this.charger.lastSentAt = this.now();
    this.client
      .setLimit(this.config.address, token, 0, {
        startBy: Infinity,
        timeoutMs: TIMINGS.readTimeout,
      })
      .then(() => this.followUp())
      .catch(async (err) => {
        this.logger.warn(`Peblar: stop reaffirmed failed (${errorReason(err)})`);
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
        }
      })
      .catch(() => {});
  }
}
