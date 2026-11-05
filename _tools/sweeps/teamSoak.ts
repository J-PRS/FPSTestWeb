/**
 * teamSoak.ts — themed team-vs-team warp soak: one weapon (or kit) per
 * side, a real map, real spawns, N sim-minutes in a few wall-seconds.
 *
 *   bun _tools/sweeps/teamSoak.ts --alpha Railgun --bravo Mortar
 *   bun _tools/sweeps/teamSoak.ts --alpha Disc --bravo Chaingun --mode ctf --mins 20
 *   bun _tools/sweeps/teamSoak.ts --alpha Railgun --alpha2 Pistol --bravo Mortar --berserk
 *
 * Why: the ladder/balance sweeps pit weapons against a MIXED field, which
 * answers "which gun wins a lobby" but not "what does a railgun line do
 * to an artillery battery". Locking a whole side to one weapon makes the
 * team fight legible — the scoreline, the weapon ledger and the class mix
 * are all one matchup.
 *
 * Mechanics: bots are real roster entries (brains, move shadows, weapons
 * fed through the normal claim funnel). The kit is injected exactly like
 * the duel scenarios do it (loadouts map + roster.refitClass) and then the
 * room is warped on the sim clock, so respawns/shields/match timers lapse
 * in sim-time — minutes of combat, not minutes of waiting.
 *
 *   --alpha W --bravo W   primary for each side (WeaponType name)
 *   --mix                 each side fields BOTH weapons, half/half — kills
 *                         the spawn-side skew mirrors expose; the verdict
 *                         table reads per-weapon K/D instead of per-side
 *   --alpha2/--bravo2 W   optional secondary: slots 2-3 instead of the
 *                         primary at close range (see BOT_SIDEARM_M)
 *   --per N               bots PER SIDE (default 8)
 *   --mins M              sim-minutes to warp (default 10)
 *   --wall S              hard wall-clock cap in seconds (default 120)
 *   --map NAME            real map (default katabatic's bare field)
 *   --mode M              tdm | ctf | dm (default tdm)
 *   --class T             pin every body to light|medium|heavy (default:
 *                         kit-faithful — the loadout picks the chassis)
 *   --seat ring|map|wide  ring = two facing lines at +-RING (default);
 *                         map = hand spawning to the real spawnPicker —
 *                         foe-clearance scoring over the flat `spawns`
 *                         pool, randomized inside each sphere;
 *                         wide = re-seat each respawn at a random range
 *                         (60-200m) from a random enemy — mixes the fight
 *                         distances so far guns aren't starved by the
 *                         picker's max-clearance rim spawns
 *   --berserk             never holster the primary (pickBotWeapon as-is,
 *                         not pickBotWeaponSafe) — artillery keeps firing
 *   --arena M             XZ arena radius in metres, 0 = map's own bound
 *   --seed S              room seed
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { WeaponType, WEAPONS, WEAPON_FIRE_INTERVAL_S } from '../../shared/weapons.ts';
import { pickBotWeapon, kitConsistent, rollWildcard, type BotLoadout } from '../../shared/botLoadouts.ts';
import { mkRoom, step, pin } from '../../server_bun/tests/scenarios/harness.ts';
import { simNow, simNowAdvance } from '../../server_bun/src/simClock.ts';
import { weaponStats } from '../../server_bun/src/weaponStats.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const has = (name: string): boolean => process.argv.includes('--' + name);

const weapon = (name: string): WeaponType => {
  const w = (WeaponType as unknown as Record<string, number>)[name];
  if (w === undefined) {
    console.error(`teamSoak: unknown weapon "${name}" — try Railgun/Mortar/Disc/Chaingun/...`);
    process.exit(2);
  }
  return w as WeaponType;
};

const MAP = arg('map', 'katabatic');
const MODE = arg('mode', 'tdm');
const PER = Number(arg('per', 8));
const MINS = Number(arg('mins', 10));
const WALL_S = Number(arg('wall', 120));
const SEED = Number(arg('seed', 1337));
const CLASS = arg('class', '');
// Contact pressure. TDM/DM have no objective to converge on, and on a 1.5km
// field 16 bots spread past hunt range and starve (measured: nearest foe
// 773-798m, hunt 0%, zero shots over 10 sim-min). RoomArena does NOT fix
// this — its pull-back shove was removed and it only warnings now — so the
// soak does what a real TDM lobby does to itself: both sides spawn facing
// each other inside sight range (`--ring` = the half-separation in metres),
// and re-seat there on every respawn so the fight can't drift apart.
const RING = Number(arg('ring', MODE === 'ctf' ? 0 : 70));
// Arena is a DOME for bot roam targets only (RoomArena never shoves), so it
// stays off unless asked for.
const ARENA = Number(arg('arena', 0));
const BERSERK = has('berserk');
const SEAT = arg('seat', 'ring');
const MIX = has('mix');
// --wild: every bot rolls a wildcard kit — the lobby read, not the
// matchup. The weapon ledger is the payload; the side table is noise.
const WILD = has('wild');
// --force: bots always fire the dealt weapon at ANY range — no band fit,
// no holster gate. Paired with the ledger's per-band table this measures
// each gun's real range curve instead of the band the AI chose for it.
const FORCE = has('force');
// --cycle: every kill walks the killer to the next pool weapon — one run
// exercises every gun across every fight instead of a 120-run matrix.
const CYCLE = has('cycle');
const A_W = weapon(arg('alpha', 'Railgun'));
const B_W = weapon(arg('bravo', 'Mortar'));
// Secondary: when set, slots 2+3 use it — the bot still carries the primary
// long, but draws the secondary inside its own range band.
const A2_W = arg('alpha2', '') ? weapon(arg('alpha2', '')) : null;
const B2_W = arg('bravo2', '') ? weapon(arg('bravo2', '')) : null;

/** katabatic's stands live in the _bare spec (t2 ports need their own
 *  extracted assets); every other map reads straight off its JSON. */
