# Raspberry Pi: Senssun Weight To Garmin

Standalone, personal-use service for Raspberry Pi 5. The browser prototype in the
parent folder is unchanged. No SmartScaleSync account, private endpoints, or code
are used. Your Pi talks directly to your scale and Garmin using Bleak and the
unofficial `garminconnect` library.

**Hardware status: unverified.** The existing protocol is reverse-engineered from
the APK, not confirmed with this physical scale. This service only accepts legacy
`10 00 00 C5` / `0x80` notifications marked stable (`AA` or `BA`). It ignores
history, settling readings, body composition, and unsupported/encrypted packets.
Some scales need a handshake or use advertisements instead; those will need a
real capture and further work. Installing this does not guarantee compatibility.

## Requirements

- Raspberry Pi 5 near the scale, with Bluetooth enabled, reliable power, and Internet.
- Current **Raspberry Pi OS Lite 64-bit (Trixie)**, Python **3.12+** (Trixie supplies
  3.13), BlueZ 5.55+. The older Bookworm default Python 3.11 is too old for the pinned
  Garmin library. Do not replace the OS's Python manually; use current 64-bit OS.
- Your Garmin Connect account, including access to any required MFA code.
- A Linux user with access to BlueZ through the system D-Bus. Do not run the app as root.
- Correct clock and timezone. Timestamps are recorded in UTC and Garmin receives
  explicit timestamps. This is weight in Garmin Connect, not a direct watch connection.

There is no Python installation needed on your Windows PC. The commands below run
on the Pi, for example through SSH. Replace example hostnames and addresses.

## 1. Install On The Pi

