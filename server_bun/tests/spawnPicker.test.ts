import { describe, expect, it } from 'bun:test';

import { SpawnPicker, type SpawnPickerHost } from '../src/spawnPicker.ts';
import type { SpawnPoint } from '../../shared/mapSpec.ts';
import type { PlayerState } from '../src/types.ts';

const pt = (x: number, z: number, over: Partial<SpawnPoint> = {}): SpawnPoint =>
  ({ x, y: 0, z, r: 0, w: 1, ...over });

const foeAt = (x: number, z: number, team?: string): [string, PlayerState] =>
  [`p-${x}-${z}`, { position: { x, y: 0, z }, isDead: false, team } as PlayerState];

const host = (over: Partial<SpawnPickerHost> = {}): SpawnPickerHost => ({
  players: () => new Map(),
  spawnPoints: () => null,
  teamSpawns: () => null,
  teamBases: () => null,
  groundAt: () => undefined,
  rng: () => 0.5,
  ...over,
});

const SPAWN_POOL = [pt(0, 0), pt(100, 0), pt(-100, 0)];

describe('SpawnPicker.pick', () => {
  it('team spheres win over the flat pool — bravo never spawns alpha-side', () => {
    const h = host({
      teamSpawns: () => ({ bravo: [pt(500, 500)] }),
      spawnPoints: () => SPAWN_POOL,
    });
    const p = new SpawnPicker(h).pick('me', 'bravo');
    expect(p).toEqual({ x: 500, y: 0, z: 500 });
  });

  it('empty roster takes the first point — no clearance math needed', () => {
    const p = new SpawnPicker(host({ spawnPoints: () => SPAWN_POOL })).pick('me');
    expect(p).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('picks the point farthest from living enemies', () => {
    const players = new Map([foeAt(95, 0), foeAt(-95, 0)]);
    const p = new SpawnPicker(host({ spawnPoints: () => SPAWN_POOL, players: () => players })).pick('me');
    expect(p.x).toBe(0); // the only spawn not beside an enemy
  });

  it('dead enemies and teammates do not factor into clearance', () => {
    const corpse = { position: { x: 95, y: 0, z: 0 }, isDead: true } as PlayerState;
    const mate = { position: { x: -95, y: 0, z: 0 }, isDead: false, team: 'alpha' } as PlayerState;
    const players = new Map<string, PlayerState>([['c', corpse], ['m', mate]]);
    // Both near-spawns are safe for an alpha player — clearance ties,
    // first point wins on score order.
    const p = new SpawnPicker(host({ spawnPoints: () => SPAWN_POOL, players: () => players })).pick('me', 'alpha');
    expect(p).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('authored anchors buried under terrain lift to the surface', () => {
    const buried = [pt(0, 0, { y: -50 })];
    const h = host({ spawnPoints: () => buried, groundAt: () => () => 12 });
    expect(new SpawnPicker(h).pick('me').y).toBe(12);
  });

  it('objective pull cannot claim a camped point — the enemy-base sphere stays off-limits', () => {
    // Bastion: flat pool, two points glued to each base. A bravo push
    // member's goal is the alpha stand — uncapped pull would respawn
    // him inside the defended base.
    const pool = [pt(0, 0), pt(250, 0)]; // alpha-side, bravo-side
    const players = new Map([foeAt(10, 0, 'alpha')]);
    const h = host({
      spawnPoints: () => pool,
      players: () => players,
      teamBases: () => ({ alpha: { x: 0, y: 0, z: 0 }, bravo: { x: 250, y: 0, z: 0 } }),
      objective: () => ({ pos: { x: 0, y: 0, z: 0 }, w: 1.6 }),
    });
    const p = new SpawnPicker(h).pick('me', 'bravo');
    expect(p.x).toBe(250);
  });

  it('objective pull still wins when the enemy-side point is safe', () => {
    const pool = [pt(0, 0), pt(250, 0)];
    const players = new Map([foeAt(125, 0, 'alpha')]); // midfield — both safe
    const h = host({
      spawnPoints: () => pool,
      players: () => players,
      teamBases: () => ({ alpha: { x: 0, y: 0, z: 0 }, bravo: { x: 250, y: 0, z: 0 } }),
      objective: () => ({ pos: { x: 0, y: 0, z: 0 }, w: 1.6 }),
    });
    const p = new SpawnPicker(h).pick('me', 'bravo');
    expect(p.x).toBe(0); // nearest the task goal, and nobody home to camp it
  });

  it('sphere volumes scatter inside r, not at the center', () => {
    const sphere = [pt(0, 0, { r: 30 })];
    let rolls: number[] = [0.25, 0.9]; // angle, radius-fraction
    const h = host({ spawnPoints: () => sphere, rng: () => rolls.shift() ?? 0.5 });
    const p = new SpawnPicker(h).pick('me');
    expect(Math.hypot(p.x, p.z)).toBeGreaterThan(1);
    expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(30);
  });
});
