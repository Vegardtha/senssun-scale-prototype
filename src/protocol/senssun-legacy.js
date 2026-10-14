// Decoder for the legacy Senssun "cloud BLE" frame protocol found in Movinglife 5.13.0
// (classes o00oo0O.o00000O and senssun.blelib.device.scale.cloudblelib.command.Command).
// Pure functions only: no Web Bluetooth, DOM, or storage dependencies. See docs/PROTOCOL.md.

import { toHex, u16be, u32be } from './bytes.js';

export const PROTOCOL_ID = 'senssun-legacy';
export const HEADER = Object.freeze([0x10, 0x00, 0x00, 0xc5]);
export const MIN_FRAME_LENGTH = 8; // header(4) + length(1) + group(1) + function(1) + checksum(1)
export const GROUP_SCALE = 0x03;
export const LB_TO_KG = 0.4535924; // constant used by the APK (o00O0ooo.o0OO00O)

export const FUNCTION_NAMES = Object.freeze({
  0x80: 'realtime-weight',
  0x81: 'user-op-reply',
  0x82: 'measurement-report',
  0x83: 'time-sync-reply',
  0x87: 'user-list-entry',
  0x89: 'eight-electrode-report',
  0x8c: 'tlv-report',
  0x8d: 'device-config',
});

const CATALOG_BASIS = 'unit from Movinglife catalog entry productId 0113 (unverified on device)';

export function startsWithHeader(bytes, offset = 0) {
  return HEADER.every((b, i) => bytes[offset + i] === b);
}

/** Sum of bytes[4 .. length-2], truncated to 8 bits (Command.OooO0OO in the APK). */
export function computeChecksum(frame) {
  let sum = 0;
  for (let i = 4; i < frame.length - 1; i++) sum += frame[i];
  return sum & 0xff;
}

/** kg divisor from the division code (o0OO00O.OooO00o). */
export function kgDivisor(division) {
  return division === 1 || division === 2 ? 100 : 10;
}

/** lb divisor from the division code (o0OO00O.OooO0O0). */
export function lbDivisor(division) {
  return division === 2 ? 100 : 10;
}

function round(value, digits = 4) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function measurement(key, label, value, unit, raw, basis) {
  return { key, label, value, unit, raw, basis };
}

function result(status, bytes, extra = {}) {
  return {
    status,
    protocol: status === 'unknown' && !extra.frame ? null : PROTOCOL_ID,
    hex: toHex(bytes),
    type: null,
    fields: {},
    measurements: [],
    notes: [],
    ...extra,
  };
}

/** Validate framing of one complete frame. */
export function parseFrame(bytes) {
  if (bytes.length < 5 || !startsWithHeader(bytes)) {
    return { ok: false, reason: 'no-legacy-header' };
  }
  const declared = bytes[4];
  const frame = {
    length: bytes.length,
    declaredLength: declared,
    group: bytes[5] ?? null,
    func: bytes[6] ?? null,
    checksum: bytes[bytes.length - 1],
    expectedChecksum: null,
    checksumOk: false,
  };
  if (declared < MIN_FRAME_LENGTH) return { ok: false, reason: 'declared-length-too-small', frame };
  if (declared !== bytes.length) return { ok: false, reason: 'length-mismatch', frame };
  frame.expectedChecksum = computeChecksum(bytes);
  frame.checksumOk = frame.expectedChecksum === frame.checksum;
  if (!frame.checksumOk) return { ok: false, reason: 'checksum-mismatch', frame };
  return { ok: true, frame };
}

/**
 * Decode one complete frame. Returns status:
 *  - 'decoded': frame understood; only evidence-backed values appear in `measurements`.
 *  - 'unknown': bytes are not a recognised legacy frame, or the function code is not understood.
 *  - 'invalid': legacy header present but length/checksum is wrong.
 */
export function decodeFrame(input) {
  const bytes = Uint8Array.from(input);
  const parsed = parseFrame(bytes);
  if (!parsed.ok) {
    const status = parsed.reason === 'no-legacy-header' ? 'unknown' : 'invalid';
    return result(status, bytes, { reason: parsed.reason, frame: parsed.frame ?? null });
  }
  const { frame } = parsed;
  if (frame.group !== GROUP_SCALE) {
    return result('unknown', bytes, { reason: 'unsupported-group', frame });
  }
  const decoder = DECODERS[frame.func];
  if (!decoder) return result('unknown', bytes, { reason: 'unsupported-function', frame });
  const out = result('decoded', bytes, { frame, type: FUNCTION_NAMES[frame.func] });
  const err = decoder(bytes, out);
  if (err) return result('invalid', bytes, { reason: err, frame, type: out.type });
  return out;
}

