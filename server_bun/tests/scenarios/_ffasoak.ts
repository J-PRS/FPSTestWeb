// Scratch: weapon-vs-weapon balance matrix — a 10-bot FFA deathmatch
// where each bot is locked to ONE weapon for the whole match, run over
// several seeds. The leaderboard IS the balance table: kills, deaths,
// K/D and sim-seconds-to-50 (or the cap) per weapon against dodging
// targets, not dummies — the complement to the ballswarm throughput
// bench.
//   bun tests/scenarios/_ffasoak.ts            # default 10 weapons
//   bun tests/scenarios/_ffasoak.ts 2 Railgun Mortar  # subset, 2 seeds
import { mkRoom, step, pin } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { BotLoadout } from '../../../shared/botLoadouts.ts';
import { weaponStats } from '../../src/weaponStats.ts';

const TARGET = 50;      // kills to win the FFA
let CAP_S = 2400;       // sim-seconds; argv[1] overrides
const BOTS = 10;
// Arena radius = map footprint. 80m is a cage match (flatters brawl
// guns); 300m is a plausible DM field — still small enough that wander
// can't disperse 10 fighters past sight range on open ground.
const FFASOAK_ARENA = Number(process.env.FFASOAK_ARENA) || 300;

// Every offensive primary — 16 weapons > 10 seats, so each round deals a
// shuffled subset and coverage builds across seeds.
const ALL: WeaponType[] = [
  WeaponType.Chaingun, WeaponType.PlasmaGun, WeaponType.Shotgun, WeaponType.Disc,
  WeaponType.BoltLauncher, WeaponType.RocketLauncher, WeaponType.Cannon,
  WeaponType.Mortar, WeaponType.GrenadeLauncher, WeaponType.Railgun,
  WeaponType.Flak, WeaponType.PlasmaCannon, WeaponType.Lightning,
  WeaponType.Sticky, WeaponType.MRVLauncher, WeaponType.Sprinkler,
];

/** Deal BOTS weapons from the pool — distinct seats, so a round reads as
 *  a real lobby, not 10 mirrors of the same gun. Seed-keyed shuffle. */
