import { mkArc80 } from './cannonConfig.js';
import type { ProjectileConfig } from './types.js';

// Basilisk - the heavy frame's member of the 80 m/s gravity-arc family.
// Same shell as the cannon/gonne (shared row is a flavored reskin):
// dark iron ball, no trail, pops on contact. The huge-bore gun is the
// flavor; the Bombard stays the heavy's unique weapon.
export const BASILISK_CONFIG: ProjectileConfig = mkArc80(43, {
  name: 'basilisk',
  displayName: 'Basilisk',
  damageColor: '#ffbb66',
  meshColor: 0x2B_27_22, // bronze-dark iron - reads cast and ancient next to the cannon's machined ball
  trailMeshType: 'sphere',
});
