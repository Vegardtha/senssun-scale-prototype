// Transport-independent decoding pipeline: raw notification bytes in, packet results out.

import { FrameAssembler, decodeFrame } from './senssun-legacy.js';
import { toHex } from './bytes.js';

export { decodeFrame } from './senssun-legacy.js';

function unknownBytes(bytes, reason) {
  return {
    status: 'unknown',
    protocol: null,
    hex: toHex(bytes),
    reason,
    type: null,
    fields: {},
    measurements: [],
    notes: ['Bytes did not form a recognised legacy Senssun frame. Nothing was decoded.'],
  };
}

/**
 * Stateful decoder for one notification stream (one characteristic).
 * push(bytes) returns zero or more results; bytes are never dropped silently.
 */
export function createStreamDecoder() {
  const assembler = new FrameAssembler();
  const handle = (items) =>
    items.map((item) => (item.kind === 'frame' ? decodeFrame(item.bytes) : unknownBytes(item.bytes, item.reason)));
  return {
    push: (bytes) => handle(assembler.push(Uint8Array.from(bytes))),
    flush: () => handle(assembler.flush()),
    reset: () => assembler.reset(),
  };
}