function deal(pool: WeaponType[], seed: number): WeaponType[] {
  const deck = [...pool];
  let s = seed | 0 || 1;
  for (let i = deck.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  // A pool smaller than BOTS cycles — a 2-weapon arg means a 5v5 duel
  // bench, not four bots drawing `undefined` (that used to crash the
  // leaderboard print with row.w === undefined).
  if (deck.length === 0) return deck;
  while (deck.length < BOTS) deck.push(deck[deck.length % pool.length]!);
  return deck.slice(0, BOTS);
}

function run(weapons: WeaponType[], seed: number): { rows: { w: string; kills: number; deaths: number }[]; winnerT: number; simS: number; wallS: number } {
  // Arena boundary = contact pressure: without it the 2km field lets
  // bots disperse past hunt range and the match starves (all action in
  // the first second, then silence). RoomArena shoves rim offenders
  // back in, which is what a real FFA lobby does to itself.
  const room = mkRoom({ mode: 'dm', bots: BOTS, botSkill: 'impossible', arena: { x: 0, z: 0, radius: FFASOAK_ARENA } }, 'dm', seed);
  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  const ctl = room.bots as unknown as {
    loadouts: Map<string, BotLoadout>;
    roster: { refitClass(id: string): void; applyClass(p: { id: string; maxHealth: number; health: number }, cls: string): void };
  };
  for (let i = 0; i < bots.length; i++) {
    const w = weapons[i]!;
    ctl.loadouts.set(bots[i]!.id, { perk: 'none', near: w, mid: w, far: w, belt: WeaponType.Grenade, side: WeaponType.Pistol });
    ctl.roster.refitClass(bots[i]!.id);
    // Weapon-vs-weapon, not body-vs-body: every fighter runs the medium
    // frame so light/heavy silhouettes don't confound the gun ranking.
    // FFASOAK_CLASSES=1 restores the loadout-driven tier for kit-faithful runs.
    if (!process.env.FFASOAK_CLASSES) {
      bots[i]!.armorClass = 'medium';
      ctl.roster.applyClass(bots[i]!, 'medium');
    }
    // Tight ring: the 2km map lets bots disperse past hunt range and
    // the "match" starves — a real FFA keeps contact pressure.
    const a = (i / bots.length) * Math.PI * 2;
    pin(room, bots[i]!.id, { x: Math.cos(a) * (FFASOAK_ARENA * 0.6), y: 65, z: Math.sin(a) * (FFASOAK_ARENA * 0.6) });
  }
  (room as { endMatch: (w: string) => void }).endMatch = () => {};

  const wOf = new Map(bots.map((b, i) => [b.id, weapons[i]!]));

  let winnerT = -1, simS = 0;
  const wall0 = Date.now();
  const maxTicks = (CAP_S / 0.05) | 0;
  const deadSince = new Map<string, number>();
  let ring = 0;
  for (let i = 0; i < maxTicks && winnerT < 0; i++) {
    step(room, 1);
    simS = (i + 1) * 0.05;
    // The harness never respawns corpses (same reason ballsoak went
    // god-mode) — a real FFA brings the dead back. 3 sim-s downtime,
    // back onto the arena ring so the fight stays joined.
    for (const p of bots) {
      if (p.isDead) {
        deadSince.set(p.id, (deadSince.get(p.id) ?? 0) + 0.05);
        if (deadSince.get(p.id)! >= 3) {
          deadSince.delete(p.id);
          room.players.respawnPlayer(p.id);
          const a = (ring++ / bots.length) * Math.PI * 2;
          pin(room, p.id, { x: Math.cos(a) * (FFASOAK_ARENA * 0.6), y: 65, z: Math.sin(a) * (FFASOAK_ARENA * 0.6) });
        }
      } else deadSince.delete(p.id);
    }
    for (const p of room.scoring.matchPlayers()) if (p.kills >= TARGET) winnerT = simS;
  }
  const wallS = (Date.now() - wall0) / 1000;
  const rows = room.scoring.matchPlayers()
    .filter((p) => wOf.has(p.id))
    .map((p) => ({ w: WeaponType[wOf.get(p.id)!]!, kills: p.kills, deaths: p.deaths }))
    .sort((a, b) => b.kills - a.kills);
  return { rows, winnerT, simS, wallS };
}

const argv = process.argv.slice(2);
const seeds = Number.isFinite(Number(argv[0])) && argv[0] !== undefined ? Number(argv[0]) : 4;
if (argv[1] !== undefined && Number.isFinite(Number(argv[1]))) {
  CAP_S = Number(argv[1]);
  argv.splice(1, 1);
}
const pool = argv.slice(1).length
  ? argv.slice(1).map((w) => WeaponType[w as keyof typeof WeaponType]).filter((w) => w !== undefined)
  : ALL;

console.log(`ffasoak: ${seeds} seeds, ${BOTS} bots, dm to ${TARGET} kills, ${pool.length}-weapon pool dealt per round (impossible skill)\n`);
const agg = new Map<string, { kills: number[]; deaths: number[]; wins: number }>();
for (let seed = 201; seed < 201 + seeds; seed++) {
  const r = run(deal(pool, seed), seed);
  console.log(`seed=${seed} winner=${r.winnerT < 0 ? `>${CAP_S}s` : r.winnerT.toFixed(0) + 's'} (simulated ${r.simS.toFixed(0)}s in ${r.wallS.toFixed(1)}s, ${(r.simS / r.wallS).toFixed(1)}x)`);
  r.rows.forEach((row, i) => {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${row.w.padEnd(16)} K=${row.kills.toString().padStart(3)} D=${row.deaths.toString().padStart(3)}`);
    const a = agg.get(row.w) ?? { kills: [], deaths: [], wins: 0 };
    a.kills.push(row.kills); a.deaths.push(row.deaths);
    if (i === 0) a.wins++;
    agg.set(row.w, a);
  });
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log('\nweapon           | rounds | avgKills | avgDeaths | K/D   | wins');
for (const [w, a] of [...agg.entries()].sort((x, y) => avg(y[1].kills) - avg(x[1].kills))) {
  console.log(`${w.padEnd(16)} | ${a.kills.length.toString().padStart(6)} | ${avg(a.kills).toFixed(1).padStart(8)} | ${avg(a.deaths).toFixed(1).padStart(9)} | ${(avg(a.kills) / Math.max(1, avg(a.deaths))).toFixed(2).padStart(5)} | ${a.wins}`);
}
// Accuracy half of the ledger: weaponStats funnels every pull/hit by
// weapon id — the table a K/D row can't tell (a hose can post weak
// kills on strong accuracy, a lucky mortar the reverse).
const snap = weaponStats.snapshot().byMode['dm'] ?? {};
console.log('\nweapon           | shots | hits  | acc%  | dmg');
for (const [w] of [...agg.entries()].sort((x, y) => avg(y[1].kills) - avg(x[1].kills))) {
  const wt = (WeaponType as unknown as Record<string, number>)[w];
  const s = snap[`w${wt}`] ?? { shots: 0, hits: 0, damage: 0 };
  console.log(`${w.padEnd(16)} | ${String(s.shots).padStart(5)} | ${String(s.hits).padStart(5)} | ${(s.shots ? (100 * s.hits / s.shots) : 0).toFixed(1).padStart(5)} | ${Math.round(s.damage)}`);
}
process.exit(0);
