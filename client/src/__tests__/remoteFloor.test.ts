/* oxlint-disable typescript/no-explicit-any -- private-field stubs for the sim internals under test */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RemoteInterp, type InterpHost } from '../entities/remoteInterp.js';
import { classCapsule } from '../../../shared/botClasses.js';
import type { Terrain } from '../world/terrain.js';

// floorToGround's airborne-wire lift: a snapshot chord can shortcut through
// a rise the true path went over. The render may climb to the DRAWN surface -
// but only when the wire feet clear it at that column, so the lift can never
// hover the body above its validated capsule.

const EYE = classCapsule('medium').eye;

const mkRi = (field: number, drawn: number): RemoteInterp => {
  const host: InterpHost = {
    position: new THREE.Vector3(),
    previousPosition: new THREE.Vector3(),
    rotation: { yaw: 0, pitch: 0, roll: 0 },
    velocity: new THREE.Vector3(),
    serverVelocity: new THREE.Vector3(),
    terrain: {
      getHeight: (): number => field,
      getRenderedHeight: (): number => drawn,
    } as unknown as Terrain,
    playerId: 'dbg', armorClass: 'medium',
  };
  return new RemoteInterp(host);
};

const floor = (ri: RemoteInterp, p: THREE.Vector3, wireY: number): void => {
  (ri as any).lastServerPosition.set(0, wireY, 0);
  (ri as any).floorToGround(p);
};

describe('remoteInterp floorToGround - airborne wire lift', (): void => {
  it('lifts a chord-shortcut render to the drawn surface when wire clears it', (): void => {
    const ri = mkRi(0, 10);              // drawn ridge at y=10 over a flat sim field
    const p = new THREE.Vector3(0, 5, 0); // interpolated render buried inside it
    floor(ri, p, 14 + EYE);               // wire feet at 14 > drawn 10 - airborne above it
    expect(p.y).toBeCloseTo(10 + EYE, 6);
  });

  it('never lifts the render above the wire capsule', (): void => {
    const ri = mkRi(0, 60);               // tall drawn column - wire feet sit BELOW its top
    const p = new THREE.Vector3(0, 5, 0);
    floor(ri, p, 50 + EYE);               // wire feet 50 < drawn 60 - lift would hover over truth
    expect(p.y).toBe(5);
  });

  it('leaves an airborne render above the surface alone', (): void => {
    const ri = mkRi(0, 10);
    const p = new THREE.Vector3(0, 20, 0);
    floor(ri, p, 30 + EYE);
    expect(p.y).toBe(20);
  });

  it('lifts a render only partially under the drawn surface', (): void => {
    const ri = mkRi(0, 10);
    // Eye just under the surface (feet ~0.5m buried): still a burial.
    const p = new THREE.Vector3(0, 10 + EYE - 0.5, 0);
    floor(ri, p, 14 + EYE);
    expect(p.y).toBeCloseTo(10 + EYE, 6);
  });

  it('no wire yet falls back to render feet - conservative, never lifts blind', (): void => {
    const ri = mkRi(0, 10);
    const p = new THREE.Vector3(0, 5, 0); // feet ~3.4: airborne-branch no-op, not a floor case
    floor(ri, p, 0); // lengthSq 0 - the fallback path must not invent a wire
    expect(p.y).toBe(5);
  });

  it('grounded wire leaves a render already above the floor alone', (): void => {
    const ri = mkRi(8, 10);
    const p = new THREE.Vector3(0, 30, 0);
    floor(ri, p, 8 + EYE);
    expect(p.y).toBe(30);
  });

  it('wire feet below the drawn surface stays buried - the lift must not fire', (): void => {
    const ri = mkRi(0, 1);                 // field 0, drawn surface at 1.0
    const p = new THREE.Vector3(0, 0.5, 0);  // render under the drawn column
    floor(ri, p, EYE + 0.6);                  // feet 0.6: airborne vs field, BELOW drawn
    expect(p.y).toBe(0.5);
  });

  it('wire feet exactly at the drawn surface is not "clear" - strict > gate', (): void => {
    const ri = mkRi(0, 10);
    const p = new THREE.Vector3(0, 5, 0);
    floor(ri, p, 10 + EYE);                   // feet == drawn: unprovable, must not lift
    expect(p.y).toBe(5);
  });

  it('wire feet exactly at field+0.5 takes the grounded lane, not airborne', (): void => {
    const ri = mkRi(0, 5);                   // drawn far above - only the grounded floor may act
    const p = new THREE.Vector3(0, 0, 0);
    floor(ri, p, 0.5 + EYE);                  // feet = 0.5 == field+0.5 boundary → grounded floor
    expect(p.y).toBeCloseTo(EYE, 6);
  });

  it('grounded wire still floors to the field+chord surface as before', (): void => {
    const ri = mkRi(8, 10);               // wire feet at field → the grounded lane
    const p = new THREE.Vector3(0, 5, 0);
    floor(ri, p, 8 + EYE);                // feet = 8 ≤ field+0.5 → original floor applies
    expect(p.y).toBeGreaterThanOrEqual(8 + EYE - 1e-9);
  });
});
