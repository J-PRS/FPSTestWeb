/**
 * demoClip — the clip-window collectors behind DemoRecorder.extractClip.
 * Each walks an append-ordered event list and rebuilds the entities that
 * were alive at clipStart as synthetic spawn events, so a clip plays
 * back correctly even when the real Spawned fired before the window
 * (or was pruned by the circular buffer).
 */
import type {
  ProjectileEvent, TargetEvent, RemoteFrame} from './types.js';
import {
  ProjectileEventType, TargetEventType, TARGETTYPE_KILL,
} from './types.js';

// Remote frames inside the clip window, plus one synthetic frame at
// clipStart per remote whose last sample predates the window — playback
// shouldn't wait for the next 20Hz sample to place them.
export function collectRemoteFrames(remoteFrames: RemoteFrame[], clipStart: number, clipEnd: number): RemoteFrame[] {
  const lastBefore = new Map<number, RemoteFrame>();
  for (const f of remoteFrames) {
    if (f.timestamp >= clipStart) {break;}
    lastBefore.set(f.rosterIdx, f);
  }
  const inWindow = remoteFrames.filter(
    f => f.timestamp >= clipStart && f.timestamp <= clipEnd
  );
  const out: RemoteFrame[] = [];
  for (const [, f] of lastBefore) {
    out.push({ ...f, timestamp: clipStart});
  }
  out.push(...inWindow);
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out.map(f => ((((({ ...f, timestamp: f.timestamp - clipStart}))))));
}

// Projectile events in [clipStart, clipEnd], plus synthetic Fired events at
// clipStart for projectiles that were in-flight when the clip began.
export function collectProjectileEvents(projectileEvents: ProjectileEvent[], clipStart: number, clipEnd: number): ProjectileEvent[] {
  // For each projectileId, find the most recent event before clipStart.
  // If it was Fired or Bounce (not Hit/Destroyed), inject a synthetic Fired at clipStart.
  const aliveProjectiles = new Map<number, ProjectileEvent>();
  for (const e of projectileEvents) {
    if (e.timestamp >= clipStart) {break;}
    if (e.eventType === ProjectileEventType.Hit || e.eventType === ProjectileEventType.Destroyed) {
      aliveProjectiles.delete(e.projectileId);
    } else if (e.eventType === ProjectileEventType.Fired) {
      aliveProjectiles.set(e.projectileId, e);
    } else {
      // Bounce — update position/velocity
      const existing = aliveProjectiles.get(e.projectileId);
      if (existing) {
        aliveProjectiles.set(e.projectileId, { ...existing, posX: e.posX,posY: e.posY,posZ: e.posZ,velX: e.velX,velY: e.velY,velZ: e.velZ});
      }
    }
  }

  const snapshotProjEvents: ProjectileEvent[] = [];
  for (const [, e] of aliveProjectiles) {
    snapshotProjEvents.push({ ...e, eventType: ProjectileEventType.Fired,timestamp: clipStart});
  }

  return [
    ...snapshotProjEvents,
    ...projectileEvents.filter(
      e => e.timestamp >= clipStart && e.timestamp <= clipEnd
    ),
  ];
}

// Target events in [clipStart, clipEnd], plus synthetic Spawned events at
// clipStart for balls that were alive when the clip began (or whose Spawned
// event was pruned before extractClip ran).
export function collectTargetEvents(targetEvents: TargetEvent[], clipStart: number, clipEnd: number): TargetEvent[] {
  const aliveBalls = findAliveTargets(targetEvents, clipStart);

  // Create synthetic Spawned events at clipStart for alive targets
  const snapshotEvents: TargetEvent[] = [];
  for (const [, e] of aliveBalls) {
    snapshotEvents.push({ ...e, eventType: TargetEventType.Spawned,timestamp: clipStart});
  }

  // Target events that fall inside the clip window
  const actualTgtEvents = targetEvents.filter(
    e => e.timestamp >= clipStart && e.timestamp <= clipEnd
  );

  return [
    ...snapshotEvents,
    ...recoverMissingSpawns(actualTgtEvents, aliveBalls, clipStart),
    ...actualTgtEvents,
  ];
}

// Replay target events before clipStart to find which targets were alive
// then. If the Spawned event was pruned, Bounce/StateChanged/Hit events
// still carry the targetType and position/velocity, so we can create a
// snapshot from them.
//
// Identity is (targetType, targetId), NOT targetId alone: the u16 id space
// is shared by a wrap-around allocator, and after enough spawns a ball's
// raw id WILL land inside the flag/pickup/creature namespaces. A single
// raw-id table lets a flag edge overwrite a live ball's entry (or a ball's
// Destroyed remove a live flag's) — the lanes are already separated by
// targetType, so the key mirrors that split.
export function findAliveTargets(targetEvents: TargetEvent[], clipStart: number): Map<number, TargetEvent> {
  const aliveBalls = new Map<number, TargetEvent>();
  const keyOf = (e: TargetEvent): number => e.targetType * 65_536 + e.targetId;
  for (const e of targetEvents) {
    if (e.timestamp >= clipStart) {break;}
    // Kill markers carry a victim ROSTER INDEX in targetId, not an entity
    // id — they are point-in-time edges with no alive state, and letting
    // them into the alive table both synthesizes phantom spawns at
    // clipStart and clobbers a same-id ball's snapshot entry.
    if (e.targetType === TARGETTYPE_KILL) {continue;}
    const k = keyOf(e);
    if (e.eventType === TargetEventType.Destroyed) {
      aliveBalls.delete(k);
      continue;
    }
    // Spawned/Bounce/StateChanged/Hit — update or create alive entry
    const existing = aliveBalls.get(k);
    if (!existing) {
      aliveBalls.set(k, e);
      continue;
    }
    // Preserve targetType and health if the new event doesn't carry them (legacy 0)
    const targetType = e.targetType === 0 ? existing.targetType : e.targetType;
    const health = e.health === 0 ? existing.health : e.health;
    aliveBalls.set(k, { ...e, targetType,health});
  }
  return aliveBalls;
}

// For any targetId that appears inside the clip but has no Spawned event and
// no alive snapshot, create a synthetic Spawned at clipStart from its first
// event. This covers Spawned events that were pruned before extractClip ran.
// Same (targetType, targetId) identity as findAliveTargets — a raw-id
// check here would skip a needed synthetic spawn the moment an unrelated
// lane reuses the id.
function recoverMissingSpawns(actualTgtEvents: TargetEvent[], aliveBalls: Map<number, TargetEvent>, clipStart: number): TargetEvent[] {
  const keyOf = (e: TargetEvent): number => e.targetType * 65_536 + e.targetId;
  const firstEventByKey = new Map<number, TargetEvent>();
  const hasSpawnedInClip = new Set<number>();
  for (const e of actualTgtEvents) {
    if (e.targetType === TARGETTYPE_KILL) {continue;}
    const k = keyOf(e);
    if (!firstEventByKey.has(k)) {
      firstEventByKey.set(k, e);
    }
    if (e.eventType === TargetEventType.Spawned) {
      hasSpawnedInClip.add(k);
    }
  }
  const additionalSpawned: TargetEvent[] = [];
  for (const [k, first] of firstEventByKey) {
    if (aliveBalls.has(k) || hasSpawnedInClip.has(k)) {continue;}
    additionalSpawned.push({ ...first, eventType: TargetEventType.Spawned,timestamp: clipStart});
  }
  return additionalSpawned;
}