function decode80(b, out) {
  if (b.length < 14) return 'frame-too-short';
  const weightRaw = u16be(b, 7);
  const lbRaw = u16be(b, 9);
  const division = b[11] >> 4;
  const unitCode = b[11] & 0x0f;
  const stable = b[12] === 0xaa || b[12] === 0xba;
  Object.assign(out.fields, {
    weightRaw, lbRaw, division, unitCode, stable, stableByte: toHex([b[12]]),
  });
  if (weightRaw >= 0xffff) {
    out.fields.overload = true;
    out.notes.push('Weight raw value >= 65535: APK flags this as overload; no weight reported.');
    return null;
  }
  const lb = lbRaw / lbDivisor(division);
  const lbBased = unitCode === 2 || unitCode === 3;
  const kg = lbBased ? lb * LB_TO_KG : weightRaw / kgDivisor(division);
  out.measurements.push(
    measurement('weight', stable ? 'Weight (stable)' : 'Weight (settling)', round(kg), 'kg',
      lbBased ? lbRaw : weightRaw,
      lbBased
        ? `unit code ${unitCode}: APK converts lb field (raw/${lbDivisor(division)}) × ${LB_TO_KG}`
        : `raw/${kgDivisor(division)} for division ${division} (APK o0OO00O.OooO00o)`),
    measurement('weight_lb_field', 'Weight (lb field)', round(lb), 'lb', lbRaw,
      `raw/${lbDivisor(division)} for division ${division} (APK o0OO00O.OooO0O0)`),
  );
  return null;
}

function decode82(b, out) {
  if (b.length < 9) return 'frame-too-short';
  const sys = b[7];
  out.fields.sys = toHex([sys]);
  if (sys === 0xff) {
    out.notes.push('sys byte FF: APK ignores the report body (seen as end of history sync).');
    return null;
  }
  if (b.length < 29) return 'frame-too-short';
  const division = b.length > 29 ? b[28] >> 4 : 0;
  const f = {
    record: sys === 0x00 ? 'realtime' : 'history',
    pin: toHex(b.subarray(8, 10), ''),
    weightRaw: u16be(b, 10),
    fatRaw: u16be(b, 12),
    impedanceRaw: u16be(b, 14),
    waterRaw: u16be(b, 16),
    muscleRaw: u16be(b, 18),
    boneRaw: u16be(b, 20),
    bmrRaw: u16be(b, 22),
    secondsAgo: u32be(b, 24),
    division,
    heartRate: b.length > 30 ? b[29] : null,
  };
  Object.assign(out.fields, f);
  if (f.record === 'history') {
    out.notes.push(`History record: APK timestamps it as receive time minus ${f.secondsAgo} s.`);
  }
  if (f.weightRaw >= 0xffff) {
    out.fields.overload = true;
    out.notes.push('Weight raw value >= 65535: APK flags this as overload.');
  } else {
    out.measurements.push(measurement('weight', 'Weight', round(f.weightRaw / kgDivisor(division)), 'kg',
      f.weightRaw, `raw/${kgDivisor(division)} for division ${division}; APK prefers the preceding stable 0x80 weight when available`));
  }
  if (f.impedanceRaw === 0) {
    out.notes.push('Impedance is 0: APK treats body composition as absent (SDeviceFat.isEmpty).');
  } else {
    out.measurements.push(
      measurement('impedance', 'Impedance (raw)', f.impedanceRaw, null, f.impedanceRaw,
        'stored unscaled by the APK ("zuKang"); unit not stated'),
      measurement('fat', 'Body fat', round(f.fatRaw / 10, 1), '%', f.fatRaw, `raw/10 (APK); ${CATALOG_BASIS}`),
      measurement('water', 'Body water', round(f.waterRaw / 10, 1), '%', f.waterRaw, `raw/10 (APK); ${CATALOG_BASIS}`),
      measurement('muscle', 'Muscle', round(f.muscleRaw / 10, 1), '%', f.muscleRaw, `raw/10 (APK); ${CATALOG_BASIS}`),
      measurement('bone', 'Bone', round(f.boneRaw / 10, 1), '%', f.boneRaw, `raw/10 (APK); ${CATALOG_BASIS}`),
      measurement('bmr', 'BMR', f.bmrRaw, 'kcal', f.bmrRaw, `unscaled (APK); ${CATALOG_BASIS}`),
    );
  }
  if (f.heartRate) {
    out.measurements.push(measurement('heart_rate', 'Heart rate', f.heartRate, 'bpm', f.heartRate,
      'byte 29 when frame length > 30 (APK)'));
  }
  return null;
}

