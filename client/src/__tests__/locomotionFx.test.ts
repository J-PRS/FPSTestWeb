import { describe, expect, it, vi, type Mock } from 'vitest';
import * as THREE from 'three';
import { emitLocomotionFx, isCarvingSki } from '../effects/locomotionFx.js';
import { PlayerEmit } from '../entities/playerEmit.js';

const vec = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

// Two sinks stand in for the two real worlds: the local player's host
// callbacks and the remotes/bots EffectsManager. Same inputs => same calls.
type SpySink = { spawnJetpack: Mock; spawnSkiDust: Mock };
const sinkSpy = (): SpySink => ({ spawnJetpack: vi.fn(), spawnSkiDust: vi.fn() });

describe('isCarvingSki', (): void => {
  it('needs ski + grounded + real horizontal speed', (): void => {
    expect(isCarvingSki(vec(6, 0, 0), true, true)).toBe(true);
    expect(isCarvingSki(vec(2, 0, 0), true, true)).toBe(false); // too slow
    expect(isCarvingSki(vec(6, 0, 0), true, false)).toBe(false); // ski not held
    expect(isCarvingSki(vec(6, 0, 0), false, true)).toBe(false); // airborne
  });
  it('counts horizontal speed only — a pure vertical drop never carves', (): void => {
    expect(isCarvingSki(vec(0, -30, 0), true, true)).toBe(false);
  });
});

describe('emitLocomotionFx', (): void => {
  it('skis on the carve gate without jetting, and vice versa', (): void => {
    const s = sinkSpy();
    emitLocomotionFx(s as never, vec(1, 1, 1), vec(12, 0, 0), true, true, false);
    expect(s.spawnSkiDust).toHaveBeenCalledTimes(1);
    expect(s.spawnJetpack).not.toHaveBeenCalled();

    emitLocomotionFx(s as never, vec(0, 0, 0), vec(0, 0, 0), false, false, true);
    expect(s.spawnJetpack).toHaveBeenCalledTimes(1);
    expect(s.spawnSkiDust).toHaveBeenCalledTimes(1);
  });

  // The whole point of the module: a local player and a remote fed identical
  // state emit identical FX — no divergent thresholds between actor types.
  it('routes every actor type through the identical gate', (): void => {
    const local = sinkSpy();
    const remote = sinkSpy();
    const cases: [THREE.Vector3, boolean, boolean, boolean][] = [
      [vec(12, 0, 0), true, true, false],
      [vec(3, 0, 0), true, true, false],
      [vec(0, 5, 0), false, true, true],
      [vec(9, 0, 0), true, false, false],
    ];
    for (const [vel, grounded, ski, jet] of cases) {
      emitLocomotionFx(local as never, vec(0, 0, 0), vel, grounded, ski, jet);
      emitLocomotionFx(remote as never, vec(0, 0, 0), vel, grounded, ski, jet);
    }
    expect(local.spawnSkiDust.mock.calls).toEqual(remote.spawnSkiDust.mock.calls);
    expect(local.spawnJetpack.mock.calls).toEqual(remote.spawnJetpack.mock.calls);
  });
});

// Minimal EmitHost — the local player's side of the shared pass.
type FakeHost = Record<string, unknown> & { onSki: Mock; onJetpack: Mock };
const host = (over: Record<string, unknown> = {}): FakeHost => Object.assign({
  pos: vec(0, 0, 0), vel: vec(10, 0, 0), onGround: true, prevVelY: 0, wasOnGround: true,
  skiing: false, jumpAnimTimer: 0,
  skills: { postMove: vi.fn() }, model: null,
  onJetpack: vi.fn(), onSki: vi.fn(), onFootDust: vi.fn(), onLand: vi.fn(), onJump: vi.fn(),
  onNetworkJump: null, onNetworkJetpack: null,
}, over) as FakeHost;

describe('PlayerEmit — the local player rides the shared pass', (): void => {
  it('emits ski dust on the carve gate and sets the audio flag', (): void => {
    const h = host();
    new PlayerEmit(h as never).moveEvents(false, true, false, 1 / 60);
    expect(h.onSki).toHaveBeenCalledTimes(1);
    expect(h.skiing).toBe(true);
  });
  it('holds no ski dust while airborne even with the key down', (): void => {
    const h = host({ onGround: false });
    new PlayerEmit(h as never).moveEvents(false, true, false, 1 / 60);
    expect(h.onSki).not.toHaveBeenCalled();
    expect(h.skiing).toBe(false);
  });
  it('emits the jet plume while burning', (): void => {
    const h = host({ onGround: false });
    new PlayerEmit(h as never).moveEvents(true, false, false, 1 / 60);
    expect(h.onJetpack).toHaveBeenCalledTimes(1);
  });
});
