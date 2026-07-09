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
  meshRampIn: boolean;
  meshRampInDuration: number;
  meshStartScale: number;
  terrainOffset: number;
  needsServerTracking: boolean;
}

export function getProjectileConfig(configs: ProjectileConfig[], weaponType: number): ProjectileConfig | undefined {
  return configs.find((c: ProjectileConfig) => c.weaponType === weaponType);
}

export function getProjectileConfigByName(configs: ProjectileConfig[], name: string): ProjectileConfig | undefined {
  return configs.find((c: ProjectileConfig) => c.name === name);
}