const SPEC_NAME = MAP === 'katabatic' ? 'katabatic_bare' : MAP;
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${SPEC_NAME}.json`), 'utf8')) as {
  bases?: { alpha: { x: number; z: number }; bravo: { x: number; z: number } };
  teamSpawns?: Record<string, { x: number; z: number; r?: number; w?: number }[]>;
  terrain?: string;
  arena?: { x: number; z: number; radius: number };
};
const field: Heightfield = hmParseBin(new Uint8Array(readFileSync(
  resolve(import.meta.dir, `../../maps/${spec.terrain ?? (MAP === 'katabatic' ? 'katabatic' : MAP) + '.bin'}`))));
const at = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });

const dt = 0.05;               // 20Hz — the live tick
const BATCH = 20;              // sim-s per warp batch (stamped msgs stay legible)
const ctf = MODE === 'ctf' && !!spec.bases;
// Sheep-meter verdicts fire per llama-life and drown the match report —
// same diversion fastSoak uses; the file keeps them for triage.
process.env.FPS_SHEEP_LOG ??= resolve(import.meta.dir, '../../run/teamsoak.log');

// seat=map hands respawns to the real spawnPicker: strip team pools and
// bases so the flat `spawns` list is scored purely by foe clearance —
// authored team spheres sit at bases hundreds of metres apart, which is
// the transit starvation the ring seating exists to avoid.
const soakSpec = { ...spec };
if (SEAT === 'map' && !ctf) {
  soakSpec.teamSpawns = undefined;
  soakSpec.bases = undefined;
}
const room = mkRoom({
  ...soakSpec,
  mode: MODE,
  bots: PER * 2,
  botFill: PER * 2,
  arena: ARENA > 0 ? { x: spec.arena?.x ?? 0, z: spec.arena?.z ?? 0, radius: ARENA } : spec.arena,
  ...(ctf ? {
    bases: { alpha: at(spec.bases!.alpha.x, spec.bases!.alpha.z), bravo: at(spec.bases!.bravo.x, spec.bases!.bravo.z) },
    teamSpawns: Object.fromEntries(Object.entries(spec.teamSpawns ?? {}).map(([t, ss]) => [
      t, ss.map((s) => ({ x: s.x, y: hmHeight(field, s.x, s.z), z: s.z, r: s.r ?? 50, w: s.w ?? 90 })),
    ])),
  } : {}),
}, MODE, SEED, false, field);
// The soak drives the roster itself — an honored botFill would cull the
// injected fleet back to the map's own count on the first tick. When
// --per exceeds the spec.bots clamp (16 total), the fill floor is the
// way up instead: maintain() tops the fleet to the target on tick 1.
// --wild only: top-up bots mint with roster kits, which a pinned bench
// would read as un-dealt ringers.
room.spec.botFill = PER > 8 && (WILD || CYCLE) ? PER * 2 : 0;

const ctl = room.bots as unknown as {
  loadouts: Map<string, BotLoadout>;
  roster: {
    alts: Map<string, Partial<Record<string, WeaponType[]>>>;
    refitClass(id: string): void;
    applyClass(p: { id: string; maxHealth: number; health: number }, cls: string): void;
  };
  arsenal: { pickWeapon(l: BotLoadout, dxz: number, d: number): number };
};
// Bench isolation: the wounded-holster gate swaps ANY aoe primary for the
// sidearm under ~60-75hp — i.e. it holsters the artillery exactly when the
// artillery matters. --berserk keeps bots on their dealt gun.
if (BERSERK) {
  ctl.arsenal.pickWeapon = (l: BotLoadout, dxz: number, d: number): number => pickBotWeapon(l, dxz, d);
}
if (FORCE) {
  ctl.arsenal.pickWeapon = (l: BotLoadout): number => l.far;
}

const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
const sides: Record<'alpha' | 'bravo', { id: string; team: string }[]> = { alpha: [], bravo: [] };
const wOf = new Map<string, WeaponType>();
const badKits: string[] = [];
const kitOf = (w: WeaponType, second: WeaponType | null): BotLoadout => ({
  perk: 'none',
  near: second ?? w, mid: second ?? w, far: w,
  belt: WeaponType.Grenade, side: w, // each gun finishes with itself - a hardcoded Pistol side made it collect every weapon's finisher kills
});
// Own seeded stream for wildcard rolls — keeping the bench off the room's
// rng keeps a wild run's sim byte-identical to the same room without it.
let wrs = (SEED * 2654435761) >>> 0 || 1;
const wrand = (): number => ((wrs = (wrs * 1664525 + 1013904223) >>> 0) / 4294967296);
// Cycle pool = every fireable WeaponType — minus the utility rows:
// heals/tools/buffs/debuffs (Repair, Satchel, *Grenade buffs, EMP,
// Concussion, Hook) aren't kill weapons and just fill the table with
// bookkeeping noise. --all-weapons restores the full pool for when
// the question IS "what does the utility row do".
const ALL_WEAPONS = has('all-weapons');
const UTILITY_WTS = new Set<number>([
  WeaponType.ClusterBomblet, WeaponType.MRVBomblet, WeaponType.Slam,
  WeaponType.HealBeam, WeaponType.Repair, WeaponType.HealGrenade,
  WeaponType.ArmorGrenade, WeaponType.SatchelCharge, WeaponType.EMP,
  WeaponType.Concussion, WeaponType.Hook,
]);
const CYCLE_POOL = (Object.keys(WEAPONS).map(Number) as WeaponType[]).filter((w) =>
  ALL_WEAPONS || !UTILITY_WTS.has(w));
const arm = (p: { id: string }, w: WeaponType): void => {
  const kit = kitOf(w, null);
  ctl.loadouts.set(p.id, kit);
  ctl.roster.refitClass(p.id);
  ctl.loadouts.set(p.id, kit); // far->Mortar rewrite on heavies — same double-write
  wOf.set(p.id, w);
};
for (const [bi, p] of bots.entries()) {
  const team = p.team === 'bravo' ? 'bravo' : 'alpha';
  if (CYCLE) {
    arm(p, CYCLE_POOL[bi % CYCLE_POOL.length]);
    sides[team].push({ id: p.id, team });
    continue;
  }
  if (WILD) {
    // The room's own kit machinery does the rest: wildcard roll, class
    // derives from the kit, adaptation stays armed (alts untouched).
    const kit = rollWildcard(wrand);
    ctl.loadouts.set(p.id, kit);
    ctl.roster.refitClass(p.id);
    ctl.loadouts.set(p.id, kit); // far->Mortar rewrite on heavies — same double-write
    wOf.set(p.id, kit.far);
    sides[team].push({ id: p.id, team });
    continue;
  }
  // --mix: half of EACH side gets each weapon, so both guns fight on both
  // terrain facings in the same match — the report reads per-weapon.
  const w = MIX ? (sides[team].length % 2 === 0 ? A_W : B_W) : (team === 'alpha' ? A_W : B_W);
  const second = MIX ? null : (team === 'alpha' ? A2_W : B2_W);
  wOf.set(p.id, w);
  const kit = kitOf(w, second);
  // Order matters. refitClass derives the body from the kit AND rewrites
  // `far` to Mortar on any heavy ("heavies shoulder the mortar" — product
  // behavior we keep), so the kit is written twice: once for the tier
  // derivation, then again to put the bench's gun back. Without the second
  // write a "PlasmaCannon team" silently fields Mortar at range.
  ctl.loadouts.set(p.id, kit);
  if (CLASS) {
    p.armorClass = CLASS as typeof p.armorClass;
    ctl.roster.applyClass(p, CLASS);
  } else {
    ctl.roster.refitClass(p.id);
  }
  ctl.loadouts.set(p.id, kit);
  // Kill the per-slot alternates too. Respawn adaptation (adaptLoadout)
  // rerolls every slot that HAS candidates toward the bot's own skill
  // matrix — left alone, each team's lock leaks away life by life
  // (measured: a "railgun vs mortar" run grew Chaingun/Shotgun/BoltLauncher
  // rows). No candidates = nothing to reroll = the kit the bench dealt.
  ctl.roster.alts.set(p.id, {});
  // A kit the body can't legally fire is the quietest way to lose a bench:
  // every shot is refused as "class-locked weapon" and the ledger reads as
  // a broken weapon instead of an illegal matchup.
  if (!kitConsistent({ ...kit, perk: 'none' }) && !badKits.includes(WeaponType[w])) {badKits.push(WeaponType[w]);}
  sides[team].push({ id: p.id, team });
}
// Two facing lines around the origin: alpha at -RING, bravo at +RING, each
// side spread across Z so a squad reads as a squad. `pin` also clears spawn
// protection — a bench wants bullets flying in the first second.
const ringPos = (team: 'alpha' | 'bravo', i: number, n: number): { x: number; y: number; z: number } => {
  const spread = RING * 1.6;
  const z = n > 1 ? (i / (n - 1) - 0.5) * 2 * spread : 0;
  const x = team === 'alpha' ? -RING : RING;
  return { x, y: hmHeight(field, x, z) + 2, z };
};
// Seat rng is separate from the room's stream — seating noise shouldn't
// perturb the sim's own draws (reproducible across seat modes on a seed).
let seatState = (SEED * 2654435761) >>> 0 || 1;
const seatRand = (): number => {
  seatState = (seatState * 1664525 + 1013904223) >>> 0;
  return seatState / 4294967296;
};
/** wide: drop the respawner at a random 60-200m gap from a random living
 *  enemy — enough spread that every range band sees traffic, near enough
 *  that transit never starves the fight. */
const widePos = (team: 'alpha' | 'bravo'): { x: number; y: number; z: number } => {
  const foes = sides[team === 'alpha' ? 'bravo' : 'alpha'];
  let cx = 0, cz = 0, n = 0;
  for (const f of foes) {
    const p = room.players.getPlayer(f.id);
    if (p && !p.isDead) {cx += p.position.x; cz += p.position.z; n += 1;}
  }
  if (n) {cx /= n; cz /= n;}
  const a = seatRand() * Math.PI * 2;
  const d = 60 + seatRand() * 140;
  const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
  return { x, y: hmHeight(field, x, z) + 2, z };
};
const seat = (team: 'alpha' | 'bravo', i: number): void => {
  const list = sides[team];
  const bot = list[i];
  if (!bot) {return;}
  pin(room, bot.id, SEAT === 'wide' ? widePos(team) : ringPos(team, i, list.length));
};
const DO_SEAT = SEAT === 'wide' || (SEAT === 'ring' && RING > 0);
if (DO_SEAT) {
  for (let i = 0; i < sides.alpha.length; i += 1) {seat('alpha', i);}
  for (let i = 0; i < sides.bravo.length; i += 1) {seat('bravo', i);}
}
const sideOf = new Map<string, { team: 'alpha' | 'bravo'; i: number }>();
for (const team of ['alpha', 'bravo'] as const) {
  sides[team].forEach((b, i) => sideOf.set(b.id, { team, i }));
}
// The match never ends mid-warp: endMatch flips scores to a result screen
// and the soak would measure a dead room.
(room as { endMatch: (w: string) => void }).endMatch = () => {};
if (badKits.length) {
  console.log(`  WARNING: ${badKits.join('/')} kit is not fireable by its own class — every shot will be refused as class-locked. Drop --class, or expect a dud ledger.`);
}

const classMix = (team: 'alpha' | 'bravo'): string => {
  const n: Record<string, number> = {};
  for (const p of bots) {if ((p.team ?? 'alpha') !== team) {continue;} n[p.armorClass ?? '?'] = (n[p.armorClass ?? '?'] ?? 0) + 1;}
  return Object.entries(n).map(([k, v]) => `${k}x${v}`).join(' ');
};

// FPS_SIM_PROF=1 (env) — per-sim wall-time rollup so a sudden warp
// collapse names the phase that owns it instead of being a mystery factor.
const simProf = process.env.FPS_SIM_PROF
  ? (() => {
    const acc = new Map<string, number>();
    room.sims.forEach((s) => {
      const inner = s.tick.bind(s);
      s.tick = (d: number): void => { const t = performance.now(); inner(d); acc.set(s.name ?? '?', (acc.get(s.name ?? '?') ?? 0) + (performance.now() - t)); };
    });
    return acc;
  })()
  : null;

const statBefore = new Map<string, { shots: number; hits: number; damage: number; kills: number; conn: number; dist?: Record<string, number>; band?: Record<string, { h: number; d: number; k: number }> }>();
const snapTable = () => weaponStats.snapshot().byMode[MODE] ?? {};
for (const [k, v] of Object.entries(snapTable())) {
  statBefore.set(k, { shots: v.shots, hits: v.hits, damage: v.damage, kills: v.kills, conn: v.conn ?? 0,
    dist: v.dist ? { ...v.dist } : undefined,
    band: v.band ? JSON.parse(JSON.stringify(v.band)) : undefined });
}

console.log(`teamSoak: ${PER}v${PER} ${MODE} on ${SPEC_NAME} seed=${SEED} — ${CYCLE ? `CYCLE pool x${CYCLE_POOL.length} (kill = next gun)` : WILD ? 'ALL WILDCARD kits' : `alpha=${WeaponType[A_W]}${A2_W ? '+' + WeaponType[A2_W] : ''} (${classMix('alpha')}) vs bravo=${WeaponType[B_W]}${B2_W ? '+' + WeaponType[B2_W] : ''} (${classMix('bravo')})`}`);
console.log(`  warping up to ${MINS} sim-min (wall cap ${WALL_S}s)${BERSERK ? ' — berserk (no holster)' : ''}${ctf ? ' — flags live' : ''}\n`);

const wall0 = performance.now();
const maxTicks = Math.floor((MINS * 60) / dt);
let ticks = 0;
const lifeStart = new Map<string, number>();
// In --mix the meaningful bucket is the dealt weapon, not the side.
const labelOf = (p: { id: string; team?: string }): string =>
  (MIX ? WeaponType[wOf.get(p.id)!] : (p.team === 'bravo' ? 'bravo' : 'alpha'));
const lives = new Map<string, number[]>();
const pushLife = (label: string, s: number): void => {
  const l = lives.get(label) ?? [];
  l.push(s); lives.set(label, l);
};
const wasDead = new Set<string>();
// Kill-watch for --cycle: scores.kills is the room's own counter, so a
// delta on any tick means that bot's gun earned the walk to the next pool
// weapon. The swap lands between batches — the next fire tick sees it.
const lastKills = new Map<string, number>();
// Contact probe — a matchup where the two sides never meet produces a
// perfectly balanced 0-0 and reads like a bug in the report, so the soak
// reports the legs it walks: speed (did anyone move), nearest foe (is
// there anything to shoot) and hunt% (did the brain agree).
const contact = { spd: 0, nfoe: 0, hunt: 0, n: 0 };
const capStats: Record<string, { carry: number; route: number; other: number } | undefined> = {};
// Held-time ledger: sim-seconds each weapon spent carried by a LIVE
// bot (the bench's kit, not the fired slot - k/10r prices kills by
// exposure, k/10s by time-on-trigger; together they split "never
// drew" from "drew and whiffed").
const held = new Map<number, number>();
for (; ticks < maxTicks; ticks += BATCH) {
  if ((performance.now() - wall0) / 1000 > WALL_S) {break;}
  simNowAdvance(dt * 1000 * BATCH);
  step(room, BATCH, dt);
  room.messages.respawnTick(simNow());
  // Teamless modes (dm/rabbit/duel) sample everyone — every other live
  // body is a foe, or the contact row reads spd=0 on a live fight.
  const teamless = !room.modeSpec?.teams;
  const live = [...room.players.getAllPlayers().values()].filter((p) => !p.isDead && (teamless || p.team));
  for (const p of live) {
    let best = Infinity;
    for (const q of live) {
      if (teamless ? q === p : q.team === p.team) {continue;}
      const d = Math.hypot(q.position.x - p.position.x, q.position.z - p.position.z);
      if (d < best) {best = d;}
    }
    if (Number.isFinite(best)) {contact.nfoe += best; contact.n++;}
    contact.spd += Math.hypot(p.velocity.x, p.velocity.z);
  }
  if (room.bots) {contact.hunt += room.bots.huntUptime();}
  // Capper cycle audit — where a runner's alive-time actually goes:
  // carrying (grabbed), on-route (goal is the enemy stand), or other
  // (respawn idle, hunting, wandering). Low route share = dead cycle.
  if (room.flags && room.bots) {
    for (const [id, role] of (room.bots as unknown as { roster: { roles: Map<string, string> } }).roster.roles) {
      if (role !== 'capper') {continue;}
      const p = room.players.getPlayer(id);
      if (!p || p.isDead || !p.team) {continue;}
      const brain = (room.bots as unknown as { brains: Map<string, { goalS?: { goal?: BotVec } }> }).brains.get(id);
      const g = brain?.goalS?.goal;
      const enemy = room.flags.flags.get(p.team === 'alpha' ? 'bravo' : 'alpha');
      const own = room.flags.flags.get(p.team);
      const s = capStats[p.team] ??= { carry: 0, route: 0, other: 0 };
      if (enemy?.carrier === id) {s.carry += dt * BATCH;}
      else if (g && enemy && Math.hypot(g.x - enemy.pos.x, g.z - enemy.pos.z) < 60) {s.route += dt * BATCH;}
      else {s.other += dt * BATCH;}
      void own;
    }
  }
  if (CYCLE) {
    for (const r of room.scoring.matchPlayers()) {
      const k = r.kills;
      if (k > (lastKills.get(r.id) ?? 0)) {
        lastKills.set(r.id, k);
        const ix = CYCLE_POOL.indexOf(wOf.get(r.id)!);
        arm({ id: r.id }, CYCLE_POOL[(ix + 1) % CYCLE_POOL.length]);
      }
    }
  }
  for (const p of room.players.getAllPlayers().values()) {
    const born = lifeStart.get(p.id);
    if (p.isDead) {
      // Life spans are sim-time (the warp clock), not wall-clock — a
      // 300hp heavy's 3s respawn is 3 sim-seconds however fast we warp.
      if (born !== undefined) {pushLife(labelOf(p), (simNow() - born) / 1000); lifeStart.delete(p.id);}
      wasDead.add(p.id);
    } else {
      if (born === undefined) {lifeStart.set(p.id, simNow());}
      // Respawn edge → back to the line, or the teams slowly drift apart
      // and the match starves exactly like the unpinned run did.
      if (DO_SEAT && wasDead.delete(p.id)) {
        const s = sideOf.get(p.id);
        if (s) {seat(s.team, s.i);}
      }
      const hw = wOf.get(p.id);
      if (hw !== undefined) {held.set(hw, (held.get(hw) ?? 0) + dt * BATCH);}
    }
  }
}
const wallS = (performance.now() - wall0) / 1000;
const simS = ticks * dt;

// ── Report ──────────────────────────────────────────────────────────
const med = (xs: number[]): string => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!.toFixed(0) : '-');
const players = room.scoring.matchPlayers();
const byGroup = (pred: (p: { id: string; team?: string }) => boolean) => {
  const rows = players.filter(pred);
  const k = rows.reduce((n, r) => n + r.kills, 0);
  const d = rows.reduce((n, r) => n + r.deaths, 0);
  return { n: rows.length, k, d, kd: k / Math.max(1, d) };
};
// Verdict rows: sides normally, weapons under --mix (a weapon's bots span
// both teams, so side K/D would just average the matchup away).
const verdict: [string, ReturnType<typeof byGroup>][] = MIX
  ? [[WeaponType[A_W], byGroup((p) => wOf.get(p.id) === A_W)], [WeaponType[B_W], byGroup((p) => wOf.get(p.id) === B_W)]]
  : [['alpha', byGroup((p) => (p.team ?? 'alpha') === 'alpha')], ['bravo', byGroup((p) => p.team === 'bravo')]];
// Team score is the room's own (TeamScores) — tdm/dm bank frags, ctf banks
// captures, so the scoreline reads as the mode's real objective.
const score = `${room.scores.alpha ?? 0}-${room.scores.bravo ?? 0}`;

console.log(`score ${score}   ${simS.toFixed(0)}s sim in ${wallS.toFixed(1)}s wall (${(simS / wallS).toFixed(1)}x)`);
// FFA modes bank on ffaScores (rabbit hold-seconds, dm frags) - the
// team columns are dead for them, so print the real leaderboard.
if (room.modeSpec?.ffa) {
  const top = [...(room.scoring as unknown as { ffaScores: Map<string, number> }).ffaScores.entries()]
    .toSorted((a, b): number => b[1] - a[1]).slice(0, 5);
  console.log(`ffa  top: ${top.map(([id, s]): string => `${id.replace('bot:', '')} ${s}`).join('  ')} (winAt ${room.modeSpec.winAt})`);
}
console.log(`${(MIX ? 'weapon' : 'side').padEnd(12)} bots   K    D    K/D    medLife(s)`);
for (const [name, s] of verdict) {
  console.log(`${name.padEnd(12)} ${String(s.n).padStart(4)} ${String(s.k).padStart(4)} ${String(s.d).padStart(4)}  ${s.kd.toFixed(2).padStart(5)}   ${med(lives.get(name) ?? []).padStart(6)}`);
}
// The room auto-places stands on base-less maps — gate on the room
// having flags, not on the spec authoring bases, or auto-ctf reads as
// a fight with no objective column.
if (room.flags) {
  const caps = room.flags.capLog.length;
  const carried = [...room.flags.flags.values()].filter((f) => f.carrier).length;
  const grabs = room.flags.grabLog.length;
  const returns = room.flags.retLog.length;
  const holds = room.flags.capLog.map((c) => Math.round(c.holdMs / 1000)).join(',');
  console.log(`flags  caps=${caps} grabs=${grabs} returns=${returns} liveCarriers=${carried} holdS=[${holds}] states=${[...room.flags.flags.values()].map((f) => f.state).join(',')}`);
  for (const [team, s] of Object.entries(capStats)) {
    if (!s) {continue;}
    const t = s.carry + s.route + s.other;
    console.log(`  ${team} cappers: route=${(100 * s.route / Math.max(1, t)).toFixed(0)}% carry=${(100 * s.carry / Math.max(1, t)).toFixed(0)}% other=${(100 * s.other / Math.max(1, t)).toFixed(0)}% of ${(t / 60).toFixed(0)}min alive`);
  }
}
const nBatches = Math.max(1, Math.round(ticks / BATCH));
console.log(`contact meanSpeed=${(contact.spd / Math.max(1, contact.n)).toFixed(1)}m/s nearestFoe=${(contact.nfoe / Math.max(1, contact.n)).toFixed(0)}m hunt=${(100 * contact.hunt / nBatches).toFixed(0)}% over ${nBatches} samples`);
// Economy line — the nuggets funnel is kill→drop→touch→bank; a mode that
// spawns gems nobody banks means the objective isn't being played.
const pk = weaponStats.snapshot().pickups[MODE];
if (pk) {
  console.log('pickups ' + Object.entries(pk).map(([kind, r]) =>
    `${kind}: spawned=${r.spawned} banked=${r.banked} decayed=${r.decayed}${r.refused ? ` refused=${r.refused}` : ''}`).join('  '));
}
// Pluggable-mode telemetry — a mode module that owns an economy
// (conquest's lattice churn) reports one line through the same channel.
const modeTelemetry = room.modeModule?.telemetry?.();
if (modeTelemetry) {console.log(modeTelemetry);}
if (simProf) {
  const tot = [...simProf.values()].reduce((a, b) => a + b, 0);
  console.log(`sims (${tot.toFixed(0)}ms total): ` + [...simProf.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${(100 * v / Math.max(1, tot)).toFixed(0)}%`).join(' '));
}

