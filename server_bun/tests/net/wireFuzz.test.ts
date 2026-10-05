/**
 * Ingress fuzz — adversarial/malformed frames must REJECT, never crash.
 * validateMessage is the choke point every socket frame passes through;
 * a throw here is a room-killing unhandled exception. Seeded mutations
 * over every known wire type: null/undefined fields, wrong types, NaN
 * (arrives as JSON null), strings where vecs go, deep garbage, arrays.
 */

import { test, expect } from 'bun:test';
import { validateMessage } from '../../src/wire.ts';
import type { ClientMessage } from '../../src/types.ts';
import { mulberry } from './chaos.ts';

// One valid specimen per type — mutations target its fields.
const SPECIMENS: Record<string, Record<string, unknown>> = {
  position: { type: 'position', position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, seq: 4, inputSeq: 3 },
  teleport: { type: 'teleport', position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } },
  shot: { type: 'shot', targetId: 'p2', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, weaponType: 0 },
  aoeShot: { type: 'aoeShot', position: { x: 0, y: 0, z: 0 }, weaponType: 1, excludeTargetId: null },
  inputMove: { type: 'inputMove', seq: 1, input: { forward: 1, right: 0, jump: 0, ski: 0, jet: 0 } },
};

const JUNK: unknown[] = [
  null, undefined, NaN, Infinity, -Infinity,
  'x', '', 'a'.repeat(10000), {}, [], [1, 2, 3], { x: 1 },
  true, false, 0, -1, 1e308, -1e308, 0x7fffffff,
  { x: NaN, y: 0, z: 0 }, { x: null, y: null, z: null },
  { yaw: 'north', pitch: [] },
];

test('every wire type rejects garbage without throwing', () => {
  const rng = mulberry(1234);
  let accepted = 0, rejected = 0;
  const cases: { type: string; obj: Record<string, unknown> }[] = [];

  for (const [type, specimen] of Object.entries(SPECIMENS)) {
    for (let i = 0; i < 400; i++) {
      const obj = JSON.parse(JSON.stringify(specimen)) as Record<string, unknown>;
      const keys = Object.keys(obj);
      const muts = 1 + Math.floor(rng() * 3);
      for (let m = 0; m < muts; m++) {
        const k = keys[Math.floor(rng() * keys.length)]!;
        const junk = JUNK[Math.floor(rng() * JUNK.length)];
        if (rng() < 0.2) delete obj[k]; else obj[k] = junk === undefined ? null : junk;
      }
      cases.push({ type, obj });
    }
  }

  for (const c of cases) {
    const res = validateMessage(c.obj);
    if (res.success) accepted++; else rejected++;
    if (res.success) expect(res.data.type as string).toBe(c.obj.type);
  }
  // Fuzz should mostly reject — a >90% accept rate means a validator is
  // too permissive to matter.
  expect(rejected / cases.length).toBeGreaterThan(0.5);
  expect(accepted).toBeLessThan(cases.length * 0.5);
});

test('non-object and unknown frames reject cleanly', () => {
  for (const raw of [null, undefined, 42, 'msg', [], [1, 2], true, NaN]) {
    const res = validateMessage(raw);
    expect(res.success).toBe(false);
  }
  for (const type of ['', 'position;', '__proto__', 'POSITION', 'eval', 'chat']) {
    const res = validateMessage({ type });
    expect(res.success).toBe(false);
  }
});

test('validated messages hold their shape — no smuggled fields survive', () => {
  const res = validateMessage(SPECIMENS.position!);
  expect(res.success).toBe(true);
  if (res.success) {
    const m = res.data as Extract<ClientMessage, { type: 'position' }>;
    expect(m.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(typeof m.seq).toBe('number');
  }
  // aoeShot position is REQUIRED — dropping it must fail.
  const noPos = { ...SPECIMENS.aoeShot! };
  delete noPos.position;
  expect(validateMessage(noPos).success).toBe(false);
  // Numbers-as-strings must not coerce through.
  const strPos = JSON.parse(JSON.stringify(SPECIMENS.position!)) as Record<string, unknown>;
  (strPos.position as Record<string, unknown>).x = '5';
  expect(validateMessage(strPos).success).toBe(false);
});
