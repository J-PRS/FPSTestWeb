import { mkRoom } from './harness.ts';
import { WeaponType, getWeaponStats } from '../../../shared/weapons.ts';

for (const igun of [false, true]) {
  const room = mkRoom({ mode: 'dm', bots: 0 }, 'dm', 7, false, undefined);
  if (igun) {room.mods.igun = true; room.mods.gungame = true;}
  room.players.addPlayer('shooter'); room.players.addPlayer('victim');
  const v = room.players.getPlayer('victim')!;
  const s = room.players.getPlayer('shooter')!;
  s.position = { x: 30, y: 0, z: 0 } as never;
  v.position = { x: 2, y: 0, z: 0 } as never;
  for (const p of [s, v]) {p.isDead = false; p.protectedUntil = -1e9 as never; p.health = p.maxHealth;}
  const stats = getWeaponStats(WeaponType.GrenadeLauncher);
  const {blast} = (room.messages.combat as unknown as { blast: { processAOE(id:string,pos:unknown,ex:unknown,st:unknown,o:unknown):void } });
  blast.processAOE('shooter', { x: 0, y: 0, z: 0 }, null, stats, { weapon: WeaponType.GrenadeLauncher, trusted: true });
  console.log(`igun=${igun} aoe=${stats.aoeDamage} r=${stats.aoeRadius} -> victim took ${v.maxHealth - v.health}`);
}
