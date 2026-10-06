import { describe, expect, it } from 'vitest';
import { recordFired, recordBounce, recordHit, recordDestroyed } from '../demo/demoEvents.js';
import { ProjectileEventType } from '../demo/types.js';
import type { DemoRecorder } from '../demo/DemoRecorder.js';
import type { ProjectileEvent } from '../demo/types.js';

const V = { x: 1, y: 2, z: 3 };

// Host stub — only the fields the event recorders read/write.
const host = () => ({
  recording: true,
  elapsedTime: 0,
  lastEventResetTime: -10,
  eventCountThisSecond: 0,
  nextProjectileId: 1,
  projectileEventPool: [] as ProjectileEvent[],
  projectileEvents: [] as ProjectileEvent[],
}) as unknown as DemoRecorder;

describe('projectile event spool', () => {
  it('recordFired stamps ids 1..65535 then wraps', () => {
    const b = host();
    expect(recordFired(b, V, V, 9)).toBe(1);
    expect(recordFired(b, V, V, 9)).toBe(2);
    b.nextProjectileId = 65_535;
    expect(recordFired(b, V, V, 9)).toBe(65_535);
    expect(recordFired(b, V, V, 9)).toBe(1); // wrapped, never 0 (sentinel)
  });

  it('id 0 is the dead sentinel — dependents never record it', () => {
    const b = host();
    recordBounce(b, 0, V, V, V);
    recordHit(b, 0, V, 7, 1, 0);
    recordDestroyed(b, 0, V);
    expect(b.projectileEvents.length).toBe(0);
  });

  it('not recording → nothing spools', () => {
    const b = host();
    b.recording = false;
    expect(recordFired(b, V, V, 1)).toBe(0);
    expect(b.projectileEvents.length).toBe(0);
  });

  it('event types stamp the right record', () => {
    const b = host();
    const id = recordFired(b, V, V, 4);
    recordBounce(b, id, V, V, { x: 0, y: 1, z: 0 });
    recordHit(b, id, V, 42, 1, 2);
    recordDestroyed(b, id, V);
    const types = b.projectileEvents.map((e) => e.eventType);
    expect(types).toEqual([
      ProjectileEventType.Fired,
      ProjectileEventType.Bounce,
      ProjectileEventType.Hit,
      ProjectileEventType.Destroyed,
    ]);
    expect(b.projectileEvents[2]!.targetId).toBe(42);
    expect(b.projectileEvents[1]!.surfaceNormalY).toBe(1);
    expect(b.projectileEvents[0]!.weaponType).toBe(4);
  });

  it('rate cap drops a flood but resets on the next second', () => {
    const b = host();
    b.elapsedTime = 0;
    let ok = 0;
    for (let i = 0; i < 1100; i++) {if (recordFired(b, V, V, 1)) {ok++;}}
    expect(ok).toBe(1000);
    b.elapsedTime = 1.5; // next window
    expect(recordFired(b, V, V, 1)).not.toBe(0);
  });

  it('dead events recycle through the pool — no churn per spawn', () => {
    const b = host();
    recordFired(b, V, V, 1);
    const dead = b.projectileEvents.pop()!;
    b.projectileEventPool.push(dead);
    recordBounce(b, recordFired(b, V, V, 1), V, V, V);
    expect(b.projectileEvents[0]).toBe(dead); // pooled object reused
    expect(b.projectileEvents[0]!.eventType).toBe(ProjectileEventType.Fired);
  });
});
