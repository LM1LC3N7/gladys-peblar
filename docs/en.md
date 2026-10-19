# Peblar for Gladys

Shows your **Peblar** EV charger (Rocksolid, Business) in Gladys through its
**local REST API**: no cloud, no account, straight on your network.

> **Never tested with a real charger.** Not affiliated with Peblar. The
> integration talks to the charger like the peblar library (used by Home
> Assistant). Peblar may change its API with a firmware update.

## What you get

One device per charger with:

| Feature                       | Content                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| Status                        | No vehicle, plugged in waiting, charge stopped, charging, error, fault  |
| Connector                     | Available, occupied, faulted or unavailable (Gladys "charging station") |
| Charging state                | Charging, vehicle connected, paused by the charger, idle                |
| Vehicle plugged in            | Yes / no                                                                |
| Power, and power L1 / L2 / L3 | In W                                                                    |
| Current L1 / L2 / L3          | In A                                                                    |
| Voltage L1 / L2 / L3          | In V (a phase the charger does not measure stays empty)                 |
| Energy of the session         | In kWh, a plain sensor                                                  |
| Total energy                  | In kWh, a plain sensor                                                  |
| Charge current limit          | In A: the limit asked through the local REST API (0 = charge stopped)   |
| Current limit applied         | In A: what the charger really allows (cable, load balancing, solar...)  |
| Limited by                    | What sets the applied limit (text of the charger)                       |
| Error / warning reported      | Yes / no                                                                |
| Forced single phase           | Yes / no (read only)                                                    |
| Start charging, Stop charging | Buttons (commands allowed only)                                         |
| Set the charging current      | List from 6 A to the ceiling (commands allowed only)                    |

Read every 30 seconds by default (10 s to 10 min, configurable).

**Energy**: the energy of the session and the total energy are **plain
sensors**, never an index: they do not enter the Energy tab of Gladys (the
charger is already counted by your main meter, it would be counted twice). No
daily consumption is published, and a total of 0 is never published.

## Installation

1. Give the charger a **fixed IP address** in your router.
2. In the **web interface of the charger** (its IP address in a browser):
   Settings, **Local REST API**: turn it on, with **read and write** access if
   you want the commands, and copy the **API token**.
3. Install the integration from the Gladys store. In its configuration, enter
   the **IP address of the charger** and the **API token**.
   - Instead of the token, you may give the **password of the web
     interface**: the integration then logs in to read the token (the local
     REST API must still be on), the installation limit and the rated current
     of the charger, at the start then once a day. It never changes a setting
     of the charger.
4. Save, then add the charger from the **Discovery** tab.

The token and the password are **kept by Gladys in its database, never shown
again**, and sent only to the charger (the token in the `Authorization`
header). They are never written in the logs, nor in `/data`, nor in a status.
The charger only speaks plain HTTP: the token and the password travel **in
clear, over HTTP** on your local network (as with the web interface of the
charger itself). Keep the charger on a network you trust.

The **Test the connection** button reads the charger once (at most every 10
seconds).

## Commands (off by default)

"Start charging", "Stop charging" and "Set the charging current" refuse every
command while **Allow the commands** is off. On:

- **Stop** sets the charge current limit to 0: the charger pauses the charge;
- **Start** sets it again to the last current seen (6 A when none is known),
  never above the ceiling; **refused when no vehicle is plugged in**, or on an
  error, a fault or an unknown state;
- **Charging current**: from 6 A to the **ceiling**: the "Ceiling of the
  charging current" of the configuration (16 A by default, 32 A at most), and
  with the password also the installation limit and the rated current read
  from the charger (the lowest wins). With the **token only**, the charger
  gives no limit to the integration: the ceiling is the configured one alone
  (16 A by default), and the charger still caps the current itself at its
  installation and cable limits (shown as "Current limit applied"). Refused
  while the charge is stopped (a limit under 6 A: it would start it again:
  use Start). **One change a minute at
  most** (start included): no fine regulation from Gladys.

They are **buttons** and a **list**, never switches: a "turn everything off"
(from Gladys, Google Home, Alexa or HomeKit) never reaches them. A scene can
trigger them, only through an explicit action, and only when the commands are
allowed. Note that the AI chat of Gladys (MCP) can create and run such a
scene: while the commands are allowed, it can start or stop the charge.

Before each command, the integration **reads the charger again** and decides
on that read only; the option is checked again right before sending. A
command with nothing to do (already so) is not sent. A command that cannot
leave within 3.5 seconds is refused unsent. When the charger does not confirm
(silence, a 5xx error), Gladys shows "Command sent, without confirmation":
check the state, read again 5 then 20 seconds later. One command at a time:
another one is refused at once, **except "Stop charging", never held back**:
it goes at once, even while another command is in flight (it is then sent
once more when that command ends, and any start or current not sent yet gives
way to it), even within the minute between two currents, even during a 429
pause (then a single request, without the read), and even when the read
just before fails. When a command stayed without confirmation, it may still
reach the charger later: a stop sent within the next 90 seconds is watched,
and sent again (twice at most) if a read shows a current again while no other
command left.

A token in **read only** mode (access mode of the local REST API) refuses
every command; the status says so.

## Errors and limits

- **Charger unreachable**: only the connector ("unavailable") and the status
  ("Charger unreachable") change; the other values keep their last one. New
  try after 30 s, 1, 2, then 5 minutes, never faster than the interval.
- **Token refused**: the status asks to check it (a new token generated in
  the web interface replaces the old one). **Password refused**: same. New
  tries after 15 minutes, 1 hour, then every 6 hours, never sooner (kept in
  `/data` across a restart, so a wrong password never locks the account in a
  loop); saving new credentials tries again at once. With the password, a
  token that expires (after a restart of the charger) gives one new login, at
  most one every 10 minutes.
- **429 (too many requests)** or **5xx**: a pause (1 minute to 6 hours for a 429) for the reads and the commands but "Stop charging", never shorter than
  the refresh interval, kept in `/data` across a restart.
- Neither the smart charging modes (solar, schedule), nor the phases, nor the
  socket lock, nor the RFID cards can be changed from Gladys.
- The logs never hold the text of the charger's answers, the token or the
  password.

## Credits

Port of [peblar](https://github.com/frenck/python-peblar) (Franck Nijhof,
MIT, version 2.1.0), the library of Home Assistant's Peblar integration.
Apache-2.0 license.
