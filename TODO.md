# TODO — Peblar v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 9) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-19): one charger by IP address, API
      token or web interface password (login, token, user limit and rated
      current), one device per serial, state, connector, charging state,
      plugged, power, current and voltage per phase, session and total
      energy (plain sensors), charge limit asked and applied, limit source,
      error/warning/single-phase flags (read only), start/stop buttons and
      current select behind `allow_commands` (off), stop never held back,
      one current a minute, late reads quarantined, 429/5xx pauses and
      credential blocks persisted, test button, docs en/fr, cover. Tested
      against made-up answers only.
- [x] **Milestone 1 fixes — review** (2026-10-19): the stop sent again is
      cancelled only by a command that really left (B1), a stop sent within
      90 s of an unconfirmed command is reaffirmed (I1), the ceiling reads
      the installation limit, never the user-defined one (I2), an interval
      change only reschedules and new credentials or address log in at once
      (I3), and M1-M11 (see Decisions). Reviewer scenarios S1-S20 in
      `test/review.test.js`.
- [x] **0.1.2 fixes** (2026-10-21, found on the sibling modules nrgkick and
      openevse): the stop sent again that fails keeps its reaffirmation, a
      stop before the first read after a restart, follow-up reads not
      stacked, "server error" refusal during a 5xx pause, credentials in the
      address never shown (see Decisions). Tests "0.1.2" in
      `test/review.test.js`.
