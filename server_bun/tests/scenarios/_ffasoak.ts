// Scratch: weapon-vs-weapon balance matrix - a 10-bot FFA deathmatch
// where each bot is locked to ONE weapon for the whole match, run over
// several seeds. The leaderboard IS the balance table: kills, deaths,
// K/D and sim-seconds-to-50 (or the cap) per weapon against dodging
// targets, not dummies - the complement to the ballswarm throughput
// bench.
//   bun tests/scenarios/_ffasoak.ts            # default 10 weapons
//   bun tests/scenarios/_ffasoak.ts 2 Railgun Mortar  # subset, 2 seeds
import { mkRoom, step, pin } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import { pickBotWeapon, WILDCARD_SLOTS, type BotLoadout } from '../../../shared/botLoadouts.ts';
import { weaponStats } from '../../src/weaponStats.ts';
import type { HitLedger } from '../../src/hitLedger.ts';
import { hmParseBin, hmScaled } from '../../../shared/heightfield.ts';
import { readFileSync } from 'node:fs';

const FFASOAK_ARENA = Number(process.env.FFASOAK_ARENA) || 300;
const FFASOAK_MAP = process.env.FFASOAK_MAP || '';
const FFASOAK_UNPINNED = Boolean(process.env.FFASOAK_UNPINNED);
const FFASOAK_CHAOS = Boolean(process.env.FFASOAK_CHAOS);
const FFASOAK_TDM = Boolean(process.env.FFASOAK_TDM);
const BOTS = FFASOAK_TDM ? 16 : 10;
const TARGET = FFASOAK_TDM ? 100 : 50;      // kills to win
let CAP_S = 2400;       // sim-seconds; argv[1] overrides

const ALL: WeaponType[] = [
  WeaponType.Chaingun, WeaponType.PlasmaGun, WeaponType.Shotgun, WeaponType.Disc,
  WeaponType.BoltLauncher, WeaponType.RocketLauncher, WeaponType.Cannon,
  WeaponType.Mortar, WeaponType.GrenadeLauncher, WeaponType.Railgun,
  WeaponType.Flak, WeaponType.PlasmaCannon, WeaponType.Lightning,
  WeaponType.Sticky, WeaponType.MRVLauncher, WeaponType.Sprinkler,
  WeaponType.Bombard, WeaponType.Pistol, WeaponType.Revolver,
];

