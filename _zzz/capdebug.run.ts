import { mkRoom, step } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { readFileSync } from 'fs';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';

const fld = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/katabatic.bin`)));
const katAt = (x: number, z: number) => ({ x, y: hmHeight(fld, x, z), z });
const bases = { alpha: katAt(236.85, -127.11), bravo: katAt(-423.57, 281.67) };
const room = mkRoom({ mode: 'ctf', bots: 6, botFill: 6, bases }, 'ctf', 9001, false, fld);
const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
const capper = bots.find((p) => p.team === 'alpha')!;
const ctl = room.bots as any;
ctl.loadouts.set(capper.id, { ...BOT_LOADOUTS[0]!, belt: WeaponType.Implodisc });
ctl.roster.refitClass(capper.id);
ctl.roster.roles.set(capper.id, 'capper');
capper.perk = 'featherjets';
room.moveSim.setPerk(capper.id, 'featherjets');
for (const p of bots) { if (p !== capper) { room.bots.quiet.add(p.id); } }

let grabbed = -1;
for (let i = 0; i < 480 * 20; i += 1) {
  step(room, 1, 0.05);
  const bf = room.flags!.flags.get('bravo')!;
  if (i % 400 === 0) {console.log("tick", i, "pos", capper.position.x.toFixed(0), capper.position.z.toFixed(0), "bstate", bf.state);}
  if (grabbed < 0 && bf.carrier === capper.id) { grabbed = i; console.log('GRAB at', (i*0.05).toFixed(1)); }
  if (grabbed >= 0 && i % 100 === 0) {
    const out = (room.bots as any).lastOut.get(capper.id);
    const dh = Math.hypot(capper.position.x - 236.85, capper.position.z + 127.11);
    console.log('t=', (i*0.05).toFixed(0), 'dHome=', dh.toFixed(0), 'v=', Math.hypot(capper.velocity.x, capper.velocity.z).toFixed(1),
      'dest=', out ? JSON.stringify(out.dest) : '?', 'park=', out?.move?.park ?? '-',
      'pos=', capper.position.x.toFixed(0), capper.position.z.toFixed(0));
    if (bf.state !== 'carried') { console.log('flag left carrier:', bf.state); break; }
  }
}
