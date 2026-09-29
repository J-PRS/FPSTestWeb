import { describe, it, expect } from 'bun:test';
import { CreatureSim } from '../src/CreatureSim.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { makeSimCrawler, makeSimFlyer, stepFlyer, commitTarget, isFlyerSpecies, makeSimRoller, stepRoller, isRollerSpecies, makeSimSlither, stepSlither, isSlitherSpecies, applySlitherDamage, makeSimBaneling, stepBaneling, isBanelingSpecies, MELEE_SPECIES, FLYER_SPECIES } from '../../shared/creatureSim.ts';
import type { SimCrawler, SimFlyer, SimRoller, SimSlither, SimBaneling } from '../../shared/creatureSim.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { ServerMessage } from '../src/types.ts';

// Private surface the tests poke at — the harness for edge-fanout
// behavior needs to drive one crawler, not a whole room tick.
type SimPrivate = {
  crawlers: Map<number, SimCrawler>;
  edge(c: SimCrawler, kind: 'retarget' | 'windup' | 'pounce' | 'bite'): void;
};

function makeRoom(): { sim: CreatureSim; sent: { pid: string; kind?: string }[]; bcast: ServerMessage[] } {
  const sent: { pid: string; kind?: string }[] = [];
  const bcast: ServerMessage[] = [];
  const pm = new PlayerManager();
  const sim = new CreatureSim(pm, (m) => { bcast.push(m); },
    (pid, m) => { sent.push({ pid, kind: (m as { kind?: string }).kind }); });
  return { sim, sent, bcast };
}

function addPlayerAt(sim: CreatureSim, id: string, x: number, z: number): void {
  const pm = (sim as unknown as { players: PlayerManager }).players;
  const p = pm.addPlayer(id);
  p.position.x = x; p.position.y = 0; p.position.z = z;
  p.isDead = false;
}

describe('MELEE_SPECIES table', () => {
  it('resolves per-species stats — scarab is faster, weaker, cheaper bite', () => {
    const cr = makeSimCrawler(1, 0, 0, 0, false, 42, 'crawler');
    const sc = makeSimCrawler(2, 0, 0, 0, false, 42, 'scarab');
    expect(cr.species).toBe('crawler');
    expect(sc.species).toBe('scarab');
    expect(sc.sp.HOP_SPEED).toBeGreaterThan(cr.sp.HOP_SPEED);
    expect(sc.health).toBeLessThan(cr.health);
    expect(sc.biteDamage).toBeLessThan(cr.biteDamage);
    expect(sc.sp.AGGRO_D2).toBeLessThan(cr.sp.AGGRO_D2);
  });

  it('unknown species falls back to crawler tunables', () => {
    const w = makeSimCrawler(3, 0, 0, 0, false, 7, 'bogstandard');
    expect(w.sp.HOP_SPEED).toBeCloseTo(makeSimCrawler(4, 0, 0, 0, false, 7, 'crawler').sp.HOP_SPEED);
  });
});

describe('distance-tiered edge fanout', () => {
  const priv = (s: CreatureSim) => s as unknown as SimPrivate;

  function crawlerAt(x: number, z: number): SimCrawler {
    const c = makeSimCrawler(9, x, 0, z, false, 11, 'crawler');
    return c;
  }

  it('near players get every retarget; far players only the resync beat', () => {
    const { sim, sent, bcast } = makeRoom();
    addPlayerAt(sim, 'near', 10, 0);   // ~10m from crawler
    addPlayerAt(sim, 'far', 300, 0);   // ~300m — beyond NEAR_D2
    const c = crawlerAt(0, 0);
    priv(sim).crawlers.set(c.id, c);

    for (let i = 0; i < 4; i++) priv(sim).edge(c, 'retarget');

    const nearGot = sent.filter(s => s.pid === 'near').length;
    const farGot = sent.filter(s => s.pid === 'far').length;
    expect(nearGot).toBe(3);   // 3 of 4 (the 4th went broadcast)
    expect(farGot).toBe(0);    // nothing direct — rides the broadcast beat
    expect(bcast.length).toBe(1); // every-4th edge is the shared resync
  });

  it('attack edges still reach near players (combat visuals survive tiering)', () => {
    const { sim, sent } = makeRoom();
    addPlayerAt(sim, 'near', 5, 0);
    const c = crawlerAt(0, 0);
    priv(sim).crawlers.set(c.id, c);
    priv(sim).edge(c, 'windup');
    priv(sim).edge(c, 'pounce');
    expect(sent.filter(s => s.kind === 'windup').length).toBe(1);
    expect(sent.filter(s => s.kind === 'pounce').length).toBe(1);
  });
});

