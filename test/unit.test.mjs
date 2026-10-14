import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChecksum, decodeFrame, FrameAssembler, kgDivisor, lbDivisor } from '../src/protocol/senssun-legacy.js';
import { fromHex, toHex } from '../src/protocol/bytes.js';
import { parseSoftwareRevision, parseUuidList, uuid16 } from '../src/protocol/gatt.js';
import {
  addEvent, createSession, csvCell, eventsToCsv, measurementsToCsv, sessionToFixture,
} from '../src/model/session.js';

test('checksum matches APK constant 10 00 00 C5 08 03 07 12', () => {
  assert.equal(computeChecksum(fromHex('10 00 00 C5 08 03 07 12')), 0x12);
});

test('division divisors follow the APK helper', () => {
  assert.deepEqual([0, 1, 2, 3].map(kgDivisor), [10, 100, 100, 10]);
  assert.deepEqual([0, 1, 2, 3].map(lbDivisor), [10, 10, 100, 10]);
});

test('length mismatch is invalid, not decoded', () => {
  const r = decodeFrame(fromHex('10 00 00 C5 0F 03 80 02 D5 06 3F 01 00 AE'));
  assert.equal(r.status, 'invalid');
  assert.equal(r.reason, 'length-mismatch');
  assert.equal(r.measurements.length, 0);
});

test('assembler waits for the rest of a frame and flushes leftovers as discarded', () => {
  const a = new FrameAssembler();
  assert.deepEqual(a.push(fromHex('10 00 00 C5 0E 03 80')), []);
  const leftover = a.flush();
  assert.equal(leftover.length, 1);
  assert.equal(leftover[0].reason, 'incomplete-frame');
  assert.equal(toHex(leftover[0].bytes), '10 00 00 C5 0E 03 80');
});

test('assembler drops a truncated frame when a new header arrives', () => {
  const a = new FrameAssembler();
  a.push(fromHex('10 00 00 C5 1F 03 82 00'));
  const out = a.push(fromHex('10 00 00 C5 08 03 83 8E'));
  assert.equal(out[0].kind, 'discarded');
  assert.equal(out[0].reason, 'truncated-frame');
  assert.equal(out[1].kind, 'frame');
  assert.equal(toHex(out[1].bytes), '10 00 00 C5 08 03 83 8E');
});

test('parseUuidList accepts 16-bit and 128-bit UUIDs', () => {
  const { uuids, invalid } = parseUuidList('fff0, 0xFFE0 f000ffc0-0451-4000-b000-000000000000 nope');
  assert.deepEqual(uuids, [uuid16(0xfff0), uuid16(0xffe0), 'f000ffc0-0451-4000-b000-000000000000']);
  assert.deepEqual(invalid, ['nope']);
});

test('parseSoftwareRevision splits like the APK', () => {
  assert.deepEqual(parseSoftwareRevision('A_B_C_V1_ALG2_3'), {
    deviceType: 'A_B_C', deviceVersion: 'V1', algVersion: 'ALG2', upgradeType: '3',
  });
  assert.equal(parseSoftwareRevision('too_short'), null);
});

test('CSV cells are quoted and guarded against formula injection', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(12.5), '12.5');
  assert.equal(csvCell(null), '');
});

test('measurement CSV only contains decoded packets', () => {
  const s = createSession({ name: 't', now: new Date('2026-01-01T00:00:00Z') });
  const decoded = decodeFrame(fromHex('10 00 00 C5 0E 03 80 1C 43 06 3B 11 AA EC'));
  const unknown = decodeFrame(fromHex('01 02 03'));
  addEvent(s, { kind: 'packet', hex: decoded.hex, decode: decoded }, new Date('2026-01-01T00:00:01Z'));
  addEvent(s, { kind: 'packet', hex: unknown.hex, decode: unknown }, new Date('2026-01-01T00:00:02Z'));
  const lines = measurementsToCsv(s).trim().split('\r\n');
  assert.equal(lines.length, 1 + decoded.measurements.length);
  assert.ok(lines.slice(1).every((l) => l.includes('realtime-weight')));
  assert.equal(eventsToCsv(s).trim().split('\r\n').length, 3);
});

test('fixture export groups notifications by characteristic', () => {
  const s = createSession({ name: 'cap' });
  addEvent(s, { kind: 'notification', characteristic: 'c1', hex: '01 02' });
  addEvent(s, { kind: 'notification', characteristic: 'c1', hex: '03' });
  addEvent(s, { kind: 'read', characteristic: 'c2', hex: '04' });
  const fx = sessionToFixture(s);
  assert.equal(fx.provenance, 'captured');
  assert.deepEqual(fx.cases.map((c) => c.notifications), [['01 02', '03']]);
});
