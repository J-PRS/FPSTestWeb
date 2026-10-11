import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { ThreatTable, PROFILES, type TargetCandidate } from '../game/targeting.js';

const cand = (id: string, x: number, alive = true): TargetCandidate =>
  ({ id, pos: new THREE.Vector3(x, 0, 0), vel: new THREE.Vector3(), alive });

const self = new THREE.Vector3();
// eval ticks jitter on Math.random — pump enough sim time to guarantee one.
const evalNow = (t: ThreatTable, cands: TargetCandidate[]) => {
  let out: TargetCandidate | null = null;
  for (let i = 0; i < 20 && !out; i += 1) {out = t.update(0.5, self, cands, PROFILES.hunter);}
  return out;
};

describe('ThreatTable', () => {
  it('picks the closest live candidate', () => {
    const t = new ThreatTable();
    const near = cand('near', 10), far = cand('far', 100);
    expect(evalNow(t, [far, near])).toBe(near);
  });

  it('damage threat pulls aggro over distance', () => {
    const t = new ThreatTable();
    const near = cand('near', 15), far = cand('far', 60);
    t.reportDamage('far', 500);
    expect(evalNow(t, [near, far])).toBe(far);
  });

  it('sticky hysteresis resists ping-pong between equal candidates', () => {
    const t = new ThreatTable();
    const a = cand('a', 10), b = cand('b', 12);
    // Commit to a first.
    expect(evalNow(t, [a, b])).toBe(a);
    // Swap distances: b is now marginally closer — incumbent should hold.
    a.pos.x = 12; b.pos.x = 10;
    expect(evalNow(t, [a, b])).toBe(a);
    // Distance NEVER flips a hunter: sticky (1.35) > max wDist (1.0), so the
    // incumbent's bonus outscores any distance advantage by construction.
    a.pos.x = 290; // still inside leash
    expect(evalNow(t, [a, b])).toBe(a);
    // Pinned current tuning: for hunter, challenger max (wDist+wDmg = 1.5)
    // < incumbent min (wDist+sticky = 2.35) at equal distance, so damage
    // aggro can NEVER flip the commit — only death/leash/forget can.
    // (flyer is the one profile where 1.0+0.8 > 1.4 barely can.)
    a.pos.x = 10; b.pos.x = 10;
    t.reportDamage('b', 500);
    expect(evalNow(t, [a, b])).toBe(a);
    a.alive = false;
    expect(evalNow(t, [a, b])).toBe(b);
  });

  it('dead target drops instantly (no stalking); leashed-out keeps stalking', () => {
    const t = new ThreatTable();
    const a = cand('a', 10);
    evalNow(t, [a]);
    expect(t.target).toBe(a);
    a.alive = false;
    t.update(0.1, self, [a], PROFILES.hunter);
    expect(t.target).toBeNull();
    expect(t.stalking).toBe(false);
    // Leash-out while alive → stalk toward last-seen.
    const b = cand('b', 10);
    evalNow(t, [b]);
    b.pos.x = 5000; // beyond hunter leash 300
    t.update(0.1, self, [b], PROFILES.hunter);
    expect(t.target).toBeNull();
    expect(t.stalking).toBe(true);
  });

  it('lastSeen snapshots only on eval ticks — pursuit chases where you were', () => {
    const t = new ThreatTable();
    const a = cand('a', 10);
    evalNow(t, [a]);
    const seen = t.lastSeen.x;
    a.pos.x = 40; // target moves but no eval has run yet
    t.update(0.01, self, [a], PROFILES.hunter);
    expect(t.lastSeen.x).toBe(seen);
  });

  it('forget drops threat and a held target', () => {
    const t = new ThreatTable();
    const a = cand('a', 10);
    evalNow(t, [a]);
    expect(t.target).toBe(a);
    t.forget('a');
    expect(t.target).toBeNull();
    expect(evalNow(t, [])).toBeNull();
  });

  it('threat decays — old damage stops mattering', () => {
    const t = new ThreatTable();
    t.reportDamage('a', 100);
    const a = cand('a', 60), near = cand('near', 10);
    // ~20s of decay: hunter profile erases a single hit from the table.
    for (let i = 0; i < 80; i += 1) {t.update(0.5, self, [a, near], PROFILES.hunter);}
    // With threat decayed the near candidate wins again.
    expect(evalNow(t, [a, near])).toBe(near);
  });
});