describe('brain buckets', () => {
  it('same-tick spawns stagger retargets across ticks, not in a spike', () => {
    const { sim, sent, bcast } = makeRoom();
    // Far enough that no crawler can aggro/windup — only retarget edges
    // land in this window.
    addPlayerAt(sim, 'p1', 5000, 0);
    const priv = (sim as unknown as SimPrivate & {
      stepAll(alive: { id: string; pos: { x: number; y: number; z: number } }[]): void;
      retargetAcc: Map<number, number>;
      resyncAcc: Map<number, number>;
      field: object | null;
    });
    priv.field = { size: 1, data: new Uint8Array(1), stride: 1 };

    // Plant 8 crawlers directly so they share the seeding logic —
    // spawn() would need randomness; set the bucket the way it does.
    const crawlers: SimCrawler[] = [];
    for (let i = 0; i < 8; i++) {
      const c = makeSimCrawler(100 + i, i * 5, 0, 0, false, 7 + i, 'crawler');
      // Same seeding as spawnCrawler: negative offset phases this
      // crawler's first retarget into its bucket (2.0–3.75s window).
      priv.retargetAcc.set(c.id, -2 * ((c.id % 8) / 8));
      priv.resyncAcc.set(c.id, -4 * ((c.id % 8) / 8));
      priv.crawlers.set(c.id, c);
      crawlers.push(c);
    }

    // Count edge() CALLS, not messages — a far player gets nothing
    // delivered but the decision still ran.
    const calls: { kind: string; tick: number }[] = [];
    let tick = 0;
    const origEdge = priv.edge.bind(priv);
    priv.edge = (c: SimCrawler, kind: 'retarget' | 'windup' | 'pounce' | 'bite') => {
      calls.push({ kind, tick });
      origEdge(c, kind);
    };

    const alive = [{ id: 'p1', pos: { x: 5000, y: 0, z: 0 } }];
    // 76 ticks = 3.8s — covers the staggered 2.0–3.75s first-retarget
    // window without reaching any resync beat (4s+).
    for (let t = 0; t < 76; t++) {
      tick = t;
      priv.stepAll(alive);
    }
    const retargets = calls.filter((c) => c.kind === 'retarget');
    const perTick = new Map<number, number>();
    for (const r of retargets) perTick.set(r.tick, (perTick.get(r.tick) ?? 0) + 1);
    // Without buckets all 8 retargets land in one tick; with buckets they
    // spread ~1 per tick across the interval.
    expect(Math.max(...perTick.values())).toBeLessThanOrEqual(1);
    expect(retargets.length).toBe(8);
  });
});

describe('crawlerHit claim gates', () => {
  it('drops claims on unknown ids and out-of-range claimers', () => {
    const { sim } = makeRoom();
    const pm = (sim as unknown as { players: PlayerManager }).players;
    const c = makeSimCrawler(5, 0, 0, 0, false, 3, 'crawler');
    (sim as unknown as SimPrivate).crawlers.set(c.id, c);
    (sim as unknown as { field: object }).field = { size: 1, data: new Uint8Array(1), stride: 1 };

    addPlayerAt(sim, 'shooter', 1, 0);
    sim.handleHit('shooter', 999, 50);      // unknown id — no crash, no damage
    expect(c.health).toBe(c.maxHealth);

    const far = pm.addPlayer('faraway');
    far.position.x = 5000; far.position.z = 5000; far.isDead = false;
    sim.handleHit('faraway', c.id, 50);      // >600m gate — dropped
    expect(c.health).toBe(c.maxHealth);
  });

  it('legal claim applies damage + stun', () => {
    const { sim } = makeRoom();
    const c = makeSimCrawler(6, 0, 0, 0, false, 3, 'scarab');
    (sim as unknown as SimPrivate).crawlers.set(c.id, c);
    (sim as unknown as { field: object }).field = { size: 1, data: new Uint8Array(1), stride: 1 };
    addPlayerAt(sim, 'shooter', 1, 0);
    sim.handleHit('shooter', c.id, 10);
    expect(c.health).toBe(c.maxHealth - 10);
    expect(c.stunTimer).toBeGreaterThan(0);
  });
});

