// Interfaces for demo system integration.
// Game systems implement these to feed data without direct coupling.

export interface IPlayerDataProvider {
  posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number;
  yaw: number;
  pitch: number;
}

export interface IInputProvider {
  inputFlags: number;    // bitmask of InputFlags
  mouseDeltaX: number;
  mouseDeltaY: number;
  jetpackFlags: number;  // bitmask of JetpackFlags
  jetpackFuel: number;
}

export interface IProjectileEventSource {
  recordFired(position: Vec3, velocity: Vec3, weaponType: number): number;
  recordBounce(projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void;
  recordHit(projectileId: number, position: Vec3, targetId: number): void;
  recordDestroyed(projectileId: number, position: Vec3): void;
}

export interface ITargetEventSource {
  recordSpawned(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void;
  recordBounce(targetId: number, position: Vec3, velocity: Vec3): void;
  recordHit(targetId: number, position: Vec3, health: number): void;
  recordDestroyed(targetId: number, position: Vec3): void;
}

export interface Vec3 {
  x: number; y: number; z: number;
}
