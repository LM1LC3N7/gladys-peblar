# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "stop"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   SDK handlers -> PeblarApp (shared with the tests)
src/app.js                        credentials, polling, device, states, status, commands
src/devices.js                    device and states of the charger (pure); feature roles are frozen
src/peblar/client.js              REST and web API calls, answer parsing (pure parsers)
src/peblar/http.js                one bounded HTTP exchange (node:http), error kinds
src/store.js                      /data/peblar-state.json: pauses and credential block, no secret
src/publisher.js                  states to Gladys within 300 per minute
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (here the serial number), never a label. Gladys
  keys devices, their history, scenes and dashboards on them: changing one
  creates a new device and orphans the old one. The same goes for every key
  users store: manifest `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log, store or show the API token, the password or
  the session cookie; never keep the body of an HTTP error (it may echo one).
  A `secret` field is "kept by Gladys in its database, never shown again",
  never "encrypted".
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
- **Peblar.** Commands stay behind `allow_commands` (off by default), are
  buttons and a select (never a switch), are decided on a fresh read of the
  EV interface, are checked again right before sending, and all write
  `ChargeCurrentLimit` (0 = stop). "Stop charging" is never held back (a
  command in flight, the minute between currents, a pause, a failed read).
  A stop sent within 90 s of an unconfirmed command is reaffirmed. The
  ceiling never reads `UserDefinedChargeLimitCurrent` (it mirrors the writes).
  Start refused without a vehicle; the current capped by the ceiling; one
  current change a minute. A read begun before a command left is never
  applied. Refused credentials block the tries (15 min, 1 h, 6 h, in
  `/data`); a login at most every 10 minutes; never a setting written on the
  charger. The energies stay plain sensors, never an `index`/`energy`
  feature.
