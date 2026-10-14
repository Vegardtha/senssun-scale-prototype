// GATT identifiers found in Movinglife 5.13.0 (classes3.dex). Transport-independent.

export const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

export function uuid16(short) {
  return `0000${short.toString(16).padStart(4, '0')}${BASE_UUID_SUFFIX}`;
}

export const SENSSUN_SERVICE = uuid16(0xfff0);
export const SENSSUN_NOTIFY = uuid16(0xfff1);
export const SENSSUN_WRITE = uuid16(0xfff2);
// Legacy service also accepts a characteristic starting with 0000ffb2 as notify/write.
export const SENSSUN_ALT_CHAR = uuid16(0xffb2);
export const DEVICE_INFORMATION_SERVICE = uuid16(0x180a);
export const SOFTWARE_REVISION = uuid16(0x2a28);

// Services the browser is asked for permission to access. Web Bluetooth hides any
// service not listed here or in the scan filter.
export const DEFAULT_OPTIONAL_SERVICES = [
  SENSSUN_SERVICE,
  DEVICE_INFORMATION_SERVICE,
  uuid16(0x180f), // Battery Service (standard; not referenced by the APK)
];

export const KNOWN_UUIDS = {
  [SENSSUN_SERVICE]: 'Senssun scale service (FFF0) — APK evidence',
  [SENSSUN_NOTIFY]: 'Senssun notify (FFF1) — APK evidence',
  [SENSSUN_WRITE]: 'Senssun write (FFF2) — APK evidence',
  [SENSSUN_ALT_CHAR]: 'Alternate notify/write (FFB2) — APK evidence',
  [DEVICE_INFORMATION_SERVICE]: 'Device Information (180A)',
  [uuid16(0x2a24)]: 'Model Number String (2A24)',
  [uuid16(0x2a25)]: 'Serial Number String (2A25)',
  [uuid16(0x2a26)]: 'Firmware Revision String (2A26)',
  [uuid16(0x2a27)]: 'Hardware Revision String (2A27)',
  [SOFTWARE_REVISION]: 'Software Revision String (2A28) — read by the APK',
  [uuid16(0x2a29)]: 'Manufacturer Name String (2A29)',
  [uuid16(0x180f)]: 'Battery Service (180F)',
  [uuid16(0x2a19)]: 'Battery Level (2A19)',
};

const STRING_CHARACTERISTICS = new Set(
  [0x2a24, 0x2a25, 0x2a26, 0x2a27, 0x2a28, 0x2a29].map(uuid16),
);

export function describeUuid(uuid) {
  return KNOWN_UUIDS[uuid.toLowerCase()] ?? null;
}

export function isStringCharacteristic(uuid) {
  return STRING_CHARACTERISTICS.has(uuid.toLowerCase());
}

/**
 * Parse a user-entered UUID list (comma/space separated). Accepts 16-bit hex
 * ("fff0", "0xfff0") or full 128-bit UUIDs. Returns { uuids, invalid }.
 */
export function parseUuidList(text) {
  const uuids = [];
  const invalid = [];
  for (const token of String(text).split(/[\s,;]+/).filter(Boolean)) {
    const t = token.toLowerCase().replace(/^0x/, '');
    if (/^[0-9a-f]{4}$/.test(t)) uuids.push(uuid16(parseInt(t, 16)));
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) uuids.push(t);
    else invalid.push(token);
  }
  return { uuids: [...new Set(uuids)], invalid };
}

/**
 * The APK splits the 2A28 string on "_" (>= 5 parts):
 * deviceType = parts[0..2], deviceVersion = parts[3], algVersion = parts[4], upgradeType = parts[5].
 */
export function parseSoftwareRevision(text) {
  const parts = String(text).split('_');
  if (parts.length < 5) return null;
  const out = {
    deviceType: parts.slice(0, 3).join('_'),
    deviceVersion: parts[3],
    algVersion: parts[4],
  };
  if (parts.length >= 6) out.upgradeType = parts[5];
  return out;
}
