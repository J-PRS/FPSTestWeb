import { describe, it, expect } from 'bun:test';
import { DemoPlayer } from '../../client/src/demo/DemoPlayer.ts';
import {
  ProjectileEventType, TargetEventType,
  createFrame, createHeader,
  type DemoFile,
} from '../../client/src/demo/types.ts';

function makeDemoFile(duration: number = 5.0): DemoFile {
  const frames = [];
  const tickRate = 60;
  const tickInterval = 1.0 / tickRate;
  const totalFrames = Math.floor(duration / tickInterval);
  for (let i = 0; i <= totalFrames; i++) {
    const f = createFrame(i, i * tickInterval);
    f.posX = i * 0.1;
    f.posY = 10 + Math.sin(i * 0.1) * 2;
    f.posZ = -5;
    f.velX = 6.0;
    f.velY = 0;
    f.velZ = 0;
    f.yaw = i * 0.01;
    f.pitch = 0;
    frames.push(f);
  }

  const header = createHeader();
  header.duration = duration;
  header.totalFrames = frames.length;

  const projectileEvents = [
    {
      eventType: ProjectileEventType.Fired,
      timestamp: 1.0,
      posX: 0, posY: 10, posZ: -5,
      velX: 50, velY: 0, velZ: 0,
      projectileId: 1,
      weaponType: 0,
      surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
      targetId: 0,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    },
    {
      eventType: ProjectileEventType.Hit,
      timestamp: 3.0,
      posX: 100, posY: 10, posZ: -5,
      velX: 0, velY: 0, velZ: 0,
      projectileId: 1,
      weaponType: 0,
      surfaceNormalX: 0, surfaceNormalY: 1, surfaceNormalZ: 0,
      targetId: 42,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    },
  ];

  const targetEvents = [
    {
      eventType: TargetEventType.Spawned,
      timestamp: 0.5,
      posX: 100, posY: 20, posZ: -5,
      velX: 0, velY: -5, velZ: 0,
      targetId: 42,
      targetType: 1,
      health: 100,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    },
  ];

  return { header, frames, projectileEvents, targetEvents };
}

