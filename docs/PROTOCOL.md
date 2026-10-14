# Senssun legacy BLE protocol notes (transport-independent)

These notes describe what the Movinglife 5.13.0 APK does. They are written so the decoder can be
re-implemented in another language (e.g. Python + Bleak on a Raspberry Pi) without the browser code.

**Status:** derived from static analysis of the APK only. No frame has yet been captured from a real
scale. Treat every layout below as "what the app expects", not "what your scale sends", until a real
capture confirms it.

Confidence labels used below:

- **APK-code**: read directly from decompiled app code (decompiler output of `classes3.dex`).
- **APK-data**: from a data file or constant packaged in the APK.
- **Inferred**: interpretation of a name or behaviour; not proven.
- **Unknown**: not determined.

## 1. Evidence

| Item | Value |
|---|---|
| APK | `com.moving.movinglife` 5.13.0, SHA-256 `299831b583ba06627bfffe4e037b3267c62e6073a276710c761981ea8658809d` |
| BLE connection + frame parser | `o00oo0O.o00000O` (log tag `BleConnectService`) — APK-code |
| Facade | `o00oo0O.o00000O0` (log tag `BleCloudProtocolUtils`) — APK-code |
| Frame class | `senssun.blelib.device.scale.cloudblelib.command.Command` — APK-code |
| Command templates | `o00oo0O0.o00O0O` static byte arrays — APK-data |
| JSON → measurement scaling | `com.senssun.device.connect.data.SDeviceDataParseManager`, `o00O0ooo.o0OO00O` — APK-code |
| Product catalog | `assets/device_en.json`, productId `0113`, keywords `iF1944B`, name `BodyFatScale(BLE)` — APK-data |
| productId → device type | `SDeviceUtils.OooO0O0`: `0113` (and `0115`) → `SS_BLE_Scale_DC` — APK-code (switch table read from dex bytes) |
| Manager handling `SS_BLE_Scale_DC` | `o00O0o0.OooOOO`, registered on the facade above — APK-code |

Tools: `dexdump` (Android build-tools), jadx 1.5.1. The native libraries (`libprotocol.so`,
`libBodyFatScaleAlg.so`) were inventoried by symbol/strings only; no native decompiler was available
here, so the newer protocol in `libprotocol.so` is **not** decoded (see §8).

## 2. GATT layout

| UUID | Role | Confidence |
|---|---|---|
| `0000fff0-0000-1000-8000-00805f9b34fb` | Primary service | APK-code |
| `0000fff1-…` | Notifications from the scale | APK-code |
| `0000fff2-…` | Writes to the scale | APK-code |
| `0000ffb2-…` | Also accepted as notify/write char inside FFF0 | APK-code |
| `0000180a-…` / `00002a28-…` | Device Information / Software Revision String, read after connecting | APK-code |

APK connection sequence (APK-code, `o00000O`):

1. `connectGatt(autoConnect=false, transport=LE)`; 500 ms after connect, `discoverServices()`.
2. In FFF0, every characteristic whose UUID starts with `0000fff1`, `0000fff2` or `0000ffb2` gets
   notifications enabled (CCCD `0x2902`; notify if supported, otherwise indicate). A characteristic
   from that set with *write* or *write-without-response* becomes the write target.
3. After the CCCD write completes, it reads 2A28 if present and starts a 500 ms timer that writes
   one queued command per tick to the write characteristic.
4. The 2A28 string is split on `_`; with ≥ 5 parts: `deviceType = p0_p1_p2`, `deviceVersion = p3`,
   `algVersion = p4`, optional `upgradeType = p5`.

The same FFF0/FFF1/FFF2 UUIDs are also used by the newer `com.ss.bluetooth` SDK (§8), so the
service UUID alone does not tell which frame format a scale speaks.

## 3. Frame format

All multi-byte integers are **big-endian**. Indices are byte offsets in the complete frame.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Header `10 00 00 C5` |
| 4 | 1 | `L` = total frame length in bytes, including header and checksum |
| 5 | 1 | Group. Scale reports use `03` |
| 6 | 1 | Function code |
| 7 … L-2 | L-8 | Payload |
| L-1 | 1 | Checksum = `(sum of bytes[4 .. L-2]) & 0xFF` |

The checksum rule was confirmed against real APK constants (e.g. `10 00 00 C5 08 03 07 12`,
`10 00 00 C5 09 AA 00 02 B5`).

