import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolveMapSpec } from '../../../shared/mapSpec.ts';
import { MODES } from '../../../shared/teams.ts';
import { mkRoom, step } from './harness.ts';

// Mode coverage gate: every (map, mode) pair a map advertises must build
// a room whose modeSpec resolves and whose objective wiring matches the
// spec — a mode name in modes[] with no MODES/rules entry is exactly the
// "rabbit doesn't work" class of bug this file exists to catch.

interface RawMap { name?: string; mode?: string; modes?: string[] }

const MAPS_DIR = `${import.meta.dir}/../../../maps`;
const entries: { map: string; mode: string }[] = [];
for (const file of readdirSync(MAPS_DIR).filter((f) => f.endsWith('.json'))) {
  const raw = JSON.parse(readFileSync(`${MAPS_DIR}/${file}`, 'utf8')) as RawMap;
  const modes = raw.modes?.length ? raw.modes : (raw.mode ? [raw.mode] : []);
  for (const mode of modes) entries.push({ map: file.replace(/\.json$/, ''), mode });
}

describe('every advertised (map, mode) pair is a real mode', () => {
  for (const { map, mode } of entries) {
    it(`${map} + ${mode}`, () => {
      expect(MODES[mode as keyof typeof MODES], `${mode} missing from MODES`).toBeTruthy();
      const spec = resolveMapSpec(JSON.parse(readFileSync(`${MAPS_DIR}/${map}.json`, 'utf8')));
      const room = mkRoom({ ...spec, mode }, mode);
      expect(room.modeSpec?.label).toBeTruthy();
      if (room.modeSpec!.flags) {
        // Flag modes must actually have flag state — rabbit = one
        // neutral flag, CTF = two. Not just a modes[] string.
        expect(room.flags).not.toBeNull();
        expect(room.flags!.flags.size).toBe(mode === 'rabbit' ? 1 : 2);
      }
      step(room, 10); // ticks must not throw
    });
  }
});
