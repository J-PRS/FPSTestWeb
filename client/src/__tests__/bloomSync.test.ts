import { describe, it, expect } from 'vitest';
import { solveBloomSeq } from '../game/combat/bloomSync.js';
import { jitter01, coneDir, getWeaponStats, bloomGrow, WeaponType } from '../../../shared/weapons.js';
import { idSeed } from '../../../shared/weaponTable.js';

const TAU = Math.PI * 2;
const PID = 'player_test';
const WT = WeaponType.Chaingun;
const BASE = { x: 0.6, y: 0.1, z: 0.79 }; // roughly normalized aim
const norm = (v: typeof BASE): typeof BASE => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const base = norm(BASE);

/** What the server does with a claim at counter `seq` and pre-grow
 *  bloom `bloom`: draws the seeded cone at spreadBase + bloom. */
function serverDraw(seq: number, bloom: number): { dir: typeof base } {
  const st = getWeaponStats(WT);
  const radius = (st.spreadBase ?? 0) + bloom;
  const [u1, u2] = jitter01(idSeed(PID) ^ seq);
  return { dir: coneDir(base, u1 * TAU, Math.sqrt(u2) * radius) };
}

describe('solveBloomSeq', () => {
  it('returns the same seq when counters agree', () => {
    const bloom = 0.03;
    const { dir } = serverDraw(17, bloom);
    const s = solveBloomSeq({ playerId: PID, weaponType: WT, baseDir: base, serverDir: dir, guessSeq: 17 });
    expect(s).not.toBeNull();
    expect(s!.seq).toBe(17);
    // Post-claim server bloom = bloomGrow(decayed); decayed == our bloom.
    expect(s!.bloom).toBeCloseTo(bloomGrow(bloom, WT), 3);
  });

  it('finds the server seq when the client ran ahead (dropped claims)', () => {
    const { dir } = serverDraw(17, 0.02);
    const s = solveBloomSeq({ playerId: PID, weaponType: WT, baseDir: base, serverDir: dir, guessSeq: 23 });
    expect(s).not.toBeNull();
    expect(s!.seq).toBe(17);
    expect(s!.angleDeg).toBeLessThan(1);
  });

  it('finds the server seq when the client ran behind (HMR counter reset)', () => {
    const { dir } = serverDraw(41, 0.05);
    const s = solveBloomSeq({ playerId: PID, weaponType: WT, baseDir: base, serverDir: dir, guessSeq: 0 });
    expect(s).not.toBeNull();
    expect(s!.seq).toBe(41);
  });

  it('recovers the server bloom magnitude too', () => {
    const { dir } = serverDraw(9, 0.08);
    const s = solveBloomSeq({ playerId: PID, weaponType: WT, baseDir: base, serverDir: dir, guessSeq: 9 });
    expect(s).not.toBeNull();
    // radius = spreadBase + bloom → implied bloom ≈ 0.08, post-grow after.
    expect(s!.bloom).toBeCloseTo(bloomGrow(0.08, WT), 2);
  });

  it('refuses a dir no seed explains (wrong claim dir, not a skew)', () => {
    const bogus = norm({ x: -0.9, y: 0.3, z: -0.2 }); // ~off-cone entirely
    const s = solveBloomSeq({ playerId: PID, weaponType: WT, baseDir: base, serverDir: bogus, guessSeq: 5 });
    expect(s).toBeNull();
  });
});
