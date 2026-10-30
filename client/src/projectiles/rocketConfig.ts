import * as THREE from 'three';
import { mkBoltLike } from './boltConfig.js';
import type { ProjectileConfig } from './types.js';

// Rocket Launcher - the universal flat rocket (type 44): bolt recipe,
// tinted orange so the two read apart in flight. Everything else -
// stats, wake, trail, viewmodel, sfx - is declared on the shared row.
export const ROCKET_CONFIG: ProjectileConfig = mkBoltLike(44, {
  name: 'rocket',
  displayName: 'Rocket Launcher',
  damageColor: '#ff8833',
  meshColor: 0xFF_88_33,
  trailColors: [
    new THREE.Color(1, 0.55, 0.1),
    new THREE.Color(1, 0.35, 0),
    new THREE.Color(0.8, 0.2, 0.1),
    new THREE.Color(0.5, 0.25, 0.2),
    new THREE.Color(0.35, 0.35, 0.4),
  ],
  ribbonColor: 0xFF_66_22,
});
