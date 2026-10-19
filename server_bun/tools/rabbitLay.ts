// Rabbit flag-lay warp soak: how much sim-time does the flag sit
// 'dropped' unpicked? JP's rule: >10% of spawned time = hunter AI busted
// (flag is the rabbit priority). Runs on the warp clock — hours of
// combat in minutes of wall time, sim-timers still honest.
//
//   bun tools/rabbitLay.ts [--map raindance] [--bots 12] [--hours 4] [--seed 4242]
//   --wall N caps by WALL-clock seconds instead of sim-hours (0 = use --hours).
//
// Buckets per flag state, plus per-drop pickup latency: a flag that is
// grabbed in seconds but dropped constantly is a combat problem; a flag
// that lies for minutes is a routing problem.

// Same harness problem as hhEvo: tight step() loop starves the MPC
// worker, so solves run synchronously in-tick. FPS_MPC_OFF=0 opts back in.
process.env.FPS_MPC_OFF ??= '1';
import { readFileSync } from 'node:fs';
import { mkRoom, step } from '../tests/scenarios/harness.ts';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { simNow } from '../src/simClock.ts';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i === -1 ? d : process.argv[i + 1]!;
};

const MAP = arg('map', 'raindance');
const BOTS = Number(arg('bots', '12'));
const HOURS = Number(arg('hours', '4'));
const SEED = Number(arg('seed', '4242'));
const WALL_S = Number(arg('wall', '0')); // wall-clock budget — real maps are far slower per sim-sec than flat arenas
const DT = 0.05;

const mapJson = JSON.parse(readFileSync(`${import.meta.dir}/../../maps/${MAP}.json`, 'utf8')) as {
  bases?: { alpha: { x: number; z: number }; bravo?: { x: number; z: number } };
  terrain?: string;
};
const field = hmParseBin(new Uint8Array(readFileSync(
  `${import.meta.dir}/../../maps/${mapJson.terrain ?? `${MAP  }.bin`}`)));

// Rabbit's single flag is keyed 'alpha'; the room declares it via a
// partial base. Center-ish anchor only matters for the pre-blood
// 'unspawned' state — first corpse re-seeds it.
const alphaBase = mapJson.bases?.alpha ?? { x: 0, z: 0 };
const room = mkRoom({
  mode: 'rabbit',
  bots: BOTS, botFill: BOTS,
  bases: { alpha: { x: alphaBase.x, y: hmHeight(field, alphaBase.x, alphaBase.z), z: alphaBase.z } },
  balls: { base: 0, perPlayer: 0, max: 0 }, creatures: {},
}, 'rabbit', SEED, false, field);
// mkRoom leaves mapSrc '' — attach() then skips the baked interior boxes.
room.mapSrc = MAP;
if (mapJson.interiors?.length) {room.spec.interiors = mapJson.interiors;}
room.structs.attach();

const bucket = { unspawned: 0, dropped: 0, carried: 0, other: 0 };
const latencies: number[] = [];
const dropDist: number[] = []; // nearest living bot's distance at each drop
const dropMinD: number[] = [];  // closest any living bot got during each lay
let layMin = Infinity;
let dropStart: number | null = null;
let drops = 0, expiries = 0;
let prevState = '';

