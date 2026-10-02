import { describe, it, expect, afterAll } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname } from 'node:path';
import { mkRoom, step, watch } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { GRAVITY } from '../../../shared/movement.ts';
import { simNow, simNowAdvance, simNowReset } from '../../src/simClock.ts';
import { weaponStats } from '../../src/weaponStats.ts';
import { selfKillImpactDist, selfKillFoeDist, selfKillTrades } from '../../src/hitLedger.ts';
import { WeaponType } from '../../../shared/weaponTable.ts';
import { WEAPON_FIRE_INTERVAL_S } from '../../../shared/weapons.ts';

// FPS_TRAIL=<file.png> plots every bot's XZ track (alpha=red, bravo=
// blue) top-down over the 1500m terrain wrap at 512x512 — hotspots and
// dead routing lanes show instantly. One combined map plus one per
// role (<file>_<role>.png) so a capper's lanes don't drown in the herd.
// Costs a position snapshot per batch, so it stays opt-in.
const TRAIL_PATH = process.env.FPS_TRAIL;
// Sheep-meter verdicts would flood this run's console (every llama
// re-maxes per life) — divert them to soak.log beside the heatmaps.
// FPS_SHEEP_LOG overrides where they go; deleting it restores console warns.
process.env.FPS_SHEEP_LOG ??= TRAIL_PATH
  ? dirname(TRAIL_PATH) + '/soak.log'
  : `${import.meta.dir}/../../../run/soak.log`;