function decode81(b, out) {
  if (b.length < 9) return 'frame-too-short';
  const ops = { 0: 'UserInfoNew', 1: 'UserInfoEdit', 2: 'UserInfoDel', 3: 'UserInfoFull' };
  out.fields.opCode = toHex([b[7]]);
  out.fields.op = ops[b[7]] ?? null;
  if (b.length >= 11) out.fields.pin = toHex(b.subarray(8, 10), '');
  return null;
}

function decode83(_b, out) {
  out.notes.push('Acknowledgement only; the APK reads no fields from 0x83.');
  return null;
}

function decode87(b, out) {
  if (b.length < 18) return 'frame-too-short';
  Object.assign(out.fields, {
    userCount: b[7],
    slot: b[8],
    pin: toHex(b.subarray(9, 11), ''),
    byte11: b[11], byte12: b[12], byte13: b[13], byte14: b[14],
    word15: u16be(b, 15),
  });
  out.notes.push('Profile byte meanings (sex/height/age/activity/weight) are not confirmed for 0x87; raw only.');
  return null;
}

function decode89(b, out) {
  if (b.length < 17) return 'frame-too-short';
  const flag = b[7];
  Object.assign(out.fields, {
    flag: toHex([flag]),
    division: b[8] >> 4,
    unitCode: b[8] & 0x0f,
    pin: toHex(b.subarray(9, 11), ''),
    secondsAgo: u32be(b, 11),
    result: toHex([b[15]]),
  });
  if (flag === 0xff) return null;
  if (b.length < 35) return 'frame-too-short';
  const division = out.fields.division;
  const imp = (i) => round(u16be(b, i) / 10, 1);
  Object.assign(out.fields, {
    weightRaw: u16be(b, 16),
    leftHandImpedance: imp(18), rightHandImpedance: imp(20),
    leftFootImpedance: imp(22), rightFootImpedance: imp(24),
    trunkImpedance: imp(26), fourImpedance: imp(28),
    fatRaw: u16be(b, 30), waterRaw: u16be(b, 32),
  });
  out.measurements.push(
    measurement('weight', 'Weight', round(out.fields.weightRaw / kgDivisor(division)), 'kg',
      out.fields.weightRaw, `raw/${kgDivisor(division)} for division ${division}`),
    measurement('fat', 'Body fat', round(out.fields.fatRaw / 10, 1), '%', out.fields.fatRaw, 'raw/10 (APK)'),
    measurement('water', 'Body water', round(out.fields.waterRaw / 10, 1), '%', out.fields.waterRaw, 'raw/10 (APK)'),
  );
  return null;
}

function decode8C(b, out) {
  if (b.length <= 11) return 'frame-too-short';
  const flags = b[9];
  const f = out.fields;
  f.pin = toHex(b.subarray(7, 9), '');
  f.unitCode = (flags & 0x03) + 1;
  f.division = (flags >> 2) & 0x03;
  f.tlv = [];
  // Records start at byte 10: [type, length (includes type+length), payload...].
  // Stops when a length exceeds (frameLength - 11), mirroring the APK loop.
  let i = 10;
  while (i < b.length - 1) {
    const type = b[i];
    const len = b[i + 1];
    if (len < 2 || b.length - 11 < len || i + len > b.length - 1) break;
    const p = b.subarray(i + 2, i + len);
    const rec = { type, length: len, payloadHex: toHex(p) };
    const w = (k) => (p.length >= k + 2 ? u16be(p, k) : null);
    switch (type) {
      case 0: rec.weightRaw = w(0); break;
      case 1: rec.weightRaw = w(0); rec.bodyImpedance = w(2); break;
      case 2: rec.weightRaw = w(0); rec.bodyImpedance = w(2); rec.heartRate = p[4] ?? null; break;
      case 6: rec.lbRaw = w(0); break;
      case 17: rec.fatRaw = w(0); rec.waterRaw = w(2); break;
      case 18:
        rec.fatRaw = w(0); rec.waterRaw = w(2); rec.muscleRaw = w(4); rec.boneRaw = w(6); rec.bmrRaw = w(8);
        break;
      case 33: case 34: rec.secondsAgo = p.length >= 4 ? u32be(p, 0) : null; break;
      default: rec.note = 'TLV type not decoded by this prototype (APK types 3/4/5 carry multi-frequency impedance)';
    }
    f.tlv.push(rec);
    i += len;
  }
  const pick = (k) => f.tlv.reduce((v, r) => (r[k] ?? v), null);
  const weightRaw = pick('weightRaw');
  const lbRaw = pick('lbRaw');
  if (weightRaw !== null && weightRaw < 0xffff) {
    const lbBased = (f.unitCode === 2 || f.unitCode === 3) && lbRaw > 0;
    out.measurements.push(measurement('weight', 'Weight',
      round(lbBased ? (lbRaw / 100) * LB_TO_KG : weightRaw / 100), 'kg', lbBased ? lbRaw : weightRaw,
      lbBased ? 'lb TLV /100 × 0.4535924 (APK parseData8C)' : 'raw/100 (APK parseData8C)'));
  }
  const imp = pick('bodyImpedance');
  if (imp) out.measurements.push(measurement('impedance', 'Impedance (raw)', imp, null, imp, 'unscaled (APK)'));
  for (const [k, key, label, unit] of [
    ['fatRaw', 'fat', 'Body fat', '%'], ['waterRaw', 'water', 'Body water', '%'],
    ['muscleRaw', 'muscle', 'Muscle', null], ['boneRaw', 'bone', 'Bone', null],
  ]) {
    const v = pick(k);
    if (v !== null) out.measurements.push(measurement(key, label, round(v / 10, 1), unit, v, 'raw/10 (APK parseData8C); unit not stated'));
  }
  const bmr = pick('bmrRaw');
  if (bmr !== null) out.measurements.push(measurement('bmr', 'BMR', bmr, 'kcal', bmr, 'unscaled (APK)'));
  const hr = pick('heartRate');
  if (hr) out.measurements.push(measurement('heart_rate', 'Heart rate', hr, 'bpm', hr, 'TLV type 2 (APK)'));
  return null;
}

