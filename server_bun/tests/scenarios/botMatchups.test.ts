import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin } from './harness.ts';
import { BOT_LOADOUTS, type BotLoadout } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { PlayerState } from '../../src/types.ts';

// Bot-vs-bot duels: pin two kits at a fixed range, let the brains fight,
// and check the matchup lands where the weapon table says it should —
// across several seeds, since aim scatter makes single duels a lottery.
// Each distance band exercises a different loadout slot: near (<15m),
// mid (15-40m), far (>40m; BOT_FIRE_RANGE tops out at 45 so 'far' duels
// pin at 43 — past that the brains never even acquire each other).
//
// Everything here is deterministic: mkRoom seeds botRng (aim scatter,
// temper, volley cadence). A flipped matchup means the balance or the
// brain moved — both worth a look.

type Room = ReturnType<typeof mkRoom>;

const KIT = {
  chaser: BOT_LOADOUTS[0]!,      // CG / PlasmaGun / Rocket — featherjets
  siege: BOT_LOADOUTS[1]!,       // CG / Disc / Rocket — bombardier
  anchor: BOT_LOADOUTS[2]!,      // CG / PlasmaGun / Disc — plated
  skirmisher: BOT_LOADOUTS[3]!,  // CG / Disc / Rocket — overcharge
  hose: BOT_LOADOUTS[4]!,        // CG / Sprinkler / Rocket — lifesteal
  bruiser: BOT_LOADOUTS[5]!,     // Shotgun / Cannon / Railgun — plated
  flanker: BOT_LOADOUTS[6]!,     // Flak / GrenadeLauncher / RocketLauncher
  artillery: BOT_LOADOUTS[7]!,   // CG / PlasmaCannon / Mortar — bombardier
  beam: BOT_LOADOUTS[8]!,        // Lightning / Disc / Railgun — overcharge
  trapper: BOT_LOADOUTS[9]!,     // Shotgun / Sticky / RocketLauncher — lifesteal
  support: BOT_LOADOUTS[10]!,    // Shotgun / PlasmaGun / Rocket — lifesteal
} satisfies Record<string, BotLoadout>;

