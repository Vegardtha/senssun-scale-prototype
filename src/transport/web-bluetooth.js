// Web Bluetooth transport. Knows nothing about packet formats; it reports raw bytes.
// Phase 1 is read-only: there is deliberately no characteristic write method.

export function webBluetoothSupport() {
  const hasApi = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  return {
    hasApi,
    secureContext: typeof window !== 'undefined' && window.isSecureContext === true,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
  };
}

export async function adapterAvailability() {
  if (!webBluetoothSupport().hasApi || typeof navigator.bluetooth.getAvailability !== 'function') return null;
  try {
    return await navigator.bluetooth.getAvailability();
  } catch {
    return null;
  }
}

function propertiesOf(ch) {
  const p = ch.properties;
  return {
    broadcast: p.broadcast, read: p.read, writeWithoutResponse: p.writeWithoutResponse, write: p.write,
    notify: p.notify, indicate: p.indicate, authenticatedSignedWrites: p.authenticatedSignedWrites,
    reliableWrite: p.reliableWrite, writableAuxiliaries: p.writableAuxiliaries,
  };
}

function bytesOf(dataView) {
  return new Uint8Array(dataView.buffer.slice(dataView.byteOffset, dataView.byteOffset + dataView.byteLength));
}

/**
 * Emits plain objects through `onEvent`:
 *  {type:'disconnected'} | {type:'notification', key, service, characteristic, bytes}
 */
export class WebBluetoothTransport {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.device = null;
    this.server = null;
    this.characteristics = new Map(); // key -> { service, characteristic, handle, listener }
    this.handleDisconnect = () => {
      this.server = null;
      for (const entry of this.characteristics.values()) entry.listener = null;
      this.onEvent({ type: 'disconnected' });
    };
  }

  /**
   * Must be called from a user gesture. `mode`: 'service' filters on serviceUuid,
   * 'name' on namePrefix, 'all' shows every nearby device.
   */
  async requestDevice({ mode, serviceUuid, namePrefix, optionalServices }) {
    const options = { optionalServices };
    if (mode === 'service') options.filters = [{ services: [serviceUuid] }];
    else if (mode === 'name') options.filters = [{ namePrefix }];
    else options.acceptAllDevices = true;
    if (this.device) this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    return { id: this.device.id, name: this.device.name ?? null };
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected);
  }

  async connect() {
    if (!this.device) throw new Error('No device selected.');
    this.server = await this.device.gatt.connect();
  }

  /** Lists every primary service the browser exposes, with characteristics and properties. */
  async discover() {
    this.characteristics.clear();
    let services;
    try {
      services = await this.server.getPrimaryServices();
    } catch (err) {
      if (err?.name === 'NotFoundError') return [];
      throw err;
    }
    const tree = [];
    for (const service of services) {
      const node = { uuid: service.uuid, characteristics: [], error: null };
      try {
        const chars = await service.getCharacteristics();
        chars.forEach((ch, index) => {
          const key = `${service.uuid}|${ch.uuid}|${index}`;
          this.characteristics.set(key, { service: service.uuid, characteristic: ch.uuid, handle: ch, listener: null });
          node.characteristics.push({ key, uuid: ch.uuid, properties: propertiesOf(ch) });
        });
      } catch (err) {
        node.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
      }
      tree.push(node);
    }
    return tree;
  }

  entry(key) {
    const e = this.characteristics.get(key);
    if (!e) throw new Error(`Unknown characteristic ${key}`);
    return e;
  }

  async read(key) {
    const e = this.entry(key);
    if (!e.handle.properties.read) throw new Error('Characteristic is not readable.');
    return bytesOf(await e.handle.readValue());
  }

  async startNotifications(key) {
    const e = this.entry(key);
    const p = e.handle.properties;
    if (!p.notify && !p.indicate) throw new Error('Characteristic does not support notify/indicate.');
    if (!e.listener) {
      e.listener = (ev) => this.onEvent({
        type: 'notification', key, service: e.service, characteristic: e.characteristic,
        bytes: bytesOf(ev.target.value),
      });
      e.handle.addEventListener('characteristicvaluechanged', e.listener);
    }
    await e.handle.startNotifications();
  }

  async stopNotifications(key) {
    const e = this.entry(key);
    if (e.listener) {
      e.handle.removeEventListener('characteristicvaluechanged', e.listener);
      e.listener = null;
    }
    if (this.connected) await e.handle.stopNotifications();
  }

  isNotifying(key) {
    return Boolean(this.characteristics.get(key)?.listener);
  }

  disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}
