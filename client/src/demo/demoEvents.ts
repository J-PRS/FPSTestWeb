import { ProjectileEventType, TargetEventType, TARGETTYPE_CREATURE_BASE, TARGETTYPE_DEPLOY_BASE, TARGETTYPE_KILL, TARGETTYPE_FLAG, TARGETTYPE_PICKUP_BASE, demoSpeciesIndex, demoDeployKindIndex, demoPickupKindIndex, creatureDemoId, deployDemoId, flagDemoId, pickupDemoId } from './types.js';
import type { Vec3 } from './interfaces.js';
import type { DemoRecorder } from './DemoRecorder.js';
import type { ProjectileEvent, TargetEvent } from './types.js';

// Event recorders — the rate-limited projectile/target event spool.
// DemoRecorder keeps the flat interface; these take it as the host.
const MAX_EVENTS_PER_SEC = 1000;
function checkEventRate(b: DemoRecorder): boolean {
    if (b.elapsedTime - b.lastEventResetTime >= 1) {
      b.eventCountThisSecond = 0;
      b.lastEventResetTime = b.elapsedTime;
    }
    if (b.eventCountThisSecond >= MAX_EVENTS_PER_SEC) {return false;}
    b.eventCountThisSecond++;
    return true;
  }

  // IProjectileEventRecorder
export function recordFired(b: DemoRecorder, position: Vec3, velocity: Vec3, weaponType: number, shooterId?: string): number {
    if (!b.recording || !checkEventRate(b)) {return 0;}
    const id = b.nextProjectileId;
    b.nextProjectileId = (b.nextProjectileId % 65_535) + 1;
    const e = b.projectileEventPool.pop() ?? ({} as ProjectileEvent);
    e.eventType = ProjectileEventType.Fired;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = velocity.x; e.velY = velocity.y; e.velZ = velocity.z;
    e.projectileId = id; e.weaponType = weaponType;
    e.surfaceNormalX = 0; e.surfaceNormalY = 0; e.surfaceNormalZ = 0;
    // targetId rides along as shooter rosterIdx+1 — playback needs it to
    // tell the local player's shots (0, viewmodel kick) from the other 19
    // guns' tracers, which must never kick the camera.
    e.targetId = shooterId ? Math.max(0, rosterIdx(b, shooterId)) + 1 : 0;
    e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.projectileEvents.push(e);
    return id;
  }