function deal(pool: WeaponType[], seed: number): WeaponType[] {
  const deck = [...pool];
  let s = seed | 0 || 1;
  for (let i = deck.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) & 0x7F_FF_FF_FF;
    const j = s % (i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  if (deck.length === 0) {return deck;}
  while (deck.length < BOTS) {deck.push(deck[deck.length % pool.length]!);}
  return deck.slice(0, BOTS);
}

function run(weapons: WeaponType[], seed: number): {
  rows: { w: string; kills: number; deaths: number }[];
  winnerT: number; simS: number; wallS: number;
  totalDeaths: number; totalKills: number;
  wStats: Map<number, { directHits: number; splashHits: number; directDmg: number; splashDmg: number; kills: number }>;
} {
  let field;
  if (FFASOAK_MAP) {
    const buf = readFileSync(`C:/TEMP/_WEB/FPSWebTest/maps/${FFASOAK_MAP}.bin`);
    const spec = JSON.parse(readFileSync(`C:/TEMP/_WEB/FPSWebTest/maps/${FFASOAK_MAP}.json`, 'utf8'));
    field = hmScaled(hmParseBin(buf, spec.heightScale ?? 1), spec.heightScale ?? 1);
  }
  const mode = FFASOAK_TDM ? 'tdm' : 'dm';
  const room = mkRoom({ mode, bots: BOTS, botSkill: 'impossible', arena: { x: 0, z: 0, radius: FFASOAK_ARENA } }, mode, seed, false, field ?? undefined);
  // FFASOAK_IGUN: igun damage law (×10 direct, ×5 splash) WITHOUT the
  // ladder gate - the kill leaderboard then ranks pure kill-ease, which
  // is the axis the igun ladder orders on.
  if (process.env.FFASOAK_IGUN) {room.mods.igun = true;}

  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  const ctl = room.bots as unknown as {
    loadouts: Map<string, BotLoadout>;
    roster: { refitClass(id: string): void; applyClass(p: { id: string; maxHealth: number; health: number }, cls: string): void };
  };
  if (process.env.FFASOAK_BERSERK) {
    (ctl as unknown as { arsenal: { pickWeapon(l: BotLoadout, dxz: number, d: number): number } })
      .arsenal.pickWeapon = (l: BotLoadout, dxz: number, d: number) => pickBotWeapon(l, dxz, d);
  }
  // FFASOAK_PURE: the locked weapon does ALL the work — no melee knife
  // picks, no belt lobs, no sidearm finishers muddying attribution.
  // Melee is pickBotWeapon's sub-3m override; belt throws are gated by
  // beltCharges, so a dry pool refuses every lob (and respawns restock
  // it — the respawn loop zeroes it again). Side finishers are moot:
  // every slot already holds the test weapon.
  const PURE = Boolean(process.env.FFASOAK_PURE);
  if (PURE) {
    const ars = ctl as unknown as { arsenal: { pickWeapon(l: BotLoadout, dxz: number, d: number, id?: string): number } };
    const origPick = ars.arsenal.pickWeapon.bind(ars.arsenal);
    ars.arsenal.pickWeapon = (l, dxz, d, id) => {
      const w = origPick(l, dxz, d, id);
      return w === WeaponType.Melee ? l.near : w;
    };
  }
  // In chaos mode, each bot holds a random draw; it only re-rolls on death
  // after earning a kill that life.
  const currentWeapon = new Map<string, WeaponType>();
  const lifeKillsBase = new Map<string, number>(); // p.kills at this life's start
  // Chaos draws come from the FULL pool (module `pool`), not the dealt
  // deck — `weapons` here is the 10-bot slice, so drawing from it meant
  // 9 of 19 weapons could never appear in a seed. Seeded LCG so a seed
  // number reproduces the draw sequence.
  let cs = (seed * 747_796_405 + 2_891_336_453) >>> 0 || 1;
  const crand = (): number => ((cs = (cs * 1_664_525 + 1_013_904_223) >>> 0) / 4_294_967_296);
  for (let i = 0; i < bots.length; i++) {
    const w = FFASOAK_CHAOS ? pool[Math.floor(crand() * pool.length)]! : weapons[i]!;
    ctl.loadouts.set(bots[i]!.id, { perk: 'none', near: w, mid: w, far: w,
      belt: PURE ? w : WeaponType.Grenade, side: PURE ? w : WeaponType.Pistol });
    ctl.roster.refitClass(bots[i]!.id);
    if (PURE) {(bots[i]! as { beltCharges: number }).beltCharges = 0;}
    if (!process.env.FFASOAK_CLASSES) {
      bots[i]!.armorClass = 'medium';
      ctl.roster.applyClass(bots[i]!, 'medium');
    }
    if (!FFASOAK_UNPINNED) {
      const a = (i / bots.length) * Math.PI * 2;
      pin(room, bots[i]!.id, { x: Math.cos(a) * (FFASOAK_ARENA * 0.6), y: 65, z: Math.sin(a) * (FFASOAK_ARENA * 0.6) });
    }
    currentWeapon.set(bots[i]!.id, w);
  }
  (room as { endMatch: (w: string) => void }).endMatch = () => {};

  const wOf = new Map(bots.map((b, i) => [b.id, weapons[i]!]));

  // Per-weapon tracking via applyHit hook (captures all damage with weapon attribution).
  // Under chaos every weapon in the pool is a possible damage source —
  // keying on the dealt deck drops ~16 of 26 weapons' stats.
  const wStats: Map<number, { directHits: number; splashHits: number; directDmg: number; splashDmg: number; kills: number }> = new Map();
  for (const w of FFASOAK_CHAOS ? pool : weapons) { wStats.set(w, { directHits: 0, splashHits: 0, directDmg: 0, splashDmg: 0, kills: 0 }); }

  const {hitLedger} = (room.messages.combat as unknown as { hitLedger: HitLedger });
  const origApplyHit = hitLedger.applyHit.bind(hitLedger);

  // Chaos mode tracking — kills are source-attributed in wStats; this
  // only counts deaths-by-held-weapon (the exposure denominator).
  const chaosDeaths = new Map<number, number>();
  const countedDeaths = new Set<string>();
  for (const w of pool) { chaosDeaths.set(w, 0); }
  // Kill dedupe: a burst volley marks result.killed on EVERY pellet of
  // the killing hit — one death = one counted kill per target per tick.
  const killTicks = new Set<string>();
  const selfKills = new Map<number, number>(); // weapon → owner-eating kills
  hitLedger.applyHit = (c, shooterId, targetId, damage, result, opts) => {
    // Spawn-only submunitions bill to the parent weapon — a ClusterBomb's
    // bomblets ARE the cluster bomb's damage, not a separate source.
    let src = opts.weapon;
    if (src === WeaponType.MRVBomblet) {src = WeaponType.MRVLauncher;}
    else if (src === WeaponType.ClusterBomblet) {src = WeaponType.ClusterBomb;}
    if (src !== undefined && wStats.has(src)) {
      const stats = wStats.get(src)!;
      const isSplash = opts.label?.includes('AOE') || opts.label?.includes('self-blast') || opts.label?.includes('Blast') || opts.label?.includes('hit') && opts.label?.includes('AOE');
      if (isSplash) { stats.splashHits++; stats.splashDmg += damage; }
      else { stats.directHits++; stats.directDmg += damage; }
      if (result.killed && !killTicks.has(`${targetId}:${tickN}`)) {
        killTicks.add(`${targetId}:${tickN}`);
        // A self-blast kill is the gun eating its owner — it already
        // counts as a death-while-held, so crediting it as a kill too
        // would pay the weapon twice for one corpse. Tracked, not scored.
        if (shooterId === targetId) {selfKills.set(src, (selfKills.get(src) ?? 0) + 1);}
        else {stats.kills++;}
      }
    }
    return origApplyHit(c, shooterId, targetId, damage, result, opts);
  };

  let winnerT = -1, simS = 0, tickN = 0;
  const wall0 = Date.now();
  const maxTicks = (CAP_S / 0.05) | 0;
  const deadSince = new Map<string, number>();
  let ring = 0;
  for (let i = 0; i < maxTicks && winnerT < 0; i++) {
    tickN = i;
    step(room, 1);
    simS = (i + 1) * 0.05;
    for (const p of bots) {
      if (p.isDead) {
        deadSince.set(p.id, (deadSince.get(p.id) ?? 0) + 0.05);
        if (deadSince.get(p.id)! >= 3) {
          deadSince.delete(p.id);
          room.players.respawnPlayer(p.id);
          if (PURE) {(p as { beltCharges: number }).beltCharges = 0;}
          if (!FFASOAK_UNPINNED) {
            const a = (ring++ / bots.length) * Math.PI * 2;
            pin(room, p.id, { x: Math.cos(a) * (FFASOAK_ARENA * 0.6), y: 65, z: Math.sin(a) * (FFASOAK_ARENA * 0.6) });
          }
        }
      } else {deadSince.delete(p.id);}
    }
    // Chaos mode: kills credit the damage SOURCE (wStats, via the
    // applyHit wrapper) — posthumous and leftover-projectile kills count
    // for the gun that dealt them, not whatever the bot holds now.
    // Deaths credit the held weapon (exposure). K/D reads "what the gun
    // did vs lives spent holding it". Rotation stays death-only, gated
    // on the life earning a kill.
    if (FFASOAK_CHAOS) {
      for (const p of bots) {
        const pk = p.kills;
        if (p.isDead && !countedDeaths.has(p.id)) {
          countedDeaths.add(p.id);
          const w = currentWeapon.get(p.id);
          if (w !== undefined) {chaosDeaths.set(w, (chaosDeaths.get(w) ?? 0) + 1);}
          if (pk > (lifeKillsBase.get(p.id) ?? 0)) {
            const newW = pool[Math.floor(crand() * pool.length)]!;
            currentWeapon.set(p.id, newW);
            const ctl = room.bots as unknown as { loadouts: Map<string, BotLoadout>; roster: { refitClass(id: string): void } };
            ctl.loadouts.set(p.id, { perk: 'none', near: newW, mid: newW, far: newW,
              belt: PURE ? newW : WeaponType.Grenade, side: PURE ? newW : WeaponType.Pistol });
            ctl.roster.refitClass(p.id);
          }
        }
        if (!p.isDead) {
          // Base resets on the first alive tick after a death — setting it
          // every alive tick would keep it equal to p.kills forever.
          if (countedDeaths.delete(p.id)) {lifeKillsBase.set(p.id, p.kills);}
        }
      }
    }
    if (FFASOAK_TDM) {
      const counts = (room as any).players?.teamCounts?.() ?? { alpha: 0, bravo: 0 };
      if (counts.alpha >= TARGET || counts.bravo >= TARGET) { winnerT = simS; }
    } else {
      for (const p of room.scoring.matchPlayers()) {if (p.kills >= TARGET) {winnerT = simS;}}
    }
  }
  const wallS = (Date.now() - wall0) / 1000;

  // Restore original method
  hitLedger.applyHit = origApplyHit;

  // Chaos: kills are source-attributed (wStats — deduped, credits the
  // weapon that dealt the kill); deaths are held-weapon exposure
  // (chaosDeaths). wOf's dealt-card labels would be wrong either way.
  const rows = FFASOAK_CHAOS
    ? [...chaosDeaths.entries()]
      .map(([w, deaths]) => ({ w: WeaponType[w]!, kills: wStats.get(w)?.kills ?? 0, deaths }))
      .filter((s) => s.kills > 0 || s.deaths > 0)
      .sort((a, b) => b.kills - a.kills)
    : room.scoring.matchPlayers()
      .filter((p) => wOf.has(p.id))
      .map((p) => ({ w: WeaponType[wOf.get(p.id)!]!, kills: p.kills, deaths: p.deaths }))
      .sort((a, b) => b.kills - a.kills);

  // Chaos mode: per-weapon tally — kills by damage source, deaths held
  if (FFASOAK_CHAOS) {
    console.log('\n--- Chaos Mode: Per-Weapon Tally (kills by source, deaths held) ---');
    console.log('weapon           | kills | deaths | K/D | selfK');
    for (const [w, deaths] of [...chaosDeaths.entries()].sort((a, b) => (wStats.get(b[0])?.kills ?? 0) - (wStats.get(a[0])?.kills ?? 0))) {
      const kills = wStats.get(w)?.kills ?? 0;
      const name = (WeaponType[w] ?? String(w)).padEnd(16);
      const kd = deaths > 0 ? (kills / deaths).toFixed(2) : (kills > 0 ? 'inf' : '0');
      console.log(`${name} | ${String(kills).padStart(5)} | ${String(deaths).padStart(6)} | ${kd.padStart(5)} | ${selfKills.get(w) ?? 0}`);
    }
  }

  // Print weaponStats snapshot (authoritative damage/kills per weapon)
  const snap = weaponStats.snapshot().byMode['dm'] ?? {};
  console.log('\n--- WeaponStats Snapshot (authoritative) ---');
  console.log('source           | shots | hits  | conn | damage | kills | botKills | botDmg');
  for (const [src, row] of Object.entries(snap).sort((a, b) => b[1].kills - a[1].kills)) {
    const wt = Number.parseInt(src.replace('w', ''));
    const name = (WeaponType[wt] ?? src).padEnd(16);
    console.log(`${name} | ${String(row.shots).padStart(5)} | ${String(row.hits).padStart(5)} | ${String(row.conn).padStart(4)} | ${Math.round(row.damage).toString().padStart(6)} | ${String(row.kills).padStart(5)} | ${String(row.botKills).padStart(8)} | ${Math.round(row.botDamage)}`);
  }

  const allPlayers = [...room.players.getAllPlayers().values()];
  return { rows, winnerT, simS, wallS, totalDeaths: allPlayers.reduce((s, p) => s + p.deaths, 0), totalKills: allPlayers.reduce((s, p) => s + p.kills, 0), wStats };
}

const argv = process.argv.slice(2);
const seeds = Number.isFinite(Number(argv[0])) && argv[0] !== undefined ? Number(argv[0]) : 4;
if (argv[1] !== undefined && Number.isFinite(Number(argv[1]))) {
  CAP_S = Number(argv[1]);
  argv.splice(1, 1);
}
// Chaos draws from the whole wildcard arsenal — every weapon a bot can
// roll in any slot (~28). Non-chaos mode keeps the curated 19 (the
// belt/side entries skew a dealt-lockout ladder, but they ARE part of
// the real kill mix chaos is measuring).
const pool = argv.slice(1).length > 0
  ? argv.slice(1).map((w) => WeaponType[w as keyof typeof WeaponType]).filter((w) => w !== undefined)
  : (FFASOAK_CHAOS
    ? [...new Set([...WILDCARD_SLOTS.near, ...WILDCARD_SLOTS.mid, ...WILDCARD_SLOTS.far, ...WILDCARD_SLOTS.belt, ...WILDCARD_SLOTS.side])]
    : ALL);

console.log(`ffasoak: ${seeds} seeds, ${BOTS} bots, dm to ${TARGET} kills, ${pool.length}-weapon pool dealt per round (impossible skill)\n`);
const agg = new Map<string, { kills: number[]; deaths: number[]; wins: number }>();
const aggStats = new Map<number, { directHits: number; splashHits: number; directDmg: number; splashDmg: number; kills: number; rounds: number }>();
for (const w of pool) { aggStats.set(w, { directHits: 0, splashHits: 0, directDmg: 0, splashDmg: 0, kills: 0, rounds: 0 }); }

for (let seed = 201; seed < 201 + seeds; seed++) {
  const r = run(deal(pool, seed), seed);
  console.log(`seed=${seed} winner=${r.winnerT < 0 ? `>${CAP_S}s` : `${r.winnerT.toFixed(0)  }s`} (simulated ${r.simS.toFixed(0)}s in ${r.wallS.toFixed(1)}s, ${(r.simS / r.wallS).toFixed(1)}x) | kills=${r.totalKills} deaths=${r.totalDeaths}`);
  r.rows.forEach((row, i) => {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${row.w.padEnd(16)} K=${row.kills.toString().padStart(3)} D=${row.deaths.toString().padStart(3)}`);
    const a = agg.get(row.w) ?? { kills: [], deaths: [], wins: 0 };
    a.kills.push(row.kills); a.deaths.push(row.deaths);
    if (i === 0) {a.wins++;}
    agg.set(row.w, a);
  });
  for (const [w, stats] of r.wStats) {
    const agg = aggStats.get(w);
    if (agg) {
      agg.directHits += stats.directHits;
      agg.splashHits += stats.splashHits;
      agg.directDmg += stats.directDmg;
      agg.splashDmg += stats.splashDmg;
      agg.kills += stats.kills;
      agg.rounds += 1;
    }
  }
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log('\nweapon           | rounds | avgKills | avgDeaths | K/D   | wins');
for (const [w, a] of [...agg.entries()].sort((x, y) => avg(y[1].kills) - avg(x[1].kills))) {
  console.log(`${w.padEnd(16)} | ${a.kills.length.toString().padStart(6)} | ${avg(a.kills).toFixed(1).padStart(8)} | ${avg(a.deaths).toFixed(1).padStart(9)} | ${(avg(a.kills) / Math.max(1, avg(a.deaths))).toFixed(2).padStart(5)} | ${a.wins}`);
}
console.log('\nweapon           | directHits | splashHits | totalHits | directDmg | splashDmg | totalDmg | trackedKills | dmg/kill');
for (const [w, stats] of [...aggStats.entries()].sort((a, b) => b[1].kills - a[1].kills)) {
  const name = WeaponType[w]!.padEnd(16);
  const totalHits = stats.directHits + stats.splashHits;
  const totalDmg = stats.directDmg + stats.splashDmg;
  const dmgPerKill = stats.kills > 0 ? (totalDmg / stats.kills).toFixed(1) : 'N/A';
  console.log(`${name} | ${String(stats.directHits).padStart(10)} | ${String(stats.splashHits).padStart(10)} | ${String(totalHits).padStart(9)} | ${Math.round(stats.directDmg).toString().padStart(9)} | ${Math.round(stats.splashDmg).toString().padStart(9)} | ${Math.round(totalDmg).toString().padStart(8)} | ${String(stats.kills).padStart(12)} | ${dmgPerKill.padStart(8)}`);
}
process.exit(0);