# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Peblar chargers read over their local REST API (no cloud), with the API
  token or the password of the web interface: one device, keyed by its serial
  number.
- State, connector and charging state (charging-station category), vehicle
  plugged in, power (total and per phase), current and voltage per phase,
  energy of the session and total energy (plain sensors, never an energy
  index), charge current limit asked and applied, what limits it, error,
  warning and forced single phase (read only).
- Start and stop buttons and a charging current list (6 A to a ceiling of 16
  A by default, lowered by the installation limit and the rated current read
  from the charger with the password), refused unless "Allow the commands" is on (off by default). Start
  refused without a vehicle plugged in; one current change a minute; "Stop
  charging" never held back (not by a command in flight, the minute, a 429
  pause or a failed read).
- Reads every 30 s (configurable); failures retried after 30 s to 5 minutes;
  429 and 5xx pause, kept in `/data`; a refused token or password is tried
  again after 15 min, 1 h, then every 6 h, kept in `/data` (no secret in it).
- A stop sent within 90 s of a command left without confirmation is sent
  again (twice at most) if a read shows a current again; the ceiling uses the
  installation limit, never the user-defined limit; an interval change no
  longer logs in again; the token and the password travel in clear over HTTP
  on the local network (said in the docs).
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-peblar/commits/main