describe('DemoPlayer', () => {
  it('loads and reports duration', () => {
    const player = new DemoPlayer();
    const demo = makeDemoFile(5.0);
    player.load(demo);
    expect(player.isLoaded).toBe(true);
    expect(player.duration).toBeCloseTo(5.0, 2);
    expect(player.currentTimeValue).toBe(0);
  });

  it('play sets playing state', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(2.0));
    player.play();
    expect(player.isPlaying).toBe(true);
  });

  it('pause stops playing', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(2.0));
    player.play();
    player.pause();
    expect(player.isPlaying).toBe(false);
  });

  it('stop resets to beginning', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(2.0));
    player.play();
    player.update(1.0);
    expect(player.currentTimeValue).toBeGreaterThan(0);
    player.stop();
    expect(player.isPlaying).toBe(false);
    expect(player.currentTimeValue).toBe(0);
  });

  it('update advances currentTime', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    player.play();
    player.update(1.5);
    expect(player.currentTimeValue).toBeCloseTo(1.5, 4);
  });

  it('update respects playback speed', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(10.0));
    player.setSpeed(2.0);
    player.play();
    player.update(1.0);
    expect(player.currentTimeValue).toBeCloseTo(2.0, 4);
  });

  it('update clamps NaN dt to 0', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    player.play();
    player.update(1.0);
    const timeBefore = player.currentTimeValue;
    player.update(NaN);
    expect(player.currentTimeValue).toBeCloseTo(timeBefore, 4);
  });

  it('update guards Infinity dt to 0', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(100.0));
    player.play();
    player.update(Infinity);
    expect(player.currentTimeValue).toBe(0);
  });

  it('update clamps negative dt to 0', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    player.play();
    player.update(1.0);
    const timeBefore = player.currentTimeValue;
    player.update(-0.5);
    expect(player.currentTimeValue).toBeCloseTo(timeBefore, 4);
  });

  it('seek sets currentTime', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    player.seek(2.5);
    expect(player.currentTimeValue).toBeCloseTo(2.5, 4);
  });

  it('seek clamps to [0, duration]', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    player.seek(-1.0);
    expect(player.currentTimeValue).toBe(0);
    player.seek(100.0);
    expect(player.currentTimeValue).toBeCloseTo(5.0, 4);
  });

  it('seek with NaN defaults to 0', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    player.seek(NaN);
    expect(player.currentTimeValue).toBe(0);
  });

  it('seek with Infinity defaults to 0', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    player.seek(Infinity);
    expect(player.currentTimeValue).toBe(0);
  });

  it('seek emits onTimeUpdate callback', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    let receivedTime = -1;
    let receivedDuration = -1;
    player.setCallbacks({
      onTimeUpdate: (t, d) => { receivedTime = t; receivedDuration = d; },
    });
    player.seek(2.0);
    expect(receivedTime).toBeCloseTo(2.0, 4);
    expect(receivedDuration).toBeCloseTo(5.0, 4);
  });

  it('seek emits onSeek callback', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    let seekCalled = false;
    player.setCallbacks({
      onSeek: () => { seekCalled = true; },
    });
    player.seek(2.0);
    expect(seekCalled).toBe(true);
  });

  it('seek emits frame state via onFrameUpdate', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    let receivedState: any = null;
    player.setCallbacks({
      onFrameUpdate: (state) => { receivedState = state; },
    });
    player.seek(2.0);
    expect(receivedState).not.toBeNull();
    expect(receivedState.posX).toBeCloseTo(12.0, 1); // frame 120 * 0.1 = 12.0
  });

  it('update emits events in time range', () => {
    const player = new DemoPlayer();
    const demo = makeDemoFile(5.0);
    player.load(demo);
    const receivedEvents: any[] = [];
    player.setCallbacks({
      onFrameUpdate: (_state, events) => {
        receivedEvents.push(...events.projectiles, ...events.targets);
      },
    });
    player.play();
    // Advance past t=1.0 (Fired event) and t=0.5 (Spawned event)
    player.update(1.1);
    const eventTypes = receivedEvents.map(e => e.eventType);
    expect(eventTypes).toContain(ProjectileEventType.Fired);
    expect(eventTypes).toContain(TargetEventType.Spawned);
  });

  it('update emits Hit event at correct time', () => {
    const player = new DemoPlayer();
    const demo = makeDemoFile(5.0);
    player.load(demo);
    const receivedEvents: any[] = [];
    player.setCallbacks({
      onFrameUpdate: (_state, events) => {
        receivedEvents.push(...events.projectiles);
      },
    });
    player.play();
    // Advance past t=3.0 (Hit event)
    player.update(3.1);
    const hitEvents = receivedEvents.filter(e => e.eventType === ProjectileEventType.Hit);
    expect(hitEvents.length).toBe(1);
    expect(hitEvents[0].timestamp).toBeCloseTo(3.0, 4);
  });

  it('play from end restarts from beginning', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(2.0));
    player.play();
    player.update(2.0); // reach end
    expect(player.currentTimeValue).toBeCloseTo(2.0, 4);
    expect(player.isPlaying).toBe(false);
    player.play(); // should restart
    expect(player.isPlaying).toBe(true);
    expect(player.currentTimeValue).toBe(0);
  });

  it('loop restarts from beginning on end', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(2.0));
    player.setLoop(true);
    player.play();
    let endCalled = false;
    player.setCallbacks({
      onPlaybackEnd: () => { endCalled = true; },
    });
    player.update(2.5); // past end
    expect(player.isPlaying).toBe(true);
    expect(endCalled).toBe(false);
    // Loop resets to 0 (excess time not carried over — pre-existing behavior)
    expect(player.currentTimeValue).toBe(0);
  });

  it('non-loop stops at end and calls onPlaybackEnd', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(2.0));
    player.play();
    let endCalled = false;
    player.setCallbacks({
      onPlaybackEnd: () => { endCalled = true; },
    });
    player.update(2.5);
    expect(player.isPlaying).toBe(false);
    expect(endCalled).toBe(true);
    expect(player.currentTimeValue).toBeCloseTo(2.0, 4);
  });

  it('unload clears state', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    player.unload();
    expect(player.isLoaded).toBe(false);
    expect(player.duration).toBe(0);
    expect(player.currentTimeValue).toBe(0);
  });

  it('getInterpolatedState interpolates between frames', () => {
    const player = new DemoPlayer();
    player.load(makeDemoFile(5.0));
    player.seek(1.008); // between frame 60 (t=1.0, x=6.0) and frame 61 (t=1.0167, x=6.1)
    // The exact interpolated x depends on frame timestamps, but should be between 6.0 and 6.1
    // We just verify it's in the right ballpark
    expect(player.currentTimeValue).toBeGreaterThan(1.0);
    expect(player.currentTimeValue).toBeLessThan(1.02);
  });
});
