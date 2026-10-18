import { describe, test, expect } from 'bun:test';
import { roleObjective, wantKOut, ROLE_PRIORITY, type FlagSituation } from '../../shared/flagGoals.ts';

const V = (x: number, y: number, z: number) => ({ x, y, z });
const HOME = V(0, 0, 0);
const ENEMY = V(100, 0, 100);
const THIEF = V(30, 0, 30);
const DROPPED = V(10, 0, 10);
const DROPPED_FAR = V(200, 0, 200);
const ESCORT = V(50, 0, 50);

function sit(o: Partial<FlagSituation> = {}): FlagSituation {
  return { home: HOME, thief: null, dropped: null, enemyStand: ENEMY, escort: null, threat: null, ...o };
}

describe('roleObjective', () => {
  test('hof never leaves the stand for a thief', () => {
    // That's what light defense is for — a HoF chasing = open base.
    expect(roleObjective('hof', sit({ thief: THIEF }))).toBe(HOME);
  });
  test('hof picks up a dropped flag only in easy reach', () => {
    expect(roleObjective('hof', sit({ dropped: DROPPED }))).toBe(DROPPED);
    expect(roleObjective('hof', sit({ dropped: DROPPED_FAR }))).toBe(HOME);
  });
  test('defense roles chase thief > dropped > hold home', () => {
    for (const role of ['ldefense', 'technician', 'defense']) {
      expect(roleObjective(role, sit({ thief: THIEF, dropped: DROPPED }))).toBe(THIEF);
      expect(roleObjective(role, sit({ dropped: DROPPED }))).toBe(DROPPED);
    }
  });
  test('idle defense roles spread to stations, not a pole-stack', () => {
    expect(roleObjective('technician', sit())).toBe(HOME);
    const ld = roleObjective('ldefense', sit());
    const def = roleObjective('defense', sit(), 1, 1);
    const defMirror = roleObjective('defense', sit(), 1, -1);
    for (const p of [ld, def, defMirror]) {expect(p).not.toEqual(HOME);}
    expect(Math.hypot(ld.x, ld.z)).toBeGreaterThan(Math.hypot(def.x, def.z)); // LD screens the lane out
    expect(def.x).not.toBe(defMirror.x); // opposite flanks
  });
  test('capper escorts a carrier first, else presses the stand', () => {
    expect(roleObjective('capper', sit({ escort: ESCORT, enemyStand: ENEMY }))).toBe(ESCORT);
    expect(roleObjective('capper', sit())).toBe(ENEMY);
    // Stand not grabbable (already carried by teammate w/o escort pos) → home.
    expect(roleObjective('capper', sit({ enemyStand: null }))).toBe(HOME);
  });
  test('infiltrator presses the stand even with a thief loose', () => {
    expect(roleObjective('infiltrator', sit({ thief: THIEF }))).toBe(ENEMY);
    expect(roleObjective('infiltrator', sit({ escort: ESCORT }))).toBe(ESCORT);
  });
  test('sniper hunts the capper, else holds an approach perch', () => {
    expect(roleObjective('sniper', sit({ thief: THIEF }))).toBe(THIEF);
    expect(roleObjective('sniper', sit({ dropped: DROPPED }))).toBe(DROPPED);
    expect(roleObjective('sniper', sit({ escort: ESCORT }))).toBe(ESCORT);
    // Idle: a perch ~75m toward the enemy stand, off the home pole —
    // covering the approach lane without standing on the flag itself.
    const perch = roleObjective('sniper', sit(), 1, 1);
    const d = Math.hypot(perch.x - HOME.x, perch.z - HOME.z);
    expect(d).toBeGreaterThan(40);
    expect(d).toBeLessThan(90);
    // Mirrored side: the two perch slots don't stack one sightline.
    const mirror = roleObjective('sniper', sit(), 1, -1);
    expect(mirror.x).not.toBe(perch.x);
  });
  test('called deny: attackers turn for the enemy flag over the thief', () => {
    const deny = sit({ thief: THIEF, deny: ENEMY });
    // The thief is at our lip — a kill isn't guaranteed, taking THEIR
    // flag is. Attackers fold to the grab; defenders keep the chase.
    expect(roleObjective('offense', deny)).toBe(ENEMY);
    expect(roleObjective('infiltrator', deny)).toBe(ENEMY);
    expect(roleObjective('ldefense', deny)).toBe(THIEF);
    expect(roleObjective('hof', deny)).toBe(HOME);
  });
  test('sweaty defender leads the thief; a pub bot chases the wake', () => {
    // Carrier running flat-out east at 40 m/s, defender 100m behind:
    // a normal bot aims at the beacon, the sweatlord cuts the corner.
    const runner = { x: 30, y: 0, z: 30, vx: 40, vz: 0 };
    const pub = roleObjective('ldefense', sit({ thief: runner, me: { x: 0, z: 0 } }));
    const sweat = roleObjective('ldefense', sit({ thief: runner, me: { x: 0, z: 0 }, sweat: 0.9 }));
    expect(pub.x).toBe(30);
    expect(sweat.x).toBeGreaterThan(30); // led ahead of the run line
    expect(sweat.x).toBeLessThanOrEqual(30 + 40 * 2.5); // capped lead
  });
  test('K-out: sweaty + stranded + the goal near base wins', () => {
    // 200m from home with both flags home and nothing to do — the
    // corpse is a free teleport to the wave/post. Any role, but only
    // the sweaty press it: the pub bot jogs back like everyone else.
    const stranded = sit({ me: { x: 200, z: 0 }, sweat: 0.9 });
    for (const r of ['offense', 'capper', 'infiltrator', 'hof', 'ldefense', 'sniper']) {
      expect(wantKOut(r, stranded)).toBe(true);
    }
    expect(wantKOut('offense', sit({ me: { x: 200, z: 0 } }))).toBe(false);
    // Live flag work out here vetoes it — a flag in play means the
    // valuable goal is HERE, not at the respawn.
    expect(wantKOut('offense', sit({ ...stranded, thief: THIEF }))).toBe(false);
    expect(wantKOut('offense', sit({ ...stranded, dropped: DROPPED }))).toBe(false);
    expect(wantKOut('offense', sit({ ...stranded, push: ENEMY }))).toBe(false);
    expect(wantKOut('offense', sit({ ...stranded, escort: ESCORT }))).toBe(false);
    // Deny splits by post: a stranded defender teleports home to meet
    // the thief, a stranded attacker skis to the counter-grab.
    const deny = sit({ ...stranded, deny: ENEMY });
    expect(wantKOut('hof', deny)).toBe(true);
    expect(wantKOut('defense', deny)).toBe(true);
    expect(wantKOut('offense', deny)).toBe(false);
    expect(wantKOut('capper', deny)).toBe(false);
    // Near home the jog is cheaper than the corpse.
    expect(wantKOut('offense', sit({ me: { x: 40, z: 0 }, sweat: 0.9 }))).toBe(false);
  });
  test('offense punishes a thief before pressing', () => {
    expect(roleObjective('offense', sit({ thief: THIEF }))).toBe(THIEF);
    expect(roleObjective('offense', sit({ dropped: DROPPED }))).toBe(DROPPED);
    expect(roleObjective('offense', sit())).toBe(ENEMY);
  });
  test('unknown roles fall back to offense policy', () => {
    expect(roleObjective('whatever', sit({ thief: THIEF }))).toBe(THIEF);
    expect(roleObjective('whatever', sit())).toBe(ENEMY);
  });
});

describe('ROLE_PRIORITY', () => {
  test('core roles unlock before luxury ones as squads grow', () => {
    const mins = ROLE_PRIORITY.map(r => r.minSquad);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    expect(ROLE_PRIORITY[0]!.role).toBe('capper'); // the flag route is the job
  });
});
