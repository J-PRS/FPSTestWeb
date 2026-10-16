/**
 * mpcCost.ts — what the MPC drive option costs a room, and what the room
 * costs without it. The probe the fastSoak A/B could not make: it stubs
 * the live BotMpc in-tree (no product edit) so "the MPC owns the tick"
 * is proven instead of inferred from a mode difference.
 *
 *   bun _tools/sweeps/mpcCost.ts                 # 16 bots, ctf, both arms
 *   bun _tools/sweeps/mpcCost.ts --mode tdm      # no runners -> MPC never arms
 *   bun _tools/sweeps/mpcCost.ts --bots 32 --wall 15
 *
 * Reports ticks/sim-s/warp per arm, plus BotMpc's own replan counters
 * (which only print on process exit in the product path).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { mkRoom, step, watch } from '../../server_bun/tests/scenarios/harness.ts';
import { simNow, simNowAdvance } from '../../server_bun/src/simClock.ts';
import { BotMpc } from '../../server_bun/src/botMpc.ts';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const MAP = arg('map', 'katabatic');
const MODE = arg('mode', 'ctf');
const BOTS = Number(arg('bots', 16));
const WALL_MS = Number(arg('wall', 10)) * 1000;
/** Cap by SIM time instead of wall time when comparing arms: a wall
 *  budget runs the fast arm 10x longer, so a "grabs" delta between arms
 *  is a sample-size artifact, not a quality signal. `--sim 600` gives both
 *  arms the same simulated match. */
const SIM_S = Number(arg('sim', 0));

