import { describe, it, expect } from 'bun:test';
import { SPECIES, speciesFamily, type SpeciesFamily } from '../../shared/species.ts';
import { SPECIES_FAMILY } from '../../shared/creatureSim.ts';

// SPECIES is the creature registry — a data row both ends resolve by
// name from the wire. A row pointing at a family with no sim means the
// creature spawns and then never steps; a missing stat silently reads
// as zero health or zero damage. Pin the table's contract.

const FAMILIES: SpeciesFamily[] = ['hop', 'fly', 'roll', 'slither', 'baneling', 'totem'];

describe('species', () => {
  it('every row references a real family sim — SPECIES_FAMILY covers the union', () => {
    for (const f of FAMILIES) {
      expect(SPECIES_FAMILY[f], `family ${f} has no sim`).toBeDefined();
    }
    for (const [name, row] of Object.entries(SPECIES)) {
      expect(FAMILIES, `${name}.family`).toContain(row.family);
      expect(SPECIES_FAMILY[row.family], `${name} family sim missing`).toBeDefined();
    }
  });

  it('every row has positive health and bite — a zero stat is a ghost or a pillow', () => {
    for (const [name, row] of Object.entries(SPECIES)) {
      expect(row.health, name).toBeGreaterThan(0);
      expect(row.bite, name).toBeGreaterThan(0);
      if (row.speed !== undefined) expect(row.speed, name).toBeGreaterThan(0);
      if (row.aggro !== undefined) expect(row.aggro, name).toBeGreaterThan(0);
      if (row.pounceD !== undefined) expect(row.pounceD, name).toBeGreaterThan(0);
      if (row.orbitR !== undefined) expect(row.orbitR, name).toBeGreaterThan(0);
      if (row.orbitAlt !== undefined) expect(row.orbitAlt, name).toBeGreaterThan(0);
    }
  });

  it('baneling-family rows carry a blast radius — the suicide pop is the family', () => {
    for (const [name, row] of Object.entries(SPECIES)) {
      if (row.family === 'baneling') {
        expect(row.blast, name).toBeGreaterThan(0);
      } else {
        // blast outside baneling is dead data — flag it so the field
        // stays meaning-only-where-it-acts.
        expect(row.blast, name).toBeUndefined();
      }
    }
  });

  it('totem rows are sessile — no speed override', () => {
    for (const [name, row] of Object.entries(SPECIES)) {
      if (row.family === 'totem') expect(row.speed, name).toBeUndefined();
    }
  });

  it('flyer rows can carry orbit params only on the fly family', () => {
    for (const [name, row] of Object.entries(SPECIES)) {
      if (row.family !== 'fly') {
        expect(row.orbitR, name).toBeUndefined();
        expect(row.orbitAlt, name).toBeUndefined();
      }
    }
  });

  it('unknown species names ride the hop fallback — same default as always', () => {
    expect(speciesFamily('crawler')).toBe('hop');
    expect(speciesFamily('baneling')).toBe('baneling');
    expect(speciesFamily('goblin')).toBe('hop');
    expect(speciesFamily('')).toBe('hop');
    expect(speciesFamily('CRAWLER')).toBe('hop'); // names are case-sensitive
  });
});