describe('flyer family (rakk)', () => {
  const field: Heightfield = { size: 1, data: new Uint8Array(1), stride: 1 };

  it('resolves per-species tunables + unknown species falls back to rakk', () => {
    const rk = makeSimFlyer(1, 0, 50, 0, false, 42, 'rakk');
    const gn = makeSimFlyer(2, 0, 50, 0, false, 42, 'gnat');
    expect(rk.state).toBe('orbit');
    expect(FLYER_SPECIES.gnat!.orbitR).toBeLessThan(FLYER_SPECIES.rakk!.orbitR ?? Infinity);
    expect(gn.sp.ORBIT_SPEED).toBeGreaterThan(rk.sp.ORBIT_SPEED);
    expect(isFlyerSpecies('rakk')).toBe(true);
    expect(isFlyerSpecies('crawler')).toBe(false);
  });

  it('committed target drives the orbit→windup→dive→bite event chain', () => {
    const f = makeSimFlyer(3, 0, 60, 0, false, 7, 'rakk');
    commitTarget(f, 'prey', { x: 0, y: 50, z: 0 });
    const events: string[] = [];
    // 30s window — covers the seeded cooldown + a full attack cycle.
    for (let i = 0; i < 600 && events.filter(e => e === 'bite').length === 0; i++) {
      const ev = stepFlyer(f, 0.05, field, { x: 0, y: 50, z: 0 }, true);
      if (ev) events.push(ev);
    }
    expect(events[0]).toBe('windup');
    expect(events).toContain('pounce');
    expect(events).toContain('bite');
    // The dive reconnects above ground — the sim's orbit anchor keeps it aloft.
    expect(f.y).toBeGreaterThanOrEqual(0.8);
  });

  it('authority and predictor replay the identical stream', () => {
    const a = makeSimFlyer(4, 0, 60, 0, false, 99, 'rakk');
    const p = makeSimFlyer(4, 0, 60, 0, false, 99, 'rakk');
    commitTarget(a, 'prey', { x: 0, y: 50, z: 0 });
    commitTarget(p, 'prey', { x: 0, y: 50, z: 0 });
    for (let i = 0; i < 120; i++) {
      stepFlyer(a, 0.05, field, { x: 0, y: 50, z: 0 }, true);
      stepFlyer(p, 0.05, field, { x: 0, y: 50, z: 0 }, false);
    }
    expect(p.x).toBeCloseTo(a.x, 10);
    expect(p.y).toBeCloseTo(a.y, 10);
    expect(p.z).toBeCloseTo(a.z, 10);
    expect(p.state).toBe(a.state);
    expect(p.rng).toBe(a.rng);
  });

  it('server spawnCrawler dispatches flyer species to makeSimFlyer', () => {
    const { sim } = makeRoom();
    addPlayerAt(sim, 'p1', 0, 0);
    const priv = sim as unknown as {
      field: Heightfield | null;
      spawnCrawler(near: { x: number; y: number; z: number }, species: string): SimFlyer;
    };
    priv.field = { size: 1, data: new Uint8Array(1), stride: 1 };
    const f = priv.spawnCrawler({ x: 0, y: 0, z: 0 }, 'rakk');
    expect('orbitPhase' in f).toBe(true);
    expect(f.species).toBe('rakk');
    expect(f.y).toBeGreaterThan(0); // spawns at cruise alt, not on the dirt
  });
});

