# Senssun BLE scale — local browser prototype

A local-only tool that connects to a Bluetooth LE body scale from Chrome/Edge, shows the GATT
services the browser can see, logs every raw read/notification as hex, decodes frames it can prove
from the Movinglife APK, and saves sessions in the browser for CSV/JSON export.

No cloud, no analytics, no external requests (enforced by a Content-Security-Policy).
It **does not write anything to the scale**.

## Quick start

Requirements: Node.js 20+ (no npm dependencies), Chrome or Edge, a Bluetooth LE adapter.

```powershell
git clone https://github.com/vegardtha/senssun-scale-prototype.git
cd senssun-scale-prototype
npm test     # decoder + model tests
npm start    # serves http://localhost:5173/ (bound to 127.0.0.1 only)
```

Open `http://localhost:5173/` in Chrome or Edge, then:

1. Close Movinglife on your phone (the scale may accept only one connection).
2. Step on the scale to wake it.
3. Click **Scan & connect**. Start with "Devices advertising FFF0". If the scale is not listed, use
   "All nearby devices".
4. After connecting, the page lists visible services. With the default option it reads Device
   Information strings and subscribes to FFF1.
5. Weigh yourself. Raw notifications appear in the log; decoded frames appear under
   **Latest decoded packet**. Anything not understood is logged as `UNKNOWN` with its bytes.
6. Export JSON/CSV, or **Export as test fixture**, and put the fixture file in
   `fixtures/captured/` (see "Turning a capture into a test").

Port: set `PORT` to change it (`$env:PORT=8080; npm start`).

## Browser requirements and limitations

- **Browsers:** Web Bluetooth is available in Chromium browsers (Chrome, Edge, Opera) on Windows,
  macOS, ChromeOS, Android and (behind a flag on some distributions) Linux. Not Firefox or Safari.
- **Secure context:** must be served over HTTPS or from `localhost`/`127.0.0.1`. Opening
  `index.html` as a file will not work.
