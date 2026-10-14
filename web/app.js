import {
  WebBluetoothTransport, adapterAvailability, webBluetoothSupport,
} from '../src/transport/web-bluetooth.js';
import { createStreamDecoder } from '../src/protocol/index.js';
import {
  DEFAULT_OPTIONAL_SERVICES, DEVICE_INFORMATION_SERVICE, SENSSUN_NOTIFY, SENSSUN_SERVICE,
  describeUuid, isStringCharacteristic, parseSoftwareRevision, parseUuidList, SOFTWARE_REVISION,
} from '../src/protocol/gatt.js';
import { decodeUtf8, toHex } from '../src/protocol/bytes.js';
import {
  addEvent, createSession, eventsToCsv, measurementsToCsv, sessionToFixture, sessionToJson,
} from '../src/model/session.js';
import { sessionStore } from '../src/storage/session-store.js';

const MAX_LOG_ROWS = 500;
const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  viewingSaved: false,
  gattTree: [],
  decoders: new Map(),
  counters: { notifications: 0, decoded: 0, unknown: 0, invalid: 0 },
  saveTimer: null,
};

const transport = new WebBluetoothTransport(onTransportEvent);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined) node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function shortUuid(uuid) {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(uuid ?? '');
  return m ? m[1].toUpperCase() : uuid ?? '';
}

function labelFor(uuid) {
  const d = describeUuid(uuid ?? '');
  return d ? `${shortUuid(uuid)} · ${d}` : shortUuid(uuid);
}

// ---------- environment ----------

async function renderEnvironment() {
  const env = $('env');
  const support = webBluetoothSupport();
  const items = [
    ['Web Bluetooth API', support.hasApi, support.hasApi ? 'available' : 'missing — use Chrome or Edge'],
    ['Secure context', support.secureContext, support.secureContext ? 'yes' : 'no — open via http://localhost'],
  ];
  const adapter = await adapterAvailability();
  items.push(['Bluetooth adapter', adapter, adapter === null ? 'unknown (browser cannot tell)' : adapter ? 'reported available' : 'not available']);
  env.replaceChildren(...items.map(([name, ok, text]) =>
    el('li', { class: ok === true ? 'ok' : ok === false ? 'bad' : 'warn' }, `${name}: ${text}`)));
  $('btn-connect').disabled = !(support.hasApi && support.secureContext);
  $('default-services').textContent = DEFAULT_OPTIONAL_SERVICES.map(shortUuid).join(', ');
}

// ---------- session ----------

function newSession() {
  state.session = createSession({ userAgent: navigator.userAgent });
  state.viewingSaved = false;
  state.decoders.clear();
  state.counters = { notifications: 0, decoded: 0, unknown: 0, invalid: 0 };
  $('session-name').value = state.session.name;
  $('log').tBodies[0].replaceChildren();
  $('latest').replaceChildren(el('p', { class: 'muted' }, 'No decoded packets yet. Unknown packets are only shown in the log.'));
  renderCounters();
  if (!transport.connected) renderGatt([]);
  $('save-status').textContent = 'Not saved yet (saves automatically when events arrive).';
}

function log(event) {
  if (state.viewingSaved) newSession();
  const rec = addEvent(state.session, event);
  appendLogRow(rec);
  scheduleSave();
  return rec;
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 800);
}

async function saveNow() {
  try {
    await sessionStore.save(state.session);
    $('save-status').textContent = `Saved locally at ${new Date().toLocaleTimeString()} (${state.session.events.length} events).`;
    renderSaved();
  } catch (err) {
    $('save-status').textContent = `Local save failed: ${err?.message ?? err}`;
  }
}

async function renderSaved() {
  let list = [];
  try {
    list = await sessionStore.list();
  } catch (err) {
    $('saved').replaceChildren(el('li', {}, `IndexedDB unavailable: ${err?.message ?? err}`));
    return;
  }
  $('saved').replaceChildren(...list.map((s) => el('li', {},
    el('span', {}, `${s.name} — ${s.deviceName ?? 'no device'} — ${s.eventCount} events — ${new Date(s.updatedAt).toLocaleString()}`),
    s.id === state.session?.id ? el('em', {}, ' (current)') : [
      el('button', { type: 'button', onclick: () => loadSaved(s.id), disabled: transport.connected }, 'View'),
      el('button', { type: 'button', onclick: () => deleteSaved(s.id, s.name) }, 'Delete'),
    ],
  )));
  if (!list.length) $('saved').replaceChildren(el('li', { class: 'muted' }, 'No saved sessions.'));
}