describe('roller family', () => {
  const field: Heightfield = { size: 1, data: new Uint8Array(1), stride: 1 };

  it('rolls at the committed snapshot and bites on contact', () => {
    const r = makeSimRoller(5, 0, 0, 0, false, 11, 'roller');
    commitTarget(r, 'prey', { x: 20, y: 1.6, z: 0 });
    const events: string[] = [];
    for (let i = 0; i < 400 && events.length === 0; i++) {
      const ev = stepRoller(r, 0.05, field, { x: 20, y: 1.6, z: 0 }, true);
      if (ev) events.push(ev);
    }
    expect(events[0]).toBe('bite');
    expect(r.x).toBeGreaterThan(5); // actually closed the distance
    expect(isRollerSpecies('roller')).toBe(true);
    expect(isRollerSpecies('crawler')).toBe(false);
  });

  it('bite cooldown stops contact multi-ticking', () => {
    const r = makeSimRoller(6, 0, 0, 0, false, 11, 'roller');
    commitTarget(r, 'prey', { x: 1, y: 1.6, z: 0 });
    const tgt = { x: 1, y: 1.6, z: 0 };
    let bites = 0;
    for (let i = 0; i < 20; i++) { // 1s at melee range — cooldown gates re-bites
      if (stepRoller(r, 0.05, field, tgt, true) === 'bite') bites++;
      r.x = 1; r.y = 1.6; r.z = 0; // hold it on the target
    }
    expect(bites).toBeLessThanOrEqual(2);
    expect(bites).toBeGreaterThanOrEqual(1);
  });

  it('authority and predictor replay identically', () => {
    const a = makeSimRoller(7, 0, 0, 0, false, 55, 'roller');
    const p = makeSimRoller(7, 0, 0, 0, false, 55, 'roller');
    commitTarget(a, 'prey', { x: 30, y: 1.6, z: 10 });
    commitTarget(p, 'prey', { x: 30, y: 1.6, z: 10 });
    for (let i = 0; i < 100; i++) {
      stepRoller(a, 0.05, field, { x: 30, y: 1.6, z: 10 }, true);
      stepRoller(p, 0.05, field, { x: 30, y: 1.6, z: 10 }, false);
    }
    expect(p.x).toBeCloseTo(a.x, 10);
    expect(p.z).toBeCloseTo(a.z, 10);
  });

  it('server spawnCrawler dispatches roller species to makeSimRoller', () => {
    const { sim } = makeRoom();
    addPlayerAt(sim, 'p1', 0, 0);
    const priv = sim as unknown as {
      field: Heightfield | null;
      spawnCrawler(near: { x: number; y: number; z: number }, species: string): SimRoller;
    };
    priv.field = { size: 1, data: new Uint8Array(1), stride: 1 };
    const r = priv.spawnCrawler({ x: 0, y: 0, z: 0 }, 'roller');
    expect('hitCd' in r).toBe(true);
    expect(r.species).toBe('roller');
  });
});

describe('slither family (snake)', () => {
  const field: Heightfield = { size: 1, data: new Uint8Array(1), stride: 1 };
  const tgt = { x: 8, y: 0.5, z: 0 };

  it('committed target → slither → windup → pounce → bite chain', () => {
    const s = makeSimSlither(9, 0, 0.5, 0, false, 21, 'snake');
    commitTarget(s, 'prey', tgt);
    s.strikeCd = 0;
    const events: string[] = [];
    for (let i = 0; i < 120 && events.length < 3; i++) {
      const ev = stepSlither(s, 0.05, field, tgt, true);
      if (ev) events.push(ev);
    }
    // Coil telegraph → lunge launch → contact bite, in order.
    expect(events[0]).toBe('windup');
    expect(events[1]).toBe('pounce');
    expect(events[2]).toBe('bite');
    expect(isSlitherSpecies('snake')).toBe(true);
    expect(isSlitherSpecies('crawler')).toBe(false);
  });

  it('a hit during windup/lunge breaks the strike', () => {
    const s = makeSimSlither(10, 0, 0.5, 0, false, 21, 'snake');
    commitTarget(s, 'prey', tgt);
    s.strikeCd = 0;
    for (let i = 0; i < 40 && s.state !== 'windup'; i++) stepSlither(s, 0.05, field, tgt, true);
    expect(s.state).toBe('windup');
    applySlitherDamage(s, 5);
    expect(s.state).toBe('slither'); // strike broken, not bit through it
  });

  it('authority and predictor replay identically', () => {
    const a = makeSimSlither(11, 0, 0.5, 0, false, 33, 'snake');
    const p = makeSimSlither(11, 0, 0.5, 0, false, 33, 'snake');
    commitTarget(a, 'prey', tgt);
    commitTarget(p, 'prey', tgt);
    for (let i = 0; i < 150; i++) {
      stepSlither(a, 0.05, field, tgt, true);
      stepSlither(p, 0.05, field, tgt, false);
      expect(p.x).toBeCloseTo(a.x, 10);
      expect(p.z).toBeCloseTo(a.z, 10);
      expect(p.state).toBe(a.state);
      expect(p.animT).toBeCloseTo(a.animT, 10);
    }
  });

  it('server spawnCrawler dispatches snake to makeSimSlither', () => {
    const { sim } = makeRoom();
    addPlayerAt(sim, 'p1', 0, 0);
    const priv = sim as unknown as {
      field: Heightfield | null;
      spawnCrawler(near: { x: number; y: number; z: number }, species: string): SimSlither;
    };
    priv.field = { size: 1, data: new Uint8Array(1), stride: 1 };
    const s = priv.spawnCrawler({ x: 0, y: 0, z: 0 }, 'snake');
    expect('animT' in s).toBe(true);
    expect(s.species).toBe('snake');
  });
});

