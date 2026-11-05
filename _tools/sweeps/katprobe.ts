// Katabatic capper wander probe v2 — replicates measureCap setup and
// wraps the flag drop paths to name WHO fumbles the flag 1-2s after
// every grab. Also logs capper health (passFlag needs <40%).
//   cd server_bun && bun ../_tools/sweeps/katprobe.ts [seed] [budgetS]
import { readFileSync } from 'node:fs';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { mkRoom, step, watch } from '../../server_bun/tests/scenarios/harness.ts';
import { BOT_LOADOUTS } from '../../shared/botLoadouts.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';
import { WeaponType } from '../../shared/weapons.ts';

// Slow-transit experiment: FPS_KAT_SLOW=<speed> scales the runner's
// speed knobs down to test "does a survivable pace beat a fast death".
const slow = Number(process.env.FPS_KAT_SLOW ?? 0);
if (slow > 0) {
  const m = BOT_TUNING.moves as unknown as Record<string, number>;
  for (const k of ['cruiseSpeed', 'runInSpeed', 'bankSpeed', 'tailTapSpeed', 'runInGdMax']) {
    if (typeof m[k] === 'number') {m[k] = Math.min(m[k]!, slow);}
  }
  console.log(`SLOW mode: speed knobs -> ${slow}`);
}

const seed = Number(process.argv[2] ?? 9001);
const budget = Number(process.argv[3] ?? 480);
const kat = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../maps/katabatic.bin`)));
const katAt = (x: number, z: number) => ({ x, y: hmHeight(kat, x, z), z });
const bases = {
  alpha: katAt(236.85, -127.11),
  bravo: katAt(-423.57, 281.67),
};

const room = mkRoom({ mode: 'ctf', bots: 6, botFill: 6, bases }, 'ctf', seed, false, kat);
const w = watch(room);
const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
const capper = bots.find((p) => p.team === 'alpha')!;
const ctl = room.bots as unknown as {
  loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
  roster: { roles: Map<string, string>; refitClass(id: string): void };
  brains: Map<string, { jetDebug: { why: string; escapeT: number; out: boolean; hold: number } }>;
  debugDest(id: string): { x: number; y: number; z: number } | null;
  debugGoal(id: string): { x: number; y: number; z: number } | null;
  quiet: Set<string>;
  sense: { routing: {
    routeHold: Map<string, { stand: { x: number; y: number; z: number }; pos: { x: number; y: number; z: number }; at: number; minD?: number }>;
    routeFailed: Map<string, { pos: { x: number; y: number; z: number }; at: number; n?: number; stand?: { x: number; y: number; z: number } }>;
  } };
};
ctl.loadouts.set(capper.id, { ...BOT_LOADOUTS[0]!, belt: WeaponType.Implodisc });
ctl.roster.refitClass(capper.id);
ctl.roster.roles.set(capper.id, 'capper');
capper.perk = process.env.FPS_KAT_PERK ?? 'featherjets';
room.moveSim.setPerk(capper.id, 'featherjets');
// INVINCIBLE probe mode: god-mode the capper to isolate "can it cap"
// from "can it survive the route" — argv[4]=='god' pins health each tick.
const god = process.argv[4] === 'god';
for (const p of bots) {
  if (p !== capper) {
    ctl.quiet.add(p.id);
    if (p.team === 'alpha') {ctl.roster.roles.set(p.id, 'offense');}
  }
}

let simT = 0;
const flagsObj = room.flags as unknown as {
  throwFor(id: string): void;
  dropIfCarrier(id: string): void;
};
const origThrow = flagsObj.throwFor.bind(flagsObj);
const origDrop = flagsObj.dropIfCarrier.bind(flagsObj);
flagsObj.throwFor = (id: string): void => {
  console.log(`  >>> t=${simT.toFixed(1)} THROWFOR ${id} (carrier=${flagsObj['flags'] ? '?' : '?'})`);
  origThrow(id);
};
flagsObj.dropIfCarrier = (id: string): void => {
  console.log(`  >>> t=${simT.toFixed(1)} DROPIFCARRIER ${id}`);
  origDrop(id);
};

// Landing forensics: every paid fall-damage hit, with the surface
// impact speed and the body state at contact — separates steep-face
// landings (vy-dominated) from wall slams (horizontal KE into -v·n).
const ms = room.moveSim as unknown as { onLanding: ((pid: string, impact: number) => void) | null };
const origLand = ms.onLanding;
ms.onLanding = (pid: string, impact: number): void => {
  if (pid === capper.id) {
    console.log(
      `  >>> t=${simT.toFixed(1)} LAND impact=${impact.toFixed(0)} ` +
      `p=(${capper.position.x.toFixed(0)},${capper.position.y.toFixed(0)},${capper.position.z.toFixed(0)}) ` +
      `v=(${capper.velocity.x.toFixed(0)},${capper.velocity.y.toFixed(0)},${capper.velocity.z.toFixed(0)}) hp=${(capper.health / capper.maxHealth).toFixed(2)}`,
    );
  }
  origLand?.(pid, impact);
};

const dt = 0.05;
const flag = () => room.flags!.flags.get('bravo')!;
let sawCarry = false;
for (let i = 0; i < budget * 20; i++) {
  step(room, 1, dt);
  simT += dt;
  if (god && !capper.isDead) {capper.health = capper.maxHealth;}
  const f0 = flag();
  if (f0.carrier === capper.id) {sawCarry = true;}
  if (sawCarry && w.count('teamScore') > 0) {console.log(`  >>> t=${simT.toFixed(1)} CAP`); break;}
  const f = flag();
  if (i % 40 === 0 || f.carrier === capper.id) {
    const rt = ctl.sense.routing;
    const hold = rt.routeHold.get(capper.id);
    const failed = rt.routeFailed.get(capper.id);
    const d = Math.hypot(f.pos.x - capper.position.x, f.pos.z - capper.position.z);
    const dest = ctl.debugDest(capper.id);
    const goal = ctl.debugGoal(capper.id);
    const jd = ctl.brains.get(capper.id)?.jetDebug;
    const hp = capper.maxHealth > 0 ? (capper.health / capper.maxHealth).toFixed(2) : '?';
    console.log(
      `t=${simT.toFixed(0).padStart(3)} p=(${capper.position.x.toFixed(0).padStart(4)},${capper.position.y.toFixed(0).padStart(3)},${capper.position.z.toFixed(0).padStart(4)}) ` +
      `dF=${d.toFixed(0).padStart(3)} fst=${f.state}@(${f.pos.x.toFixed(0)},${f.pos.y.toFixed(0)},${f.pos.z.toFixed(0)}) ` +
      `v=${Math.hypot(capper.velocity.x, capper.velocity.z).toFixed(0).padStart(2)} hp=${hp} dead=${capper.isDead} ` +
      `goal=${goal ? `(${goal.x.toFixed(0)},${goal.z.toFixed(0)})` : '-'} ` +
      `dest=${dest ? `(${dest.x.toFixed(0)},${dest.y.toFixed(0)},${dest.z.toFixed(0)})` : '-'} ` +
      `hold=${hold ? `(${hold.pos.x.toFixed(0)},${hold.pos.z.toFixed(0)})` : '-'} ` +
      `fail=${failed ? `n${failed.n ?? 1}` : '-'} ` +
      `jet=${jd?.why ?? '?'}`,
    );
  }
}
console.log(`done t=${simT.toFixed(0)}`);