async function loadSaved(id) {
  const s = await sessionStore.get(id);
  if (!s) return;
  state.session = s;
  state.viewingSaved = true;
  state.counters = { notifications: 0, decoded: 0, unknown: 0, invalid: 0 };
  $('session-name').value = s.name;
  $('log').tBodies[0].replaceChildren();
  $('latest').replaceChildren(el('p', { class: 'muted' }, 'Viewing a saved session.'));
  for (const e of s.events) appendLogRow(e);
  renderGatt(s.gatt, true);
  renderCounters();
  $('save-status').textContent = 'Viewing saved session (read-only). New BLE events start a new session.';
  renderSaved();
}

async function deleteSaved(id, name) {
  if (!confirm(`Delete saved session "${name}" from this browser?`)) return;
  await sessionStore.remove(id);
  renderSaved();
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileBase() {
  return state.session.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'session';
}

// ---------- log rendering ----------

function interpretation(e) {
  if (e.kind === 'packet' && e.decode) {
    const d = e.decode;
    if (d.status === 'decoded') {
      const parts = d.measurements.map((m) => `${m.label}: ${m.value}${m.unit ? ` ${m.unit}` : ''}`);
      const extra = Object.entries(d.fields)
        .filter(([k, v]) => !/Raw$/.test(k) && typeof v !== 'object')
        .map(([k, v]) => `${k}=${v}`);
      return `${d.type}${parts.length ? ` — ${parts.join(', ')}` : ''}${extra.length ? ` [${extra.join(' ')}]` : ''}`;
    }
    return `${d.status.toUpperCase()} packet (${d.reason ?? 'not understood'}) — no values decoded`;
  }
  return [e.text ? `text: "${e.text}"` : null, e.message].filter(Boolean).join(' — ');
}

function appendLogRow(e) {
  const group = e.kind === 'packet' ? 'packets' : e.kind === 'read' || e.kind === 'notification' ? 'raw' : 'status';
  const cls = e.kind === 'packet' ? `pkt-${e.decode?.status}` : e.kind === 'error' ? 'pkt-invalid' : '';
  const row = el('tr', { class: `${cls} grp-${group}` },
    el('td', {}, e.seq),
    el('td', { title: e.t }, new Date(e.t).toLocaleTimeString(undefined, { hour12: false }) + `.${String(new Date(e.t).getMilliseconds()).padStart(3, '0')}`),
    el('td', {}, e.kind),
    el('td', { title: e.characteristic ?? '' }, shortUuid(e.characteristic)),
    el('td', { class: 'hex' }, e.hex ?? ''),
    el('td', {}, interpretation(e)),
  );
  const tbody = $('log').tBodies[0];
  tbody.prepend(row);
  while (tbody.rows.length > MAX_LOG_ROWS) tbody.deleteRow(-1);
  applyLogFilter(row);
}

function applyLogFilter(row) {
  const show = { raw: $('log-raw').checked, packets: $('log-packets').checked, status: $('log-status').checked };
  const rows = row ? [row] : [...$('log').tBodies[0].rows];
  for (const r of rows) {
    const g = [...r.classList].find((c) => c.startsWith('grp-'))?.slice(4);
    r.hidden = !show[g];
  }
}

function renderCounters() {
  const c = state.counters;
  $('counters').textContent = state.viewingSaved ? '' :
    `Notifications: ${c.notifications} · decoded packets: ${c.decoded} · unknown: ${c.unknown} · invalid: ${c.invalid}`;
}

function renderLatest(rec) {
  const d = rec.decode;
  $('latest').replaceChildren(
    el('p', {}, el('strong', {}, d.type), ` at ${new Date(rec.t).toLocaleTimeString()} (frame #${rec.seq})`),
    d.measurements.length
      ? el('table', { class: 'meas' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Value'), el('th', {}, 'Reading'), el('th', {}, 'Raw'), el('th', {}, 'Basis'))),
        el('tbody', {}, d.measurements.map((m) => el('tr', {},
          el('td', {}, m.label), el('td', { class: 'big' }, `${m.value}${m.unit ? ` ${m.unit}` : ''}`),
          el('td', {}, m.raw), el('td', { class: 'muted' }, m.basis)))))
      : el('p', { class: 'muted' }, 'This packet carries no measurements.'),
    d.notes.length ? el('ul', { class: 'notes' }, d.notes.map((n) => el('li', {}, n))) : null,
  );
}

// ---------- GATT ----------

function renderGatt(tree, readOnly = false) {
  state.gattTree = tree;
  const host = $('gatt');
  if (!tree.length) {
    host.replaceChildren(el('p', { class: 'muted' }, readOnly ? 'No GATT data in this session.' : 'Connect to list services.'));
    return;
  }
  host.replaceChildren(...tree.map((svc) => el('div', { class: 'svc' },
    el('h3', {}, `Service ${labelFor(svc.uuid)}`),
    svc.error ? el('p', { class: 'bad' }, `Characteristics unavailable: ${svc.error}`) : null,
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Characteristic'), el('th', {}, 'Properties'), el('th', {}, 'Actions'))),
      el('tbody', {}, svc.characteristics.map((ch) => el('tr', {},
        el('td', { title: ch.uuid }, labelFor(ch.uuid)),
        el('td', {}, Object.entries(ch.properties).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'),
        el('td', {}, readOnly ? '—' : actionsFor(ch))))),
    ))));
}

function actionsFor(ch) {
  const out = [];
  if (ch.properties.read) out.push(el('button', { type: 'button', onclick: () => doRead(ch.key) }, 'Read'));
  if (ch.properties.notify || ch.properties.indicate) {
    const on = transport.isNotifying(ch.key);
    out.push(el('button', { type: 'button', onclick: () => toggleNotify(ch.key) }, on ? 'Stop notifications' : 'Start notifications'));
  }
  if (ch.properties.write || ch.properties.writeWithoutResponse) out.push(el('span', { class: 'muted' }, ' (write disabled)'));
  return out.length ? out : '—';
}

function findChar(key) {
  for (const s of state.gattTree) for (const c of s.characteristics) if (c.key === key) return { service: s.uuid, ...c };
  return null;
}

async function doRead(key) {
  const ch = findChar(key);
  try {
    const bytes = await transport.read(key);
    const text = isStringCharacteristic(ch.uuid) ? decodeUtf8(bytes) : null;
    let message = null;
    if (ch.uuid === SOFTWARE_REVISION && text) {
      const sw = parseSoftwareRevision(text);
      if (sw) message = `APK split: ${JSON.stringify(sw)}`;
    }
    log({ kind: 'read', service: ch.service, characteristic: ch.uuid, hex: toHex(bytes), text, message });
  } catch (err) {
    log({ kind: 'error', service: ch?.service, characteristic: ch?.uuid, message: `Read failed: ${err?.name ?? ''} ${err?.message ?? err}` });
  }
}

async function toggleNotify(key) {
  const ch = findChar(key);
  try {
    if (transport.isNotifying(key)) {
      await transport.stopNotifications(key);
      flushDecoder(key, ch);
      log({ kind: 'notify-stop', service: ch.service, characteristic: ch.uuid, message: 'Notifications stopped' });
    } else {
      await transport.startNotifications(key);
      log({ kind: 'notify-start', service: ch.service, characteristic: ch.uuid, message: 'Notifications started (CCCD enabled by the browser)' });
    }
  } catch (err) {
    log({ kind: 'error', service: ch?.service, characteristic: ch?.uuid, message: `Notify toggle failed: ${err?.name ?? ''} ${err?.message ?? err}` });
  }
  renderGatt(state.gattTree);
}

// ---------- decoding ----------

function decoderFor(key) {
  if (!state.decoders.has(key)) state.decoders.set(key, createStreamDecoder());
  return state.decoders.get(key);
}

function recordResults(results, ch, sourceSeq) {
  for (const r of results) {
    state.counters[r.status] = (state.counters[r.status] ?? 0) + 1;
    const rec = log({ kind: 'packet', service: ch.service, characteristic: ch.characteristic ?? ch.uuid, hex: r.hex, sourceSeq, decode: r });
    if (r.status === 'decoded') renderLatest(rec);
  }
  renderCounters();
}

function flushDecoder(key, ch) {
  const d = state.decoders.get(key);
  if (d && ch) recordResults(d.flush(), ch, null);
}

function onTransportEvent(ev) {
  if (ev.type === 'notification') {
    state.counters.notifications++;
    const rec = log({ kind: 'notification', service: ev.service, characteristic: ev.characteristic, hex: toHex(ev.bytes) });
    recordResults(decoderFor(ev.key).push(ev.bytes), ev, rec.seq);
  } else if (ev.type === 'disconnected') {
    for (const [key, d] of state.decoders) {
      const ch = findChar(key);
      if (ch) recordResults(d.flush(), ch, null);
    }
    state.decoders.clear();
    log({ kind: 'disconnect', message: 'GATT server disconnected' });
    setConnUi(false, 'Disconnected.');
    renderGatt(state.gattTree.length ? state.gattTree : [], true);
  }
}

// ---------- connection ----------

function setConnUi(connected, text) {
  $('btn-connect').disabled = connected || !webBluetoothSupport().hasApi;
  $('btn-disconnect').disabled = !connected;
  $('btn-reconnect').disabled = connected || !transport.device;
  $('conn-status').textContent = text;
  renderSaved();
}

function requestedServices() {
  const { uuids, invalid } = parseUuidList($('extra-services').value);
  return { services: [...new Set([...DEFAULT_OPTIONAL_SERVICES, ...uuids])], invalid };
}

async function connectFlow(selectNew) {
  const mode = document.querySelector('input[name="scan-mode"]:checked').value;
  const namePrefix = $('name-prefix').value.trim();
  const { services, invalid } = requestedServices();
  if (invalid.length) {
    $('conn-status').textContent = `Ignoring invalid UUIDs: ${invalid.join(', ')}`;
  }
  if (mode === 'name' && !namePrefix) {
    $('conn-status').textContent = 'Enter a name prefix or choose another scan mode.';
    return;
  }
  try {
    if (selectNew) {
      if (state.viewingSaved || state.session.events.length) newSession();
      $('conn-status').textContent = 'Waiting for device selection in the browser picker…';
      const dev = await transport.requestDevice({ mode, serviceUuid: SENSSUN_SERVICE, namePrefix, optionalServices: services });
      state.session.device = { id: dev.id, name: dev.name };
      log({ kind: 'status', message: `Selected device "${dev.name ?? '(no name)'}" (browser id ${dev.id}); scan mode ${mode}; requested services ${services.map(shortUuid).join(', ')}` });
    } else if (state.viewingSaved) {
      newSession();
      state.session.device = { id: transport.device.id, name: transport.device.name ?? null };
    }
    $('conn-status').textContent = 'Connecting…';
    await transport.connect();
    log({ kind: 'connect', message: 'GATT connected' });
    $('conn-status').textContent = 'Connected. Discovering services…';
    const tree = await transport.discover();
    state.session.gatt = tree.map((s) => ({ uuid: s.uuid, error: s.error, characteristics: s.characteristics.map(({ uuid, properties }) => ({ uuid, properties })) }));
    log({ kind: 'discovery', message: tree.length
      ? `Visible services: ${tree.map((s) => `${shortUuid(s.uuid)} (${s.characteristics.map((c) => shortUuid(c.uuid)).join(', ') || 'no characteristics'})`).join('; ')}`
      : 'No permitted services found. Add UUIDs from nRF Connect under "Extra services" and reconnect.' });
    renderGatt(tree);
    setConnUi(true, `Connected to ${transport.device.name ?? '(no name)'} — ${tree.length} visible service(s).`);
    if ($('auto-notify').checked) await autoStart(tree);
  } catch (err) {
    if (err?.name === 'NotFoundError' && /cancel/i.test(err.message)) {
      $('conn-status').textContent = 'No device selected.';
      return;
    }
    log({ kind: 'error', message: `Connection failed: ${err?.name ?? ''} ${err?.message ?? err}` });
    setConnUi(transport.connected, `Error: ${err?.message ?? err}`);
  }
}

async function autoStart(tree) {
  for (const s of tree) {
    if (s.uuid !== DEVICE_INFORMATION_SERVICE) continue;
    for (const c of s.characteristics) if (c.properties.read && isStringCharacteristic(c.uuid)) await doRead(c.key);
  }
  for (const s of tree) {
    for (const c of s.characteristics) {
      if (c.uuid === SENSSUN_NOTIFY && (c.properties.notify || c.properties.indicate) && !transport.isNotifying(c.key)) {
        await toggleNotify(c.key);
      }
    }
  }
}

// ---------- wiring ----------

function init() {
  newSession();
  renderEnvironment();
  renderSaved();
  $('btn-connect').addEventListener('click', () => connectFlow(true));
  $('btn-reconnect').addEventListener('click', () => connectFlow(false));
  $('btn-disconnect').addEventListener('click', () => {
    log({ kind: 'status', message: 'Disconnect requested by user' });
    transport.disconnect();
  });
  $('btn-new').addEventListener('click', () => { if (!transport.connected) newSession(); else alert('Disconnect first.'); });
  $('session-name').addEventListener('change', () => {
    state.session.name = $('session-name').value.trim() || state.session.name;
    if (state.session.events.length) scheduleSave();
  });
  $('btn-export-json').addEventListener('click', () => download(`${fileBase()}.json`, sessionToJson(state.session), 'application/json'));
  $('btn-export-csv').addEventListener('click', () => download(`${fileBase()}-events.csv`, eventsToCsv(state.session), 'text/csv'));
  $('btn-export-meas').addEventListener('click', () => download(`${fileBase()}-measurements.csv`, measurementsToCsv(state.session), 'text/csv'));
  $('btn-export-fixture').addEventListener('click', () =>
    download(`fixture-${fileBase()}.json`, JSON.stringify(sessionToFixture(state.session), null, 2), 'application/json'));
  for (const id of ['log-raw', 'log-packets', 'log-status']) $(id).addEventListener('change', () => applyLogFilter());
  navigator.bluetooth?.addEventListener?.('availabilitychanged', renderEnvironment);
}

init();