// Weapon ledger — every row this mode recorded, delta'd from the pre-warp
// snapshot so a long session's leftovers can't leak into the table.
const now = snapTable();
const rows = Object.entries(now)
  .map(([k, v]) => ({
    k,
    shots: v.shots - (statBefore.get(k)?.shots ?? 0),
    hits: v.hits - (statBefore.get(k)?.hits ?? 0),
    damage: v.damage - (statBefore.get(k)?.damage ?? 0),
    kills: v.kills - (statBefore.get(k)?.kills ?? 0),
    conn: (v.conn ?? 0) - (statBefore.get(k)?.conn ?? 0),
  }))
  .filter((r) => r.shots > 0 || r.hits > 0 || r.damage > 0)
  .sort((x, y) => y.damage - x.damage);
const mark = (wid: string): string => {
  const n = Number(wid.slice(1));
  if (n === A_W || n === A2_W) {return 'A';}
  if (n === B_W || n === B2_W) {return 'B';}
  return ' ';
};
// up = trigger-uptime seconds (shots × the weapon's fire interval, with
// the arsenal's own 0.1s default for unlisted types). dmg/10s and k/10s
// price a weapon by time-on-trigger, not by how often the AI drew it —
// that's the column that makes a 10/s belt spam and a 2.5s rocket
// comparable.
const intervalOf = (wt: number): number => WEAPON_FIRE_INTERVAL_S[wt as WeaponType] ?? 0.1;
console.log(`\nweapon            | side | shots | hits | conn% |  dmg  |  kills |   up(ts) |  s | dmg/10ts | k/10ts | k/10s`);
for (const r of rows) {
  const wt = Number(r.k.slice(1));
  const name = WeaponType[wt] ?? r.k;
  const up = r.shots * intervalOf(wt);
  const hs = held.get(wt) ?? 0;
  // conn% = pulls that tagged ≥1 victim, deduped by shotId — the honest
  // connect rate. `hits` stays pellet/victim-level for damage accounting
  // (a flak burst is 1 connect of ~8 hits).
  console.log(`${name.padEnd(17)} |  ${mark(r.k)}   | ${String(r.shots).padStart(5)} | ${String(r.hits).padStart(4)} | ${(r.shots ? (100 * r.conn / r.shots) : 0).toFixed(1).padStart(5)} | ${String(Math.round(r.damage)).padStart(5)} | ${String(r.kills).padStart(5)} | ${up.toFixed(0).padStart(7)} | ${hs.toFixed(0).padStart(8)} | ${(10 * r.damage / Math.max(1, up)).toFixed(0).padStart(7)} | ${(10 * r.kills / Math.max(1, up)).toFixed(2).padStart(7)} | ${(10 * r.kills / Math.max(1, hs)).toFixed(2).padStart(5)}`);
}
// Range curve: shots vs hits/dmg/kills per engagement band, delta'd like
// the table above. The payoff of --force — where a gun actually works.
const BANDS = ['<10', '10-25', '25-60', '60-120', '120+'];
console.log(`\nrange bands       | side | per band: shots|hits|dmg|kills`);
for (const r of rows) {
  const prev = statBefore.get(r.k);
  const cur = now[r.k];
  const line = BANDS.map((b): string => {
    const sh = (cur?.dist?.[b] ?? 0) - (prev?.dist?.[b] ?? 0);
    const bd = cur?.band?.[b];
    const pbd = prev?.band?.[b];
    const h = (bd?.h ?? 0) - (pbd?.h ?? 0);
    const d = Math.round((bd?.d ?? 0) - (pbd?.d ?? 0));
    const k = (bd?.k ?? 0) - (pbd?.k ?? 0);
    return `${b.padStart(5)}:${String(sh).padStart(4)}|${String(h).padStart(4)}|${String(d).padStart(5)}|${String(k).padStart(3)}`;
  }).join('  ');
  console.log(`${(WeaponType[Number(r.k.slice(1))] ?? r.k).padEnd(17)} |  ${mark(r.k)}   | ${line}`);
}