export function recordBounce(b: DemoRecorder, projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void {
    // 0 = recordFired's rate-limit/not-recording sentinel — no live projectile
    if (projectileId === 0 || !b.recording || !checkEventRate(b)) {return;}
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

export function recordHit(b: DemoRecorder, projectileId: number, position: Vec3, targetId: number, weaponType: number): void {
    if (projectileId === 0 || !b.recording || !checkEventRate(b)) {return;}
    const e = b.projectileEventPool.pop() ?? ({} as ProjectileEvent);
    e.eventType = ProjectileEventType.Hit;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = 0; e.velY = 0; e.velZ = 0;
    // Seek reconstruction rebuilds the terminal explosion from this — the
    // shell itself is already gone, so the Hit must carry its own config id.
    e.projectileId = projectileId; e.weaponType = weaponType;
    e.surfaceNormalX = 0; e.surfaceNormalY = 0; e.surfaceNormalZ = 0;
    e.targetId = targetId; e.hasPeakPosition = false;
    e.peakPosX = 0; e.peakPosY = 0; e.peakPosZ = 0;
    b.projectileEvents.push(e);
  }

export function recordDestroyed(b: DemoRecorder, projectileId: number, position: Vec3): void {
    if (projectileId === 0 || !b.recording || !checkEventRate(b)) {return;}
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

export function recordRemoteFired(b: DemoRecorder, serverId: string, position: Vec3, velocity: Vec3, weaponType: number, ownerId?: string): void {
    // Missing ownerId must NOT mint targetId 0 — that bit is reserved for
    // the local player's gun (viewmodel kick). Unknown remote shooters get
    // their own roster entry so every kick check sees them as remote.
    const id = recordFired(b, position, velocity, weaponType, ownerId ?? '[unknown]');
    if (id !== 0) {b.remoteProjIdByServerId.set(serverId, id);}
  }

export function recordRemoteDestroyed(b: DemoRecorder, serverId: string, position: Vec3): void {
    const id = b.remoteProjIdByServerId.get(serverId);
    if (id === undefined) {return;} // fired edge predates the window — nothing to pair
    b.remoteProjIdByServerId.delete(serverId);
    recordDestroyed(b, id, position);
  }

  // Creature lane — rides targetEvents with targetType = 64 + species idx
  // and a top-bit-namespaced demo id so it can't alias a ball's id.
const ZERO_VEC: Vec3 = { x: 0, y: 0, z: 0 };
// weaponType sentinel for deployable-fired bolts — no real weapon owns it;
// playback falls back to the bolt config for unknown ids anyway.
const DEPLOY_SHOT_WEAPON = 254;

export function recordCreatureSpawned(b: DemoRecorder, netId: number, species: string, position: Vec3): void {
    const tt = TARGETTYPE_CREATURE_BASE + demoSpeciesIndex(species);
    b.creatureTtByNetId.set(netId, tt);
    recordTargetSpawned(b, creatureDemoId(netId), position, ZERO_VEC, tt);
  }

export function recordCreatureEdge(b: DemoRecorder, netId: number, position: Vec3, velocity: Vec3): void {
    const tt = b.creatureTtByNetId.get(netId);
    if (tt === undefined) {return;} // edge predates the recording window
    recordTargetBounce(b, creatureDemoId(netId), position, velocity, tt);
  }

export function recordCreatureRoster(b: DemoRecorder, netId: number, species: string, position: Vec3, velocity: Vec3): void {
    if (!b.creatureTtByNetId.has(netId)) {
      // A roster row can be the first sight of a creature spawned before
      // the record window — adopt it so the clip is complete.
      recordCreatureSpawned(b, netId, species, position);
      return;
    }
    recordTargetPeak(b, creatureDemoId(netId), position, velocity, b.creatureTtByNetId.get(netId) as number);
  }

export function recordCreatureDie(b: DemoRecorder, netId: number, position: Vec3): void {
    const tt = b.creatureTtByNetId.get(netId);
    if (tt === undefined) {return;}
    b.creatureTtByNetId.delete(netId);
    recordTargetDestroyed(b, creatureDemoId(netId), position, tt);
  }

  // Deployable lane — targetType = 128 + kind idx, demo id 0x4000|netId.
  // gone/down/up/hp edges carry no position, so spawn seeds deployInfo and
  // the terminal events reuse its last known spot.

export function recordDeploySpawned(b: DemoRecorder, netId: number, kind: string, position: Vec3): void {
    const tt = TARGETTYPE_DEPLOY_BASE + demoDeployKindIndex(kind);
    b.deployInfoByNetId.set(netId, { tt, x: position.x, y: position.y, z: position.z });
    recordTargetSpawned(b, deployDemoId(netId), position, ZERO_VEC, tt);
  }

export function recordDeployGone(b: DemoRecorder, netId: number): void {
    const info = b.deployInfoByNetId.get(netId);
    if (!info) {return;}
    b.deployInfoByNetId.delete(netId);
    recordTargetDestroyed(b, deployDemoId(netId), info, info.tt);
  }

export function recordDeployHp(b: DemoRecorder, netId: number, hp: number): void {
    const info = b.deployInfoByNetId.get(netId);
    if (!info) {return;} // hp edge predates the recording window
    recordTargetHit(b, deployDemoId(netId), info, ZERO_VEC, info.tt, hp);
  }

export function recordDeployShot(b: DemoRecorder, netId: number, target: Vec3): void {
    const info = b.deployInfoByNetId.get(netId);
    if (!info) {return;} // shot from a deployable that predates the window
    // Deploy bolts replay as plain tracers — a Fired event with the
    // weaponType sentinel; the reader falls back to the bolt config.
    // Shooter rides as a shared pseudo-id — without it targetId lands 0
    // (local lane) and every turret bolt kicks the playback viewmodel.
    const speed = 80;
    const dx = target.x - info.x, dy = target.y - info.y, dz = target.z - info.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    recordFired(b, info, { x: (dx / len) * speed, y: (dy / len) * speed, z: (dz / len) * speed }, DEPLOY_SHOT_WEAPON, '[deployable]');
  }

export function recordDeployBoom(b: DemoRecorder, netId: number, position: Vec3): void {
    const info = b.deployInfoByNetId.get(netId);
    if (!info) {return;}
    b.deployInfoByNetId.delete(netId);
    recordTargetHit(b, deployDemoId(netId), position, ZERO_VEC, info.tt, 0);
    recordTargetDestroyed(b, deployDemoId(netId), position, info.tt);
  }

  // Marker lanes — game-state edges packed into targetEvents:
  // kill (224): victim roster idx in targetId, weapon in health,
  //   shooter roster idx + 1 in peakPosX.
  // flag (225): state code in health (0 home / 1 carried / 2 dropped),
  //   carrier roster idx + 1 in peakPosX.
  // pickup (226+kind): spawn/gone, gone carries no pos — spawn seeds it.

function rosterIdx(b: DemoRecorder, id: string | null): number {
    if (!id) {return -1;}
    let i = b.rosterIdxById.get(id);
    if (i === undefined) {
      // Adopt-if-unknown, same policy as remote sampling: kills reference
      // victims the 20Hz sampler never captured — including the LOCAL
      // player, who never enters remoteFrames at all. A -1→0 clamp would
      // silently misname roster[0] as the victim.
      i = b.roster.length;
      b.rosterIdxById.set(id, i);
      b.roster.push({ name: id });
    }
    return i;
  }

export function recordKill(b: DemoRecorder, shooterId: string | null, targetId: string, weapon: number, position: Vec3): void {
    if (!b.recording || !checkEventRate(b)) {return;}
    const e = b.targetEventPool.pop() ?? ({} as TargetEvent);
    e.eventType = TargetEventType.StateChanged;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = 0; e.velY = 0; e.velZ = 0;
    e.targetId = Math.max(0, rosterIdx(b, targetId));
    e.targetType = TARGETTYPE_KILL;
    e.health = weapon;
    e.hasPeakPosition = true;
    e.peakPosX = rosterIdx(b, shooterId) + 1;
    e.peakPosY = 0; e.peakPosZ = 0;
    b.targetEvents.push(e);
  }

const FLAG_TEAM_IDX: Record<string, number> = { alpha: 0, beta: 1 };
const FLAG_STATE_CODE: Record<string, number> = { home: 0, carried: 1, dropped: 2 };

export function recordFlagUpdate(b: DemoRecorder, team: string, state: string, position: Vec3, carrier: string | null): void {
    if (!b.recording || !checkEventRate(b)) {return;}
    const teamIdx = FLAG_TEAM_IDX[team] ?? 0;
    const demoId = flagDemoId(teamIdx);
    if (!b.flagSeen.has(demoId)) {
      b.flagSeen.add(demoId);
      const s = b.targetEventPool.pop() ?? ({} as TargetEvent);
      s.eventType = TargetEventType.Spawned;
      s.timestamp = b.elapsedTime;
      s.posX = position.x; s.posY = position.y; s.posZ = position.z;
      s.velX = 0; s.velY = 0; s.velZ = 0;
      s.targetId = demoId; s.targetType = TARGETTYPE_FLAG;
      s.health = FLAG_STATE_CODE[state] ?? 0;
      s.hasPeakPosition = true;
      s.peakPosX = rosterIdx(b, carrier) + 1; s.peakPosY = 0; s.peakPosZ = 0;
      b.targetEvents.push(s);
      if (!checkEventRate(b)) {return;}
    }
    const e = b.targetEventPool.pop() ?? ({} as TargetEvent);
    e.eventType = TargetEventType.StateChanged;
    e.timestamp = b.elapsedTime;
    e.posX = position.x; e.posY = position.y; e.posZ = position.z;
    e.velX = 0; e.velY = 0; e.velZ = 0;
    e.targetId = demoId; e.targetType = TARGETTYPE_FLAG;
    e.health = FLAG_STATE_CODE[state] ?? 0;
    e.hasPeakPosition = true;
    e.peakPosX = rosterIdx(b, carrier) + 1; e.peakPosY = 0; e.peakPosZ = 0;
    b.targetEvents.push(e);
  }

export function recordPickupSpawned(b: DemoRecorder, netId: number, kind: string, position: Vec3): void {
    const tt = TARGETTYPE_PICKUP_BASE + demoPickupKindIndex(kind);
    b.pickupInfoByNetId.set(netId, { tt, x: position.x, y: position.y, z: position.z });
    recordTargetSpawned(b, pickupDemoId(netId), position, ZERO_VEC, tt);
  }

export function recordPickupGone(b: DemoRecorder, netId: number): void {
    const info = b.pickupInfoByNetId.get(netId);
    if (!info) {return;}
    b.pickupInfoByNetId.delete(netId);
    recordTargetDestroyed(b, pickupDemoId(netId), info, info.tt);
  }

  // ITargetEventRecorder
export function recordTargetSpawned(b: DemoRecorder, targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!b.recording || !checkEventRate(b)) {return;}
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
    if (!b.recording || !checkEventRate(b)) {return;}
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
    if (!b.recording || !checkEventRate(b)) {return;}
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
    if (!b.recording || !checkEventRate(b)) {return;}
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
    if (!b.recording || !checkEventRate(b)) {return;}
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

