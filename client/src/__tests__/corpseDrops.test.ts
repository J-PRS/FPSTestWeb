/* oxlint-disable typescript/no-explicit-any -- test stubs are deliberately loosely typed */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import type { ServerMessage } from '../../../shared/protocol.js';
import { makeDeps, feed } from './netHarness.js';
import { noteCorpseFling } from '../game/net/pickups.js';

vi.mock('../core/sfx.js', () => ({ at: (): void => { return; }, shotAt: (): void => { return; }, init: (): void => { return; }, hitMarker: (): void => { return; }, playerHurt: (): void => { return; }, shieldHit: (): void => { return; }, killConfirm: (): void => { return; }, flagCue: (): void => { return; }, matchHorn: (): void => { return; } }));
vi.mock('../core/sfx/player.js', () => ({ powerup: (): void => { return; } }));
vi.mock('../entities/PlayerModel.js', (): { PlayerModel: () => { load: () => Promise<void>; } } => ({
  PlayerModel: function (): { load: () => Promise<void>; } {
    return new Proxy({ load: (): Promise<void> => Promise.resolve() }, {
      get: (t, k): unknown => (k in t ? (t as Record<PropertyKey, unknown>)[k] : (): void => { return; }),
    });
  },
}));
// jsdom has no 2d canvas - the texture is render-only.
vi.mock('../effects/glowTexture.js', () => ({
  getGlowTexture: (): THREE.Texture => new THREE.Texture(),
  getPuffTexture: (): THREE.Texture => new THREE.Texture(),
}));
globalThis.fetch = ((): Promise<Response> => new Promise<Response>((): void => { return; })) as unknown as typeof fetch;

/** Corpse-scatter ordering: kill frame rides the binary lane, pickupSpawn
 *  rides JSON - on WT the drop can land FIRST. The drop must materialize
 *  exactly once: bursting from the rescued corpse, or at wire truth when
 *  the grace expires - never rendered-then-jumped. */
describe('corpse-scatter drop ordering', (): void => {
  let h!: ReturnType<typeof makeDeps>;
  beforeEach((): void => {
    vi.useFakeTimers();
    h = makeDeps();
  });
  afterEach((): void => { vi.useRealTimers(); });

  const pickups = (): Map<number, any> => h.world.netPickups as unknown as Map<number, any>;

  it('drop-before-kill: parked spawn bursts from the late corpse', (): void => {
    const at = { x: 10, y: 0, z: 10 };
    feed(h.nm, { type: 'pickupSpawn', id: 7, pos: { x: 12, y: 1, z: 10 }, kind: 'gem', val: 1, vel: { x: 1, y: 0, z: 0 } } as ServerMessage);
    // No corpse yet - the drop must NOT render at wire pos.
    expect(pickups().has(7)).toBe(false);
    noteCorpseFling({ x: 10.5, y: 0, z: 10.5 }, at);
    const e = pickups().get(7);
    expect(e).toBeDefined();
    // Spawned AT the rendered corpse, launched toward the wire rest-spot.
    expect(e.nugget.pos.x).toBeCloseTo(10.5);
    expect(e.nugget.pos.z).toBeCloseTo(10.5);
    expect(e.nugget.vel.x).toBeGreaterThan(0); // flinging toward +x rest-spot
    expect(e.nugget.vel.y).toBeGreaterThan(0); // the +4 pop
  });

  it('kill-first ordering: immediate fling, no park', (): void => {
    const at = { x: 20, y: 0, z: 20 };
    noteCorpseFling({ x: 20.5, y: 0, z: 20 }, at);
    feed(h.nm, { type: 'pickupSpawn', id: 8, pos: { x: 22, y: 1, z: 20 }, kind: 'gem', val: 1 } as ServerMessage);
    const e = pickups().get(8);
    expect(e).toBeDefined();
    expect(e.nugget.pos.x).toBeCloseTo(20.5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no corpse inside the grace: drop appears at wire truth on expiry', (): void => {
    feed(h.nm, { type: 'pickupSpawn', id: 9, pos: { x: -50, y: 1, z: -50 }, kind: 'gem', val: 1, vel: { x: 0, y: 0, z: 0 } } as ServerMessage);
    expect(pickups().has(9)).toBe(false);
    vi.advanceTimersByTime(900);
    const e = pickups().get(9);
    expect(e).toBeDefined();
    expect(e.nugget.pos.x).toBeCloseTo(-50);
  });

  it('collect inside the grace cancels the park - drop never materializes', (): void => {
    feed(h.nm, { type: 'pickupSpawn', id: 10, pos: { x: -80, y: 1, z: -80 }, kind: 'gem', val: 1, vel: { x: 0, y: 0, z: 0 } } as ServerMessage);
    feed(h.nm, { type: 'pickupGone', id: 10, by: 'someone-else' } as ServerMessage);
    vi.advanceTimersByTime(1000);
    expect(pickups().has(10)).toBe(false);
  });

  it('powerups never park - unrelated spawns must not get yanked to a corpse', (): void => {
    feed(h.nm, { type: 'pickupSpawn', id: 11, pos: { x: 0, y: 1, z: 0 }, kind: 'heal', val: 1 } as ServerMessage);
    expect(pickups().has(11)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
