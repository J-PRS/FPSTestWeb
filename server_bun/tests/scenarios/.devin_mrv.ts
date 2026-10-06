// Probe: where does an MRV carrier burst relative to its aim target?
import { mkRoom } from '../harness.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';

const r = mkRoom({ mode: 'ffa' });
const bot = r.addBot('BOT-MRV-01');
// Park the shooter on flat ground, aim at a point 40m out.
const me = r.players.getPlayer(bot)!;
me.position.x = 0; me.position.y = 0; me.position.z = 0;
// A live target to stand where we aim.
const foe = r.addBot('BOT-FOE-01');
const f = r.players.getPlayer(foe)!;
f.position.x = 40; f.position.y = 0; f.position.z = 0;

// Capture every blast position.
const blasts: { x: number; y: number; z: number; wt: number }[] = [];
const origBlast = r.messages.serverBlast.bind(r.messages);
r.messages.serverBlast = (o: string, at: any, wt: number, ex?: any, sid?: string) => {
  blasts.push({ x: at.x, y: at.y, z: at.z, wt });
  return origBlast(o, at, wt, ex, sid);
};
const destroyed: { id: string; at: number }[] = [];
const origBc = r.broadcast.bind(r);
r.broadcast = (msg: any) => { if (msg.type === 'projectileDestroyed') destroyed.push({ id: msg.projectileId, at: simT }); return origBc(msg); };

// Aim: lofted solve for fuse waypoint at the foe (mimic pickFire).
const G = -9.8 * 3; // whatever GRAVITY is — read it
import { GRAVITY } from '../../shared/movement.ts';
const st = getWeaponStats(WeaponType.MRVLauncher)!;
const fuse = st.maxLifetime!;
let simT = 0;
const eye = { x: 0, y: 1.7, z: 0 };
const aim = {
  x: 40,
  y: 0 - 0.5 * GRAVITY * fuse * fuse, // drop compensation = +loft
  z: 0,
};
const dx = aim.x - eye.x, dy = aim.y - eye.y, dz = aim.z - eye.z;
const dl = Math.hypot(dx, dy, dz);
const dir = { x: dx / dl, y: dy / dl, z: dz / dl };
console.log('dir', dir, 'speed', st.speed, 'fuse', fuse);
r.projectiles.spawn(bot, WeaponType.MRVLauncher, eye, dir, { x: 0, y: 0, z: 0 });
for (let i = 0; i < 200 && blasts.length === 0; i++) { r.projectiles.tick(0.05); simT += 0.05; }
console.log('carrier died at simT', simT.toFixed(2), 'blasts:', blasts.length);
for (const b of blasts.slice(0, 8)) console.log(' blast', b, 'vs target(40,0,0)');
console.log('live projs left:', (r.projectiles as any).projs?.size);
process.exit(0);
