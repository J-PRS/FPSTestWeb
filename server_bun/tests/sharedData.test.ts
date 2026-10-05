import { describe, it, expect } from 'bun:test';
import { TREE, type VgsNode } from '../../shared/vgsTree.ts';
import { DEPLOY_ITEMS } from '../../shared/deployItems.ts';
import { SPECIES, speciesFamily } from '../../shared/species.ts';

// Shipped-data tripwires — the wire registries both ends resolve by
// name/chord. A malformed row (empty line, negative cap, missing blast)
// fails silently at runtime: a VGS chord that emits '', a plantable
// item with no cost, a baneling that can't detonate.

const FAMILIES = new Set(['hop', 'fly', 'roll', 'slither', 'baneling', 'totem']);

describe('vgsTree', () => {
  /** Walk the chord tree; `global` = inside the VG all-chat family. */
  function walk(node: Record<string, VgsNode>, global: boolean, errs: string[], path: string) {
    for (const [key, n] of Object.entries(node)) {
      const at = path + key;
      if (!n.label) errs.push(`${at}: empty label`);
      if ('line' in n) {
        if (!n.line) errs.push(`${at}: empty line`);
        // say() marks all-chat lines team:false — canon keeps them in VG only
        if (n.team === false && !global) errs.push(`${at}: team:false outside VG`);
      } else {
        if (Object.keys(n.children).length === 0) errs.push(`${at}: empty category`);
        walk(n.children, global, errs, at);
      }
    }
  }

  it('every chord resolves to a labelled, non-empty line or category — all-chat lines stay in VG', () => {
    const errs: string[] = [];
    for (const [key, n] of Object.entries(TREE)) {
      walk({ [key]: n }, key === 'G', errs, '');
    }
    expect(errs).toEqual([]);
  });
});

describe('DEPLOY_ITEMS', () => {
  it('every def has a label and sane base numbers', () => {
    for (const [kind, d] of Object.entries(DEPLOY_ITEMS)) {
      expect(d.label.length, `${kind} label`).toBeGreaterThan(0);
      expect(Number.isInteger(d.cap) && d.cap >= 0, `${kind} cap`).toBe(true);
      expect(d.hp, `${kind} hp`).toBeGreaterThan(0);
      expect(d.ttlS, `${kind} ttlS`).toBeGreaterThanOrEqual(0);
      expect(d.cost, `${kind} cost`).toBeGreaterThanOrEqual(0);
    }
  });

  it('plantable items cost belt charges; authored-only items cost nothing', () => {
    for (const [kind, d] of Object.entries(DEPLOY_ITEMS)) {
      if (d.cap > 0) expect(d.cost, `${kind} free plant`).toBeGreaterThan(0);
      else expect(d.cost, `${kind} authored cost`).toBe(0);
    }
  });

  it('every present optional field is positive — zero disables, never a stat', () => {
    for (const [kind, d] of Object.entries(DEPLOY_ITEMS)) {
      for (const [k, v] of Object.entries(d)) {
        if (['label', 'cap', 'hp', 'ttlS', 'cost'].includes(k)) continue;
        expect(typeof v === 'number' && v > 0, `${kind}.${k} = ${v}`).toBe(true);
      }
    }
  });
});

describe('SPECIES', () => {
  it('every row rides a real family with positive combat stats', () => {
    for (const [name, r] of Object.entries(SPECIES)) {
      expect(FAMILIES.has(r.family), `${name} family ${r.family}`).toBe(true);
      expect(r.health, `${name} health`).toBeGreaterThan(0);
      expect(r.bite, `${name} bite`).toBeGreaterThan(0);
    }
  });

  it('a baneling without a blast radius is a melee bot that forgot to explode', () => {
    for (const [name, r] of Object.entries(SPECIES)) {
      if (r.family === 'baneling') expect(r.blast, `${name} blast`).toBeGreaterThan(0);
    }
  });

  it('speciesFamily resolves wire names — unknown species ride hop, never throw', () => {
    expect(speciesFamily('crawler')).toBe('hop');
    expect(speciesFamily('baneling')).toBe('baneling');
    expect(speciesFamily('not-a-creature')).toBe('hop');
  });
});
