// Offline gun-game ladder - the local-authority mirror of Room's
// gunRungs/gunGameOnKill. Same rules: a credited player frag advances
// the shooter one rung (climax holds), the victim drops to rung 0,
// environment/self kills move nobody. `apply` swaps the actual weapon:
// the local armory band or a bot's loadout fields.
import { gunGameRoll, gunGameClimax } from '../../../shared/gunGame.js';
import { simRand } from '../../../shared/simRand.js';
import type { WeaponType } from '../../../shared/weapons.js';
import type { WorldState } from './worldState.js';

export function gunRungOf(world: { gunRungs?: Map<string, number> }, id: string): number {
  return world.gunRungs?.get(id) ?? 0;
}

/** Rung edge → stored value + weapon swap. Clamped like the server's
 *  setGunRung so a bad caller can't push past the climax. */
export function setGunRung(world: WorldState, id: string, rung: number, apply: (id: string, wt: WeaponType) => void): void {
  const r = Math.max(0, Math.min(gunGameClimax(world.igun === true), Math.floor(rung)));
  world.gunRungs.set(id, r);
  // Same deal the server rolls - one bucket member, luck not a pick.
  apply(id, gunGameRoll(r, world.igun === true, simRand()));
}

/** Kill-bus edge: victim resets (any death), shooter advances only on a
 *  credited player frag - shooterId null/'environment'/self = nobody
 *  climbs. Mirrors Room.gunGameOnKill. */
export function gunGameOnKill(world: WorldState, victimId: string, shooterId: string | null, apply: (id: string, wt: WeaponType) => void): void {
  if (!world.gungame) {return;}
  setGunRung(world, victimId, 0, apply);
  if (!shooterId || shooterId === 'environment' || shooterId === victimId) {return;}
  setGunRung(world, shooterId, gunRungOf(world, shooterId) + 1, apply);
}
