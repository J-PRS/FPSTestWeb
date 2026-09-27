import * as THREE from 'three';

export interface ProjectileConfig {
  name: string; // unique identifier, e.g. 'rocket', 'disc'
  displayName: string;
  weaponType: number; // numeric ID for demo protocol (0=rocket, 1=disc)
  speed: number;
  gravity: number; // 0 for no gravity, GRAVITY for arc
  explosionRadius: number;
  force: number;
  forceMode: 'push' | 'pull';
  bodyRadius: number; // core hitbox for direct hits
  hitMin: number;
  hitMax: number;
  hitGrow: number;
  falloffMultiplier: number;
  collisionMultiplier: number;
  forceMultiplier: number;
  aoeDamage: number;
  aoeRadius: number;
  damageColor: string;
  trailColors: THREE.Color[];
  trailParticlesPerUnit: number;
  trailLifeMin: number;
  trailLifeMax: number;
  trailSpread: number;
  trailForwardSpread: number;
  trailParticleGravity: number;
  trailOpacity: number;
  trailBaseSize: number;
  trailSizeRange: number;
  trailScaleMin: number;
  trailScaleMax: number;
  trailRampIn: number;
  meshColor: number;
  meshType: string; // 'rocket', 'disc' — Projectile class dispatches on this
  glowShell: boolean;
  glowColor: number;
  glowOpacity: number;
  glowScale?: number; // override glow mesh size; defaults to hitRadius if not set
  meshRampIn?: boolean; // default ON — projectiles spawn small and grow; false = pop in at full size
  meshRampInDuration?: number; // default 0.2s, capped at 40% of maxLifetime
  meshStartScale?: number; // default 0.2
  terrainOffset: number;
  needsServerTracking: boolean;
  maxLifetime?: number; // 0 or undefined = no auto-explode; >0 auto-explodes after age reaches this (seconds)
  trailMeshType?: 'sphere' | 'ring' | 'disc' | 'billboard'; // trail particle geometry; defaults to sphere
  noExplosion?: boolean; // true = hit produces no explosion/knockback (hitscan-style bullets)
  ribbonTrail?: boolean; // flat ribbon trail strip (single mesh, cheap) in addition to particles
  ribbonLanes?: number; // 1 = single strip; 3 = main band + 2 offset core lanes (default)
  ribbonWidth?: number;
  ribbonLife?: number;
  ribbonColor?: number;
  bounces?: boolean; // bounce off terrain instead of exploding (grenade launcher); fuse still applies
  bounceSfx?: string; // /sfx/<name>.ogg ping played positionally on each bounce
  bounceRestitution?: number; // velocity kept along the terrain normal per bounce
  bounceFriction?: number; // tangential velocity kept per bounce
  maxBounces?: number; // die on the Nth terrain hit (flak shards); undefined = bounce until fuse
  armTime?: number; // T2 mortar arming delay: contacts before this age BOUNCE, after it they detonate
  wakeVisual?: boolean; // turbulent wake particles marking the growing proxy hitbox (off by default — tuning pending)
}

export function getProjectileConfig(configs: ProjectileConfig[], weaponType: number): ProjectileConfig | undefined {
  return configs.find((c: ProjectileConfig) => c.weaponType === weaponType);
}

export function getProjectileConfigByName(configs: ProjectileConfig[], name: string): ProjectileConfig | undefined {
  return configs.find((c: ProjectileConfig) => c.name === name);
}
