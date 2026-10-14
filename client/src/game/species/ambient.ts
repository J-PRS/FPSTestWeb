import * as THREE from 'three';

import {
  WEED_MAX, WEED_SPAWN_INTERVAL, WEED_SPAWN_MIN, WEED_SPAWN_MAX,
  WEED_WIND_X, WEED_WIND_Z,
} from '../../core/config.js';
import { simRand } from '../../../../shared/simRand.js';
import type { Species } from '../speciesKit.js';
import { Tumbleweed } from '../../entities/Tumbleweed.js';
import type { SpeciesCtx } from './context.js';
import { capFor } from './ambientCaps.js';

// Ambient family — destructible props that aren't really enemies.
// Tumbleweeds: wind-blown ambience you can shoot.
export function createAmbientSpecies({ deps, kit, targets }: SpeciesCtx): { weeds: Tumbleweed[]; spawnWeed: () => void; updateWeeds: (dt: number) => void; } {
  const { scene } = deps;
  const { burrow, updateSpecies, kickDust, atCap } = kit;

  const weeds: Tumbleweed[] = [];
  const weedWind = new THREE.Vector3(WEED_WIND_X, 0, WEED_WIND_Z).normalize();

  function spawnWeed(): void {
    if (atCap(weeds, capFor('tumbleweed', WEED_MAX))) {return;}
    const player = deps.lazyPlayer();
    // Spawn upwind so it rolls across the player's field of view; a lateral
    // jitter keeps the parade from becoming a conveyor line.
    const dist = WEED_SPAWN_MIN + simRand() * (WEED_SPAWN_MAX - WEED_SPAWN_MIN);
    const side = (simRand() - 0.5) * WEED_SPAWN_MAX;
    const pos = new THREE.Vector3(
      player.pos.x - weedWind.x * dist - weedWind.z * side,
      0,
      player.pos.z - weedWind.z * dist + weedWind.x * side,
    );
    // ~1 in 8 is a megaweed — 2x ball, 6x hp, 3 nuggets
    const w = new Tumbleweed(scene, deps.lazyTerrain(), pos, simRand() < 0.125);
    burrow(w);
    weeds.push(w);
    targets.push(w);
  }

  const weedSpecies: Species<Tumbleweed> = {
    list: weeds, interval: WEED_SPAWN_INTERVAL, t: 0,
    decor: true, // ambience — ?nocreatures gates combat species, not set dressing
    spawn: spawnWeed,
    tick: (w, dt): void => { w.update(dt, deps.lazyTerrain(), deps.lazyPlayer().pos); kickDust(w, dt); },
  };
  function updateWeeds(dt: number): void { updateSpecies(weedSpecies, dt); }

  return { weeds, spawnWeed, updateWeeds };
}
