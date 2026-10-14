// Session data model and local export formats. No browser APIs beyond optional userAgent.

export const SESSION_SCHEMA = 'senssun-scale-session/1';

export function createSession({ name, userAgent = null, now = new Date() } = {}) {
  const iso = now.toISOString();
  return {
    schema: SESSION_SCHEMA,
    id: `session-${iso.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || `Session ${iso.slice(0, 19).replace('T', ' ')}`,
    createdAt: iso,
    updatedAt: iso,
    environment: { userAgent },
    device: null,
    gatt: [],
    events: [],
  };
}

/** Append an event. `event` must contain `kind`; seq/time fields are assigned here. */
export function addEvent(session, event, now = new Date()) {
  const seq = session.events.length ? session.events[session.events.length - 1].seq + 1 : 1;
  const record = {
    seq,
    t: now.toISOString(),
    elapsedMs: now.getTime() - Date.parse(session.createdAt),
    kind: event.kind,
    service: event.service ?? null,
    characteristic: event.characteristic ?? null,
    hex: event.hex ?? null,
    text: event.text ?? null,
    message: event.message ?? null,
    sourceSeq: event.sourceSeq ?? null,
    decode: event.decode ?? null,
  };
  session.events.push(record);
  session.updatedAt = record.t;
  return record;
}

const INJECTION = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let s = String(value);
  if (INJECTION.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function eventsToCsv(session) {
  const header = ['seq', 'time_utc', 'elapsed_ms', 'kind', 'service', 'characteristic', 'hex', 'text',
    'message', 'source_seq', 'decode_status', 'packet_type', 'decode_reason'];
  const rows = session.events.map((e) => [
    e.seq, e.t, e.elapsedMs, e.kind, e.service, e.characteristic, e.hex, e.text, e.message, e.sourceSeq,
    e.decode?.status ?? null, e.decode?.type ?? null, e.decode?.reason ?? null,
  ]);
  return toCsv(header, rows);
}

/** One row per decoded measurement. Unknown/invalid packets never produce rows. */
export function measurementsToCsv(session) {
  const header = ['seq', 'time_utc', 'packet_type', 'record', 'key', 'label', 'value', 'unit', 'raw', 'basis', 'frame_hex'];
  const rows = [];
  for (const e of session.events) {
    if (e.kind !== 'packet' || e.decode?.status !== 'decoded') continue;
    for (const m of e.decode.measurements) {
      rows.push([e.seq, e.t, e.decode.type, e.decode.fields?.record ?? null, m.key, m.label, m.value, m.unit,
        m.raw, m.basis, e.hex]);
    }
  }
  return toCsv(header, rows);
}

export function sessionToJson(session) {
  return JSON.stringify(session, null, 2);
}

/** Group raw notifications into a fixture file (no expected values) for later annotation. */
export function sessionToFixture(session) {
  const byChar = new Map();
  for (const e of session.events) {
    if (e.kind !== 'notification' || !e.hex) continue;
    if (!byChar.has(e.characteristic)) byChar.set(e.characteristic, []);
    byChar.get(e.characteristic).push(e.hex);
  }
  return {
    description: 'Raw notifications captured with the browser prototype. Add an "expected" array per case once values are confirmed against the scale display.',
    provenance: 'captured',
    source: {
      sessionId: session.id,
      sessionName: session.name,
      capturedAt: session.createdAt,
      device: session.device,
      userAgent: session.environment?.userAgent ?? null,
    },
    cases: [...byChar.entries()].map(([characteristic, notifications]) => ({
      name: `${session.name} — ${characteristic}`,
      characteristic,
      notifications,
    })),
  };
}

export function isSession(value) {
  return Boolean(value) && value.schema === SESSION_SCHEMA && Array.isArray(value.events);
}
