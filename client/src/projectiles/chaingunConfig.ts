import * as THREE from 'three';

import { WEAPONS } from '../../../shared/weapons.js';

import type { ProjectileConfig } from './types.js';

export const CHAINGUN_CONFIG: ProjectileConfig = {
  name: 'chaingun',
  displayName: 'Chaingun',
  weaponType: 3,
  speed: WEAPONS[3].speed,
  gravity: WEAPONS[3].gravity,
  explosionRadius: 0,
  force: 0,
  forceMode: 'push',
  bodyRadius: WEAPONS[3].bodyRadius,
  hitMin: WEAPONS[3].hitMin,
  hitMax: WEAPONS[3].hitMax, // tight proxy cap — slugs get a small wake, not the 8m shell drag
  hitGrow: WEAPONS[3].hitGrow,
  maxLifetime: WEAPONS[3].maxLifetime,
  forceMultiplier: 0,
  aoeDamage: 1.5, // unused (aoeRadius 0, noExplosion) — kept at 1/10 of rocket AOE for consistency
  aoeRadius: 0,
  damageColor: '#ffee88',
  trailColors: [
    new THREE.Color(1.0, 0.95, 0.6),
    new THREE.Color(1.0, 0.8, 0.3),
    new THREE.Color(0.9, 0.5, 0.1),
  ],
  // No particle trail — the bright bolt mesh IS the tracer. At 250 m/s this
  // config would otherwise spawn ~1000 individual Mesh+Material trail particles
  // per second (one draw call each, plus bloom pass), which tanks the framerate.
  trailParticlesPerUnit: 0,
  trailLifeMin: 0,
  trailLifeMax: 0,
  trailSpread: 0,
  trailForwardSpread: 0,
  trailParticleGravity: 0,
  trailOpacity: 0.6,
  trailBaseSize: 0.04,
  trailSizeRange: 0.03,
  trailScaleMin: 0.3,
  trailScaleMax: 1.0,
  trailRampIn: 0,
  meshColor: 0xffee88,
  meshType: 'rocket',
  // Wake cone available but off for now — flip glowShell to render the
  // same hitbox-coupled collar disc/bolt wear.
  glowShell: false,
  glowShape: 'wakeCone',
  glowColor: 0xffee88,
  glowOpacity: 0.6,
  glowScale: 0.8,
  meshRampIn: true,
  // Same spawn trick as plasma — at 250 m/s a full-size bolt at the
  // muzzle covers the crosshair on frame one; grow 10% → full over 0.1s.
  meshRampInDuration: 0.1,
  meshStartScale: 0.1,
  terrainOffset: 0.05,
  needsServerTracking: true,
  noExplosion: true,
  trailMeshType: 'sphere',
  // Very short thin ribbon = tracer streak. Cheap (one draw call per lane)
  // unlike the particle trail, which cost ~1000 draw calls/sec.
  ribbonTrail: true,
  ribbonLanes: 1,
  ribbonWidth: 0.22,
  ribbonLife: 0.08,
  // Streak grows in behind the slug — same 10%→full ramp as the bolt
  // mesh, applied to both width and trail length.
  ribbonRampIn: 0.2,
  ribbonColor: 0xffd850,
};
