// Scratch: sustained-firefight benchmark — ONE bot vs a continuously
// respawning ball swarm. Three milestone timers per weapon × seed:
//   kills  — sim-seconds to 100 ball kills   (finishing power)
//   dmg    — sim-seconds to 10k applied damage (raw throughput)
//   score  — sim-seconds to 10k style score  (midair formula estimate:
//            per kill, dist × acc × est.airtime; airtime ≈ dist/muzzle
//            speed, acc fixed at 8 — server can't measure center-miss)
// The economy is real: ball kills route through ballSim.onKilled →
// RoomScore (gem drops in 'nuggets'), so the score path exercises the
// same funnels as play. endMatch is suppressed — the metric is the
// timer, not the horn.
//   bun tests/scenarios/_ballsoak.ts            # default matrix
//   bun tests/scenarios/_ballsoak.ts 4 Chaingun Disc  # subset
//   bun tests/scenarios/_ballsoak.ts creatures 1 3600  # creature swarm instead of balls
import { mkRoom, step, pin, watch } from './harness.ts';
import { WEAPONS, WeaponType } from '../../../shared/weapons.ts';
import type { BotLoadout } from '../../../shared/botLoadouts.ts';
import type { PlayerState } from '../../src/types.ts';

type Room = ReturnType<typeof mkRoom>;

const TARGET_KILLS = 100;
const TARGET_DMG = 10_000;
const TARGET_SCORE = 10_000;
let CAP_S = 3600; // sim-seconds before a weapon is declared unable; argv[2] overrides
const BALLS = 40;   // live target density — balls spawn near the bot anyway
let BEASTS: 'balls' | 'creatures' = 'balls'; // argv 'creatures' flips the swarm
// Creature pack: the same light wildlife maps field — crawlers are the
// fodder analogue (70hp hop-family), snakes/rakks are faster, totems the
// heavy. Continuous respawn to cap keeps target density live.
const POPS: Record<string, number> = { crawler: 20, snake: 8, rakk: 8, totem: 4 };

const botOf = (room: Room): PlayerState => {
  const b = [...room.players.getAllPlayers().values()].find((p) => p.isBot);
  if (!b) throw new Error('ballsoak: no bot');
  return b;
};

function run(weapon: WeaponType, seed: number): { kills: number; dmg: number; score: number; shots: number; huntUp: number; tK: number; tD: number; tS: number; simS: number; wallS: number } {
  // 'nuggets' is the only mode where brains FARM the swarm — huntCreatures
  // widens ball engagement from 30m self-defense to 65m hunting, which is
  // exactly the "shoot the resource bag" loop being benchmarked. 'dm'
  // leaves the bot ignoring a target-rich field for phantom players.
  // 'impossible' tier: the benchmark prices weapons, not potato aim —
  // medium-skill shots scatter ~3× wider and starve the metric.
  const room = mkRoom({
    mode: 'nuggets', bots: 1, botSkill: 'impossible',
    bases: { alpha: { x: -200, y: 60, z: 0 }, bravo: { x: 200, y: 60, z: 0 } },
    ...(BEASTS === 'balls'
      ? { balls: { base: BALLS, perPlayer: 0, max: BALLS + 10 } }
      : { creatures: POPS }),
  }, 'nuggets', seed);
  const bot = botOf(room);
  const lo: BotLoadout = { perk: 'none', near: weapon, mid: weapon, far: weapon, belt: WeaponType.Grenade, side: WeaponType.Pistol };
  const ctl = room.bots as unknown as { loadouts: Map<string, BotLoadout>; roster: { refitClass(id: string): void } };
  ctl.loadouts.set(bot.id, lo);
  ctl.roster.refitClass(bot.id);
  pin(room, bot.id, { x: 0, y: 65, z: 0 });
  (room as { endMatch: (w: string) => void }).endMatch = () => {};

  // Instrumented counters over the real damage/kill funnels.
  let kills = 0, dmg = 0, score = 0;
  const speed = WEAPONS[weapon]?.speed ?? 50;
  const credit = (by: string, pos: { x: number; y: number; z: number }) => {
    if (by !== bot.id) return;
    kills++;
    const d = Math.hypot(pos.x - bot.position.x, pos.y - bot.position.y, pos.z - bot.position.z);
    score += Math.round(8 * d * (d / speed)); // midair-style: acc×dist×airtime(est)
  };
  if (BEASTS === 'balls') {
    const origKilled = room.ballSim.onKilled;
    room.ballSim.onKilled = (by, pos, variant) => { origKilled?.(by, pos, variant); credit(by, pos); };
    // Wrap at the BallCombat funnel, not BallSim.handleHit — splash paths
    // (preySplash → splashDamage) call combat.handleHit internally and
    // would otherwise escape the damage counter.
    const combat = (room.ballSim as unknown as {
      combat: { handleHit(pid: string, id: number, d: number, kx?: number, ky?: number, kz?: number): { killed: boolean } };
    }).combat;
    const origHit = combat.handleHit.bind(combat);
    combat.handleHit = (pid, id, d, kx, ky, kz) => {
      const v = origHit(pid, id, d, kx, ky, kz);
      if (pid === bot.id) dmg += Math.max(1, Math.min(d, 400));
      return v;
    };
  } else {
    const cs = room.creatureSim as unknown as {
      onKilled: ((by: string, pos: { x: number; y: number; z: number }) => void) | null;
      handleHit(pid: string, id: number, d: number): { killed: boolean };
    };
    const origKilled = cs.onKilled;
    cs.onKilled = (by, pos) => { origKilled?.(by, pos); credit(by, pos); };
    const origHit = cs.handleHit.bind(cs);
    cs.handleHit = (pid, id, d) => {
      const v = origHit(pid, id, d);
      if (pid === bot.id) dmg += Math.max(1, Math.min(d, 400));
      return v;
    };
  }

  const w = watch(room);
  let huntTicks = 0;
  const brains = (room.bots as unknown as { brains: Map<string, { h: { hunt?: unknown } }> }).brains;

  let tK = -1, tD = -1, tS = -1;
  let simS = 0;
  const wall0 = Date.now();
  const maxTicks = (CAP_S / 0.05) | 0;
  for (let i = 0; i < maxTicks && (tK < 0 || tD < 0 || tS < 0); i++) {
    // God-mode: the swarm grinds the bot to 0hp in ~1h and the harness
    // never respawns it. Survival isn't the metric — sustained fire is.
    bot.health = bot.maxHealth;
    bot.isDead = false;
    step(room, 1);
    simS = (i + 1) * 0.05;
    if (brains.get(bot.id)?.h.hunt) huntTicks++;
    const t = (i + 1) * 0.05;
    if (tK < 0 && kills >= TARGET_KILLS) tK = t;
    if (tD < 0 && dmg >= TARGET_DMG) tD = t;
    if (tS < 0 && score >= TARGET_SCORE) tS = t;
  }
  const wallS = (Date.now() - wall0) / 1000;
  return { kills, dmg, score, shots: w.count('projectileCreated'), huntUp: huntTicks / maxTicks, tK, tD, tS, simS, wallS };
}