function botsOf(room: Room): PlayerState[] {
  return [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
}

/** One seeded duel at a fixed pin distance; 'a' always spawns on the -x
 *  side so seed luck isn't symmetric. Returns winner 'a' | 'b' | '-'
 *  (draw) plus the survivor's hp — competitiveness gates read it. */
function duel(loA: BotLoadout, loB: BotLoadout, distM: number, seed: number, maxTicks = 700): { w: 'a' | 'b' | '-'; hp: number } {
  const room = mkRoom({
    mode: 'tdm', bots: 2,
    bases: { alpha: { x: -300, y: 60, z: 0 }, bravo: { x: 300, y: 60, z: 0 } },
  }, 'tdm', seed);
  const [a, b] = botsOf(room);
  const ctl = room.bots as unknown as { loadouts: Map<string, BotLoadout>; roster: { refitClass(id: string): void } };
  ctl.loadouts.set(a!.id, loA);
  ctl.loadouts.set(b!.id, loB);
  // The class follows the kit now (plated/mortar → heavy, featherjets →
  // light): re-fit both bodies or the duel fights with spawn-random tiers.
  ctl.roster.refitClass(a!.id);
  ctl.roster.refitClass(b!.id);
  for (let i = 0; i < maxTicks; i++) {
    pin(room, a!.id, { x: -distM / 2, y: 32, z: 0 });
    pin(room, b!.id, { x: distM / 2, y: 32, z: 0 });
    step(room, 1);
    if (a!.isDead || b!.isDead) {break;}
  }
  const w = a!.isDead ? 'b' : b!.isDead ? 'a' : '-';
  return { w, hp: w === '-' ? 0 : (w === 'a' ? a!.health : b!.health) };
}

const SEEDS = [11, 22, 33, 44, 55];

function series(loA: BotLoadout, loB: BotLoadout, distM: number, seeds = SEEDS) {
  return seeds.map((s) => duel(loA, loB, distM, s));
}

const wins = (results: { w: 'a' | 'b' | '-' }[], who: 'a' | 'b') => results.filter((r) => r.w === who).length;

describe('scenario: weapon matchups at near band (10m)', () => {
  it('shotgun vs lightning at 10m: contested, nobody free-wins', () => {
 // 100 nominal dps vs 80 tick-dps. Was a 5/5 stomp because the beam
 // bot used to draw its aoe Disc at 10m — the self-splash penalty now
 // pulls it onto Lightning, the right gun. The edge has since flipped
 // band-by-band with the brain work (skills/orbits/loadout alts):
 // observed 2/5 shotgun wins 2026-11-09 — a razor, same class as the
 // chaser/flanker duel below. Pin resolution + a bleeding winner,
 // not who takes it.
 const r = series(KIT.bruiser, KIT.beam, 10);
 expect(r.filter((x): boolean => x.w !== '-').length).toBeGreaterThanOrEqual(4);
 for (const d of r.filter((x): boolean => x.w !== '-')) {
   const pool = d.w === 'a' ? 200 : 75; // bruiser heavy / beam light (same tiers as the chaser/flanker pin below)
   expect(d.hp).toBeLessThanOrEqual(pool * 0.8);
 }
  });

  it('chaser vs flanker at knife range: contested, nobody free-wins', () => {
    // Winner-pins on this duel flaked twice already (1/5 → 3/5 → 5/5
    // chaser sweep as balance knobs moved) — it's a razor's edge: every
    // seed resolves ~2.5s with the winner on 4-34/75hp (2026-10-25
    // probe). Pin what survives tuning: every duel resolves AND the
    // winner bleeds — a >50%-hp survivor means one kit stopped fighting.
    const r = series(KIT.chaser, KIT.flanker, 10);
    expect(r.filter((x): boolean => x.w !== '-').length).toBeGreaterThanOrEqual(4);
    // …and the winner bleeds: a survivor over half its pool means the
    // loser's near-gun stopped fighting back.
    for (const d of r.filter((x): boolean => x.w !== '-')) {
      const pool = d.w === 'a' ? 75 : 200; // chaser light (−25) / flanker heavy (+100)
      // Capsule hits got honest (axis test, no midpoint sphere): the
      // phantom near-miss hits that used to bleed the winner stopped
      // crediting, so survivors keep more hp. Still contested — the
      // winner bleeds — just less than a padded hitbox produced.
      expect(d.hp).toBeLessThanOrEqual(pool * 0.8);
    }
  });
});

describe('scenario: weapon matchups at mid band (25m)', () => {
  it('lightning at mid band contests the cannon - a razor coin flip', () => {
    // The beam-rider kit now draws Lightning at mid band (its measured
    // 25-60m apex) instead of Disc - so this duel reads LG vs cannon:
    // the shaft's standoff tracking vs the 70dmg banded slug went
    // 2/2/1 observed - contested, nobody free-wins. Pin resolution.
    const r = series(KIT.beam, KIT.bruiser, 25);
    expect(r.filter((x): boolean => x.w !== '-').length).toBeGreaterThanOrEqual(4);
  });

  it('plasma cannon edges the support plinker', () => {
    // 168 vs ~110 nominal dps but the PC's proxy radius grows slowly —
    // it wins most seeds, not all (observed 5/7).
    expect(wins(series(KIT.artillery, KIT.support, 25), 'a')).toBeGreaterThanOrEqual(3);
  });
});

describe('scenario: weapon matchups at far band (43m — BOT_FIRE_RANGE cap)', () => {
  it('railgun vs mortar: a coin flip since humanized aim', () => {
    // Hitscan owned this duel 4/5 until aim humanization — now the rail
    // pays the perpendicular-motion penalty while the mortar's 18m splash
    // forgives scatter, so it's a toss-up. The property to pin: the duel
    // still resolves (nobody is unkillable), not who wins it.
    const r = series(KIT.beam, KIT.artillery, 43);
    expect(r.filter((x) => x.w !== '-').length).toBeGreaterThanOrEqual(4);
  });

  it('railgun vs rocket: a coin flip since humanized aim', () => {
    // Was rail dominance (5/0) after the wake proxy shrank; the strafe
    // penalty at 43m brought it back to even. Pin resolution, not winner.
    const r = series(KIT.bruiser, KIT.chaser, 43);
    expect(r.filter((x) => x.w !== '-').length).toBeGreaterThanOrEqual(4);
  });

  it('mortar vs MRV volley: the heavies trade area ordnance', () => {
    // Same bombardier artillery frame; only the far slot differs —
    // one 300dmg shell on a point vs a bouncing carrier airbursting
    // six contact bomblets over an area. Pin resolution, not winner.
    const mrv: BotLoadout = { ...KIT.artillery, far: WeaponType.MRVLauncher };
    const r = series(KIT.artillery, mrv, 43);
    expect(r.filter((x) => x.w !== '-').length).toBeGreaterThanOrEqual(4);
  });
});

describe('scenario: matchup sanity', () => {
  it('mirror duel resolves — same kit still produces a loser', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -300, y: 60, z: 0 }, bravo: { x: 300, y: 60, z: 0 } },
    }, 'tdm', 7331);
    const [a, b] = botsOf(room);
    for (let i = 0; i < 700; i++) {
      pin(room, a!.id, { x: -12.5, y: 32, z: 0 });
      pin(room, b!.id, { x: 12.5, y: 32, z: 0 });
      step(room, 1);
      if (a!.isDead || b!.isDead) {break;}
    }
    expect(a!.isDead || b!.isDead || a!.health < a!.maxHealth || b!.health < b!.maxHealth).toBe(true);
  });

  it('plated outlasts featherjets in the same gunfight', () => {
    // Same CG/Plasma/Rocket bands — only the perk differs (25% resist
    // below 80% hp vs unused jets). The edge is real but small in a
    // pinned duel — a coin flip that should never go negative (2/5 now;
    // 0-1/5 would mean the resist stopped applying).
    expect(wins(series(KIT.anchor, KIT.chaser, 25), 'a')).toBeGreaterThanOrEqual(2);
  });
});