**Reassembly (APK-code):** notification bytes are appended to a buffer. If the buffer does not start
with the header it is cleared. When the buffer length equals `L` the frame is checked and dispatched;
if longer and it contains exactly one header, the first `L` bytes are taken and the rest dropped; if it
contains more than one header, the buffer is cleared. Identical consecutive over-length frames are
suppressed.

**Prototype difference (intentional):** the prototype keeps bytes after a frame (so two frames in one
notification both decode), drops a partial frame when a new header appears, and reports every
discarded byte run as an `unknown` result instead of dropping it silently.

## 4. Value scaling (APK-code, `o0OO00O`)

- `division` code → kg divisor: `1` or `2` → ÷100, otherwise ÷10.
- `division` code → lb divisor: `2` → ÷100, otherwise ÷10.
- lb → kg: × `0.4535924`.
- Raw weight ≥ 65535 → overload; no weight.

## 5. Scale → app reports (group `03`)

### 0x80 — realtime weight

| Offset | Field |
|---|---|
| 7–8 | weight raw |
| 9–10 | lb weight raw |
| 11 | high nibble = division, low nibble = unit code |
| 12 | `AA` or `BA` = stable; anything else = settling |

kg = weight raw ÷ kg-divisor(division), except unit codes 2 and 3, where the app uses
lb raw ÷ lb-divisor(division) × 0.4535924. The meaning of unit codes 0/1 is **unknown**; the app
only singles out 2 and 3 as pound-based.

### 0x82 — measurement report (final / history)

| Offset | Field | Scaling in app |
|---|---|---|
| 7 | `sys`: `00` realtime, `FF` = ignore body (seen at end of history), other = history | — |
| 8–9 | user PIN | — |
| 10–11 | weight raw | ÷ kg-divisor(division). The app prefers the preceding stable 0x80 weight if it has one |
| 12–13 | fat | ÷10 |
| 14–15 | impedance ("zuKang") | none |
| 16–17 | water ("moisture") | ÷10 |
| 18–19 | muscle | ÷10 |
| 20–21 | bone | ÷10 |
| 22–23 | BMR | none (kcal per catalog) |
| 24–27 | seconds since measurement (u32) | history timestamp = receive time − value |
| 28 | high nibble = division (only if L > 29; otherwise division = 0) | — |
| 29 | heart rate (only if L > 30) | none |

If impedance is 0 the app treats body composition as absent. Units for fat/water/muscle/bone come
from the catalog entry for productId 0113 (`%` for all four — APK-data, unverified on a device).

### 0x81 — user operation reply

Byte 7: `00` new, `01` edit, `02` delete, `03` user table full. Bytes 8–9: PIN (if present).

### 0x83 — time-sync reply

No payload fields are read by the app.

### 0x87 — user list entry (reply to "query all users")

Byte 7 total users, 8 slot, 9–10 PIN, 11–14 four single-byte profile fields, 15–16 a 16-bit field.
The app stores them into a user object; which byte is sex/height/age/activity/weight is **unknown**
for this frame.

### 0x89 — eight-electrode report

Byte 7 flag (`00` realtime, `FF` no body), 8 division/unit nibbles, 9–10 PIN, 11–14 seconds ago,
15 result, 16–17 weight, then 16-bit impedances ÷10: left hand, right hand, left foot, right foot,
trunk, four-electrode (18–29), fat ÷10 (30–31), water ÷10 (32–33). Unlikely to apply to a
four-electrode scale.

### 0x8C — TLV report

Bytes 7–8 PIN; byte 9 flags: unit code = `(b & 3) + 1`, division = `(b >> 2) & 3`.
From byte 10: records `[type][len][payload…]`, where `len` includes the type and length bytes.
The app stops when `len > L − 11`.

| Type | Payload |
|---|---|
| 0 | weight (÷100 kg) |
| 1 | weight, impedance |
| 2 | weight, impedance, heart rate (1 byte) |
| 3, 4, 5 | multi-frequency / segmental impedance (not decoded by the prototype) |
| 6 | lb weight (÷100; used when unit code is 2 or 3) |
| 17 | fat ÷10, water ÷10 |
| 18 | fat, water, muscle, bone (each ÷10), BMR |
| 33, 34 | u32 seconds ago |

### 0x8D — device configuration