- **User gesture:** the device picker can only be opened from a click.
- **Adapter:** the computer needs a BLE adapter. The page reports what the browser says about it.
- **Emulator:** the Android emulator cannot talk to a physical scale.
- **Hidden services:** a site can only see services listed in the scan filter or the
  "Extra services" field. Some UUIDs are blocked outright by Chrome's GATT blocklist
  (e.g. TI OAD `F000FFC0-…`, used by the APK's firmware updater).
- **Advertisements:** Senssun "broadcast" scales put weight in advertising data, which the normal
  Web Bluetooth picker does not expose.
- **Bonding:** if the scale requires pairing/encryption, the OS pairing dialog may appear.
- **Writes:** disabled in this phase. The only writes are the CCCD enable/disable done by the browser
  for notifications.

### If the browser cannot see the right service: capture with nRF Connect

1. Install **nRF Connect for Mobile** (Nordic Semiconductor) on a phone; close Movinglife.
2. Scan, wake the scale, and note the device name, MAC, and advertised service UUIDs
   (tap the device to see raw advertising data; copy it).
3. Connect. Write down every service and characteristic UUID and its properties.
4. On each characteristic with *Notify*/*Indicate*, tap the subscribe icon. Weigh yourself.
5. Open the app's log view and export/share it. Note the value shown on the scale display for
   each measurement.
6. Add any extra service UUIDs to the "Extra services" field here and reconnect, or send me the
   log so the bytes can become fixtures.

## Project layout

```
scale-prototype/
  server.mjs                  static dev server (loopback only, allowlisted dirs, CSP headers)
  web/                        UI only: index.html, app.js, styles.css
  src/transport/web-bluetooth.js   BLE transport (no decoding, no writes)
  src/protocol/               transport-independent decoder
    senssun-legacy.js         frame assembler + decoder for the legacy 10 00 00 C5 protocol
    index.js                  stream decoder: bytes in → decoded/unknown/invalid results out
    gatt.js, bytes.js         UUIDs from the APK, hex helpers
  src/model/session.js        session model, CSV/JSON/fixture export
  src/storage/session-store.js IndexedDB persistence (this browser profile only)
  fixtures/                   byte fixtures + expected results (shared with a future Python port)
  docs/PROTOCOL.md            protocol notes with byte tables and evidence
  test/                       node:test suites
```

## What was established from the APK

Source: `movinglife.apk`, `com.moving.movinglife` 5.13.0,
SHA-256 `299831b583ba06627bfffe4e037b3267c62e6073a276710c761981ea8658809d` (verified).
Method: `dexdump` and jadx 1.5.1 on the dex files; strings/symbols only for native libraries.
Details and byte tables: [docs/PROTOCOL.md](docs/PROTOCOL.md).

Facts (from app code or packaged data):

- The legacy Senssun BLE service in the app uses service **FFF0**, notify **FFF1**, write **FFF2**
  (FFB2 also accepted), and reads **180A/2A28** (software revision) after connecting.
- Frames are `10 00 00 C5 | length | 03 | function | payload | checksum`, checksum = low byte of the
  sum from the length byte to the last payload byte. Confirmed on constants in the APK.
- Scale reports: `0x80` realtime weight (with stable flag), `0x82` final/history report (weight, fat,
  impedance, water, muscle, bone, BMR, optional heart rate), `0x8C` TLV report, `0x89`
  eight-electrode report, `0x8D` device config, `0x81`/`0x83`/`0x87` replies.
- Weight scaling depends on a "division" code: ÷100 for codes 1–2, otherwise ÷10. Body-composition
  values are ÷10; BMR and impedance are unscaled.
- Catalog productId `0113` (`iF1944B`, "BodyFatScale(BLE)") maps to device type `SS_BLE_Scale_DC`,
  which is handled by the same manager that consumes the legacy frames above. Its catalog data
  points list weight, BMI, fat %, water %, muscle %, bone %, BMR, AMR, impedance and health score.
- A second, newer Senssun SDK in the app uses the **same UUIDs** but a native frame format
  (`libprotocol.so`), with signs of encryption and a random-code authentication step for newer
  firmware. This prototype does not decode it.

The decoder only emits measurements whose scaling is backed by APK code; each value carries its
raw number and a `basis` string. Everything else is reported as `unknown` or `invalid`.

## Tests and fixtures

- `fixtures/apk-constants.json` — real byte sequences copied from APK constants (command
  templates). They prove the checksum rule and show that non-report frames stay `unknown`.
- `fixtures/synthetic-layout.json` — **hand-built** frames following the APK layout, with expected
  values. They test the decoder logic but are not captures from a scale.
- `fixtures/captured/` — put real captures here. Every `*.json` under `fixtures/` is tested.

### Turning a capture into a test

1. Connect, weigh, then **Export as test fixture**. Save it in `fixtures/captured/`.
2. Without an `expected` array the test only checks that nothing undecoded carries measurements.
3. Add `expected` entries (format in [docs/PROTOCOL.md §10](docs/PROTOCOL.md)) using the numbers
   shown on the scale display, then `npm test`.

## Privacy

- Data lives in this browser profile's IndexedDB (`senssun-scale-prototype`) and in files you export.
- The server binds to `127.0.0.1` and serves only `web/` and `src/`.
- The page's CSP blocks all third-party scripts and network connections.

## Unresolved questions

1. **Exact scale model** — not yet known. productId `0113`/`iF1944B` may not be your scale.
   Please check the label under the scale and the name it advertises.
2. **Which protocol your scale speaks** — legacy `10 00 00 C5` frames or the newer native protocol
   (same UUIDs). The first real FFF1 capture answers this.
3. **No real capture yet** — all decoded layouts are from app code; none are confirmed on hardware.
4. **Unit code meanings** — the app treats codes 2 and 3 as pound-based; codes 0/1 are not named.
5. **Muscle/bone units** — `%` comes from the product catalog, not from parser code.
6. **Impedance unit** — passed through unscaled; unit not stated.
7. **Body composition prerequisites** — the app sends a user profile (sex/height/age/activity) to
   the scale after the first weight; the scale probably needs that to fill 0x82 body-composition
   fields. Not sent by this prototype.
8. **0x87 profile byte meanings** and **0x8C TLV types 3/4/5** — not decoded.
9. **Newer protocol in `libprotocol.so`** — needs native reverse engineering (no native
   decompiler was available for this pass).
10. **Broadcast scales** — advertisement-based, partly encrypted; out of scope for Web Bluetooth.

## Phase 2 (Raspberry Pi) notes

Not built yet. The likely transport is BlueZ through Python **Bleak**:
`BleakScanner` → `BleakClient(address)` → `start_notify("0000fff1-0000-1000-8000-00805f9b34fb", cb)`.
Port `src/protocol/senssun-legacy.js` (pure functions + a small assembler) and run it against the same
`fixtures/*.json` files; [docs/PROTOCOL.md](docs/PROTOCOL.md) is written to be implemented without
the browser code. Bleak also exposes advertisement data, which would make broadcast scales possible.