function decode8D(b, out) {
  if (b.length < 12) return 'frame-too-short';
  Object.assign(out.fields, {
    unitCode: b[7] & 0x0f,
    division: b[8] & 0x0f,
    weightRangeNibble: b[8] >> 4,
    batteryRaw: b[9],
    motherBabyMode: (b[10] & 0x01) === 1,
    gravidMode: ((b[10] >> 1) & 0x01) === 1,
  });
  out.notes.push('Battery byte is raw; its unit (percent/level) is not stated in the APK.');
  return null;
}

const DECODERS = {
  0x80: decode80,
  0x81: decode81,
  0x82: decode82,
  0x83: decode83,
  0x87: decode87,
  0x89: decode89,
  0x8c: decode8C,
  0x8d: decode8D,
};

function headerIndex(buf, from = 0) {
  for (let i = from; i + HEADER.length <= buf.length; i++) {
    if (startsWithHeader(buf, i)) return i;
  }
  return -1;
}

function partialHeaderSuffix(buf) {
  for (let k = Math.min(HEADER.length - 1, buf.length); k > 0; k--) {
    if (HEADER.slice(0, k).every((b, i) => buf[buf.length - k + i] === b)) return k;
  }
  return 0;
}

/**
 * Reassembles frames that may be split across (or packed into) BLE notifications.
 * Bytes that cannot belong to a legacy frame are returned as `discarded` so the UI
 * can show them as unknown rather than dropping them silently.
 */
export class FrameAssembler {
  constructor() {
    this.buffer = new Uint8Array(0);
  }

  reset() {
    this.buffer = new Uint8Array(0);
  }

  /** Returns any bytes still waiting for completion, then clears the buffer. */
  flush() {
    const rest = this.buffer;
    this.reset();
    return rest.length ? [{ kind: 'discarded', bytes: rest, reason: 'incomplete-frame' }] : [];
  }

  push(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    let buf = merged;
    const out = [];
    const discard = (n, reason) => {
      out.push({ kind: 'discarded', bytes: buf.slice(0, n), reason });
      buf = buf.slice(n);
    };
    while (buf.length > 0) {
      const idx = headerIndex(buf);
      if (idx === -1) {
        const keep = partialHeaderSuffix(buf);
        if (buf.length > keep) discard(buf.length - keep, 'no-legacy-header');
        break;
      }
      if (idx > 0) discard(idx, 'bytes-before-header');
      if (buf.length < 5) break;
      const len = buf[4];
      if (len < MIN_FRAME_LENGTH) {
        discard(1, 'declared-length-too-small');
        continue;
      }
      if (buf.length >= len) {
        out.push({ kind: 'frame', bytes: buf.slice(0, len) });
        buf = buf.slice(len);
        continue;
      }
      const next = headerIndex(buf, 1);
      if (next !== -1) {
        discard(next, 'truncated-frame');
        continue;
      }
      break;
    }
    this.buffer = buf;
    return out;
  }
}
