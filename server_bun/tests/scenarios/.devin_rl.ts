import { mkRoom, step, pin } from './harness.ts';
import { type BotLoadout } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';

const mk = (w: WeaponType): BotLoadout => ({ perk: 'none', near: w, mid: w, far: w, belt: WeaponType.Grenade, side: WeaponType.Pistol });
const room = mkRoom({ mode: 'dm', bots: 4, arena: { x: 0, z: 0, radius: 80 } }, 'dm', 77);
const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
const ctl = room.bots as any;
const arsen = ctl.arsenal;
const counts: Record<string, number> = { spawnOk: 0, spawnFail: 0, blocked: 0, fireAt: 0 };
const origSpawn = room.projectiles.spawn.bind(room.projectiles);
(room.projectiles as any).spawn = (...a: any[]) => { const ok = origSpawn(...a); counts[ok ? 'spawnOk' : 'spawnFail']++; return ok; };
const origBlock = (arsen as any).selfBlastBlocked.bind(arsen);
(arsen as any).selfBlastBlocked = (...a: any[]) => { const b = origBlock(...a); if (b) counts.blocked++; return b; };
const origFA = (arsen as any).fireAt.bind(arsen);
(arsen as any).fireAt = (...a: any[]) => { counts.fireAt++; return origFA(...a); };
for (let i = 0; i < bots.length; i++) { ctl.loadouts.set(bots[i].id, mk(WeaponType.RocketLauncher)); ctl.roster.refitClass(bots[i].id); }
for (let i = 0; i < 1200; i++) step(room, 1);
console.log(JSON.stringify(counts), 'simS:', 60);
process.exit(0);
