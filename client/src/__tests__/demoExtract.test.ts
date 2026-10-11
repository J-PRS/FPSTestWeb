import { describe, expect, it } from 'vitest';
import { extractClip, buildDemoFile } from '../demo/demoExtract.js';
import { CircularBuffer } from '../demo/CircularBuffer.js';
import {ProjectileEventType, type DemoFrame, type ProjectileEvent} from '../demo/types.js';
import type { DemoRecorder } from '../demo/DemoRecorder.js';

const pEvt = (t: number, id: number): ProjectileEvent =>
  ({ timestamp: t, eventType: ProjectileEventType.Fired, projectileId: id } as ProjectileEvent);

const frame = (t: number, n = 0): DemoFrame =>
  ({ timestamp: t, frameNumber: n, posX: 0, posY: 0, posZ: 0, yaw: 0, pitch: 0, velX: 0, velY: 0, velZ: 0 }) as DemoFrame;

const host = (times: number[], startN = 0): DemoRecorder => {
  const buf = new CircularBuffer<DemoFrame>(64);
  times.forEach((t, i): void => buf.add(frame(t, startN + i)));
  return {
    frameBuffer: buf,
    elapsedTime: times.at(-1) ?? 0,
    projectileEvents: [] as ProjectileEvent[],
    targetEvents: [],
    roster: [],
    remoteFrames: [],
    context: {},
  } as unknown as DemoRecorder;
};

describe('extractClip', (): void => {
  it('empty buffer → null', (): void => {
    expect(extractClip(host([]), 0, 5, 'x')).toBeNull();
  });

  it('window outside the recording → null', (): void => {
    const r = host([0, 1, 2]);
    expect(extractClip(r, 9, 12, 'x')).toBeNull();
  });

  it('slices, renormalizes timestamps, and clamps to buffer extent', (): void => {
    const r = host([0, 1, 2, 3, 4, 5]);
    const clip = extractClip(r, 1.5, 4, 'mid')!;
    expect(clip).not.toBeNull();
    expect(clip.header.duration).toBeCloseTo(2.5, 5); // the requested window
    expect(clip.frames.map((f): number => f.timestamp)).toEqual([0.5, 1.5, 2.5]);
    expect(clip.header.totalFrames).toBe(3);
  });

  it('frame numbers survive the 65536 wrap', (): void => {
    const r = host([0, 1, 2, 3], 65_534); // crosses the wrap mid-clip
    const clip = extractClip(r, 1, 3, 'wrap')!;
    expect(clip.frames.map((f): number => f.frameNumber)).toEqual([0, 1, 2]);
  });

  it('a still-live projectile injects a synthetic Fired at clipStart', (): void => {
    const r = host([0, 1, 2, 3, 4]);
    r.projectileEvents.push(pEvt(0.5, 1), pEvt(2.5, 2), pEvt(6, 3));
    const clip = extractClip(r, 2, 4, 'w')!;
    // Projectile 1 is mid-flight when the clip opens — playback needs its
    // launch state, so a synthetic Fired lands at t=0. Projectile 3 is
    // outside the window entirely.
    expect(clip.projectileEvents.length).toBe(2);
    expect(clip.projectileEvents[0]!.projectileId).toBe(1);
    expect(clip.projectileEvents[0]!.timestamp).toBe(0);
    expect(clip.projectileEvents[1]!.projectileId).toBe(2);
    expect(clip.projectileEvents[1]!.timestamp).toBeCloseTo(0.5, 5);
    expect(clip.header.projectileEventCount).toBe(2);
  });

  it('a projectile killed before the window gets no synthetic spawn', (): void => {
    const r = host([0, 1, 2, 3, 4]);
    r.projectileEvents.push(
      { timestamp: 0.5, eventType: ProjectileEventType.Fired, projectileId: 1 } as ProjectileEvent,
      { timestamp: 1, eventType: ProjectileEventType.Hit, projectileId: 1 } as ProjectileEvent,
    );
    const clip = extractClip(r, 2, 4, 'w')!;
    expect(clip.projectileEvents.length).toBe(0);
  });

  it('startPose comes from the clip first frame, not the recording head', (): void => {
    const r = host([0, 1, 2, 3]);
    r.frameBuffer.getUnsafe(2).posX = 42;
    const clip = extractClip(r, 1.5, 3, 'tail')!;
    expect(clip.header.startPosX).toBe(42);
  });
});

describe('buildDemoFile', (): void => {
  it('stamps counts from the actual arrays', (): void => {
    const r = host([0, 1, 2]);
    const f = buildDemoFile(r, 'desc');
    expect(f.header.totalFrames).toBe(3);
    expect(f.header.description).toBe('desc');
    expect(f.header.startPosX).toBe(0);
  });
});
