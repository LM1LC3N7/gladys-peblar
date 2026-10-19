# gladys-peblar

[Gladys Assistant](https://gladysassistant.com) external integration for
**Peblar** EV chargers (Rocksolid, Business) through their local REST API:
state, connector and charging state, vehicle plugged in, power, current and
voltage per phase, energy of the session and total energy (plain sensors),
charge current limit; start, stop and the charging current behind an
off-by-default option. **Never tested with a real charger. Not affiliated
with Peblar.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (PeblarApp)
                                  ├─ src/peblar/client.js  REST and web API, parsing (own fields, exact types)
                                  ├─ src/peblar/http.js    the only network access (node:http, bounded)
                                  ├─ src/devices.js        the device and its states (pure)
                                  ├─ src/publisher.js      states within 300/min
                                  └─ src/store.js          /data/peblar-state.json (pauses, block; no secret)
```

- **Credentials**: the API token of the local REST API (sent as is in the
  `Authorization` header, as peblar does), or the password of the web
  interface: login (`/api/v1/auth/login`, session cookie), then the token
  (`/api/v1/config/api-token`), the user configuration (installation limit)
  and the system information, at the start then every 24 h. Plain HTTP: the
  secrets travel in clear on the LAN. Never a setting changed on the charger. A refused
  token or password blocks the tries for 15 min, 1 h, then 6 h (kept in
  `/data`, no secret in it); a login at most every 10 minutes.
- **Reads**: `GET /api/wlac/v1/system`, `evinterface`, `meter` every 30 s
  (configurable, 10 s – 10 min), `health` every hour; failures retried after
  30 s, 1, 2, 5 min, never under the interval; 429 and 5xx pause, kept in
  `/data`.
- **Device**: `ext:<selector>:peblar:<serial>` (`ProductSn`, lower case),
  never the IP address. Readings on `energy-sensor` (W, A, V), energies on
  `electrical-vehicle-charge` (kWh, plain sensors: never an index, never
  `publishEnergyConsumption`), the connector and the charging state on the
  core's `charging-station` category.
- **Commands** (`allow_commands`, off by default): two `button/push`
  features (start, stop) and a `text/select` (6 A to the ceiling), never a
  switch nor a writable binary. All three write `ChargeCurrentLimit` (mA) of
  the EV interface: 0 stops, a current starts or changes. Each command reads
  the EV interface first and decides on that read only, checks the option
  again right before sending, leaves within 3.5 s of the click or is refused
  unsent, and is answered by 4.3 s; a silence or a 5xx is "sent, without
  confirmation", followed by reads 5 s and 20 s later. Start refused without
  a vehicle (CP state A); one current change a minute; the stop never held
  back. A poll read begun before a command left is quarantined.
- **Hostile answers**: 64 KB at most, only own fields read with their exact
  type (no prototype pollution; a missing value refuses a command), no
  answer text in the logs.

## Credits

The APIs, their fields and the login are ported from
[peblar](https://github.com/frenck/python-peblar) (Franck Nijhof, MIT,
2.1.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the
sibling integrations
[gladys-technove](https://github.com/LM1LC3N7/gladys-technove) (local HTTP
charger) and [gladys-keba](https://github.com/LM1LC3N7/gladys-keba) (charger
commands).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: the charger is a fake behind the injected
transport, Gladys is the SDK's fake; `test/client.test.js` runs the real
transport against a loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
