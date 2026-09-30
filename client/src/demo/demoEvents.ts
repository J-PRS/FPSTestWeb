import { ProjectileEventType, TargetEventType } from './types.js';
import type { Vec3 } from './interfaces.js';
import type { DemoRecorder } from './DemoRecorder.js';

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
    b.projectileEvents.push({
      eventType: ProjectileEventType.Fired,
      timestamp: b.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      projectileId: id, weaponType,
      surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
      targetId: 0, hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
    return id;
  }

export function recordBounce(b: DemoRecorder, projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void {
    // 0 = recordFired's rate-limit/not-recording sentinel — no live projectile
    if (projectileId === 0 || !b.recording || !checkEventRate(b)) return;
    b.projectileEvents.push({
      eventType: ProjectileEventType.Bounce,
      timestamp: b.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      projectileId, weaponType: 0,
      surfaceNormalX: surfaceNormal.x, surfaceNormalY: surfaceNormal.y, surfaceNormalZ: surfaceNormal.z,
      targetId: 0, hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

export function recordHit(b: DemoRecorder, projectileId: number, position: Vec3, targetId: number): void {
    if (projectileId === 0 || !b.recording || !checkEventRate(b)) return;
    b.projectileEvents.push({
      eventType: ProjectileEventType.Hit,
      timestamp: b.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: 0, velY: 0, velZ: 0,
      projectileId, weaponType: 0,
      surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
      targetId, hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

export function recordDestroyed(b: DemoRecorder, projectileId: number, position: Vec3): void {
    if (projectileId === 0 || !b.recording || !checkEventRate(b)) return;
    b.projectileEvents.push({
      eventType: ProjectileEventType.Destroyed,
      timestamp: b.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: 0, velY: 0, velZ: 0,
      projectileId, weaponType: 0,
      surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
      targetId: 0, hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  // ITargetEventRecorder
export function recordTargetSpawned(b: DemoRecorder, targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!b.recording || !checkEventRate(b)) return;
    b.targetEvents.push({
      eventType: TargetEventType.Spawned,
      timestamp: b.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType, health: 0,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

export function recordTargetBounce(b: DemoRecorder, targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!b.recording || !checkEventRate(b)) return;
    b.targetEvents.push({
      eventType: TargetEventType.Bounce,
      timestamp: b.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType, health: 0,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

export function recordTargetPeak(b: DemoRecorder, targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!b.recording || !checkEventRate(b)) return;
    b.targetEvents.push({
      eventType: TargetEventType.StateChanged,
      timestamp: b.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType, health: 0,
      hasPeakPosition: true,
      peakPosX: position.x, peakPosY: position.y, peakPosZ: position.z,
    });
  }

export function recordTargetHit(b: DemoRecorder, targetId: number, position: Vec3, velocity: Vec3, targetType: number, health: number): void {
    if (!b.recording || !checkEventRate(b)) return;
    b.targetEvents.push({
      eventType: TargetEventType.Hit,
      timestamp: b.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType, health,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

export function recordTargetDestroyed(b: DemoRecorder, targetId: number, position: Vec3, targetType: number, health: number = 0): void {
    if (!b.recording || !checkEventRate(b)) return;
    b.targetEvents.push({
      eventType: TargetEventType.Destroyed,
      timestamp: b.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: 0, velY: 0, velZ: 0,
      targetId, targetType, health,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

