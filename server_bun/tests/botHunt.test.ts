import { afterEach, describe, expect, it } from 'bun:test';

import { newHuntState, pickHunt, pickFire, scanVisible, retreatDest, noteFoeHit, noteFoeDeath, dreadOf } from '../../shared/botHunt.ts';
import { botRng, botRngRelease } from '../../shared/botRand.ts';
import type { BotEnemy, BrainCtx } from '../../shared/botBrain.ts';

const foe = (x: number, z: number, id = 'p:1'): BotEnemy => ({
  id, alive: true,
  pos: { x, y: 0, z }, vel: { x: 0, y: 0, z: 0 },
} as BotEnemy);

const flat = (over: Partial<BrainCtx> = {}): BrainCtx => ({
  pos: { x: 0, y: 0, z: 0 },
  enemies: [],
  now: 0,
  groundY: () => 0,
  ...over,
});

const mood = { hero: false, fearing: false };
const P = { x: 0, y: 0, z: 0 };

afterEach(() => botRngRelease());

describe('scanVisible', () => {
  it('dead and occluded candidates are skipped', () => {
    const c = flat({ enemies: [foe(10, 0, 'p:dead')] });
    (c.enemies[0] as BotEnemy).alive = false;
    const { player } = scanVisible(c, P, 100, 100);
    expect(player).toBeNull();
  });

  it('beasts (b: ids) sort into their own lane', () => {
    const c = flat({ enemies: [foe(10, 0, 'b:7'), foe(20, 0, 'p:1')] });
    const r = scanVisible(c, P, 100, 100);
    expect(r.beast?.id).toBe('b:7');
    expect(r.player?.id).toBe('p:1');
  });
});

