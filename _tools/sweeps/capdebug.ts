import { readFileSync } from 'node:fs';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { BOT_LOADOUTS } from '../../shared/botLoadouts.ts';
import { WeaponType } from '../../shared/weapons.ts';

const name = process.argv[2]!;
const seed = process.argv[3] ? Number(process.argv[3]) : 9001;
const spec = JSON.parse(readFileSync(`${import.meta.dir}/../../maps/${name}.json`, 'utf8'));
const fld = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../maps/${spec.terrain}`)));
const at = (x: number, z: number) => ({ x, y: hmHeight(fld, x, z), z });
const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };

const room = mkRoom({ mode: 'ctf', bots: 6, bases }, 'ctf', seed, false, fld);
const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
const capper = bots.find((p) => p.team === 'alpha')!;
const ctl = room.bots as unknown as {
  loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
  roster: { roles: Map<string, string>; refitClass(id: string): void };
  brains: Map<string, { jetDebug: { why: string; escapeT: number; out: boolean; hold: number } }>;
  debugDest(id: string): { x: number; y: number; z: number } | null;
};
ctl.loadouts.set(capper.id, { ...BOT_LOADOUTS[0]!, belt: WeaponType.Implodisc });
ctl.roster.refitClass(capper.id);
ctl.roster.roles.set(capper.id, 'capper');
for (const p of bots) {
  if (p !== capper) {
    room.bots.quiet.add(p.id);
    if (p.team === 'alpha') ctl.roster.roles.set(p.id, 'offense');
  }
}

const dt = 0.05;
let simT = 0;
for (let i = 0; i < 240 * 20; i++) {
  step(room, 1, dt);
  simT += dt;
  const flag = room.flags!.flags.get('bravo')!;
  if (flag.carrier === capper.id) { console.log(`t=${simT.toFixed(1)} GRABBED`); break; }
  if (i % 40 === 0) {
    const d = Math.hypot(flag.pos.x - capper.position.x, flag.pos.z - capper.position.z);
    const dy = flag.pos.y - capper.position.y;
    const jd = ctl.brains.get(capper.id)?.jetDebug;
    const dest = ctl.debugDest(capper.id);
    const sh = (room.moveSim as unknown as { shadows: Map<string, { sim: { input: { forward: number; jumpHeld: boolean; jetHeld: boolean; skiHeld: boolean } }; energy: number }> }).shadows.get(capper.id);
    const inp = sh?.sim.input;
    console.log(
      `t=${simT.toFixed(0)} p=(${capper.position.x.toFixed(0)},${capper.position.y.toFixed(0)},${capper.position.z.toFixed(0)}) ` +
      `dStand=${d.toFixed(0)} dy=${dy.toFixed(1)} v=${Math.hypot(capper.velocity.x, capper.velocity.z).toFixed(0)} vy=${capper.velocity.y.toFixed(0)} ` +
      `flag=${flag.state}@${flag.pos.y.toFixed(0)} dead=${capper.isDead} ` +
      `inp=${inp ? `f${inp.forward.toFixed(0)}/j${inp.jumpHeld ? 1 : 0}/J${inp.jetHeld ? 1 : 0}/s${inp.skiHeld ? 1 : 0}` : '-'} ` +
      `en=${sh?.energy.toFixed(0) ?? '-'} ` +
      `dest=${dest ? `(${dest.x.toFixed(0)},${dest.y.toFixed(0)},${dest.z.toFixed(0)})` : '-'} jet=${jd?.why ?? '?'}/${jd?.out ? 1 : 0}`,
    );
  }
}
console.log(`done t=${simT.toFixed(0)}`);