describe('kamikaze family (baneling)', () => {
  const field: Heightfield = { size: 1, data: new Uint8Array(1), stride: 1 };

  it('proximity fuse emits detonate and kills the sac', () => {
    const b = makeSimBaneling(12, 0, 0.7, 0, false, 5, 'baneling');
    commitTarget(b, 'prey', { x: 30, y: 0.7, z: 0 });
    let ev: string | null = null;
    for (let i = 0; i < 600 && !ev; i++) {
      ev = stepBaneling(b, 0.05, field, { x: 30, y: 0.7, z: 0 }, true);
    }
    expect(ev).toBe('detonate');
    expect(b.dead).toBe(true);
    expect(b.x).toBeGreaterThan(10); // actually ran the fuse in
    expect(isBanelingSpecies('baneling')).toBe(true);
    expect(isBanelingSpecies('roller')).toBe(false);
  });

  it('life clock pops it even with no target', () => {
    const b = makeSimBaneling(13, 0, 0.7, 0, false, 5, 'baneling');
    b.age = 24.99;
    expect(stepBaneling(b, 0.05, field, null, true)).toBe('detonate');
    expect(b.dead).toBe(true);
  });

  it('a lethal hit detonates it — blast hook + die edge both fire', () => {
    const { sim, sent, bcast } = makeRoom();
    const booms: number[] = [];
    sim.onDetonate = (b) => { booms.push(b.id); };
    addPlayerAt(sim, 'shooter', 1, 0);
    const priv = sim as unknown as {
      field: Heightfield | null;
      crawlers: Map<number, SimBaneling>;
    };
    priv.field = field;
    const b = makeSimBaneling(14, 0, 0.7, 0, false, 5, 'baneling');
    priv.crawlers.set(b.id, b);
    sim.handleHit('shooter', b.id, 999);
    expect(booms).toEqual([14]);
    // The detonate edge rides the near-player sendTo tier; crawlDie is
    // the broadcast sweep — both channels carry part of the pop.
    expect(sent.filter(s => s.kind === 'detonate').length).toBe(1);
    expect(bcast.map(m => m.type)).toContain('crawlDie');
  });

  it('authority and predictor replay the identical chase', () => {
    const a = makeSimBaneling(15, 0, 0.7, 0, false, 77, 'baneling');
    const p = makeSimBaneling(15, 0, 0.7, 0, false, 77, 'baneling');
    commitTarget(a, 'prey', { x: 400, y: 0.7, z: 300 });
    commitTarget(p, 'prey', { x: 400, y: 0.7, z: 300 });
    for (let i = 0; i < 100; i++) {
      stepBaneling(a, 0.05, field, { x: 400, y: 0.7, z: 300 }, true);
      stepBaneling(p, 0.05, field, { x: 400, y: 0.7, z: 300 }, false);
    }
    expect(p.x).toBeCloseTo(a.x, 10);
    expect(p.z).toBeCloseTo(a.z, 10);
    expect(p.age).toBeCloseTo(a.age, 10);
  });

  it('server spawnCrawler dispatches baneling to makeSimBaneling', () => {
    const { sim } = makeRoom();
    addPlayerAt(sim, 'p1', 0, 0);
    const priv = sim as unknown as {
      field: Heightfield | null;
      spawnCrawler(near: { x: number; y: number; z: number }, species: string): SimBaneling;
    };
    priv.field = { size: 1, data: new Uint8Array(1), stride: 1 };
    const b = priv.spawnCrawler({ x: 0, y: 0, z: 0 }, 'baneling');
    expect('age' in b).toBe(true);
    expect(b.species).toBe('baneling');
    expect(b.blastRadius).toBeGreaterThan(0);
  });
});