- [ ] **Milestone 2 — real charger**: run against a real Rocksolid (see "To
      check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: several chargers, the websocket of the web API
      (session events, instead of polling), smart charging mode, forced
      single phase, socket lock — each behind the option, never a switch.

## To check on a real charger

- That `PATCH /api/wlac/v1/evinterface {"ChargeCurrentLimit": 0}` pauses the
  charge (as Home Assistant's "Charge" switch does) and a value of 6000 or
  more resumes it; how long until `CpState` and the meter show it; whether
  the charger clamps a value above its limits (peblar's test sends 99999 and
  reads 16000) — the guard then ends after 90 s.
- Whether the limit set through the REST API survives a restart of the
  charger, and whether it has a timeout (a fallback after silence).
- The answer of a refused write with a read-only token (403? 401?), and of a
  wrong password at login (401 as peblar reads it?); whether repeated wrong
  passwords lock the web interface.
- The session cookie: its name, its lifetime, and whether the token read with
  it changes after a restart (peblar logs in again on a 401).
- `EnergyTotal` resets (firmware update?) and `EnergySession` after the
  vehicle left.
- `CpState` values seen in practice (`State Invalid`, `unknown state`).
- Whether two clients (Home Assistant and Gladys) on the same charger
  conflict on `ChargeCurrentLimit` (the last write wins).
- A late answer: a PATCH that timed out on our side but reaches the charger
  after a later stop (TCP ordering across two connections) — handled by the
  reaffirmed stop (I1), to confirm.
- Whether the limit written through the REST API is mirrored into
  `UserDefinedChargeLimitCurrent` (Home Assistant's number entity suggests
  so): the reason the ceiling never reads it (I2).
- Whether the web interface allows one session only: our login (at the start,
  then once a day) may log the user out of the web interface, or the other
  way round (M7).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-peblar:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Reference**: peblar 2.1.0 (MIT, Franck Nijhof, frenck/python-peblar, tag
  v2.1.0, commit e2cac48), the library of Home Assistant's Peblar
  integration — license checked in `LICENSE.md`: MIT, not GPL. Cloned read
  only in `_ref/peblar`. Ported to JavaScript (`src/peblar/client.js`,
  `src/peblar/http.js` on `node:http`), no Python, no runtime dependency but
  the SDK; full MIT notice in `THIRD_PARTY_NOTICES.md`, shipped in the image
  with `LICENSE` (the standard Apache-2.0 text, no name). peblar's three tries
  with exponential backoff are not kept (the app spaces its tries).
- **Credentials**: the API token (secret field) wins; else the password
  (secret field) logs in to the web API (`POST /api/v1/auth/login`,
  `PersistentSession: false`), keeps the session cookie (its `name=value`
  only, bounded) and reads the token, the user configuration and the system
  information (at the start, then every 24 h: M7). Both kept in memory only, never logged, never in `/data`,
  never in a status or an error; the HTTP error bodies are never kept (they
  may echo a secret). The manifest says "kept by Gladys in its database,
  never shown again", never "encrypted" (test). **Never a setting written**
  on the charger: peblar's `rest_api(enable=True)` is not ported (the user
  turns the REST API on); a disabled API read with the password is said in
  the status.
- **Refused credentials** (401/403): a block persisted in `/data` (`mode`
  and a count only, no secret, no hash), tries after 15 min, 1 h, then every
  6 h, never sooner (polling, button, commands), bounded at a restart; saving
  other credentials lifts it at once. With the password: a token refused
  more than 10 minutes after the last login gives one new login at once (the
  charger restarted, as peblar's re-login); a login at most every 10 minutes;
  a refusal right after a login, or a refused login, blocks. A reconnection
  to Gladys never clears a block, a pause, nor the token.
- **Reads**: system (identity, errors), EV interface, meter every interval,
  one after the other; health (access mode of the token) and, with the
  password, the web API every 24 h — a failure of these never blocks the
  main data. 429: pause bounded to 1 min – 6 h (Retry-After, 5 min without);
  5xx: a pause of the failure delay (30 s, 1, 2, 5 min, never under the
  interval); both persisted in `/data`, bounded to 6 h at a restart, applied
  to every path but the stop.
- **Identity**: one device per serial (`ProductSn`, lower case,
  `[0-9a-z-]`, 40 characters at most), never per IP. Another serial at the
  address: the old device becomes "not read any more" (unreachable, status
  names it), its commands are refused. No serial: not added.
- **One charger** per integration in v1 (peblar and Home Assistant take one
  host per entry); several in milestone 3.
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`): power
  (total and per phase), current and voltage per phase on `energy-sensor`
  (W/A/V, instantaneous; the charger gives mA, converted); session energy on
  `electrical-vehicle-charge/last-charge-energy-added` and total energy on
  `charge-energy-consumption-total` (kWh, from Wh) — **plain sensors, never an
  index** (lot 6 rules: the charger is behind the main meter, the energy tab
  would count it twice, so an index is not reliable here; no
  `publishEnergyConsumption`, no daily consumption). A total of 0 is never
  published. Charge limit asked and applied on `target-current` (A, read
  only), limit source as text, plugged on `electrical-vehicle-charge/plugged`,
  error / warning / forced single phase `unknown/binary`. A phase or a
  voltage the charger leaves out stays empty, never 0. Every role always
  built (single-phase chargers keep L2/L3), so a republished device never
  loses a feature.
- **States** (CP state, IEC 61851): A → AVAILABLE/IDLE; B → OCCUPIED,
  EV_CONNECTED (PAUSED_BY_CHARGER and "charge stopped" when the limit is 0);
  C, D → OCCUPIED/CHARGING; E, F → FAULTED/IDLE; invalid or unknown → "Unknown
  state", no connector. Offline: status "Charger unreachable", connector
  UNAVAILABLE, other values kept.
- **Commands** (`allow_commands`, off by default, only `true` allows): start
  and stop as two `button/push` (value 1 only), the charging current as a
  `text/select` of whole amperes from 6 A to the ceiling; never a switch nor
  a writable binary. All write `ChargeCurrentLimit` (mA): stop 0; start the
  last limit seen above 6 A (memory only), else 6 A, capped by the ceiling;
  current `amps × 1000`. Never the phases, the smart charging, the socket
  lock, the RFID authorization (a toggle), a reboot or an update.
- **Ceiling** ("courant plafonné au maximum relu", KEBA): the lowest of the
  configured ceiling (`max_current`, 16 A by default, 6–32 A), the
  installation limit (`CurrentCtrlFixedChargeCurrentLimit`) and the rated
  current (`HwMaxCurrent`) read with the password (each trusted as an
  integer of 6–80 A). **Never `UserDefinedChargeLimitCurrent`** (I2): the
  charger may mirror into it the limit written through the REST API, so the
  ceiling would ratchet down at each command (6 A after a start). With the token only, the charger
  gives no limit on the REST API: the configured ceiling alone (the charger
  still applies its own installation limit, shown as "limit applied").
- **Command rules** (lot 6, wave 2/3 lessons, KEBA review): value validated
  strictly; the option checked on arrival and right before sending, with the
  start (generation) and the serial; a fresh read of the EV interface (1.5 s
  at most) decides, never memory; a missing limit refuses; start refused
  without a vehicle (A), on E, F, invalid or unknown; current refused above
  the ceiling, and while the limit is 0 (it would restart the charge: Start
  does that); nothing sent when already so (unless a guard holds); sent
  within 3.5 s or refused unsent, answered by 4.3 s. Outcomes: 2xx →
  success; unreachable, late or not sent → "not sent" (the minute is not
  spent); 4xx → "refused by the charger" (401/403 drop the password's token);
  429 → pause; silence, 5xx, broken answer → **"sent, without
  confirmation"** + guard. Reads 5 s and 20 s after, each a new read (a read
  under way is waited for, then a new one). A read-only token (health)
  refuses every command. The ack never waits for Gladys.
- **"Stop charging" first** (KEBA I1): never refused for a command in flight
  (it goes at once; a second stop shares the first one's outcome); sent once
  more, without a read, when the overtaken command settles (unless a newer
  command left); a start or a current that has not left yet gives way
  (refused unsent); never limited to one a minute; sent during a 429 or 5xx
  pause (one request, no read); sent even when the fresh read fails or has
  no time.
- **One current change a minute** (KEBA I3, `TIMINGS.currentMinInterval`),
  start included, counted from the send; a change sooner is refused unsent
  ("Stop charging stays available"). No fine regulation (docs).
- **Review fixes** (2026-10-19):
  - B1: the stop sent again (after the command it overtook) is cancelled only
    when a command really left after it (`lastCommandAt` against the time
    the stop left), never by a command refused unsent;
  - I1: a command other than a stop left without confirmation opens a 90 s
    window; a stop sent in it keeps its guard the whole 90 s and, at each
    polling or follow-up read, if the limit read is above 0 and no start or
    current left since the stop, sends 0 again (twice at most, logged);
  - I3: only a new address or new credentials restart; an interval change
    reschedules (no new login); a restart resets the login spacing;
    `connected()` lifts a block on new credentials like `configUpdated`;
  - M1: a limit under 6 A is "stopped" (state, current refused, start sends);
  - M2: a stop during a pause is one request (no fresh read);
  - M3: the stop sent again checks only the serial and the token (turning
    the option off after an accepted stop never cancels it);
  - M4: a 403 on a write keeps the token (only a 401 drops it);
  - M5: a REST API turned off is said before the block message;
  - M6: a 429 during a cycle (login, health) stops it at once;
  - M7: the web API at the start, then every 24 h (health stays hourly);
  - M8: the unused `loginBlocked` removed;
  - M9, M10: docs: the token-only ceiling (16 A by default, the charger caps
    itself) and the token and password sent in clear over HTTP on the LAN;
  - M11: a failure (refused credentials, login wait, unreachable, 5xx)
    shows the charger offline; a 429 keeps it online with the 429 pause in
    the status (approval S21);
  - approval round 2: only a start or a current that really left after the
    stop (`lastCurrentAt`) ends its reaffirmation, never a second stop click,
    which renews it from its own time (S2b); the reaffirmation only comes
    from the polling and follow-up reads, never from the fresh read of a
    command nor while a start or a current is in flight (S2c).
- **0.1.2 fixes** (2026-10-21, models: gladys-nrgkick 152dca0 I1, M6, M8;
  gladys-openevse 0cad0dc B1, M4):
  - the reaffirmation of a stop is decided after its send, and also when the
    stop overtook a command that really left (`overtakenEntry.sentAt`); a
    stop sent again (`stopAgain`) that fails sets the guard with the
    reaffirmation and schedules the follow-up reads;
  - `/data` keeps `charger: { address, serial }` (the serial is the id of
    the device, not a secret); restored at a start for the same address
    (`readAt` -Infinity until a polling read). Before that read only the
    stop is accepted, as one request (no fresh read); start and current are
    refused ("not read yet"). No serial kept (0.1.1, /data lost): a stop to a
    device created in Gladys still goes to the address. The kept device is
    shown offline while it cannot be read (down, pause, block), never "not
    read any more";
  - a stop goes during a block with the configured API token (one request);
    with the password, the token read at the login is dropped by a block, so
    a stop is refused until a login (said in the docs);
  - follow-up reads: one series pending at a time (a new command replaces
    the pending one);
  - a command refused during a 5xx pause says "server error";
  - an address holding an `@` is ignored (`credentialsInHost`), the status
    gives a fixed text, never the typed one.
- **Late answers** (KEBA M1/M2, over HTTP): an answer always belongs to its
  request; but a poll read begun before a command left may show the state
  before it: it is quarantined (neither applied, nor published, nor used by
  the guard); the fresh read of a command is applied only when no command
  left during it. A timed-out command is "sent, without confirmation".
- **Guards**: after a command that may have been applied, one guard per
  charger keeps the start and wanted limits; while it holds (a move then the
  wanted limit, or 90 s), a command is always sent. A read equal to the start
  state never lifts it.
- **Hostile answers**: 64 KB at most; only own fields of a plain object, each
  with its exact type; serials and texts bounded, texts without control
  characters; error codes 32 at most, integers only; the config takes only
  its known keys and printable ASCII secrets of 256 characters at most;
  feature ids matched by a strict pattern and a fixed role list. Logs carry
  error kinds and HTTP statuses only.
- **Gladys**: reconnection (`connected`): republishes status, devices,
  states and badge (caches cleared, the core keeps them in memory); a changed
  address, credentials or interval restarts; the option, the ceiling and the
  language apply at once.
- **gladys_version >= 5.1.0** (as the sibling local modules); **category
  `energy`**, transport `local`.
- **Demo files of the template** (`src/devices/*`, `scenes.js`, `widgets.js`,
  `weather.js` and their tests) deleted with `git rm`.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved. No
  Docker on this PC: the image was not built locally. The store validator
  (`npx github:GladysAssistant/integration-store .`) cannot be run from this
  session: to run in the real terminal (`validate.ps1`).