Run these yourself on the Pi:

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip bluez bluetooth
sudo systemctl enable --now bluetooth
sudo rfkill unblock bluetooth
sudo timedatectl set-ntp true
timedatectl
uname -m
python3 --version
```

`uname -m` must say `aarch64`. Set your actual timezone if needed, for example
`sudo timedatectl set-timezone Europe/Oslo`.

```bash
git clone https://github.com/Vegardtha/senssun-scale-prototype.git ~/senssun-scale-prototype
cd ~/senssun-scale-prototype/raspberry-pi
bash setup.sh
```

If already cloned there, use `git pull --ff-only` instead of cloning again. Setup
creates `.venv`, installs pinned direct dependencies, runs offline tests, installs
a **user** systemd service, and creates a private config outside Git. It does not
start the service or contact Garmin. Dependencies may install their own dependencies.

## 2. Find Your Scale

Close Movinglife and the browser's scale connection. Wake the scale while scanning:

```bash
.venv/bin/python sync.py scan --seconds 20
```

Find its name/address, preferably advertising `0000fff0-0000-1000-8000-00805f9b34fb`.
Only configure your own device. The service always targets the exact configured
MAC, never whichever nearby scale happens to be found first.

```bash
nano ~/.config/senssun-sync/config.toml
```

Replace `AA:BB:CC:DD:EE:FF` with the real MAC. Leave `dry_run = true`. Adjust
`min_kg` and `max_kg` to a reasonable range for you; this rejects implausible
readings but **does not identify people**. Anyone using this scale within that
range could otherwise upload to your Garmin account.

## 3. Verify A Real Reading Without Garmin

```bash
.venv/bin/python sync.py --config ~/.config/senssun-sync/config.toml run
```

Step on the scale. Confirm a logged `Dry run: ... kg, stable=True` agrees with its
display. Repeat with at least two weigh-ins. Dry-run does not enqueue readings,
does not connect to Garmin, and never replays test readings when live mode is enabled.
Stop with Ctrl+C. If no stable weight is decoded, do not enable live mode.

The reader subscribes to FFF1 and reconnects after disconnects, scan failures, or
60 seconds without a packet. It sends no profile, clock, authentication, or other
scale commands (notification subscription changes the BLE descriptor as usual).
There is no body-composition calculation or inference from settling values.

## 4. Log Into Garmin Locally

```bash
.venv/bin/python sync.py --config ~/.config/senssun-sync/config.toml login
```

Enter email, password and MFA directly in the Pi terminal. Password and MFA use
hidden prompts. Never put these in Git, shell arguments, config, screenshots, or chat.
Tokens go to `~/.local/state/senssun-sync/tokens/`, with owner-only permissions.
The service does not save the password. Tokens themselves grant account access;
protect the Pi, backups, and SD card. They are permission-protected, not encrypted
at rest by this application. Login reads Garmin profile/settings but uploads no weight.

If Garmin rejects cached tokens, stop the service and move that tokens directory
to a private backup before re-running `login`; the library tries existing tokens
first. A failed or revoked session needs interactive login again, not repeated
password attempts in a background service.

## 5. Enable Automatic Uploads And Boot Startup

Only after confirming real scale readings, change `dry_run = false` in the config.
Every accepted stable reading now writes to the local queue, then uploads weight
in kilograms using `Garmin.add_weigh_in`. Garmin labels this API's entries as
manual weigh-ins; body composition is not uploaded.

```bash
systemctl --user enable --now senssun-sync.service
sudo loginctl enable-linger "$USER"
systemctl --user status senssun-sync.service
journalctl --user -u senssun-sync.service -f
```

Linger lets the user service start at boot and continue after SSH logout. Keep
the checkout at `~/senssun-scale-prototype`; edit the unit's paths if you move it.
Run setup and service commands as the **same user**, never with `sudo systemctl --user`.
The Pi must be on and in Bluetooth range while you weigh yourself; history is
deliberately not imported. Bluetooth and network startup failures are retried.

After the first live weigh-in, confirm the value and time in Garmin Connect.
No live hardware or Garmin account testing was possible during development.

## Queue, Retries, And Duplicates

```bash
.venv/bin/python sync.py --config ~/.config/senssun-sync/config.toml status
```

The private SQLite queue stores only weight, receive timestamp, and state.
Duplicate readings within 0.02 kg and `duplicate_seconds` (default 180 seconds)
are suppressed across reconnects and restarts. A later weigh-in at the same weight
is allowed. This is a single-scale, single-account tool, not multi-user tracking.

- `pending`: saved locally, not submitted yet. Login/network preparation failures
  retain it and back off from 30 seconds to 30 minutes. On recovery it uploads
  with its original timestamp, not the retry time.
- `sending`: request about to be/in flight. Marked before the external call.
- `sent`: call completed without an exception; not sent again.
- `uncertain`: send raised an exception or the process stopped during a send.
  **Not retried automatically**, because Garmin might already have accepted it.
  This includes offline failures that occur after session preparation. Other
  pending readings may still proceed. Check Garmin before resolving.
- `discarded`: intentionally not uploaded.

After checking Garmin, stop the service and resolve the affected ID:

```bash
systemctl --user stop senssun-sync.service
.venv/bin/python sync.py --config ~/.config/senssun-sync/config.toml resolve 12 --as sent
systemctl --user start senssun-sync.service
```

Use `--as pending` only after confirming it is absent from Garmin and you intend
to retry, or `--as discarded` to skip it. ID `12` is an example. The file lock
prevents simultaneous service/login/resolve processes. Exactly-once delivery
cannot be guaranteed across a network failure; this conservative handling avoids
blind retries. Changing `state_dir` or deleting its database loses deduplication
and queued readings. Do not reuse its state/tokens for another Garmin account.

## Operations And Troubleshooting

- Restart after config changes: `systemctl --user restart senssun-sync.service`.
- Pause uploads: stop the service. Set `dry_run = true` before running tests.
  Pending live entries remain and will resume if live mode is re-enabled.
- Update: stop service, `git pull --ff-only`, `bash setup.sh`, then start it again.
- Bluetooth permission denied: confirm BlueZ is active and inspect the Pi's
  D-Bus policy. If its policy allows the `bluetooth` group, use
  `sudo usermod -aG bluetooth "$USER"`, then reboot. Do not grant broad D-Bus access.
- No device: wake it during scan, move the Pi closer, and close the phone/browser
  connection. Check `bluetoothctl show` and `rfkill list` on the Pi.
- Device connects but no weights: FFF1 may differ, need a handshake, or carry the
  newer encrypted protocol. Return to dry-run and capture raw notifications with
  the existing browser tool/nRF Connect. Do not guess the packet scaling.
- Wrong weights: stop live mode immediately and compare captures against
  `../docs/PROTOCOL.md`. Unknown unit codes and overloads are ignored.
- Logs show no credentials or raw packets, but dry-run/status show your weight,
  and journald retains logs. Treat them as health data and avoid sharing them.
- The Garmin library is unofficial and can break when Garmin changes its service.
  No availability guarantee; check its upstream documentation and Garmin terms.

## Offline Tests And Dependencies

```bash
.venv/bin/python test_sync.py -v
```

Tests require only Python's standard library. They cover shared synthetic frames,
fragmentation/checksums, stable flags, kilogram/pound conversion, queue persistence,
duplicate suppression, upload ambiguity, dry-run, and mocked BLE/Garmin adapters.
They are not proof of physical-scale compatibility or Garmin acceptance.

Direct dependencies are pinned in `requirements.txt`; transitive dependencies
are resolved by pip. `garminconnect==0.3.17` login/upload signatures were checked
against its published wheel. The service reuses saved tokens and requests no
Garmin password in the background. Source references:

- https://github.com/cyberjunky/python-garminconnect
- https://bleak.readthedocs.io/
- https://pypi.org/project/garminconnect/0.3.17/
- https://pypi.org/project/bleak/3.0.2/