const specName = MAP === 'katabatic' ? 'katabatic_bare' : MAP;
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${specName}.json`), 'utf8')) as {
  bases?: { alpha: { x: number; z: number }; bravo: { x: number; z: number } };
  teamSpawns?: Record<string, { x: number; z: number; r?: number; w?: number }[]>;
  terrain?: string;
};
const field = hmParseBin(new Uint8Array(readFileSync(
  resolve(import.meta.dir, `../../maps/${spec.terrain ?? (MAP === 'katabatic' ? 'katabatic' : MAP) + '.bin'}`))));
const at = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });

interface Arm { name: string; ticks: number; simS: number; wallS: number; replans: number; searchMs: number; grabs: number; caps: number; near: number; capSpd: number }

function runArm(name: string, stub: boolean): Arm {
  const room = mkRoom({
    ...spec,
    mode: MODE,
    bots: BOTS,
    botFill: BOTS,
    ...(spec.bases && MODE === 'ctf' ? {
      bases: { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) },
      teamSpawns: Object.fromEntries(Object.entries(spec.teamSpawns ?? {}).map(([t, ss]) => [
        t, ss.map((s) => ({ x: s.x, y: hmHeight(field, s.x, s.z), z: s.z, r: s.r ?? 50, w: s.w ?? 90 })),
      ])),
    } : {}),
  }, MODE, 1337, false, field);
  room.spec.botFill = 0;
  (room as { endMatch: (w: string) => void }).endMatch = () => {};
  if (stub) {
    // Same shape, never drives — the caller's `false` return sends the bot
    // through the normal pipeline, i.e. exactly the pre-MPC behavior.
    (room.bots as unknown as { mpc: { drive(id: string, t: unknown): boolean; release(id: string): void } }).mpc = {
      drive: () => false,
      release: () => { /* stub */ },
    };
  }
  const n0 = BotMpc.n, ms0 = BotMpc.ms;
  // Flag activity as the end-to-end quality signal: the option's whole
  // claim is a better capper line, so a room that grabs LESS with it on
  // is the option hurting, whatever the offline metric says.
  const w = watch(room);
  const carried = new Set<string>();
  let grabs = 0, caps = 0, msgCur = 0;
  // Dense quality signal: grabs are too rare on a 1.5km map to compare
  // arms (0 vs 3 in 600 sim-s), but a capper's CLOSEST APPROACH to the
  // enemy flag happens every run and directly reflects the route the
  // option flew — min over the arm, plus the mean capper speed.
  let near = Infinity, spdSum = 0, spdN = 0;
  const botsRef = room.bots as unknown as { roleOf(id: string): string | null };
  const drain = (): void => {
    for (; msgCur < w.msgs.length; msgCur++) {
      const m = w.msgs[msgCur]! as unknown as { type: string; flags?: { team: string; state: string; carrier: string | null }[] };
      if (m.type !== 'flagUpdate') {continue;}
      for (const f of m.flags ?? []) {
        if (f.state === 'carried' && !carried.has(f.team)) {carried.add(f.team); grabs++;}
        else if (f.state !== 'carried') {carried.delete(f.team);}
      }
    }
  };
  const dt = 0.05, BATCH = 20;
  const t0 = performance.now();
  let ticks = 0;
  const simCap = SIM_S > 0 ? SIM_S / dt : Infinity;
  while (performance.now() - t0 < WALL_MS && ticks < simCap) {
    simNowAdvance(dt * 1000 * BATCH);
    step(room, BATCH, dt);
    room.messages.respawnTick(simNow());
    drain();
    caps = room.flags?.capLog.length ?? 0;
    for (const p of room.players.getAllPlayers().values()) {
      if (p.isDead || !p.team) {continue;}
      const foe = room.flags?.flags.get(p.team === 'alpha' ? 'bravo' : 'alpha');
      if (!foe) {continue;}
      const d = Math.hypot(p.position.x - foe.pos.x, p.position.z - foe.pos.z);
      if (d < near) {near = d;}
      if (botsRef.roleOf(p.id) === 'capper') {spdSum += Math.hypot(p.velocity.x, p.velocity.z); spdN++;}
    }
    ticks += BATCH;
  }
  const wallS = (performance.now() - t0) / 1000;
  return { name, ticks, simS: ticks * dt, wallS, replans: BotMpc.n - n0, searchMs: BotMpc.ms - ms0, grabs, caps, near, capSpd: spdN ? spdSum / spdN : 0 };
}

const arms: Arm[] = [];
arms.push(runArm('mpc', false));
arms.push(runArm('no-mpc', true));

console.log(`\nmpcCost: ${BOTS} bots, ${MODE}, ${specName}, ${WALL_MS / 1000}s wall budget per arm\n`);
console.log('arm      | ticks |  sim-s | wall-s |  warp | replans | replans/s | search ms | avg ms | %wall | grabs | caps | grabs/100s | capNear | capSpd');
for (const a of arms) {
  const warp = a.simS / a.wallS;
  console.log(`${a.name.padEnd(8)} | ${String(a.ticks).padStart(5)} | ${a.simS.toFixed(0).padStart(6)} | ${a.wallS.toFixed(1).padStart(6)} | ${warp.toFixed(0).padStart(4)}x | ${String(a.replans).padStart(7)} | ${(a.replans / a.wallS).toFixed(1).padStart(9)} | ${a.searchMs.toFixed(0).padStart(9)} | ${(a.replans ? a.searchMs / a.replans : 0).toFixed(0).padStart(6)} | ${(100 * a.searchMs / (a.wallS * 1000)).toFixed(0).padStart(4)}% | ${String(a.grabs).padStart(5)} | ${String(a.caps).padStart(4)} | ${(100 * a.grabs / Math.max(1, a.simS)).toFixed(2).padStart(10)} | ${(Number.isFinite(a.near) ? a.near.toFixed(0) : '-').padStart(7)} | ${a.capSpd.toFixed(1).padStart(6)}`);
}
const mpc = arms[0]!, no = arms[1]!;
if (mpc.replans > 0) {
  console.log(`\nMPC search owns ${(100 * mpc.searchMs / (mpc.wallS * 1000)).toFixed(0)}% of the mpc arm's wall time; removing it moves the warp ${ (mpc.simS / mpc.wallS).toFixed(0) }x -> ${ (no.simS / no.wallS).toFixed(0) }x`);
} else {
  console.log('\nMPC never armed in this arm (no runners) — compare against the mode that has them.');
}
process.exit(0);