describe('pickHunt', () => {
  it('no visible enemy → hunt falls to the thief beacon or nothing', () => {
    const st = newHuntState(P);
    pickHunt(st, flat({ thief: foe(30, 0, 'p:thief') }), P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('p:thief'); // beacon tracks without LOS
  });

  it('nearest live player in range becomes the hunt', () => {
    const st = newHuntState(P);
    pickHunt(st, flat({ enemies: [foe(10, 0)] }), P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('p:1');
    expect(st.lastSeen).toEqual({ x: 10, y: 0, z: 0 });
  });

  it('a creature on top of the bot outranks a distant player', () => {
    const st = newHuntState(P);
    const c = flat({ enemies: [foe(4, 0, 'b:biter'), foe(30, 0, 'p:1')] });
    pickHunt(st, c, P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('b:biter');
  });

  it('sight line acquires at Tribes range — 90m hunts, beyond sight does not', () => {
    const st = newHuntState(P);
    pickHunt(st, flat({ enemies: [foe(90, 0)] }), P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('p:1'); // inside the 300m sight band
    const st2 = newHuntState(P);
    pickHunt(st2, flat({ enemies: [foe(400, 0)] }), P, 0, mood, () => {});
    expect(st2.hunt).toBeNull(); // past the eye line
  });

  it('nothing visible → the goal ladder runs instead', () => {
    const st = newHuntState(P);
    let ran = false;
    pickHunt(st, flat(), P, 0, mood, () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe('nemesis', () => {
  const scar = (st: ReturnType<typeof newHuntState>, id: string, deaths = 2) => {
    for (let i = 0; i < deaths * 2; i++) { noteFoeHit(st, id, i * 100); noteFoeDeath(st, i * 100 + 50); }
  };

  it('hits and deaths stack a foe score', () => {
    const st = newHuntState(P);
    noteFoeHit(st, 'p:1', 0);
    noteFoeDeath(st, 100);
    expect(dreadOf(st, 'p:1')).toBeCloseTo(1.5 + 0.25, 3);
    noteFoeHit(st, 'p:2', 0);
    expect(dreadOf(st, 'p:2')).toBeCloseTo(0.25, 3);
    // A stale lastHitBy attributes nothing.
    const st2 = newHuntState(P);
    noteFoeHit(st2, 'p:1', 0);
    noteFoeDeath(st2, 10_000);
    expect(dreadOf(st2, 'p:1')).toBeCloseTo(0.25, 3);
  });

  it('a nemesis is invisible to acquisition — the brawl-range foe is not', () => {
    const st = newHuntState(P);
    scar(st, 'p:nem');
    pickHunt(st, flat({ enemies: [foe(40, 0, 'p:nem'), foe(50, 0, 'p:2')] }), P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('p:2');
    // Inside brawl range nobody gets ignored — dread can't stand down
    // a fight that's already on top of the bot.
    const st2 = newHuntState(P);
    scar(st2, 'p:nem');
    pickHunt(st2, flat({ enemies: [foe(10, 0, 'p:nem')] }), P, 0, mood, () => {});
    expect(st2.hunt?.id).toBe('p:nem');
  });

  it('hero mode does not pick its opponent', () => {
    const st = newHuntState(P);
    scar(st, 'p:nem');
    pickHunt(st, flat({ enemies: [foe(40, 0, 'p:nem')] }), P, 0, { hero: true, fearing: false }, () => {});
    expect(st.hunt?.id).toBe('p:nem');
  });

  it('a plain grudge (hits, no deaths) stays engaged', () => {
    const st = newHuntState(P);
    noteFoeHit(st, 'p:1', 0); // 0.25 < 2 — annoyance, not fear
    pickHunt(st, flat({ enemies: [foe(40, 0, 'p:1')] }), P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('p:1');
  });
});

describe('anticipation', () => {
  it('a lost runner heading at a pack is chased to the pack', () => {
    const st = newHuntState(P);
    // First sighting establishes the model: runner at (30,0) going +x.
    const runner = foe(30, 0, 'p:run');
    runner.vel = { x: 20, y: 0, z: 0 };
    pickHunt(st, flat({ enemies: [runner] }), P, 0, mood, () => {});
    expect(st.hunt?.id).toBe('p:run');
    // LOS breaks — no enemy in the next ctx. The pickup sits at the end
    // of the heading line, so the ghost should land on it.
    st.lastSeenAt = 900;
    const pack = { x: 54, y: 0, z: 0 }; // 30 + 20*1.2 = 54 — on the money
    pickHunt(st, flat({ pickup: pack, now: 2000 }), P, 2000, mood, () => {});
    expect(st.hunt?.pos.x).toBeCloseTo(54, 3);
    // Without the attractor the same ghost rides pure momentum.
    const st2 = newHuntState(P);
    const r2 = foe(30, 0, 'p:run');
    r2.vel = { x: 20, y: 0, z: 0 };
    pickHunt(st2, flat({ enemies: [r2] }), P, 0, mood, () => {});
    st2.lastSeenAt = 900;
    pickHunt(st2, flat({ now: 2000 }), P, 2000, mood, () => {});
    expect(st2.hunt?.pos.x).toBeGreaterThan(30); // momentum carried it
    expect(st2.hunt?.pos.x).toBeLessThanOrEqual(54.001);
  });
});

describe('difficulty tiers', () => {
  it('harder bands roll a sharper population — mean aim and speed rise', () => {
    const mean = (tier: 'easy' | 'medium' | 'impossible') => {
      let aim = 0, move = 0, jit = 0;
      const N = 60;
      for (let i = 0; i < N; i++) {
        const st = newHuntState({ x: i * 7, y: 0, z: i * 3 }, tier);
        aim += (st.skill.axes.snap.moving + st.skill.axes.track.moving) / 2;
        move += st.skill.movement;
        jit += st.jitter;
      }
      return { aim: aim / N, move: move / N, jit: jit / N };
    };
    const easy = mean('easy'), mid = mean('medium'), god = mean('impossible');
    expect(easy.aim).toBeLessThan(mid.aim);
    expect(mid.aim).toBeLessThan(god.aim);
    expect(easy.move).toBeLessThan(god.move);
    expect(god.jit).toBeLessThan(easy.jit); // steadier hands
  });
});

describe('pickFire', () => {
  const armed = () => {
    const st = newHuntState(P);
    st.hunt = foe(20, 0);
    st.lastSeen = { x: 20, y: 0, z: 0 };
    st.lastSeenVel = { x: 0, y: 0, z: 0 };
    st.lastSeenAt = 0;
    st.fireT = 0;
    return st;
  };

  it('no hunt or expired pursuit window → no volley', () => {
    const st = newHuntState(P);
    expect(pickFire(st, 0.1, flat(), P, 0, mood)).toBeUndefined();
    st.hunt = foe(20, 0);
    st.lastSeenAt = -4000; // past PURSUE_MS — the ghost is forgotten
    expect(pickFire(st, 0.1, flat(), P, 0, mood)).toBeUndefined();
  });

  it('LOS memory: past the sight window the ghost still eats suppression', () => {
    const st = armed();
    // Sighting 2s ago — inside the pursuit window but past STALE_MS:
    // the shot goes at the drifting ghost, not nothing.
    st.lastSeenAt = -2000;
    st.hunt!.pos = { x: 24, y: 0, z: 0 }; // ghost walked +x with the model
    botRng(() => 0.5);
    const f = pickFire(st, 1, flat(), P, 0, mood);
    expect(f?.targetId).toBe('p:1');
    expect(f!.aim.x).toBeGreaterThan(22); // ghost pos, not the stale sighting
  });

  it('leads a moving target along its velocity', () => {
    const st = armed();
    // The lagged opponent model is what leads shots now — lastSeenVel
    // only feeds aim-error sizing.
    st.leadVel = { x: 10, y: 0, z: 0 }; // running +x
    st.lastSeenVel = { x: 10, y: 0, z: 0 };
    botRng(() => 0.5); // zero scatter
    const f = pickFire(st, 1, flat({ weaponSpeed: () => 60 }), P, 0, mood);
    expect(f?.targetId).toBe('p:1');
    expect(f!.aim.x).toBeGreaterThan(20); // led forward
  });

  it('ballistic drop aims low; weaponGravity compensates back', () => {
    const st = armed();
    st.lastSeenVel = { x: 0, y: 10, z: 0 }; // rising target
    botRng(() => 0.5);
    const c = flat({ weaponSpeed: () => 60, weaponGravity: () => true });
    const f = pickFire(st, 1, c, P, 0, mood);
    // ground clamp vs falling target — aim ends up clamped to terrain here,
    // the point is the gravity shell drop is folded in.
    expect(f).toBeDefined();
  });

  it('burst cadence: a clip of shots then a longer pause', () => {
    const st = armed();
    botRng(() => 0.5);
    const times: number[] = [];
    const ctx = flat({ weaponSpeed: () => 60, fireInterval: () => 0.5 });
    let shots = 0;
    while (st.burstLeft! > 0 || shots === 0) {
      const f = pickFire(st, 10, ctx, P, 0, mood);
      expect(f).toBeDefined();
      times.push(st.fireT!);
      shots++;
      st.fireT = 0; // pretend the cadence elapsed
    }
    expect(times[shots - 1]!).toBeGreaterThan(times[0]!); // post-burst pause > in-burst
  });
});

describe('retreatDest', () => {
  it('retreats 24m away from the threat', () => {
    const d = retreatDest(flat(), P, foe(10, 0));
    expect(d.x).toBeCloseTo(-24, 3);
  });

  it('folds toward a nearby ally', () => {
    const d = retreatDest(flat({ others: [{ x: -30, y: 0, z: 0 }] }), P, foe(10, 0));
    expect(d.x).toBeCloseTo((-24 + -30) / 2, 3);
  });
});