// Results ledger: every pinned/mixed match appends one JSONL row so
// weaponRank.ts can ladder weapons over history (Glicko-lite kill-share
// scoring). Cycle/wild runs don't fit the A-vs-B shape.
if (!CYCLE && !WILD) {
  const rowOf = (wt: number): object | null => {
    const r = rows.find((x): boolean => Number(x.k.slice(1)) === wt);
    if (!r) {return null;}
    const up = r.shots * intervalOf(wt);
    return { kills: r.kills, shots: r.shots, hits: r.hits, conn: +(r.shots ? 100 * r.conn / r.shots : 0).toFixed(1), dmg: Math.round(r.damage), upTs: +up.toFixed(0), heldS: +(held.get(wt) ?? 0).toFixed(0) };
  };
  const line = JSON.stringify({
    ts: Date.now(), seed: SEED, map: SPEC_NAME, mode: MODE, per: PER, simS: Math.round(simS), mix: MIX,
    a: WeaponType[A_W], b: WeaponType[B_W],
    score: [room.scores.alpha ?? 0, room.scores.bravo ?? 0],
    A: rowOf(A_W), B: rowOf(B_W),
  });
  mkdirSync(resolve(import.meta.dir, 'out'), { recursive: true });
  appendFileSync(resolve(import.meta.dir, 'out', 'weapon_results.jsonl'), line + '\n');
}
process.exit(0);
