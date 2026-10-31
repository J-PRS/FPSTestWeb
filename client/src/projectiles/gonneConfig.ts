import { mkArc80 } from './cannonConfig.js';
import type { ProjectileConfig } from './types.js';

// Gonne - the light frame's member of the 80 m/s gravity-arc family.
// Same shell as the cannon (shared row is a flavored reskin): dark iron
// ball, no trail, pops on contact. The gun differs, the ball doesn't.
export const GONNE_CONFIG: ProjectileConfig = mkArc80(42, {
  name: 'gonne',
  displayName: 'Gonne',
  damageColor: '#ffbb66',
  trailMeshType: 'sphere',
  meshColor: 0x2A_2D_33, // slightly bluer dark iron than the cannonball - the wrought-forged read
});
