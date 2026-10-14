import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamDecoder } from '../src/protocol/index.js';
import { fromHex } from '../src/protocol/bytes.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const TOLERANCE = 1e-4;

function listJson(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return listJson(p);
    return name.endsWith('.json') ? [p] : [];
  });
}

function assertSubset(actual, expected, path) {
  for (const [k, v] of Object.entries(expected)) {
    const a = actual?.[k];
    if (typeof v === 'number' && typeof a === 'number') {
      assert.ok(Math.abs(a - v) < TOLERANCE, `${path}.${k}: expected ${v}, got ${a}`);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      assertSubset(a, v, `${path}.${k}`);
    } else {
      assert.deepEqual(a, v, `${path}.${k}`);
    }
  }
}

function runCase(c) {
  const decoder = createStreamDecoder();
  return [...c.notifications.flatMap((hex) => decoder.push(fromHex(hex))), ...decoder.flush()];
}

for (const file of listJson(FIXTURE_DIR)) {
  const fixture = JSON.parse(readFileSync(file, 'utf8'));
  const label = relative(FIXTURE_DIR, file);

  for (const c of fixture.cases ?? []) {
    test(`${label} :: ${c.name}`, () => {
      const results = runCase(c);

      for (const r of results) {
        if (r.status !== 'decoded') {
          assert.equal(r.measurements.length, 0, 'non-decoded results must not carry measurements');
        }
      }
      if (!c.expected) return; // captured but not yet annotated

      assert.equal(results.length, c.expected.length, 'result count');
      c.expected.forEach((exp, i) => {
        const r = results[i];
        const where = `result[${i}]`;
        assert.equal(r.status, exp.status, `${where}.status (reason: ${r.reason})`);
        if ('reason' in exp) assert.equal(r.reason, exp.reason, `${where}.reason`);
        if ('type' in exp) assert.equal(r.type, exp.type, `${where}.type`);
        if (exp.fields) assertSubset(r.fields, exp.fields, `${where}.fields`);
        if (exp.frame) assertSubset(r.frame, exp.frame, `${where}.frame`);
        if (exp.measurements) {
          const got = Object.fromEntries(r.measurements.map((m) => [m.key, m.value]));
          assert.deepEqual(Object.keys(got).sort(), Object.keys(exp.measurements).sort(), `${where} measurement keys`);
          assertSubset(got, exp.measurements, `${where}.measurements`);
        }
      });
    });
  }
}
