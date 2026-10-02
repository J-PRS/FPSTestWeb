import { describe, it, expect, afterAll } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkRoom, step, watch } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { GRAVITY } from '../../../shared/movement.ts';
import { simNow, simNowAdvance, simNowReset } from '../../src/simClock.ts';
import { weaponStats } from '../../src/weaponStats.ts';
import { selfKillImpactDist } from '../../src/hitLedger.ts';
import { WeaponType } from '../../../shared/weaponTable.ts';
import { WEAPON_FIRE_INTERVAL_S } from '../../../shared/weapons.ts';

// FPS_TRAIL=<file.bmp> plots every bot's XZ track (alpha=red, bravo=
// blue) top-down over the 1500m terrain wrap at 512x512 — hotspots and
// dead routing lanes show instantly. Costs a position snapshot per
// batch, so it stays opt-in.
const TRAIL_PATH = process.env.FPS_TRAIL;

/** 24-bit uncompressed BMP — zero deps, opens everywhere. */
function bmpWrite(path: string, w: number, h: number, px: Uint8Array): void {
  const row = w * 3, pad = (4 - (row % 4)) % 4, size = (row + pad) * h;
  const b = Buffer.alloc(54 + size);
  b.write('BM'); b.writeUInt32LE(54 + size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(size, 34);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = 54 + y * (row + pad) + x * 3;
      b[d] = px[s + 2]!; b[d + 1] = px[s + 1]!; b[d + 2] = px[s]!;
    }
  writeFileSync(path, b);
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
    }, mode, 4242, false, field);
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
          targetId?: string; shooterId?: string;
        };
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
        }
      }
    };
    const trail: { x: number; z: number; team: string; carrying: boolean }[] = [];
    const deaths: { x: number; z: number; team: string }[] = [];
    // Movement-energy telemetry — specific mechanical energy ½v²+g·h
    // (h = height above terrain, J/kg), the "are they skiing like Tribes
    // or walking like llamas" meter. Sampled per batch per live bot.
    const eStats = new Map<string, { team: string; sum: number; max: number; n: number }>();
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
          if (TRAIL_PATH && p.team && !wasDead.get(p.id)) deaths.push({ x: p.position.x, z: p.position.z, team: p.team });
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
        wasDead.set(p.id, false);
        if (p.team) {
          const v2 = p.velocity.x ** 2 + p.velocity.y ** 2 + p.velocity.z ** 2;
          const e = 0.5 * v2 - GRAVITY * Math.max(0, p.position.y - hmHeight(field, p.position.x, p.position.z));
          const s = eStats.get(p.id) ?? { team: p.team, sum: 0, max: 0, n: 0 };
          s.sum += e; s.n++; if (e > s.max) s.max = e;
          eStats.set(p.id, s);
        }
        if (TRAIL_PATH && p.team) {
          const carrying = [...(room.flags?.flags.values() ?? [])].some((f) => f.carrier === p.id);
          trail.push({ x: p.position.x, z: p.position.z, team: p.team, carrying });
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
      const px = new Uint8Array(W * W * 3);
      const ij = (x: number, z: number) => [
        Math.round((x + HALF) / (2 * HALF) * (W - 1)),
        Math.round((z + HALF) / (2 * HALF) * (W - 1)),
      ];
      const set = (ix: number, iy: number, r: number, g: number, b: number) => {
        if (ix < 0 || iy < 0 || ix >= W || iy >= W) return;
        const i = (iy * W + ix) * 3;
        px[i] = r; px[i + 1] = g; px[i + 2] = b;
      };
      const plot = (x: number, z: number, r: number, g: number, b: number) => set(ij(x, z)[0]!, ij(x, z)[1]!, r, g, b);
      // Terrain underlay: elevation → brightness, so dead zones read as
      // ridges/valleys and not unexplored void.
      let hMin = Infinity, hMax = -Infinity;
      const hAt: number[] = new Array(W * W);
      for (let iy = 0; iy < W; iy++)
        for (let ix = 0; ix < W; ix++) {
          const h = hmHeight(field, (ix / (W - 1)) * 2 * HALF - HALF, (iy / (W - 1)) * 2 * HALF - HALF);
          hAt[iy * W + ix] = h;
          if (h < hMin) hMin = h;
          if (h > hMax) hMax = h;
        }
      for (let i = 0; i < W * W; i++) {
        const v = 18 + 52 * ((hAt[i]! - hMin) / Math.max(1, hMax - hMin));
        px[i * 3] = v; px[i * 3 + 1] = v; px[i * 3 + 2] = v + 6;
      }
      // Deaths under trails: where bodies fall decides whether a dead
      // lane is a wall (deaths on the seam) or a killbox (deaths clustered).
      for (const d of deaths) {
        const [ix, iy] = ij(d.x, d.z);
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            d.team === 'alpha' ? set(ix! + dx, iy! + dy, 140, 40, 30) : set(ix! + dx, iy! + dy, 40, 60, 140);
      }
      for (const t of trail) {
        // Carriers glow so flag routes cut through the team-color noise —
        // orange for alpha, purple for bravo.
        const [r, g, b] = t.carrying
          ? (t.team === 'alpha' ? [255, 160, 40] : [190, 80, 255])
          : (t.team === 'alpha' ? [255, 70, 70] : [90, 140, 255]);
        plot(t.x, t.z, r, g, b);
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
      bmpWrite(TRAIL_PATH, W, W, px);
      console.log(`  trail: ${trail.length} samples, ${deaths.length} deaths, ${pins.length} flag events → ${TRAIL_PATH}`);
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
    const selfLine = [...selfByW.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' ') +
      ` @${(selfImpact[selfImpact.length >> 1] ?? 0).toFixed(1)}m`;
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
    const roleLine = [...byRole.entries()].sort().map(([r, s]) => `${r}:${s.n}x ${s.k}K/${s.d}D`).join('  ');
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
    console.log(
      `  kpi,score_alpha=${room.scores.alpha ?? 0},score_bravo=${room.scores.bravo ?? 0}` +
      `,kills_a=${killsByTeam.alpha ?? 0},kills_b=${killsByTeam.bravo ?? 0},pkEv=${pkMsgs.length},selfK=${selfKills}(${selfLine})` +
      `,press_a=${Number.isFinite(press.alpha) ? press.alpha.toFixed(1) : '-'},press_b=${Number.isFinite(press.bravo) ? press.bravo.toFixed(1) : '-'}` +
      `,flagA=${Number.isFinite(flagNear.alpha) ? flagNear.alpha.toFixed(1) : '-'}(${flagGap.alpha[0].toFixed(1)}+${flagGap.alpha[1].toFixed(1)}y@${flagGap.alpha[2].toFixed(0)}mps),flagB=${Number.isFinite(flagNear.bravo) ? flagNear.bravo.toFixed(1) : '-'}(${flagGap.bravo[0].toFixed(1)}+${flagGap.bravo[1].toFixed(1)}y@${flagGap.bravo[2].toFixed(0)}mps)` +
      `,capA=${Number.isFinite(capNear.alpha) ? capNear.alpha.toFixed(1) : '-'},capB=${Number.isFinite(capNear.bravo) ? capNear.bravo.toFixed(1) : '-'}` +
      `,fdieA=${flagDeaths.alpha.length}@${flagDeaths.alpha.length ? (flagDeaths.alpha.reduce((s, v) => s + v, 0) / flagDeaths.alpha.length).toFixed(0) : '-'}m,fdieB=${flagDeaths.bravo.length}@${flagDeaths.bravo.length ? (flagDeaths.bravo.reduce((s, v) => s + v, 0) / flagDeaths.bravo.length).toFixed(0) : '-'}m` +
      `,ringD=${ringSurv.died.length}@${ringSurv.died.length ? (ringSurv.died.reduce((s, v) => s + v, 0) / ringSurv.died.length).toFixed(1) : '-'}s,ringL=${ringSurv.left.length}` +
      `,capStop=${capStop.entries}e/${capStop.grabs}g/${capStop.died}d/${capStop.left}l` +
      (capStop.dSpd.length ? ` Δspd=${medOf(capStop.dSpd).toFixed(1)} Δhp=${medOf(capStop.dHp).toFixed(0)}` : '') +
      `,kzA=${killZone.attack},kzD=${killZone.defense},kzM=${killZone.mid}` +
      `,nug=${nug.spawn}s/${nug.bankHot + nug.bankCold}b(hot${nug.bankHot})/${nug.decay}dec/${nug.die}die` +
      `,grabs_a_flag=${grabsBy.alpha ?? 0},grabs_b_flag=${grabsBy.bravo ?? 0},caps=${caps.length}` +
      `,e_med=${medOf(eRows.map((r) => r.avg)).toFixed(0)}` +
      `,hunt=${huntN ? Math.round((huntSum / huntN) * 100) : 0}%,cloak=${huntN ? Math.round((cloakSum / huntN) * 100) : 0}%` +
      `,foeM=${huntN ? (nearFoeSum / huntN).toFixed(0) : '-'},inSight=${huntN ? Math.round((inSightSum / huntN) * 100) : 0}%` +
      `,goalA=${goalOut.nA ? (goalOut.alpha / goalOut.nA).toFixed(0) : '-'},goalB=${goalOut.nB ? (goalOut.bravo / goalOut.nB).toFixed(0) : '-'}` +
      `,progA=${progRows.alpha.cnt ? (progRows.alpha.sum / progRows.alpha.cnt).toFixed(1) : '-'},progB=${progRows.bravo.cnt ? (progRows.bravo.sum / progRows.bravo.cnt).toFixed(1) : '-'}` +
      `,flips=${flips.size ? ([...flips.values()].reduce((n, f) => n + f.n, 0) / flips.size).toFixed(1) : '-'}` +
      `,align=${align.n ? (align.sum / align.n).toFixed(2) : '-'}` +
      (caps.length ? `,fastest_s=${(fastest.holdMs / 1000).toFixed(1)}` : ''),
    );
    console.log(`  roles: ${roleLine}`);
    // Launch telemetry — a soak that reports avgE without launches can't
    // tell whether bots ever disc-jump.
    const prop = room.bots?.arsenal.propels;
    if (prop?.size) {
      let heel = 0, pull = 0, crest = 0;
      const byBot = [...prop.entries()].sort((a, b) => (b[1].heel + b[1].pull + b[1].crest) - (a[1].heel + a[1].pull + a[1].crest));
      for (const [, s] of prop) { heel += s.heel; pull += s.pull; crest += s.crest; }
      console.log(`  propels: heel=${heel} pull=${pull} crest=${crest}; top ${byBot.slice(0, 3).map(([id, s]) => `${fmtId(id)} ${s.heel}/${s.pull}/${s.crest}`).join(' ')}`);
    }
    console.log(`  energy: ${eLine}`);
    // Per-weapon lethality — the ranking table the chaser-kit question
    // needs: which guns actually convert hits to kills in real traffic.
    // weaponStats keys sources 'w<weaponType>' plus labels for turret/
    // mine/env; print everything that killed, damage-ordered.
    const wsnap = weaponStats.snapshot();
    const wrows = wsnap.byMode[room.mode] ?? {};
    const wttk = wsnap.ttk[room.mode] ?? {};
    const wline = Object.entries(wrows)
      .filter(([, r]) => r.kills > 0)
      .sort((a, b) => b[1].kills - a[1].kills)
      .map(([w, r]) => {
        const name = w.startsWith('w') && WeaponType[+w.slice(1)] !== undefined ? WeaponType[+w.slice(1)] : w;
        // Kills per trigger-uptime second: shots × the weapon's own
        // fire period — fair across weapon switching since every pull
        // costs its own cadence, unlike duel-time which credits the
        // finisher for duels other weapons started.
        const iv = w.startsWith('w') ? WEAPON_FIRE_INTERVAL_S[+w.slice(1) as WeaponType] : undefined;
        const trigS = iv !== undefined && r.shots > 0 ? r.shots * iv : 0;
        const t = wttk[w];
        const duelKps = t && t.totalMs > 0 ? ` ${(r.kills / (t.totalMs / 1000)).toFixed(2)}K/s` : '';
        const trigKps = trigS > 0 ? ` ${(r.kills / trigS).toFixed(2)}K/tr` : '';
        return `${name} ${r.kills}K/${r.hits}hits/${r.shots}shots/${r.damage.toFixed(0)}dmg${trigKps}${duelKps}`;
      })
      .join('  ');
    console.log(`  weapons: ${wline || 'no credited kills'}`);
    console.log(
      `  match: score ${score}; kills ${kills} (alpha ${killsByTeam.alpha ?? 0} / bravo ${killsByTeam.bravo ?? 0}); ` +
      `press ${Number.isFinite(press.alpha) ? press.alpha.toFixed(0) : '—'}m(dy${pressY.alpha >= 0 ? '+' : ''}${pressY.alpha.toFixed(0)})/${Number.isFinite(press.bravo) ? press.bravo.toFixed(0) : '—'}m(dy${pressY.bravo >= 0 ? '+' : ''}${pressY.bravo.toFixed(0)}); ` +
      `grabs ${grabs}${grabs ? ` (alpha flag ${grabsBy.alpha ?? 0} / bravo flag ${grabsBy.bravo ?? 0})` : ''} caps ${caps.length}` +
      (caps.length ? `, fastest cap ${(fastest.holdMs / 1000).toFixed(1)}s by ${fmtId(fastest.by)} (${fastest.team}), avg hold ${avgHold.toFixed(1)}s` : '') +
      (fragger ? `; top fragger ${fmtId(fragger.id)} ${fragger.kills}K/${fragger.deaths}D` : '') +
      (kd && kd.id !== fragger?.id ? `; best K/D ${fmtId(kd.id)} ${(kd.kills / Math.max(1, kd.deaths)).toFixed(1)}` : ''),
    );
    // The probe only works if the room genuinely simmed: a bot CTF room
    // at 20Hz should comfortably beat real-time, not crawl at 1x.
    expect(ratio).toBeGreaterThan(10);
    // Honesty check: after ~3h of sim a wall-clock-cheap room would be a
    // graveyard — respawns must have kept cycling (some alive now).
    expect(alive).toBeGreaterThan(0);
  }, WALL_BUDGET_MS + 30_000);
});