Byte 7 low nibble unit code; byte 8 low nibble division, high nibble weight-range code; byte 9
battery (raw, unit unknown); byte 10 bit 0 mother/baby mode, bit 1 pregnancy mode.

## 6. App → scale commands (documented only — the prototype sends none)

Templates from `o00O0O`. `pp pp` = 2-byte PIN, `cs` = checksum.

| Purpose | Frame | Basis |
|---|---|---|
| Add/update user profile | `10 00 00 C5 13 03 01 00 00 pp pp sex height age activity unit wHi wLo cs` | APK-code (facade log names the arguments) |
| Delete user | `10 00 00 C5 13 03 01 02 00 pp pp 00 00 00 00 00 00 00 cs` | APK-code (reply op `02` = UserInfoDel) |
| History sync for PIN | `10 00 00 C5 0B 03 02 pp pp 00 cs` | Inferred: dequeued when a 0x82 with `sys = FF` arrives |
| Query all users | `10 00 00 C5 08 03 07 12` | APK-code (answered by 0x87) |
| Command 03 09 for PIN | `10 00 00 C5 0B 03 09 pp pp 00 cs` | Inferred: dequeued by a 0x89 reply |
| Command 03 0C for PIN | `10 00 00 C5 0B 03 0C pp pp 00 cs` | Inferred: dequeued by a 0x8C reply with bit 5 of byte 9 set |
| Pregnancy mode on/off | `10 00 00 C5 0B 03 0D 02 (00 or 02) 00 cs` | APK-code (`gravidMode`) |

The user-profile field order comes from the app's log line
`pin / sex / height / age / activity / unit / weightKG`; value encodings are **inferred**.
The app sends user info only after it has received weight data, which suggests weight reports do
not depend on a prior command (**inferred**). Body-composition values in 0x82 probably require a
matching user profile stored on the scale (**inferred**).

## 7. Decoder output contract

Every input byte run produces exactly one of:

- `decoded` — frame valid and function understood; `measurements[]` contains only values whose
  scaling is backed by APK code, each with `raw` and `basis`.
- `unknown` — not a legacy frame, unsupported group/function, or discarded bytes. No measurements.
- `invalid` — legacy header but bad length/checksum or too short. No measurements.

## 8. Other protocol families in the APK (not decoded)

- **Newer xshq/`com.ss.bluetooth` SDK.** Frames are parsed and built in native `libprotocol.so`
  (`Java_com_xshq_sdk_Protocol_parseData`, `getFuncBuffer`, `parseStableWeight*`, cJSON output with
  command names such as `U_BF_WEIGHT`). Strings include `encrypt err size` / `decrypt err size`.
  For body-fat products whose version string, parsed as hex, is ≥ 30 (decimal), the app first runs a
  random-code authentication (`D_BF_RANDOM_CODE` / `U_BF_CHECK_RESULT`); older versions get a time
  sync instead. Uses the same FFF0/FFF1/FFF2 UUIDs.
- **Broadcast scales** (`o00oo0Oo.Oooo0`, `o00oo0oO.o00O0O`): data in advertisements, partly
  encrypted ("TaoBao" format). Web Bluetooth cannot read these with the normal picker.
- **`A5`-prefixed templates** in `o00O0O` (first 13 arrays): another frame family; usage not traced.

If your scale's FFF1 notifications do not start with `10 00 00 C5`, it probably uses one of these.

## 9. Porting checklist (Python / Bleak)

1. Connect, enable notifications on FFF1 (`start_notify`).
2. Feed each notification into a stream assembler that implements §3.
3. Decode each frame per §5; return `unknown` for anything else.
4. Run the same fixtures as the browser tests: `fixtures/*.json` (see the format below).

## 10. Fixture format

```json
{
  "provenance": "apk-constant | synthetic-from-apk-layout | captured",
  "cases": [
    {
      "name": "…",
      "notifications": ["10 00 00 C5 …", "…"],
      "expected": [
        { "status": "decoded", "type": "realtime-weight",
          "fields": { "stable": true },
          "measurements": { "weight": 72.35 } }
      ]
    }
  ]
}
```

`notifications` are fed in order into one fresh stream decoder, then flushed. `expected` lists the
results in order: `fields`/`frame` are subset matches, `measurements` must match the exact key set
(numbers within 1e-4). Captured fixtures may omit `expected` until values are confirmed against the
scale display.