/** Lossless RGB PNG — zlib from node, no image deps. */
function pngWrite(path: string, w: number, h: number, px: Uint8Array): void {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none — heatmap pixels don't predict
    Buffer.from(px.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// Throughput probe: how much honest sim-time does a real CTF room burn
// through per wall-second when stepped flat-out? "Honest" means the
// whole room runs on the warp clock — respawns, spawn shields, flag and
// match timers all lapse in sim-time, not wall-time, so minutes of
// combat in seconds is actually minutes of combat.
// FPS_SOAK_MAP=<name> picks the terrain (default katabatic). Stands and
// spawn spheres come from the map's own JSON (real T2 placements for the
// t2 ports — equinox/surreal/riverdance/... — home-authored elsewhere),
// and a team with no authored spheres synthesizes one at its own base so
// respawns stay near home, not midfield.
const MAP = process.env.FPS_SOAK_MAP ?? 'katabatic';
const mapJson = JSON.parse(readFileSync(`${import.meta.dir}/../../../maps/${MAP === 'katabatic' ? 'katabatic_bare' : MAP}.json`, 'utf8')) as {
  bases?: { alpha: { x: number; z: number }; bravo: { x: number; z: number } };
  teamSpawns?: Record<string, { x: number; z: number; r?: number; w?: number }[]>;
  terrain?: string;
  balls?: { base: number; perPlayer: number; max: number };
  creatures?: Record<string, number>;
  ambient?: Record<string, number>;
};
// t2 ports store the heightfield under maps/t2/<name>/terrain.bin — honor
// the JSON's own terrain path instead of assuming maps/<name>.bin.
const field = hmParseBin(new Uint8Array(readFileSync(
  `${import.meta.dir}/../../../maps/${mapJson.terrain ?? (MAP === 'katabatic' ? 'katabatic' : MAP) + '.bin'}`)));

// FPS_SOAK_MS=<ms> runs a longer warp from the CLI for profiling.
const WALL_BUDGET_MS = Number(process.env.FPS_SOAK_MS ?? 10_000);

describe('scenario: warp soak throughput', () => {
  afterAll(() => simNowReset());

  it('steps a full 16-bot room flat-out for the wall budget', () => {
    // Real T2 stand positions — a ctf room without bases spawns no
    // flags at all, and a flagless soak just measures wandering. A map
    // with no bases isn't an error: it runs its own mode (tdm/dm) as a
    // pure combat-density soak — the flag probes simply never fire.
    const baseAt = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });
    const spawnAt = (x: number, z: number, r: number, w: number) => ({ x, y: hmHeight(field, x, z), z, r, w });
    const ctf = !!mapJson.bases;
    // Per-team fallback: a map may give spheres for one side only
    // (SunDried's 4 spheres are shared neutrals) — the missing side
    // still gets a sphere at its own base rather than midfield.
    const teamSpawns: Record<string, { x: number; z: number; r?: number; w?: number }[]> | undefined = ctf ? {
      alpha: mapJson.teamSpawns?.alpha ?? [{ ...mapJson.bases!.alpha, r: 50, w: 90 }],
      bravo: mapJson.teamSpawns?.bravo ?? [{ ...mapJson.bases!.bravo, r: 50, w: 90 }],
    } : undefined;
    // FPS_SOAK_MODE overrides the authored mode — e.g. tdm on a ctf map
    // measures pure combat density on that terrain (flags stay on the
    // field as scenery, probes just report zero).
    const mode = process.env.FPS_SOAK_MODE ?? (ctf ? 'ctf' : (mapJson as { mode?: string }).mode ?? 'tdm');
    if (process.env.FPS_SHEEP_LOG) writeFileSync(process.env.FPS_SHEEP_LOG, '');
    const room = mkRoom({
      mode, bots: 16, botFill: 16,
      // Economy sims off by default in the combat soak — ball/creature
      // kills ride the same weapon-kill ledger and poison duel stats.
      // FPS_SOAK_ECO=1 restores the map's own population tables for
      // economy probes (a nuggets map without them spawns zero gems).
      ...(process.env.FPS_SOAK_ECO
        ? { balls: mapJson.balls, creatures: mapJson.creatures, ambient: mapJson.ambient }
        : { balls: { base: 0, perPlayer: 0, max: 0 }, creatures: {} }),
      ...(ctf ? {
        bases: { alpha: baseAt(mapJson.bases!.alpha.x, mapJson.bases!.alpha.z), bravo: baseAt(mapJson.bases!.bravo.x, mapJson.bases!.bravo.z) },
        teamSpawns: Object.fromEntries(
          Object.entries(teamSpawns!).map(([t, ss]) => [t, ss.map((s) => spawnAt(s.x, s.z, s.r ?? 50, s.w ?? 90))]),
        ),
      } : {}),
    // FPS_SOAK_SEED rerolls the room — the multi-soak bat runs several
    // seeds back to back so one wall-minute buys several match samples
    // instead of the same roll replayed.
    }, mode, Number(process.env.FPS_SOAK_SEED ?? 4242), false, field);
    // Sim-clock stamped watch — _s lets post-run stats time flag
    // transitions (grab→cap deltas) instead of counting blind.
    let simTicks = 0;
    const dt = 0.05;                      // 20Hz — matches the live tick
    const w = watch(room, () => simTicks * dt);
    if (mode === 'ctf') expect(room.flags).not.toBeNull();

    const wallBudgetMs = WALL_BUDGET_MS;
    const runStart = simNow();
    const t0 = performance.now();
    const BATCH = 20; // sim-s granularity of stamped msgs — 100-tick
    // batches made 5s caps read as 0.0s in the match report.
    // Per-side stand pressure: closest any team's bot ever got to the
    // ENEMY stand — catches "one direction is unroutable" before the
    // grab count does (grab==0 can be a routing wall or no press).
    const alphaStand = ctf ? { x: mapJson.bases!.alpha.x, z: mapJson.bases!.alpha.z } : { x: 0, z: 0 };
    const bravoStand = ctf ? { x: mapJson.bases!.bravo.x, z: mapJson.bases!.bravo.z } : { x: 0, z: 0 };
    const press = { alpha: Infinity, bravo: Infinity };
    // Vertical gap at the closest XZ approach — pickup needs |dy|<=6,
    // so a press that stalls on a plateau rim shows up as press small
    // but pressY large (the bot is UNDER the stand lip, not on it).
    const pressY = { alpha: 0, bravo: 0 };
    // Closest 3D approach to the live enemy flag — the pickup radius is
    // ~2.2m, so flagNear tells whether anyone ever got close enough to
    // matter, vs dying/routing in the deck kill-zone.
    const flagNear = { alpha: Infinity, bravo: Infinity };
    const flagDeaths: { alpha: number[]; bravo: number[] } = { alpha: [], bravo: [] };
    // Same closest-approach probe, cappers only — if runners get to ~5m
    // while everyone else stalls at 50m, commitment works and the
    // missing piece is speed; if the capper stalls like the rest, the
    // route itself is the problem.
    const capNear = { alpha: Infinity, bravo: Infinity };
    const flagGap: { alpha: [number, number, number]; bravo: [number, number, number] } = { alpha: [0, 0, 0], bravo: [0, 0, 0] };
    // Ring-survival probe: sim-seconds a bot lives after entering the
    // 80m ring around the ENEMY flag (died inside / escaped). If the
    // median is seconds, grabs need coordinated clearing, not routing.
    const ringIn = new Map<string, number>();
    const ringSurv: { died: number[]; left: number[] } = { died: [], left: [] };
    // HoF-denial probe: a capper crossing the enemy flag's 80m ring
    // records entry speed+health; on resolution (grab / died / repelled)
    // we measure how much momentum and HP defense stripped. "stopped"
    // = died or left ring without grabbing; the deltas say whether the
    // stop was a kill or a slowdown.
    const ringCap = new Map<string, { t: number; spd: number; hp: number }>();
    const capStop = { entries: 0, grabs: 0, died: 0, left: 0, dSpd: [] as number[], dHp: [] as number[] };
    // Capper-route probe: each sampled tick, is the capper's live
    // destination still the enemy stand, and which stand-distance band
    // is it in? Separates "brain rerouted off the run" (low on%) from
    // "legs point at the stand but never close" (on% high, stuck band).
    const capRoute = { ticks: 0, on: 0, route: 0, bands: [0, 0, 0, 0, 0] as number[], bandsA: [0, 0, 0, 0, 0] as number[], bandsB: [0, 0, 0, 0, 0] as number[] };
    // Are a capper's kills stand-clearing (victim inside its own flag
    // ring) or transit fights (everywhere else)?
    const capKills = { near: 0, far: 0 };
    const capDeaths: { d: number; spd: number; by: string }[] = [];
    const capStall = new Map<string, number>();
    const capStalls: { id: string; team: string; dd: number; spd: number; destD: number }[] = [];
    // Role-table feed: per-bot damage dealt (playerHit), carrier kills
    // (victim held a flag at the kill), plus grab/cap/return logs.
    const botDmg = new Map<string, number>();
    const botCk = new Map<string, number>();
    const carriers = new Map<string, string>(); // flag team -> carrier id
    const killZone = { attack: 0, defense: 0, mid: 0 };
    // Nugget risk probe — JP's model: going for a gem telegraphs your
    // position, so a grab under enemy pressure is a trade. Track live
    // pickups from the spawn/gone broadcasts; classify each bank by the
    // collector's nearest-enemy distance at grab time (hot <40m) and each
    // decayed gem by whether anyone was contesting it; count deaths within
    // 15m of a live gem as "died for a nug".
    const liveNugs = new Map<number, { x: number; z: number }>();
    const nug = { spawn: 0, bankHot: 0, bankCold: 0, decay: 0, die: 0 };
    let msgCur = 0;
    const foeDistTo = (pos: { x: number; z: number }, team?: string) => {
      let best = Infinity;
      for (const q of room.players.getAllPlayers().values()) {
        if (q.isDead || q.team === team) continue;
        const d = Math.hypot(q.position.x - pos.x, q.position.z - pos.z);
        if (d < best) best = d;
      }
      return best;
    };
    const drainMsgs = () => {
      for (; msgCur < w.msgs.length; msgCur++) {
        const m = w.msgs[msgCur]! as unknown as {
          type: string; id?: number; by?: string | null; pos?: { x: number; z: number };
          targetId?: string; shooterId?: string; damage?: number;
          flags?: { team: string; carrier?: string | null }[];
        };
        if (m.type === 'playerHit' && m.shooterId && m.damage) {
          botDmg.set(m.shooterId, (botDmg.get(m.shooterId) ?? 0) + m.damage);
        }
        if (m.type === 'pickupSpawn' && m.id !== undefined && m.pos) {
          liveNugs.set(m.id, m.pos); nug.spawn++;
        } else if (m.type === 'pickupGone' && m.id !== undefined) {
          const pos = liveNugs.get(m.id);
          liveNugs.delete(m.id);
          if (!pos) continue;
          if (m.by) {
            const p2 = room.players.getPlayer(m.by);
            const d = p2 ? foeDistTo(p2.position, p2.team) : Infinity;
            if (d < 40) nug.bankHot++; else nug.bankCold++;
          } else nug.decay++;
        } else if (m.type === 'playerKill' && m.targetId) {
          const v = room.players.getPlayer(m.targetId);
          if (v) for (const np of liveNugs.values()) {
            if (Math.hypot(v.position.x - np.x, v.position.z - np.z) < 15) { nug.die++; break; }
          }
          if (m.shooterId && [...carriers.values()].includes(m.targetId)) {
            botCk.set(m.shooterId, (botCk.get(m.shooterId) ?? 0) + 1);
          }
          // Capper autopsy: WHERE a dead runner was on his route (dist
          // to the flag he was pressing), how fast he was going, and
          // which role killed him. "Dies 250m out walking" ≠ "dies on
          // the stand" — the fixes are different legs of the run.
          if (v?.team && room.bots?.roleOf(m.targetId) === 'capper') {
            const foeF3 = room.flags?.flags.get(v.team === 'alpha' ? 'bravo' : 'alpha');
            if (foeF3) {
              capDeaths.push({
                d: Math.hypot(v.position.x - foeF3.pos.x, v.position.z - foeF3.pos.z),
                spd: Math.hypot(v.velocity.x, v.velocity.z),
                by: room.bots?.roleOf(m.shooterId ?? '') ?? (m.shooterId === 'environment' ? 'env' : '?'),
              });
            }
          }
          // Capper kill map: a kill inside the victim's own stand ring is
          // approach-clearing; anywhere else is a midfield transit fight.
          if (v?.team && m.shooterId && room.bots?.roleOf(m.shooterId) === 'capper') {
            const home = room.flags?.flags.get(v.team)?.home;
            if (home) {
              const d = Math.hypot(v.position.x - home.x, v.position.z - home.z);
              if (d < 40) capKills.near++; else capKills.far++;
            }
          }
        }
      }
    };
    const trail: { x: number; z: number; team: string; carrying: boolean; role: string }[] = [];
    const deaths: { x: number; z: number; team: string; role: string }[] = [];
    // Movement-energy telemetry — specific mechanical energy ½v²+g·h
    // (h = height above terrain, J/kg), the "are they skiing like Tribes
    // or walking like llamas" meter. Sampled per batch per live bot.
    const eStats = new Map<string, { team: string; sum: number; max: number; n: number; spd: number; post: number; flag: number; flagHome: number }>();
    const hofDest: number[] = [];
    const hofTrace: { t: number; id: string; dh: number; dd: number; st: string }[] = [];
    const hofLastTrace = new Map<string, number>();
    const hofGoalProbe: { posted: number; pd: number }[] = [];
    const hofLadder: number[] = [];
    const hofTrips: { t: number; age: number; peak: number; dd0: number; gg0: number }[] = [];
    const hofBand2 = new Map<string, boolean>();
    // HoF distance-from-stand audit keyed '<flagState><band>' — band 0
    // is <15m, 1 is 15-60m, 2 is beyond the stolen-flag roam radius.
    const hofAway = new Map<string, number>();
    // Per-bot lifetimes: respawn→death spans, role table's survival column.
    const lifeStart = new Map<string, number>();
    const lifeSpans = new Map<string, number[]>();
    // Engagement density — mean share of brains with a live hunt target,
    // sampled per batch. The single number that separates "nobody ever
    // finds a fight" from "fights never finish".
    let huntSum = 0, huntN = 0, cloakSum = 0, nearFoeSum = 0, inSightSum = 0;
    // Per-team goal-distance probe: mean XZ gap between each bot's
    // flagGoal destination and its OWN stand. Goal-side asymmetry (goals
    // never leave home) vs routing-side (goals point out, bots don't
    // move) is what splits a turtle map.
    const goalOut = { alpha: 0, bravo: 0, nA: 0, nB: 0 };
    // Route progress: each bot's distance-to-goal sampled ~5s apart.
    // Oscillation (goal churn) reads as ~zero net progress while moving;
    // a death loop reads as progress resets from respawn.
    const prog = new Map<string, { lastD: number; t: number; gained: number; windows: number }>();
    // Goal churn: count per-bot flips — consecutive flagGoal samples
    // landing >60m apart. A flip-heavy fleet with stable progress means
    // the goal itself ping-pongs; flips≈0 with prog≈0 points downstream.
    const flips = new Map<string, { lastG: { x: number; z: number }; n: number }>();
    // Move alignment: mean dot(vel̂, ĝoal) per bot. ~0 = orbiting in
    // place, <0 = a repulsor outvotes the goal, >0 with prog≈0 = a
    // circular trap (moving, never advancing).
    const align = { sum: 0, n: 0 };
    const wasDead = new Map<string, boolean>();
    while (performance.now() - t0 < wallBudgetMs) {
      // Carrier truth BEFORE the step — a carrier killed inside the
      // batch has already dropped by the time kill msgs drain, so the
      // pre-step snapshot is what a carrier-kill counts against.
      carriers.clear();
      for (const f of room.flags?.flags.values() ?? []) {
        if (f.carrier) carriers.set(f.team, f.carrier);
      }
      // Advance the room's clock first, then step every sim — the
      // order mirrors a live tick (timers lapse, then sims move).
      simNowAdvance(dt * 1000 * BATCH);
      step(room, BATCH, dt);
      room.messages.respawnTick(simNow());
      drainMsgs();
      simTicks += BATCH;
      if (room.bots) {
        huntSum += room.bots.huntUptime(); huntN++;
        let cl = 0, al = 0;
        for (const q of room.players.getAllPlayers().values()) if (!q.isDead) { al++; if (q.status & 4) cl++; }
        if (al) cloakSum += cl / al;
        // Foe density vs LOS, split the hunt=0 mystery: mean nearest-
        // enemy XZ distance says whether anyone's even in sight range,
        // and the <160m share says how often a sight roll is possible.
        const alive = [...room.players.getAllPlayers().values()].filter((q) => !q.isDead && q.team);
        let nd = 0, inSight = 0;
        for (const q of alive) {
          let best = Infinity;
          for (const e of alive) {
            if (e.team === q.team) continue;
            const d = Math.hypot(e.position.x - q.position.x, e.position.z - q.position.z);
            if (d < best) best = d;
          }
          if (Number.isFinite(best)) { nd += best; if (best < 160) inSight++; }
        }
        if (alive.length) { nearFoeSum += nd / alive.length; if (alive.some(() => true)) inSightSum += inSight / alive.length; }
        for (const q of alive) {
          const g = room.bots!.flagGoal({ id: q.id, team: q.team, position: q.position });
          if (!g) continue;
          const home = q.team === 'alpha' ? alphaStand : bravoStand;
          const d = Math.hypot(g.pos.x - home.x, g.pos.z - home.z);
          if (q.team === 'alpha') { goalOut.alpha += d; goalOut.nA++; } else { goalOut.bravo += d; goalOut.nB++; }
          const fl = flips.get(q.id) ?? { lastG: g.pos, n: 0 };
          if (Math.hypot(g.pos.x - fl.lastG.x, g.pos.z - fl.lastG.z) > 60) fl.n++;
          fl.lastG = g.pos;
          flips.set(q.id, fl);
          const gd = Math.hypot(g.pos.x - q.position.x, g.pos.z - q.position.z);
          const sp = Math.hypot(q.velocity.x, q.velocity.z);
          if (gd > 20 && sp > 4) align.sum += ((q.velocity.x * (g.pos.x - q.position.x) + q.velocity.z * (g.pos.z - q.position.z)) / (gd * sp)), align.n++;
          // Route progress against the stable anchor (the enemy stand,
          // not the churning goal): gained>0 means approach per window.
          const foeStand = q.team === 'alpha' ? bravoStand : alphaStand;
          const dFoe = Math.hypot(q.position.x - foeStand.x, q.position.z - foeStand.z);
          const pr = prog.get(q.id) ?? { lastD: dFoe, t: simTicks * dt, gained: 0, windows: 0 };
          if (simTicks * dt - pr.t >= 5) { pr.gained += pr.lastD - dFoe; pr.windows++; pr.lastD = dFoe; pr.t = simTicks * dt; }
          prog.set(q.id, pr);
        }
      }
      for (const p of room.players.getAllPlayers().values()) {
        if (p.isDead) {
          // Corpses can't press or carry — but the kill spot still feeds
          // the death heatmap.
          if (TRAIL_PATH && p.team && !wasDead.get(p.id)) deaths.push({ x: p.position.x, z: p.position.z, team: p.team, role: room.bots.roleOf(p.id) ?? 'bot' });
          if (wasDead.get(p.id) === false) {
            const born = lifeStart.get(p.id);
            if (born !== undefined) (lifeSpans.get(p.id) ?? lifeSpans.set(p.id, []).get(p.id)!).push(simTicks * dt - born);
            lifeStart.delete(p.id);
          }
          wasDead.set(p.id, true);
          const tin = ringIn.get(p.id);
          if (tin !== undefined) { ringSurv.died.push(simTicks * dt - tin); ringIn.delete(p.id); }
          const rc = ringCap.get(p.id);
          if (rc !== undefined) {
            capStop.died++;
            capStop.dSpd.push(Math.hypot(p.velocity.x, p.velocity.z) - rc.spd);
            capStop.dHp.push(Math.max(0, p.health) - rc.hp);
            ringCap.delete(p.id);
          }
          // Near-flag deaths: how close to the ENEMY flag each kill
          // landed — dying at 15m means the stand kill-zone eats runs,
          // dying at 300m means routes never arrived.
          const foeF = p.team === 'alpha' ? room.flags?.flags.get('bravo') : room.flags?.flags.get('alpha');
          if (foeF && p.team) {
            const fd = Math.hypot(p.position.x - foeF.pos.x, p.position.z - foeF.pos.z);
            if (fd < 60) (p.team === 'alpha' ? flagDeaths.alpha : flagDeaths.bravo).push(fd);
          }
          // Kill geography: died inside OWN flag's 80m ring (defense),
          // inside the ENEMY ring (attack), or in the midfield between.
          if (p.team) {
            const ownF2 = room.flags?.flags.get(p.team);
            const foeF2 = room.flags?.flags.get(p.team === 'alpha' ? 'bravo' : 'alpha');
            if (ownF2 && foeF2) {
              const do_ = Math.hypot(p.position.x - ownF2.pos.x, p.position.z - ownF2.pos.z);
              const df_ = Math.hypot(p.position.x - foeF2.pos.x, p.position.z - foeF2.pos.z);
              if (df_ < 80) killZone.attack++;
              else if (do_ < 80) killZone.defense++;
              else killZone.mid++;
            }
          }
          continue;
        }
        {
          const foeF0 = p.team === 'alpha' ? room.flags?.flags.get('bravo') : room.flags?.flags.get('alpha');
          if (foeF0 && p.team) {
            const rd = Math.hypot(p.position.x - foeF0.pos.x, p.position.z - foeF0.pos.z);
            const inside = rd < 80;
            if (inside && !ringIn.has(p.id)) ringIn.set(p.id, simTicks * dt);
            else if (!inside && ringIn.has(p.id)) { ringSurv.left.push(simTicks * dt - ringIn.get(p.id)!); ringIn.delete(p.id); }
            if (room.bots.roleOf(p.id) === 'capper') {
              const carrying = foeF0.carrier === p.id;
              if (inside && !ringCap.has(p.id) && !carrying) {
                ringCap.set(p.id, { t: simTicks * dt, spd: Math.hypot(p.velocity.x, p.velocity.z), hp: Math.max(0, p.health) });
                capStop.entries++;
              } else if (carrying && ringCap.has(p.id)) {
                capStop.grabs++; ringCap.delete(p.id);
              } else if (!inside && !carrying && ringCap.has(p.id)) {
                const rc = ringCap.get(p.id)!;
                capStop.left++;
                capStop.dSpd.push(Math.hypot(p.velocity.x, p.velocity.z) - rc.spd);
                capStop.dHp.push(Math.max(0, p.health) - rc.hp);
                ringCap.delete(p.id);
              }
            }
          }
        }
        const standY = p.team === 'alpha' ? hmHeight(field, bravoStand.x, bravoStand.z) : hmHeight(field, alphaStand.x, alphaStand.z);
        if (p.team === 'alpha') {
          const d = Math.hypot(p.position.x - bravoStand.x, p.position.z - bravoStand.z);
          if (d < press.alpha) { press.alpha = d; pressY.alpha = p.position.y - standY; }
        } else if (p.team === 'bravo') {
          const d = Math.hypot(p.position.x - alphaStand.x, p.position.z - alphaStand.z);
          if (d < press.bravo) { press.bravo = d; pressY.bravo = p.position.y - standY; }
        }
        // Closest approach to the LIVE enemy flag (3D, pickup test is 2.2m):
        // separates "died in the kill zone" from "never routed to the flag".
        const foeFlag = p.team === 'alpha' ? room.flags?.flags.get('bravo') : room.flags?.flags.get('alpha');
        if (foeFlag && p.team) {
          const fd = Math.hypot(p.position.x - foeFlag.pos.x, p.position.y - foeFlag.pos.y, p.position.z - foeFlag.pos.z);
          const k = p.team === 'alpha' ? 'alpha' : 'bravo';
          if (fd < flagNear[k]) {
            flagNear[k] = fd;
            // Planar vs vertical + arrival speed at the closest moment —
            // 2.2m planar + |dy|<=6 is the touch test, and a slow arrival
            // is a dead arrival: Tribes runs survive on momentum.
            flagGap[k] = [
              Math.hypot(p.position.x - foeFlag.pos.x, p.position.z - foeFlag.pos.z),
              p.position.y - foeFlag.pos.y,
              Math.hypot(p.velocity.x, p.velocity.z),
            ];
          }
          if (room.bots.roleOf(p.id) === 'capper' && fd < capNear[k]) capNear[k] = fd;
        }
        if (foeFlag && room.bots.roleOf(p.id) === 'capper') {
          const dd = Math.hypot(p.position.x - foeFlag.pos.x, p.position.z - foeFlag.pos.z);
          const dest = room.bots.debugDest(p.id);
          capRoute.ticks++;
          if (dest) {
            const dDest = Math.hypot(dest.x - foeFlag.pos.x, dest.z - foeFlag.pos.z);
            if (dDest < 340) capRoute.route++;
          }
          // 'on' counts the bot inside graze range — the committed aim
          // pulls short of the stand, so dest distance can't measure it.
          if (dd < 12) capRoute.on++;
          // Stall autopsy: a capper parked outside the ring for a whole
          // minute is either routed into a wall or hunting instead of
          // running — one line per stall names which.
          const stallT = capStall.get(p.id);
          if (dd > 80) {
            if (stallT === undefined) capStall.set(p.id, simTicks * dt);
            else if (simTicks * dt - stallT > 60) {
              capStalls.push({ id: p.id, team: p.team ?? '?', dd, spd: Math.hypot(p.velocity.x, p.velocity.z), destD: dest ? Math.hypot(dest.x - foeFlag.pos.x, dest.z - foeFlag.pos.z) : -1 });
              const goal = room.bots.debugGoal(p.id);
              const en = room.moveSim.energyOf(p.id);
              console.log(`  cap-stall ${p.id} ${p.team} dd=${dd.toFixed(0)} spd=${Math.hypot(p.velocity.x, p.velocity.z).toFixed(0)} pos=${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)} en=${en?.toFixed(0) ?? '?'} dest=${dest ? `${dest.x.toFixed(0)},${dest.z.toFixed(0)}` : 'none'} goal=${goal ? `${goal.x.toFixed(0)},${goal.z.toFixed(0)}` : 'none'} stand=${foeFlag.pos.x.toFixed(0)},${foeFlag.pos.z.toFixed(0)} ${room.bots.debugBrain(p.id)}`);
              capStall.set(p.id, simTicks * dt);
            }
          } else capStall.delete(p.id);
          const band = dd < 25 ? 0 : dd < 80 ? 1 : dd < 160 ? 2 : dd < 300 ? 3 : 4;
          capRoute.bands[band]!++;
          (p.team === 'alpha' ? capRoute.bandsA : capRoute.bandsB)[band]!++;
        }
        if (wasDead.get(p.id) !== false) lifeStart.set(p.id, simTicks * dt);
        wasDead.set(p.id, false);
        if (p.team) {
          const v2 = p.velocity.x ** 2 + p.velocity.y ** 2 + p.velocity.z ** 2;
          const e = 0.5 * v2 - GRAVITY * Math.max(0, p.position.y - hmHeight(field, p.position.x, p.position.z));
          const s = eStats.get(p.id) ?? { team: p.team, sum: 0, max: 0, n: 0, spd: 0, post: 0, flag: 0, flagHome: 0 };
          s.sum += e; s.n++; if (e > s.max) s.max = e;
          s.spd += Math.hypot(p.velocity.x, p.velocity.z);
          const ownF = room.flags?.flags.get(p.team);
          const home = ownF?.home;
          if (home) {
            const dh = Math.hypot(p.position.x - home.x, p.position.z - home.z);
            if (dh < 15) s.post++;
            // Contact rate only counts ticks where touching the pole is
            // even possible — a stolen flag can't be sat on.
            if (ownF?.state === 'home') {
              s.flagHome++;
              if (dh < 3) s.flag++;
            }
            // HoF excursion audit — where is he when NOT on the pole,
            // split by flag state. The stolen-flag window is the only
            // legal far roam; a >60m reading with the flag HOME is a
            // leak (wander, revenge, or a commander pull that survived).
            if (room.bots.roleOf(p.id) === 'hof') {
              if (!process.env.FPS_TRACE) process.env.FPS_TRACE = p.id;
              const band = dh < 15 ? 0 : dh < 60 ? 1 : 2;
              const st = ownF?.state === 'carried' ? 'car' : ownF?.state === 'dropped' ? 'drp' : 'home';
              // A fresh-spawn walk-back reads identically to a leak —
              // flag it apart: 'R' suffix = still within the first 25s
              // of this life, when crossing the map is expected.
              const born = lifeStart.get(p.id);
              const fresh = born !== undefined && simTicks * dt - born < 25 ? 'R' : '';
              hofAway.set(st + band + fresh, (hofAway.get(st + band + fresh) ?? 0) + 1);
              // Excursion-entry log: each time he leaves the >60m ring
              // while the flag is home, was it a fresh spawn or did he
              // genuinely walk off post mid-life?
              const wasBand2 = hofBand2.get(p.id) ?? false;
              if (band === 2 && st === 'home' && !wasBand2) {
                const d0 = room.bots.debugDest(p.id);
                const dd0 = d0 ? Math.hypot(d0.x - home.x, d0.z - home.z) : -1;
                const gp = room.bots.flagGoal({ id: p.id, team: p.team, position: p.position });
                const gg0 = gp ? Math.hypot(gp.pos.x - home.x, gp.pos.z - home.z) : -1;
                hofTrips.push({ t: simTicks * dt, age: simTicks * dt - (born ?? 0), peak: dh, dd0, gg0 });
              }
              if (band === 2 && st === 'home') hofTrips.at(-1)!.peak = Math.max(hofTrips.at(-1)!.peak, dh);
              hofBand2.set(p.id, band === 2);
              // Far out with flag home: does the brain still POINT
              // home (body dragged) or did a goal pull it away?
              if (band === 2 && st === 'home') {
                const dest = room.bots.debugDest(p.id);
                if (dest) hofDest.push(Math.hypot(dest.x - home.x, dest.z - home.z));
                const g = room.bots.flagGoal({ id: p.id, team: p.team, position: p.position });
                if (g) hofGoalProbe.push({ posted: g.posted ?? 0, pd: Math.hypot(g.pos.x - home.x, g.pos.z - home.z) });
                const gs = room.bots.debugGoal(p.id);
                if (gs) hofLadder.push(Math.hypot(gs.x - home.x, gs.z - home.z));
              }
              // Full trace — every ~5s sample where the hof actually
              // is and where he's pointing. Aggregates hid whether the
              // smear is one arc or a hundred orbits.
              if (simTicks * dt - ((hofLastTrace.get(p.id) ?? -99)) >= 5) {
                const dest = room.bots.debugDest(p.id);
                hofLastTrace.set(p.id, simTicks * dt);
                hofTrace.push({ t: simTicks * dt, id: p.id, dh, dd: dest ? Math.hypot(dest.x - home.x, dest.z - home.z) : -1, st });
              }
            }
          }
          eStats.set(p.id, s);
        }
        if (TRAIL_PATH && p.team) {
          const carrying = [...(room.flags?.flags.values() ?? [])].some((f) => f.carrier === p.id);
          trail.push({ x: p.position.x, z: p.position.z, team: p.team, carrying, role: room.bots.roleOf(p.id) ?? 'bot' });
        }
      }
    }
    const wallMs = performance.now() - t0;
    const simSecs = simTicks * dt;
    const ratio = simSecs / (wallMs / 1000);

    // ── Match report ──────────────────────────────────────────────
    // Caps come from flags.capLog — ground truth written at the capture
    // instant (broadcast-diffing can't tell a cap from an end-of-match
    // flag reset). Grabs still diff flagUpdate transitions: carried is
    // unambiguous state.
    type FlagSnap = { team: string; state: string; carrier: string | null; pos: { x: number; y: number; z: number } };
    const runBy = new Map<string, number>();
    const grabsBy: Record<string, number> = {};
    const pins: { x: number; z: number; kind: 'grab' | 'drop' | 'home' }[] = [];
    let grabs = 0;
    for (const m of w.msgs) {
      if (m.type !== 'flagUpdate') continue;
      for (const f of (m as unknown as { flags: FlagSnap[] }).flags ?? []) {
        if (f.state === 'carried' && !runBy.has(f.team)) {
          runBy.set(f.team, 1); grabs++;
          grabsBy[f.team] = (grabsBy[f.team] ?? 0) + 1;
          pins.push({ x: f.pos.x, z: f.pos.z, kind: 'grab' });
        } else if (f.state !== 'carried' && runBy.delete(f.team)) {
          pins.push({ x: f.pos.x, z: f.pos.z, kind: f.state === 'home' ? 'home' : 'drop' });
        }
      }
    }
    const caps = (room.flags?.capLog ?? []).filter((c) => c.capAt >= runStart);

    if (TRAIL_PATH && trail.length) {
      const W = 512, HALF = 750; // terrain wrap is ±750m
      const ij = (x: number, z: number) => [
        Math.round((x + HALF) / (2 * HALF) * (W - 1)),
        Math.round((z + HALF) / (2 * HALF) * (W - 1)),
      ];
      // Terrain underlay: elevation → brightness, so dead zones read as
      // ridges/valleys and not unexplored void. Built once; every map
      // (combined + per-role) shares it.
      let hMin = Infinity, hMax = -Infinity;
      const hAt: number[] = new Array(W * W);
      for (let iy = 0; iy < W; iy++)
        for (let ix = 0; ix < W; ix++) {
          const h = hmHeight(field, (ix / (W - 1)) * 2 * HALF - HALF, (iy / (W - 1)) * 2 * HALF - HALF);
          hAt[iy * W + ix] = h;
          if (h < hMin) hMin = h;
          if (h > hMax) hMax = h;
        }
      const basePx = new Uint8Array(W * W * 3);
      for (let i = 0; i < W * W; i++) {
        const v = 18 + 52 * ((hAt[i]! - hMin) / Math.max(1, hMax - hMin));
        basePx[i * 3] = v; basePx[i * 3 + 1] = v; basePx[i * 3 + 2] = v + 6;
      }
      const render = (rows: typeof trail, deads: typeof deaths) => {
        const px = new Uint8Array(basePx);
        const set = (ix: number, iy: number, r: number, g: number, b: number) => {
          if (ix < 0 || iy < 0 || ix >= W || iy >= W) return;
          const i = (iy * W + ix) * 3;
          px[i] = r; px[i + 1] = g; px[i + 2] = b;
        };
        const plot = (x: number, z: number, r: number, g: number, b: number) => set(ij(x, z)[0]!, ij(x, z)[1]!, r, g, b);
        // Deaths under trails: where bodies fall decides whether a dead
        // lane is a wall (deaths on the seam) or a killbox (clustered).
        for (const d of deads) {
          const [ix, iy] = ij(d.x, d.z);
          for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
              d.team === 'alpha' ? set(ix! + dx, iy! + dy, 140, 40, 30) : set(ix! + dx, iy! + dy, 40, 60, 140);
        }
        // Trail dots blend at ~25% over the terrain — overlaps stack, so
        // a single point reads as a pass and a hotspot reads as a habit
        // instead of both flattening into one solid blob.
        for (const t of rows) {
          // Carriers glow so flag routes cut through the team-color noise —
          // orange for alpha, purple for bravo.
          const [r, g, b] = t.carrying
            ? (t.team === 'alpha' ? [255, 160, 40] : [190, 80, 255])
            : (t.team === 'alpha' ? [255, 70, 70] : [90, 140, 255]);
          const [ix, iy] = ij(t.x, t.z);
          if (ix! < 0 || iy! < 0 || ix! >= W || iy! >= W) continue;
          const i = (iy! * W + ix!) * 3;
          px[i] = Math.min(255, px[i]! + r * 0.25);
          px[i + 1] = Math.min(255, px[i + 1]! + g * 0.25);
          px[i + 2] = Math.min(255, px[i + 2]! + b * 0.25);
        }
        // Flag-event pins on top: lime grab, cyan drop/return-to-home.
        for (const pin of pins) {
          const [ix, iy] = ij(pin.x, pin.z);
          const c = pin.kind === 'grab' ? [120, 255, 60] : pin.kind === 'home' ? [255, 255, 120] : [60, 220, 255];
          for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++) set(ix! + dx, iy! + dy, c[0]!, c[1]!, c[2]!);
        }
        for (const s of [alphaStand, bravoStand]) {
          for (let dx = -3; dx <= 3; dx++)
            for (let dz = -3; dz <= 3; dz++) plot(s.x + dx * 3, s.z + dz * 3, 255, 255, 255);
        }
        return px;
      };
      const out = TRAIL_PATH.replace(/\.(png|bmp)$/i, '');
      pngWrite(`${out}.png`, W, W, render(trail, deaths));
      const roles = [...new Set(trail.map((t) => t.role))].sort();
      for (const role of roles) {
        pngWrite(`${out}_${role}.png`, W, W,
          render(trail.filter((t) => t.role === role), deaths.filter((d) => d.role === role)));
      }
      console.log(`  trail: ${trail.length} samples, ${deaths.length} deaths, ${pins.length} flag events → ${out}.png + ${roles.length} role maps`);
    }

    const alive = [...room.players.getAllPlayers().values()].filter((p) => !p.isDead).length;
    const respawned = room.players.getAllPlayers().size;
    const fastest = caps.reduce((a, b) => (b.holdMs < a.holdMs ? b : a), { by: '-', holdMs: Infinity, team: '' });
    const avgHold = caps.length ? caps.reduce((n, c) => n + c.holdMs, 0) / caps.length / 1000 : 0;
    const players = room.scoring.matchPlayers();
    const fragger = [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
    const kd = [...players].sort((a, b) => (b.kills / Math.max(1, b.deaths)) - (a.kills / Math.max(1, a.deaths)))[0];
    const kills = players.reduce((n, p) => n + p.kills, 0);
    // Self-blast credit check: playerKill broadcasts carry shooter/target —
    // a suicide counts once as scoreboard-zero but still hits the weapon
    // ledger, so selfK reconciles kills_a+b vs the weapons table.
    const pkMsgs = w.msgs.filter((m) => m.type === 'playerKill') as unknown as { shooterId: string; targetId: string; weapon?: number }[];
    const selfKills = pkMsgs.filter((m) => m.shooterId === m.targetId).length;
    const selfByW = new Map<string, number>();
    for (const m of pkMsgs) if (m.shooterId === m.targetId) {
      const k: string = m.weapon !== undefined && WeaponType[m.weapon] ? WeaponType[m.weapon]! : `w${m.weapon}`;
      selfByW.set(k, (selfByW.get(k) ?? 0) + 1);
    }
    const selfImpact = [...selfKillImpactDist].sort((a, b) => a - b);
    const selfFoe = [...selfKillFoeDist].sort((a, b) => a - b);
    const selfLine = [...selfByW.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ') +
      ` @${(selfImpact[selfImpact.length >> 1] ?? 0).toFixed(1)}m foe@${(selfFoe[selfFoe.length >> 1] ?? 0).toFixed(0)}m ${selfKillTrades.trades}traded`;
    const killsByTeam = players.reduce<Record<string, number>>((m, p) => { if (p.team) m[p.team] = (m[p.team] ?? 0) + p.kills; return m; }, {});
    const score = Object.entries(room.scores).map(([t, s]) => `${t} ${s}`).join(' / ');
    const fmtId = (id: string) => id.replace(/^BOT-/, '');
    console.log(
      `warpSoak: ${simTicks} ticks, ${simSecs.toFixed(0)} sim-s ` +
      `(${(simSecs / 60).toFixed(1)} sim-min) in ${(wallMs / 1000).toFixed(1)} wall-s ` +
      `— ${ratio.toFixed(0)}x real-time; ${alive}/${respawned} alive`,
    );
    // Per-role stat lines — tuning needs "do cappers cap" and "does the
    // bombardier kill the stand guards", not team totals. roleInfo is
    // the live assignment map the rebalance owns.
    const byRole = new Map<string, { n: number; k: number; d: number }>();
    for (const pl of players) {
      const role = room.bots?.roleOf(pl.id) ?? '-';
      const r = byRole.get(role) ?? { n: 0, k: 0, d: 0 };
      r.n++; r.k += pl.kills; r.d += pl.deaths;
      byRole.set(role, r);
    }
    // Energy report: per-bot avg + peak E. Team means + fleet median
    // answer "does the whole match move like Tribes"; the top mover
    // shows what good looks like in the same run.
    const eRows = [...eStats.entries()].filter(([, s]) => s.n > 0)
      .map(([id, s]) => ({ id, team: s.team, avg: s.sum / s.n, max: s.max }));
    const medOf = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[a.length >> 1]! : 0; };
    const eLine = eRows.length
      ? `median avgE=${medOf(eRows.map((r) => r.avg)).toFixed(0)} ` +
        `alpha=${(eRows.filter((r) => r.team === 'alpha').reduce((n, r) => n + r.avg, 0) / Math.max(1, eRows.filter((r) => r.team === 'alpha').length)).toFixed(0)} ` +
        `bravo=${(eRows.filter((r) => r.team === 'bravo').reduce((n, r) => n + r.avg, 0) / Math.max(1, eRows.filter((r) => r.team === 'bravo').length)).toFixed(0)}; ` +
        `top ${eRows.sort((a, b) => b.avg - a.avg).slice(0, 3).map((r) => `${fmtId(r.id)} ${r.avg.toFixed(0)}/${r.max.toFixed(0)}`).join(' ')}`
      : 'no samples';
    // KPI: machine-readable single line for A/B diffing runs.
    const progRows = { alpha: { sum: 0, cnt: 0 }, bravo: { sum: 0, cnt: 0 } };
    for (const [id, pr] of prog) {
      if (!pr.windows) continue;
      const t = room.players.getPlayer(id)?.team;
      const row = t === 'alpha' ? progRows.alpha : t === 'bravo' ? progRows.bravo : null;
      if (row) { row.sum += pr.gained / pr.windows; row.cnt++; }
    }
    // KPI report — plain-language rows a human scans top-down, then the
    // compact tables. The kpi-csv row at the end keeps one machine line
    // for A/B diffing runs.
    const fdie = (t: 'alpha' | 'bravo') => `${flagDeaths[t].length}@${flagDeaths[t].length ? (flagDeaths[t].reduce((s, v) => s + v, 0) / flagDeaths[t].length).toFixed(0) : '-'}m`;
    const row = (label: string, s: string) => console.log(`  ${label.padEnd(9)} ${s}`);
    console.log('');
    row('match', `alpha ${room.scores.alpha ?? 0} - bravo ${room.scores.bravo ?? 0}   kills ${killsByTeam.alpha ?? 0}-${killsByTeam.bravo ?? 0}   pkEv ${pkMsgs.length}   selfK ${selfKills} (${selfLine})`);
    row('flags', `grabs ${grabsBy.alpha ?? 0}-${grabsBy.bravo ?? 0}   caps ${caps.length}${caps.length ? ` (fastest ${(fastest.holdMs / 1000).toFixed(1)}s)` : ''}   press ${Number.isFinite(press.alpha) ? press.alpha.toFixed(0) : '-'}m/${Number.isFinite(press.bravo) ? press.bravo.toFixed(0) : '-'}m`);
    row('approach', `closest: any ${Number.isFinite(flagNear.alpha) ? flagNear.alpha.toFixed(0) : '-'}m(+${flagGap.alpha[1].toFixed(0)}y @${flagGap.alpha[2].toFixed(0)}mps) / ${Number.isFinite(flagNear.bravo) ? flagNear.bravo.toFixed(0) : '-'}m(+${flagGap.bravo[1].toFixed(0)}y @${flagGap.bravo[2].toFixed(0)}mps)   cappers ${Number.isFinite(capNear.alpha) ? capNear.alpha.toFixed(0) : '-'}m/${Number.isFinite(capNear.bravo) ? capNear.bravo.toFixed(0) : '-'}m   flag deaths ${fdie('alpha')}/${fdie('bravo')}`);
    row('ring', `died inside ${ringSurv.died.length} (${ringSurv.died.length ? (ringSurv.died.reduce((s, v) => s + v, 0) / ringSurv.died.length).toFixed(1) : '-'}s avg)   left ${ringSurv.left.length}   capper pushes ${capStop.entries} -> ${capStop.grabs} grabs, ${capStop.died} died, ${capStop.left} repelled${capStop.dSpd.length ? ` (lost ${medOf(capStop.dSpd).toFixed(1)}mps ${medOf(capStop.dHp).toFixed(0)}hp)` : ''}`);
    row('cappers', `route-to-stand ${capRoute.ticks ? Math.round((capRoute.route / capRoute.ticks) * 100) : 0}% · in graze range ${capRoute.ticks ? Math.round((capRoute.on / capRoute.ticks) * 100) : 0}% of ticks   push calls ${room.bots?.debugPushCalls('alpha') ?? 0}/${room.bots?.debugPushCalls('bravo') ?? 0}   time at <160m a${(capRoute.bandsA[0] ?? 0) + (capRoute.bandsA[1] ?? 0) + (capRoute.bandsA[2] ?? 0)}/b${(capRoute.bandsB[0] ?? 0) + (capRoute.bandsB[1] ?? 0) + (capRoute.bandsB[2] ?? 0)} ticks stalls ${capStalls.length}   capper kills ${capKills.near + capKills.far} (${capKills.near} at stand)   deaths@${capDeaths.length ? medOf(capDeaths.map((c) => c.d)).toFixed(0) : '-'}m@${capDeaths.length ? medOf(capDeaths.map((c) => c.spd)).toFixed(0) : '-'}mps by ${[...capDeaths.reduce((m, c) => m.set(c.by, (m.get(c.by) ?? 0) + 1), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`).join(' ')}`);
    row('economy', `nugs: ${nug.spawn} spawned · ${nug.bankHot + nug.bankCold} banked (${nug.bankHot} hot) · ${nug.decay} decayed · ${nug.die} died-for`);
    row('fight', `kills: attack ${killZone.attack} · defense ${killZone.defense} · midfield ${killZone.mid}   hunting ${huntN ? Math.round((huntSum / huntN) * 100) : 0}%   cloak ${huntN ? Math.round((cloakSum / huntN) * 100) : 0}%   in sight ${huntN ? Math.round((inSightSum / huntN) * 100) : 0}%   nearest foe ${huntN ? (nearFoeSum / huntN).toFixed(0) : '-'}m   med energy ${medOf(eRows.map((r) => r.avg)).toFixed(0)}`);
    row('macro', `goal output ${goalOut.nA ? (goalOut.alpha / goalOut.nA).toFixed(0) : '-'}/${goalOut.nB ? (goalOut.bravo / goalOut.nB).toFixed(0) : '-'}   progress ${progRows.alpha.cnt ? (progRows.alpha.sum / progRows.alpha.cnt).toFixed(1) : '-'}/${progRows.bravo.cnt ? (progRows.bravo.sum / progRows.bravo.cnt).toFixed(1) : '-'}m/win   goal flips ${flips.size ? ([...flips.values()].reduce((n, f) => n + f.n, 0) / flips.size).toFixed(0) : '-'}/bot   aim align ${align.n ? (align.sum / align.n).toFixed(2) : '-'}`);
    console.log('');
    const roleOf = (id: string) => room.bots.roleOf(id);
    const sumFor = (r: string, m: Map<string, number>) => { let s = 0; for (const [id, v] of m) if (roleOf(id) === r) s += v; return s; };
    console.log('  — K/D kills·deaths · dmg dealt · gr grabs · cp caps · rt returns · cK carrier-kills · spd avg speed · avgE avg energy · life avg lifespan · post% ticks within 15m of stand · flag% inside flag hitbox (<3m) —');
    console.log('  role           bots   K / D    dmg   gr cp rt cK   spd   avgE  life(s)  post% flag%');
    for (const [r, s] of [...byRole.entries()].sort()) {
      // Per-role means of per-bot means — one hot bot can't skew a role.
      let spd = 0, en = 0, life = 0, post = 0, flag = 0, cnt = 0;
      for (const [id, es] of eStats) {
        if (roleOf(id) !== r || es.n === 0) continue;
        spd += es.spd / es.n; en += es.sum / es.n; post += es.post / es.n; flag += es.flagHome ? es.flag / es.flagHome : 0; cnt++;
        const spans = [...(lifeSpans.get(id) ?? [])];
        const born = lifeStart.get(id);
        // The life still running counts too — a bot that died at 7s and
        // survived the rest of the match isn't a 7-second player.
        if (born !== undefined) spans.push(simTicks * dt - born);
        life += spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : 0;
      }
      const gr = (room.flags?.grabLog ?? []).filter((g) => g.at >= runStart && roleOf(g.by) === r).length;
      const cp = (room.flags?.capLog ?? []).filter((c) => c.capAt >= runStart && roleOf(c.by) === r).length;
      const rt = (room.flags?.retLog ?? []).filter((x) => x.at >= runStart && roleOf(x.by) === r).length;
      console.log(`  ${r.padEnd(14)} ${String(s.n).padStart(4)}  ${String(s.k).padStart(3)} / ${s.d} ${String(Math.round(sumFor(r, botDmg))).padStart(6)} ${String(gr).padStart(3)} ${String(cp).padStart(2)} ${String(rt).padStart(2)} ${String(sumFor(r, botCk)).padStart(2)}   ${cnt ? (spd / cnt).toFixed(1).padStart(4) : '   -'} ${cnt ? (en / cnt).toFixed(0).padStart(5) : '    -'} ${cnt ? (life / cnt).toFixed(0).padStart(6) : '     -'} ${cnt ? ((post / cnt) * 100).toFixed(0).padStart(4) : '   -'} ${cnt ? ((flag / cnt) * 100).toFixed(0).padStart(4) : '   -'}`);
    }
    if (hofAway.size) {
      const hofTotal = [...hofAway.values()].reduce((a, b) => a + b, 0);
      const parts = [...hofAway.keys()].sort()
        .map((k) => `${k}:${(((hofAway.get(k) ?? 0) / hofTotal) * 100).toFixed(0)}%`);
      const destMed = hofDest.length ? hofDest.sort((a, b) => a - b)[hofDest.length >> 1]!.toFixed(0) : '-';
      if (hofGoalProbe.length) {
        const unposted = hofGoalProbe.filter((g) => g.posted === 0).length;
        const pdMed = hofGoalProbe.map((g) => g.pd).sort((a, b) => a - b)[hofGoalProbe.length >> 1]!.toFixed(0);
        parts.push(`goalpick med ${pdMed}m, posted=0 on ${((unposted / hofGoalProbe.length) * 100).toFixed(0)}%`);
      }
      if (hofLadder.length) {
        const ladMed = hofLadder.sort((a, b) => a - b)[hofLadder.length >> 1]!.toFixed(0);
        parts.push(`ladderGoal med ${ladMed}m`);
      }
      if (hofTrips.length) {
        const fresh = hofTrips.filter((x) => x.age < 60).length;
        parts.push(`${hofTrips.length} trips >60m (${fresh} within 60s of spawn)`);
        row('hof-trips', hofTrips.slice(0, 12).map((x) => `t${x.t.toFixed(0)} age${x.age.toFixed(0)} pk${x.peak.toFixed(0)} goal${x.gg0.toFixed(0)} dest${x.dd0.toFixed(0)}`).join(' · '));
      }
      row('hof-away', `ticks by flagState+distBand (<15m/15-60m/60m+, R=first 25s of life)   ${parts.join(' ')}   home2 dest-dist median ${destMed}m`);
      for (const id of [...new Set(hofTrace.map((s) => s.id))]) {
        const tr = hofTrace.filter((s) => s.id === id).filter((_, i) => i % 6 === 0)
          .map((s) => `${s.t.toFixed(0)}s ${s.st} pos${s.dh.toFixed(0)}→dest${s.dd.toFixed(0)}`).join(' | ');
        if (tr) row('hof-trace', `${id}   ${tr}`);
      }
    }
    console.log(
      `  kpi-csv: score_alpha=${room.scores.alpha ?? 0},score_bravo=${room.scores.bravo ?? 0}` +
      `,kills_a=${killsByTeam.alpha ?? 0},kills_b=${killsByTeam.bravo ?? 0},pkEv=${pkMsgs.length},selfK=${selfKills}` +
      `,press_a=${Number.isFinite(press.alpha) ? press.alpha.toFixed(1) : '-'},press_b=${Number.isFinite(press.bravo) ? press.bravo.toFixed(1) : '-'}` +
      `,flagA=${Number.isFinite(flagNear.alpha) ? flagNear.alpha.toFixed(1) : '-'},flagB=${Number.isFinite(flagNear.bravo) ? flagNear.bravo.toFixed(1) : '-'}` +
      `,capA=${Number.isFinite(capNear.alpha) ? capNear.alpha.toFixed(1) : '-'},capB=${Number.isFinite(capNear.bravo) ? capNear.bravo.toFixed(1) : '-'}` +
      `,grabs_a=${grabsBy.alpha ?? 0},grabs_b=${grabsBy.bravo ?? 0},caps=${caps.length}` +
      `,nug=${nug.spawn}/${nug.bankHot + nug.bankCold}/${nug.decay}/${nug.die}` +
      `,hunt=${huntN ? Math.round((huntSum / huntN) * 100) : 0}%,inSight=${huntN ? Math.round((inSightSum / huntN) * 100) : 0}%` +
      `,e_med=${medOf(eRows.map((r) => r.avg)).toFixed(0)}` +
      (caps.length ? `,fastest_s=${(fastest.holdMs / 1000).toFixed(1)}` : ''),
    );
    console.log('');
    // Launch telemetry — a soak that reports avgE without launches can't
    // tell whether bots ever disc-jump.
    const prop = room.bots?.arsenal.propels;
    if (prop?.size) {
      let heel = 0, pull = 0, crest = 0;
      const byBot = [...prop.entries()].sort((a, b) => (b[1].heel + b[1].pull + b[1].crest) - (a[1].heel + a[1].pull + a[1].crest));
      for (const [, s] of prop) { heel += s.heel; pull += s.pull; crest += s.crest; }
      console.log(`  propels    heel ${heel} · pull ${pull} · crest ${crest}   top ${byBot.slice(0, 3).map(([id, s]) => `${fmtId(id)} ${s.heel}/${s.pull}/${s.crest}`).join(' · ')}`);
    }
    console.log(`  energy     ${eLine}`);
    // Per-weapon lethality — the ranking table the chaser-kit question
    // needs: which guns actually convert hits to kills in real traffic.
    // weaponStats keys sources 'w<weaponType>' plus labels for turret/
    // mine/env; print everything that killed, damage-ordered.
    const wsnap = weaponStats.snapshot();
    const wrows = wsnap.byMode[room.mode] ?? {};
    const wttk = wsnap.ttk[room.mode] ?? {};
    const wtable = Object.entries(wrows)
      .filter(([, r]) => r.kills > 0)
      .sort((a, b) => b[1].kills - a[1].kills)
      .map(([w, r]) => {
        const name = (w.startsWith('w') ? WeaponType[+w.slice(1)] : undefined) ?? w;
        // Kills per trigger-uptime second: shots × the weapon's own
        // fire period — fair across weapon switching since every pull
        // costs its own cadence, unlike duel-time which credits the
        // finisher for duels other weapons started.
        const iv = w.startsWith('w') ? WEAPON_FIRE_INTERVAL_S[+w.slice(1) as WeaponType] : undefined;
        const trigS = iv !== undefined && r.shots > 0 ? r.shots * iv : 0;
        const t = wttk[w];
        // Sub-50ms "duels" are claim/settle races, not engagements —
        // a finisher landing on a pre-wounded body reads 76K/s without
        // the floor, which poisons the comparison.
        const duelKps = t && t.totalMs / Math.max(1, t.n) >= 50 ? (r.kills / (t.totalMs / 1000)).toFixed(2) : '';
        const trigKps = trigS > 0 ? (r.kills / trigS).toFixed(2) : '';
        return { name, r, trigKps, duelKps };
      });
    console.log('');
    if (wtable.length) {
      console.log('  — K kills · hits/shots fired · acc% hit rate · K/tr-s kills per trigger-second · K/s kills per shot · shots-by-range aim-distance bands (m) —');
    console.log('  weapon            K  hits  shots   acc%   dmg  K/tr-s  K/s   shots-by-range');
      for (const { name, r, trigKps, duelKps } of wtable) {
        const acc = r.shots > 0 ? ((r.hits / r.shots) * 100).toFixed(0) : '-';
        const rng = r.dist && Object.keys(r.dist).length
          ? Object.entries(r.dist).sort((a, b) => b[1] - a[1]).map(([b, n]) => `${b}:${n}`).join(' ')
          : '';
        console.log(`  ${name.padEnd(14)} ${String(r.kills).padStart(3)} ${String(r.hits).padStart(5)} ${String(r.shots).padStart(6)} ${acc.padStart(5)} ${String(Math.round(r.damage)).padStart(5)} ${trigKps.padStart(7)} ${duelKps.padStart(6)}   ${rng}`);
      }
    } else console.log('  weapon       no credited kills');
    console.log('');
    console.log(
      `  summary    ${score} · kills ${kills} · grabs ${grabs} caps ${caps.length}` +
      (caps.length ? ` · fastest ${(fastest.holdMs / 1000).toFixed(1)}s by ${fmtId(fastest.by)} (${fastest.team}) avg hold ${avgHold.toFixed(1)}s` : '') +
      (fragger ? ` · top fragger ${fmtId(fragger.id)} ${fragger.kills}K/${fragger.deaths}D` : '') +
      (kd && kd.id !== fragger?.id ? ` · best K/D ${fmtId(kd.id)} ${(kd.kills / Math.max(1, kd.deaths)).toFixed(1)}` : ''),
    );
    // The probe only works if the room genuinely simmed: a bot CTF room
    // at 20Hz should comfortably beat real-time, not crawl at 1x.
    expect(ratio).toBeGreaterThan(10);
    // Honesty check: after ~3h of sim a wall-clock-cheap room would be a
    // graveyard — respawns must have kept cycling (some alive now).
    expect(alive).toBeGreaterThan(0);
  }, WALL_BUDGET_MS + 30_000);
});
