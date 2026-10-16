import { describe, it, expect } from 'bun:test';
import { ordnanceAimY } from '../src/botArsenal.ts';
import { weaponStats } from '../src/weaponStats.ts';
import { WeaponType } from '../../shared/weapons.ts';

/** Ordnance aim is a decision about where the blast can reach, not where
 *  the body is. The EV argmax replaces a hard airborne cutoff — grounded
 *  targets get the dirt under them, airborne targets get the risky
 *  direct shot because the ground can't splash them. */
describe('ordnanceAimY — EV ordnance aim', () => {
  it('fires the dirt under a grounded target', () => {
    // RL at 40m: direct odds are thin at this flight time, ground splash
    // is nearly guaranteed — the argmax picks the ground point.
    const aim = { x: 0, y: 11, z: 0 };
    expect(ordnanceAimY(aim, 10, 40, WeaponType.RocketLauncher)).toBe(10.5);
  });
  it('takes the risky direct when the target is airborne', () => {
    // 20m above the ground: the blast can't reach — no point aiming at
    // dirt, so the shot stays on the body.
    const aim = { x: 0, y: 30, z: 0 };
    expect(ordnanceAimY(aim, 10, 40, WeaponType.RocketLauncher)).toBe(30);
  });
  it('a lifted-but-reachable target still eats the ground shot', () => {
    // 4m off the deck vs a 14m blast: the envelope reaches, and at 40m
    // the direct odds are too thin to justify the body shot.
    const aim = { x: 0, y: 14, z: 0 };
    expect(ordnanceAimY(aim, 10, 40, WeaponType.RocketLauncher)).toBe(10.5);
  });
  it('a huge blast still reaches a target 10m up', () => {
    // Mortar: 18m envelope — 10m of lift stays inside the radius edge
    // where the ground shot pays more than the thin direct.
    const aim = { x: 0, y: 20, z: 0 };
    expect(ordnanceAimY(aim, 10, 40, WeaponType.Mortar)).toBe(10.5);
  });
});

/** conn counts trigger pulls that tagged at least one victim — a flak
 *  fan is 1 conn of ~8 hits, not 8 conn. Deduped on the pull nonce. */
describe('weaponStats conn — pull-level connects', () => {
  it('pellets of one pull count once; separate pulls count each', () => {
    const w = weaponStats as unknown as { table: Record<string, Record<string, { conn: number; hits: number }>> };
    weaponStats.record('test-conn', 'w-testfan', 10, false, true, 30, 'pull-1');
    weaponStats.record('test-conn', 'w-testfan', 10, false, true, 30, 'pull-1');
    weaponStats.record('test-conn', 'w-testfan', 10, false, true, 30, 'pull-1');
    weaponStats.record('test-conn', 'w-testfan', 10, false, true, 30, 'pull-2');
    const r = w.table['test-conn']!['w-testfan']!;
    expect(r.hits).toBe(4);
    expect(r.conn).toBe(2);
  });
  it('hits without a pull identity count per-hit', () => {
    const w = weaponStats as unknown as { table: Record<string, Record<string, { conn: number; hits: number }>> };
    weaponStats.record('test-conn2', 'w-testbeam', 5, false, true, 20);
    weaponStats.record('test-conn2', 'w-testbeam', 5, false, true, 20);
    const r = w.table['test-conn2']!['w-testbeam']!;
    expect(r.hits).toBe(2);
    expect(r.conn).toBe(2);
  });
});
