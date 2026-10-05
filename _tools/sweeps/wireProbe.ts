/**
 * Wire-cost probe — sims measure server CPU, but the bill that scales
 * with players is egress bytes. This wraps the room's binary send so
 * fanout runs for real and counts the frames it would ship: total
 * bytes/tick (×20Hz = egress), per-client rate, and fanout CPU.
 *
 *   bun _tools/sweeps/wireProbe.ts [--map katabatic] [--counts 40,100,200]
 *                                  [--secs 4] [--seed 1337]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { simNow } from '../../server_bun/src/simClock.ts';
import { TickFanout } from '../../server_bun/src/tickRecords.ts';
import type { PlayerState } from '../../server_bun/src/types.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const MAP = arg('map', 'katabatic');
const COUNTS = arg('counts', '40,100,160,200').split(',').map(Number);
const SECS = Number(arg('secs', 4));
const SEED = Number(arg('seed', 1337));
const dt = 0.05;
const TICK_HZ = 20;

const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${MAP}.json`), 'utf8'));
const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${(spec as { terrain: string }).terrain}`))), 1);
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const bases = {
  alpha: at((spec as { bases: { alpha: { x: number; z: number } } }).bases.alpha.x, (spec as never as { bases: { alpha: { z: number } } }).bases.alpha.z),
  bravo: at((spec as never as { bases: { bravo: { x: number; z: number } } }).bases.bravo.x, (spec as never as { bases: { bravo: { z: number } } }).bases.bravo.z),
};

const room = mkRoom({ ...spec, mode: 'ctf', bots: 0, bases }, 'ctf', SEED, false, f);
room.spec.botFill = 0; // same fix as capSoak — the soak owns the roster

// Count bytes instead of shipping them — harness bots have no sockets,
// so the real sender would drop every frame before its size mattered.
let tickBytes = 0;
let tickClients = 0;
room.connections.sendBinaryToPlayer = ((_id: string, data: Uint8Array) => {
  tickBytes += data.byteLength;
  tickClients++;
  return 'sent';
}) as never;

const metrics = { ticks: 0, recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0, recordsSent: 0, recordsTierSkipped: 0, bytesSent: 0, tickFramesDropped: 0, tickErrors: 0, windowStart: 0 };
const fanout = new TickFanout(metrics, () => {});

console.log(`map=${MAP} seed=${SEED} window=${SECS}s sim — bytes are egress per tick`);
console.log('count  B/tick    KB/s/sock  MB/s total  recs/tick  fanoutMs');

let prev = 0;
for (const target of COUNTS) {
  room.bots.populate(target - prev);
  prev = target;
  step(room, Math.round(2 / dt), dt); // settle
  let bytes = 0, clients = 0, ticks = 0, fanMs = 0, recs = 0;
  const players = room.players.getAllPlayers() as Map<string, PlayerState>;
  for (let i = 0, n = Math.round(SECS / dt); i < n; i++) {
    step(room, 1, dt);
    room.messages.respawnTick(simNow());
    tickBytes = 0; tickClients = 0;
    const t0 = performance.now();
    const records = fanout.buildRecords(room, players, simNow());
    fanout.fanoutRecords(room, players, records);
    fanMs += performance.now() - t0;
    bytes += tickBytes; clients += tickClients; recs += records.length; ticks++;
  }
  const bpt = bytes / ticks;
  const perSockKb = (bytes / Math.max(1, clients)) * TICK_HZ / 1024;
  const totalMb = bpt * TICK_HZ / 1048576;
  console.log(`${String(target).padStart(5)}  ${String(Math.round(bpt)).padStart(7)}  ${perSockKb.toFixed(1).padStart(8)}  ${totalMb.toFixed(1).padStart(9)}  ${(recs / ticks).toFixed(0).padStart(8)}  ${(fanMs / ticks).toFixed(2)}`);
}
