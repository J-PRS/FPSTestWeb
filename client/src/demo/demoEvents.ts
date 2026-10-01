import { ProjectileEventType, TargetEventType } from './types.js';
import type { Vec3 } from './interfaces.js';
import type { DemoRecorder } from './DemoRecorder.js';
import type { ProjectileEvent, TargetEvent } from './types.js';

// Event recorders — the rate-limited projectile/target event spool.
// DemoRecorder keeps the flat interface; these take it as the host.
const MAX_EVENTS_PER_SEC = 1000;
function checkEventRate(b: DemoRecorder): boolean {
    if (b.elapsedTime - b.lastEventResetTime >= 1.0) {
      b.eventCountThisSecond = 0;
      b.lastEventResetTime = b.elapsedTime;
    }
    if (b.eventCountThisSecond >= MAX_EVENTS_PER_SEC) return false;
    b.eventCountThisSecond++;
    return true;
  }

  // IProjectileEventRecorder
export function recordFired(b: DemoRecorder, position: Vec3, velocity: Vec3, weaponType: number): number {
    if (!b.recording || !checkEventRate(b)) return 0;
    const id = b.nextProjectileId;
    b.nextProjectileId = (b.nextProjectileId % 65535) + 1;
    const e = b.projectileEventPool.pop() ?? ({} as ProjectileEvent);
    e.eventType = ProjectileEventType.Fired;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = velocity.x; e.velY = velocity.y; e.velZ = velocity.z;
    e.projectileId = id; e.weaponType = weaponType;
    e.surfaceNormalX = 0; e.surfaceNormalY = 0; e.surfaceNormalZ = 0;
    e.targetId = 0; e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.projectileEvents.push(e);
    return id;
  }

export function recordBounce(b: DemoRecorder, projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void {
    // 0 = recordFired's rate-limit/not-recording sentinel — no live projectile
    if (projectileId === 0 || !b.recording || !checkEventRate(b)) return;
    const e = b.projectileEventPool.pop() ?? ({} as ProjectileEvent);
    e.eventType = ProjectileEventType.Bounce;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = velocity.x; e.velY = velocity.y; e.velZ = velocity.z;
    e.projectileId = projectileId; e.weaponType = 0;
    e.surfaceNormalX = surfaceNormal.x; e.surfaceNormalY = surfaceNormal.y; e.surfaceNormalZ = surfaceNormal.z;
    e.targetId = 0; e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.projectileEvents.push(e);
  }

export function recordHit(b: DemoRecorder, projectileId: number, position: Vec3, targetId: number): void {
    if (projectileId === 0 || !b.recording || !checkEventRate(b)) return;
    const e = b.projectileEventPool.pop() ?? ({} as ProjectileEvent);
    e.eventType = ProjectileEventType.Hit;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = 0; e.velY = 0; e.velZ = 0;
    e.projectileId = projectileId; e.weaponType = 0;
    e.surfaceNormalX = 0; e.surfaceNormalY = 0; e.surfaceNormalZ = 0;
    e.targetId = targetId; e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.projectileEvents.push(e);
  }

export function recordDestroyed(b: DemoRecorder, projectileId: number, position: Vec3): void {
    if (projectileId === 0 || !b.recording || !checkEventRate(b)) return;
    const e = b.projectileEventPool.pop() ?? ({} as ProjectileEvent);
    e.eventType = ProjectileEventType.Destroyed;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = 0; e.velY = 0; e.velZ = 0;
    e.projectileId = projectileId; e.weaponType = 0;
    e.surfaceNormalX = 0; e.surfaceNormalY = 0; e.surfaceNormalZ = 0;
    e.targetId = 0; e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.projectileEvents.push(e);
  }

  // ITargetEventRecorder
export function recordTargetSpawned(b: DemoRecorder, targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!b.recording || !checkEventRate(b)) return;
    const e = b.targetEventPool.pop() ?? ({} as TargetEvent);
    e.eventType = TargetEventType.Spawned;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = velocity.x; e.velY = velocity.y; e.velZ = velocity.z;
    e.targetId = targetId; e.targetType = targetType; e.health = 0;
    e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.targetEvents.push(e);
  }

export function recordTargetBounce(b: DemoRecorder, targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!b.recording || !checkEventRate(b)) return;
    const e = b.targetEventPool.pop() ?? ({} as TargetEvent);
    e.eventType = TargetEventType.Bounce;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = velocity.x; e.velY = velocity.y; e.velZ = velocity.z;
    e.targetId = targetId; e.targetType = targetType; e.health = 0;
    e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.targetEvents.push(e);
  }

export function recordTargetPeak(b: DemoRecorder, targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!b.recording || !checkEventRate(b)) return;
    const e = b.targetEventPool.pop() ?? ({} as TargetEvent);
    e.eventType = TargetEventType.StateChanged;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = velocity.x; e.velY = velocity.y; e.velZ = velocity.z;
    e.targetId = targetId; e.targetType = targetType; e.health = 0;
    e.hasPeakPosition = true;
    e.peakPosX = position.x; e.peakPosY = position.y; e.peakPosZ = position.z;
    b.targetEvents.push(e);
  }

export function recordTargetHit(b: DemoRecorder, targetId: number, position: Vec3, velocity: Vec3, targetType: number, health: number): void {
    if (!b.recording || !checkEventRate(b)) return;
    const e = b.targetEventPool.pop() ?? ({} as TargetEvent);
    e.eventType = TargetEventType.Hit;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = velocity.x; e.velY = velocity.y; e.velZ = velocity.z;
    e.targetId = targetId; e.targetType = targetType; e.health = health;
    e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.targetEvents.push(e);
  }

export function recordTargetDestroyed(b: DemoRecorder, targetId: number, position: Vec3, targetType: number, health: number = 0): void {
    if (!b.recording || !checkEventRate(b)) return;
    const e = b.targetEventPool.pop() ?? ({} as TargetEvent);
    e.eventType = TargetEventType.Destroyed;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = 0; e.velY = 0; e.velZ = 0;
    e.targetId = targetId; e.targetType = targetType; e.health = health;
    e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.targetEvents.push(e);
  }