const argv = process.argv.slice(2);
if (argv[0] === 'creatures' || argv[0] === 'balls') { BEASTS = argv[0] as 'balls' | 'creatures'; argv.shift(); }
const seeds = Number.isFinite(Number(argv[0])) && argv[0] !== undefined ? Number(argv[0]) : 6;
if (argv[1] !== undefined && Number.isFinite(Number(argv[1]))) {
  CAP_S = Number(argv[1]);
  argv.splice(1, 1);
}
const wanted = argv.slice(1).length
  ? argv.slice(1).map((w) => WeaponType[w as keyof typeof WeaponType]).filter((w) => w !== undefined)
  : [WeaponType.Chaingun, WeaponType.Sprinkler, WeaponType.PlasmaGun, WeaponType.Shotgun,
     WeaponType.Disc, WeaponType.BoltLauncher, WeaponType.RocketLauncher, WeaponType.Cannon,
     WeaponType.Mortar, WeaponType.GrenadeLauncher];

const fmt = (t: number) => (t < 0 ? `>${CAP_S}` : t.toFixed(1));
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[(s.length / 2) | 0]!; };

console.log(`ballsoak[${BEASTS}]: ${seeds} seeds/weapon, ${BEASTS === 'balls' ? BALLS + ' live balls' : Object.values(POPS).reduce((a, b) => a + b) + ' creatures'}, nuggets single-bot (impossible skill)\n`);
console.log('weapon           | t100kills med/best/avg | t10kDmg med/best/avg | t10kScore med/best/avg');
for (const w of wanted) {
  const tKs: number[] = [], tDs: number[] = [], tSs: number[] = [];
  for (let seed = 101; seed < 101 + seeds; seed++) {
    const r = run(w, seed);
    tKs.push(r.tK); tDs.push(r.tD); tSs.push(r.tS);
    console.log(`  seed=${seed} kills=${r.kills} dmg=${r.dmg} score=${r.score} shots=${r.shots} huntUp=${(r.huntUp * 100).toFixed(0)}% tK=${fmt(r.tK)} tD=${fmt(r.tD)} tS=${fmt(r.tS)} (simulated ${r.simS.toFixed(0)}s in ${r.wallS.toFixed(1)}s, ${(r.simS / r.wallS).toFixed(1)}x)`);
  }
  const row = (xs: number[]) =>
    `${fmt(med(xs))}/${fmt(Math.min(...xs))}/${fmt(xs.reduce((a, b) => a + b, 0) / xs.length)}`;
  console.log(`${WeaponType[w].padEnd(16)} | ${row(tKs).padEnd(22)} | ${row(tDs).padEnd(22)} | ${row(tSs)}`);
}
process.exit(0);
