// Pooled-checkout contract: a pooled ParticleSystem carries parked
// emission bookkeeping (travelDistance/previousWorldPos from its LAST
// owner). activateSystem must re-baseline all of it to the new position,
// or the first emit reads the teleport as travel and dumps the whole
// debt as one stationary burst — the "muzzle blob" regression.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ParticleSystem, ConstantValue } from 'three.quarks';
import { activateSystem, resyncEmission } from '../effects/vfxRuntime.js';

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

const emissionState = (ps: ParticleSystem) => ps.emissionState as unknown as EmissionState;

describe('activateSystem (pooled-emitter checkout)', () => {
  it('zeroes the distance-emission debt a parked pooled system carries', () => {
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

  it('refreshes matrixWorld before baselining — same-frame position writes count', () => {
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

  it('unpauses systems that come back distance-paused from the pool', () => {
    const ps = makeSystem();
    ps.paused = true;
    activateSystem(ps, new THREE.Vector3(1, 2, 3));
    expect(ps.paused).toBe(false);
  });

  it('applies orientation when given one', () => {
    const ps = makeSystem();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    activateSystem(ps, new THREE.Vector3(), q);
    expect(ps.emitter.quaternion.angleTo(q)).toBeLessThan(1e-6);
  });
});

describe('resyncEmission', () => {
  it('is idempotent — a second resync keeps the baseline', () => {
    const ps = makeSystem();
    const pos = new THREE.Vector3(7, 8, 9);
    activateSystem(ps, pos);
    resyncEmission(ps, ps.emitter);
    const st = emissionState(ps);
    expect(st.travelDistance).toBe(0);
    expect(st.previousWorldPos!.distanceTo(pos)).toBeLessThan(1e-4);
  });
});
