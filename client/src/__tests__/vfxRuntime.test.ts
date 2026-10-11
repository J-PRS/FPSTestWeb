// Pooled-checkout contract: a pooled ParticleSystem carries parked
// emission bookkeeping (travelDistance/previousWorldPos from its LAST
// owner). activateSystem must re-baseline all of it to the new position,
// or the first emit reads the teleport as travel and dumps the whole
// debt as one stationary burst — the "muzzle blob" regression.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ParticleSystem, ConstantValue } from 'three.quarks';
import { activateSystem, resyncEmission, TrailDriver } from '../effects/vfxRuntime.js';

interface EmissionState {
  travelDistance: number;
  waitEmiting: number;
  previousWorldPos?: THREE.Vector3;
}

function makeSystem(): ParticleSystem {
  return new ParticleSystem({
    duration: 1,
    looping: true,
    emissionOverTime: new ConstantValue(0),
    emissionOverDistance: new ConstantValue(2),
    material: new THREE.MeshBasicMaterial(),
    worldSpace: true,
  });
}

const emissionState = (ps: ParticleSystem): EmissionState => ps.emissionState as unknown as EmissionState;

describe('activateSystem (pooled-emitter checkout)', (): void => {
  it('zeroes the distance-emission debt a parked pooled system carries', (): void => {
    const ps = makeSystem();
    // Simulate the residue a pooled entry brings back: it emitted at its
    // previous owner's muzzle, then sat parked hundreds of meters away.
    const st = emissionState(ps);
    st.travelDistance = 780;
    st.waitEmiting = 4.2;
    st.previousWorldPos = new THREE.Vector3(500, 0, 500);
    ps.emitter.position.set(500, 0, 500);
    ps.emitter.updateMatrixWorld(true);

    const muzzle = new THREE.Vector3(10, 65, 200);
    activateSystem(ps, muzzle);

    expect(st.travelDistance).toBe(0);
    expect(st.waitEmiting).toBe(0);
    // previousWorldPos must equal the NEW emitter world position — not the
    // stale value and not undefined (which quarks would lazily re-seed
    // from a stale matrixWorld on the next emit).
    expect(st.previousWorldPos).toBeDefined();
    expect(st.previousWorldPos!.distanceTo(muzzle)).toBeLessThan(1e-4);
  });

  it('refreshes matrixWorld before baselining — same-frame position writes count', (): void => {
    const ps = makeSystem();
    const muzzle = new THREE.Vector3(-30, 5, 120);
    // Position written but matrixWorld never flushed — the classic first-
    // emit-after-teleport ordering that produced particles:1563.
    ps.emitter.position.copy(muzzle);
    const st = emissionState(ps);
    st.previousWorldPos = new THREE.Vector3(0, 0, 0);

    activateSystem(ps, muzzle);
    expect(st.previousWorldPos!.distanceTo(muzzle)).toBeLessThan(1e-4);
  });

  it('unpauses systems that come back distance-paused from the pool', (): void => {
    const ps = makeSystem();
    ps.paused = true;
    activateSystem(ps, new THREE.Vector3(1, 2, 3));
    expect(ps.paused).toBe(false);
  });

  it('applies orientation when given one', (): void => {
    const ps = makeSystem();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    activateSystem(ps, new THREE.Vector3(), q);
    expect(ps.emitter.quaternion.angleTo(q)).toBeLessThan(1e-6);
  });
});

describe('resyncEmission', (): void => {
  it('is idempotent — a second resync keeps the baseline', (): void => {
    const ps = makeSystem();
    const pos = new THREE.Vector3(7, 8, 9);
    activateSystem(ps, pos);
    resyncEmission(ps, ps.emitter);
    const st = emissionState(ps);
    expect(st.travelDistance).toBe(0);
    expect(st.previousWorldPos!.distanceTo(pos)).toBeLessThan(1e-4);
  });
});

// TrailDriver (VFX P1): the emit-vs-jump decision lives in ONE place —
// updateVfx ticks registered drivers; a host discontinuity cuts every
// layer without any caller declaring a teleport.
const fakeLayer = (): { emits: number; teleports: number; emitSegment(): void; teleport(): void; } => ({ emits: 0, teleports: 0,
  emitSegment(): void {this.emits += 1; }, teleport(): void {this.teleports += 1; } });
const fakeRibbon = (): { pushes: number; clears: number; push(): void; clear(): void; } => ({ pushes: 0, clears: 0,
  push(): void {this.pushes += 1; }, clear(): void {this.clears += 1; } });

describe('TrailDriver', (): void => {

  it('emits on ordinary travel, cuts every layer on a jump — no caller teleport', (): void => {
    const host = { pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(10, 0, 0) };
    const layer = fakeLayer(); const rib = fakeRibbon();
    const d = new TrailDriver(host, [layer], [rib]);
    host.pos.x += 1; d.tick(0.016);          // ~legit frame of travel
    expect(layer.emits).toBe(1); expect(rib.pushes).toBe(1);
    host.pos.x += 200; d.tick(0.016);        // discontinuity — no caller help
    expect(layer.teleports).toBe(2); expect(rib.clears).toBe(1); // +1 = startup resync on the first tick
    host.pos.x += 1; d.tick(0.016);          // motion resumes cleanly
    expect(layer.emits).toBe(3);
    d.release();
  });

  it('stops emitting when the host reports dead, keeps sampling pos', (): void => {
    let alive = true;
    const host = { pos: new THREE.Vector3(), vel: new THREE.Vector3(5, 0, 0),
      emitting: (): boolean => alive };
    const layer = fakeLayer(); const rib = fakeRibbon();
    const d = new TrailDriver(host, [layer], [rib]);
    d.tick(0.016); expect(layer.emits).toBe(1);
    alive = false; host.pos.x += 0.5; d.tick(0.016);
    expect(layer.emits).toBe(1); expect(rib.pushes).toBe(1);
    d.release();
  });

  it('emitOnJump=false suppresses the jump frame entirely; ribbonEmitting gates pushes', (): void => {
    let moving = true;
    const host = {
      pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(10, 0, 0),
      ribbonEmitting: (): boolean => moving,
      emitOnJump: false, // correction-sweep host: the sweep IS the motion to hide
      maxStep: (d: number): number => Math.max(6, 10 * d * 4),
    };
    const layer = fakeLayer(); const rib = fakeRibbon();
    const d = new TrailDriver(host, [layer], [rib]);
    host.pos.x += 1; d.tick(0.016);
    expect(layer.emits).toBe(1); expect(rib.pushes).toBe(1);
    host.pos.x += 50; d.tick(0.016); // correction sweep — layers still cut…
    expect(rib.clears).toBe(1); expect(layer.teleports).toBe(2); // +1 = startup resync on the first tick
    expect(layer.emits).toBe(1); expect(rib.pushes).toBe(1); // …but nothing deposits
    moving = false; host.pos.x += 1; d.tick(0.016);
    expect(layer.emits).toBe(2); expect(rib.pushes).toBe(1); // dots sparkle, ribbon starves
    d.release();
  });

  it('release() unregisters — updateVfx no longer ticks it', (): void => {
    const host = { pos: new THREE.Vector3(), vel: new THREE.Vector3(1, 0, 0) };
    const layer = fakeLayer();
    const d = new TrailDriver(host, [layer]);
    d.release();
    host.pos.x += 1; d.tick(0.016); // direct tick still works — release only gates the registry
    expect(layer.emits).toBe(1);
  });
});
