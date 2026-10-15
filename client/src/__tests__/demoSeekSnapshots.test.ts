// Seek checkpoints: the tail window must rebuild the same alive set as a
// from-0 replay — synthetic baselines stand in for pre-window Spawned/Fired.
import { describe, expect, it } from 'vitest';
import { reconstructToTime } from '../demo/demoPlayback.js';
import {
  collectProjectileEvents, windowProjectileEvents,
  collectTargetEvents, windowTargetEvents,
} from '../demo/demoClip.js';
import {
  ProjectileEventType, TargetEventType,
  type DemoFile, type ProjectileEvent, type TargetEvent,
} from '../demo/types.js';
import type { DemoPlayer } from '../demo/DemoPlayer.js';

const proj = (t: number, id: number, type: ProjectileEventType): ProjectileEvent =>
  ({ timestamp: t, eventType: type, projectileId: id, posX: t, posY: 0, posZ: 0, velX: 1, velY: 0, velZ: 0 } as ProjectileEvent);

const tgt = (t: number, id: number, type: TargetEventType, tt = 1): TargetEvent =>
  ({ timestamp: t, eventType: type, targetId: id, targetType: tt, posX: t, posY: 0, posZ: 0, velX: 0, velY: 0, velZ: 0, health: 100 } as TargetEvent);

const playerStub = (file: Partial<DemoFile>): DemoPlayer => Object.assign({
  demoData: file,
  callbacks: {},
  lastProjectileEventIndex: 0,
  lastTargetEventIndex: 0,
  lastRemoteFrameIndex: 0,
}, {}) as unknown as DemoPlayer;

describe('checkpoint tail windows', (): void => {
  it('window from 0 with no renorm equals the clip collectors', (): void => {
    const p = [proj(1, 5, ProjectileEventType.Fired), proj(3, 5, ProjectileEventType.Bounce)];
    expect(windowProjectileEvents(p, 0, 5, null)).toEqual(collectProjectileEvents(p, 0, 5));
    const t = [tgt(1, 7, TargetEventType.Spawned), tgt(3, 7, TargetEventType.StateChanged)];
    expect(windowTargetEvents(t, 0, 5, null)).toEqual(collectTargetEvents(t, 0, 5));
  });

  it('an in-flight shell re-enters as a synthetic Fired at the checkpoint', (): void => {
    const p = [proj(1, 5, ProjectileEventType.Fired), proj(20, 5, ProjectileEventType.Bounce)];
    const tail = windowProjectileEvents(p, 30, 40, null);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.eventType).toBe(ProjectileEventType.Fired);
    expect(tail[0]!.timestamp).toBe(30);
    expect(tail[0]!.projectileId).toBe(5);
    // Last known state rides the baseline — Bounce at 20, not Fired at 1.
    expect(tail[0]!.posX).toBe(20);
  });

  it('a shell killed before the checkpoint stays dead', (): void => {
    const p = [proj(1, 5, ProjectileEventType.Fired), proj(20, 5, ProjectileEventType.Destroyed)];
    expect(windowProjectileEvents(p, 30, 40, null)).toEqual([]);
  });

  it('a live target re-enters as a synthetic Spawned at the checkpoint', (): void => {
    const t = [tgt(1, 7, TargetEventType.Spawned), tgt(20, 7, TargetEventType.StateChanged), tgt(35, 7, TargetEventType.Hit)];
    const tail = windowTargetEvents(t, 30, 40, null);
    expect(tail[0]!.eventType).toBe(TargetEventType.Spawned);
    expect(tail[0]!.timestamp).toBe(30);
    expect(tail[1]).toMatchObject({ eventType: TargetEventType.Hit, timestamp: 35 });
  });

  it('reconstructToTime replays the tail, keeping full-array pointers', (): void => {
    const p = playerStub({
      projectileEvents: [proj(1, 5, ProjectileEventType.Fired), proj(20, 5, ProjectileEventType.Bounce)],
      targetEvents: [tgt(1, 7, TargetEventType.Spawned)],
      snapshots: [30],
    });
    const r = reconstructToTime(p, 40);
    // Tail only: one synthetic shell baseline + one synthetic target baseline.
    expect(r.newProjEvents).toHaveLength(1);
    expect(r.newProjEvents[0]!.timestamp).toBe(30);
    expect(r.newTargetEvents).toHaveLength(1);
    expect(r.newTargetEvents[0]!.timestamp).toBe(30);
    // Pointers still index the full arrays — forward playback continues.
    expect(r.projCount).toBe(2);
    expect(r.tgtCount).toBe(1);
  });

  it('no checkpoints (or seek before the first) replays from 0', (): void => {
    const evts = [proj(1, 5, ProjectileEventType.Fired)];
    const p = playerStub({ projectileEvents: evts, targetEvents: [] });
    const r = reconstructToTime(p, 40);
    expect(r.newProjEvents).toEqual(evts);
    const p2 = playerStub({ projectileEvents: evts, targetEvents: [], snapshots: [50] });
    expect(reconstructToTime(p2, 40).newProjEvents).toEqual(evts);
  });
});