const ticks = Math.round((HOURS * 3600) / DT);
const w0 = Date.now();
const carrierHolds: { id: string; s: number }[] = [];
let carrierStart: number | null = null, carrierId: string | null = null;
let t = 0;
for (; t < ticks; t++) {
  if (WALL_S > 0 && Date.now() - w0 > WALL_S * 1000) {break;}
  step(room, 1, DT);
  // Warp: wall-clock respawn timers can't keep pace — drive the sim-paced pass.
  room.messages.respawnTick(simNow());
  const f = room.flags?.flags.get('alpha');
  const st = f ? f.state : 'unspawned';
  if (st in bucket) {bucket[st as keyof typeof bucket] += DT;}
  else {bucket.other += DT;}
  if (st === 'dropped') {
    for (const p of room.players.getAllPlayers().values()) {
      if (p.isDead) {continue;}
      layMin = Math.min(layMin, Math.hypot(p.position.x - f!.pos.x, p.position.y - f!.pos.y, p.position.z - f!.pos.z));
    }
  }
  if (f?.carrier !== carrierId) {
    if (carrierId !== null && carrierStart !== null) {carrierHolds.push({ id: carrierId, s: (simNow() - carrierStart) / 1000 });}
    carrierId = f?.carrier ?? null;
    carrierStart = carrierId ? simNow() : null;
  }
  if (st !== prevState) {
    if (st === 'dropped') {
      dropStart = simNow(); drops++;
      let near = Infinity;
      for (const p of room.players.getAllPlayers().values()) {
        if (p.isDead || p.id === f!.carrier) {continue;}
        near = Math.min(near, Math.hypot(p.position.x - f!.pos.x, p.position.y - f!.pos.y, p.position.z - f!.pos.z));
      }
      if (near < Infinity) {dropDist.push(near);}
      layMin = Infinity;
    }
    if (st === 'carried' && dropStart !== null) { latencies.push((simNow() - dropStart) / 1000); dropMinD.push(layMin); dropStart = null; }
    if (st === 'unspawned' && dropStart !== null) { expiries++; dropStart = null; }
    prevState = st;
  }
}
let alive = 0, dead = 0, frags = 0;
for (const p of room.players.getAllPlayers().values()) { p.isDead ? dead++ : alive++; frags += p.kills ?? 0; }
const wallMs = Date.now() - w0;

const spawned = bucket.dropped + bucket.carried;
const pct = (v: number, of: number) => (of > 0 ? (v / of * 100).toFixed(1) : '0.0');
const sorted = [...latencies].sort((a, b) => a - b);
const med = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;
const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)]! : 0;
const max = sorted.length > 0 ? sorted[sorted.length - 1]! : 0;

console.log(`rabbit flag-lay — map=${MAP} bots=${BOTS} sim=${(t * DT / 3600).toFixed(2)}h wall=${(wallMs / 1000).toFixed(0)}s (${(t * DT * 1000 / wallMs).toFixed(0)}x)`);
console.log(`  spawned=${(spawned / 3600).toFixed(2)}h carried=${(bucket.carried / 3600).toFixed(2)}h (${pct(bucket.carried, spawned)}%) dropped=${(bucket.dropped / 3600).toFixed(2)}h (${pct(bucket.dropped, spawned)}%) unspawned=${(bucket.unspawned / 3600).toFixed(2)}h`);
console.log(`  drops=${drops} pickups=${latencies.length} despawned-unpicked=${expiries}`);
console.log(`  pickup latency s: med=${med.toFixed(1)} p95=${p95.toFixed(1)} max=${max.toFixed(1)}`);
const dd = [...dropDist].sort((a, b) => a - b);
console.log(`  nearest-bot at drop m: med=${(dd[Math.floor(dd.length / 2)] ?? 0).toFixed(0)} p95=${(dd[Math.floor(dd.length * 0.95)] ?? 0).toFixed(0)} max=${(dd[dd.length - 1] ?? 0).toFixed(0)}`);
const dm = [...dropMinD].sort((a, b) => a - b);
console.log(`  closest approach during lay m: med=${(dm[Math.floor(dm.length / 2)] ?? 0).toFixed(1)} p95=${(dm[Math.floor(dm.length * 0.95)] ?? 0).toFixed(1)}`);
const holds = carrierHolds.map(h => h.s).sort((a, b) => a - b);
console.log(`  carrier holds n=${carrierHolds.length} med=${(holds[Math.floor(holds.length / 2)] ?? 0).toFixed(0)}s max=${(holds[holds.length - 1] ?? 0).toFixed(0)}s · roster frags=${frags} alive=${alive} dead=${dead}`);
const downPct = spawned > 0 ? bucket.dropped / spawned : 0;
console.log(`  VERDICT: flag down ${(downPct * 100).toFixed(1)}% of spawned time — ${downPct > 0.1 ? 'BUSTED (>10% threshold)' : 'healthy'}`);
