/* oxlint-disable typescript/no-explicit-any -- private-field stubs for the sim internals under test */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RemoteInterp, type InterpHost } from '../entities/remoteInterp.js';
import { GRAVITY, MOVEMENT_CONFIG } from '../../../shared/movement.js';
import { classMass } from '../../../shared/botClasses.js';

// Stryker flagged lines 799-830 (simStep's jet-hold integration + the
// >40m drift pull-back) as surviving every deletion - these pin the
// correction math the canary test only grazes.

const mkHost = (): InterpHost => ({
  position: new THREE.Vector3(),
  previousPosition: new THREE.Vector3(),
  rotation: { yaw: 0, pitch: 0, roll: 0 },
  velocity: new THREE.Vector3(),
  serverVelocity: new THREE.Vector3(),
  terrain: null, playerId: 'dbg', armorClass: 'medium',
});

const mkRi = (): RemoteInterp => {
  const ri = new RemoteInterp(mkHost());
  // Fresh wire stamp - the uncertainty brake only engages past ~600ms of
  // silence; these tests pin the correction math, not the brake.
  (ri as any).lastUpdateTime = Date.now();
  return ri;
};

const step = (ri: RemoteInterp, dt: number): void => { (ri as any).simStep(dt); };
const vel = (ri: RemoteInterp): THREE.Vector3 => (ri as any).simulatedVelocity;

describe('remoteInterp simStep - dead-reckoning correction math', (): void => {
  it('gravity integrates every step', (): void => {
    const ri = mkRi();
    step(ri, 0.1);
    expect(vel(ri).y).toBeCloseTo(GRAVITY * 0.1, 6);
  });

  it('held wireJet adds thrust on top of gravity', (): void => {
    const idle = mkRi();
    step(idle, 0.1);
    const jetted = mkRi();
    (jetted as any).h.wireJet = true;
    step(jetted, 0.1);
    // Jet force minus same gravity - strictly less fall than the free body.
    expect(vel(jetted).y).toBeGreaterThan(vel(idle).y);
    expect(vel(jetted).y).toBeCloseTo(
      GRAVITY * 0.1 + MOVEMENT_CONFIG.jetForceUp * 0.1 / classMass('medium'), 6);
  });

  it('drift >40m strips the outward velocity component only', (): void => {
    const ri = mkRi();
    (ri as any).h.position.set(50, 60, 0);          // 50m out along +x
    (ri as any).lastServerPosition.set(0, 60, 0);   // wire truth at origin
    vel(ri).set(10, 0, 4);                          // +x outward, +z tangent
    step(ri, 0.016);
    // The +x push is removed (tiny residual: drift > 40 by the post-
    // integration position, so ux isn't exactly -1); z survives intact.
    expect(Math.abs(vel(ri).x)).toBeLessThan(0.1);
    expect(vel(ri).z).toBeCloseTo(4, 1); // tangential z survives within the uz bleed
  });

  it('drift >40m keeps inward velocity - the cap is not a freeze', (): void => {
    const ri = mkRi();
    (ri as any).h.position.set(50, 60, 0);
    (ri as any).lastServerPosition.set(0, 60, 0);
    vel(ri).set(-10, 0, 0); // already heading back to the wire
    step(ri, 0.016);
    expect(vel(ri).x).toBeCloseTo(-10, 5); // closing speed untouched
  });

  it('drift under the cap leaves velocity alone', (): void => {
    const ri = mkRi();
    (ri as any).h.position.set(10, 60, 0); // 10m < 40m cap, drift ⊥ velocity
    (ri as any).lastServerPosition.set(0, 60, 0);
    vel(ri).set(0, 0, 10); // tangential - neither the ring nor the lead cap bite
    step(ri, 0.016);
    expect(vel(ri).z).toBeCloseTo(10, 5);
  });

  it('lead cap stalls a ghost ahead of the wire head', (): void => {
    const ri = mkRi();
    (ri as any).h.position.set(3, 60, 0);     // 3m ahead along +x of wire
    (ri as any).lastServerPosition.set(0, 60, 0);
    vel(ri).set(10, 0, 2);                     // +x forward, +z tangential
    step(ri, 0.016);
    // Forward component stripped (gravity's -y dt survives the math);
    // tangential slide lives so the drift can turn off-path.
    expect(Math.abs(vel(ri).x)).toBeLessThan(0.5);
    expect(vel(ri).z).toBeCloseTo(2, 0.5);
  });

  it('lead cap spares behind-wire drift - that lag is rewindable', (): void => {
    const ri = mkRi();
    (ri as any).h.position.set(-3, 60, 0);    // 3m BEHIND wire along -x
    (ri as any).lastServerPosition.set(0, 60, 0);
    vel(ri).set(10, 0, 0);                     // moving toward wire head
    step(ri, 0.016);
    expect(vel(ri).x).toBeCloseTo(10, 5); // closing speed untouched
  });

  it('lead cap ignores sub-0.5m leads - the seed jitter zone', (): void => {
    const ri = mkRi();
    (ri as any).h.position.set(0.3, 60, 0);
    (ri as any).lastServerPosition.set(0, 60, 0);
    vel(ri).set(10, 0, 0);
    step(ri, 0.016);
    expect(vel(ri).x).toBeCloseTo(10, 5);
  });
});

describe('remoteInterp simStep - uncertainty brake', (): void => {
  it('bleeds XZ cruise past ~600ms silence, leaves Y alone', (): void => {
    const ri = mkRi();
    (ri as any).lastUpdateTime = Date.now() - 1000;
    vel(ri).set(10, 0, 8);
    step(ri, 0.016);
    const b = Math.exp(-0.016 / 0.45);
    expect(vel(ri).x).toBeCloseTo(10 * b, 5);
    expect(vel(ri).z).toBeCloseTo(8 * b, 5);
    expect(vel(ri).y).toBeCloseTo(GRAVITY * 0.016, 6);
  });

  it('fresh wire stamp leaves cruise untouched', (): void => {
    const ri = mkRi(); // mkRi stamps lastUpdateTime = now
    vel(ri).set(10, 0, 8);
    step(ri, 0.016);
    expect(vel(ri).x).toBeCloseTo(10, 5);
    expect(vel(ri).z).toBeCloseTo(8, 5);
  });
});
