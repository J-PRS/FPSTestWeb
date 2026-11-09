import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BotSenses, type SenseHost } from '../game/bots/botSenses.js';
import { NOISE_TTL_MS } from '../../../shared/wire.js';
import { WeaponType } from '../../../shared/weaponTable.js';
import type { GameBot } from '../game/bots/botBrain.js';
import type { Targetable } from '../entities/balls.js';

const v = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);

const mkBot = (id: string, team: string, over: Record<string, unknown> = {}): GameBot =>
  ((((Object.assign({}, {playerId: id,team,isDead: false,isCloakHidden: false,ghostT: 0,pos: v(),vel: v(),position: v()}, over))))) as unknown as GameBot;

interface Rig {
  senses: BotSenses;
  bots: GameBot[];
  teamOf: Map<string, string>;
  worldState: { remotePlayers: Map<string, { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloakHidden: boolean; ghostT: number }>;
                explosions: { pos: THREE.Vector3; age: number }[];
                projectiles: { pos: THREE.Vector3; vel: THREE.Vector3; config?: { weaponType?: number } }[] };
  playerState: { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloaked: boolean; lastFireAt: number; health: number; maxHealth: number };
  targets: Targetable[];
  state: { modeId: string };
}

const mkRig = (): Rig => {
  const bots: GameBot[] = [];
  const teamOf = new Map<string, string>();
  const worldState = { remotePlayers: new Map<string, { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloakHidden: boolean; ghostT: number }>(), explosions: [] as { pos: THREE.Vector3; age: number }[], projectiles: [] as { pos: THREE.Vector3; vel: THREE.Vector3; config?: { weaponType?: number } }[] };
  const playerState = { pos: v(), vel: v(), isDead: false, isCloaked: false, lastFireAt: -Infinity, health: 100, maxHealth: 100 };
  const targets: Targetable[] = [];
  const state = { modeId: 'ctf' };
  const host = {
    bots, teamOf,
    player: () => playerState,
    world: () => worldState,
    mode: (): string => state.modeId,
    targets,
  };
  return { senses: new BotSenses(host as SenseHost), bots, teamOf, worldState, playerState, targets, state };
};

describe('enemyBotsForTeam', (): void => {
  it('includes the local player only when hostile, and marks cloaked/dead as not alive', (): void => {
    const r = mkRig();
    r.teamOf.set('local', 'alpha');
    r.playerState.isCloaked = true;
    const b = mkBot('b:e', 'bravo');
    r.bots.push(b);
    const out = r.senses.enemyBotsForTeam('bravo'); // who is hostile TO bravo
    expect(out).toHaveLength(1); // b:e IS bravo — only local is hostile
    expect(out[0]!.playerId).toBe('local');
    expect(out[0]!.alive).toBe(false); // cloaked → not targetable
    const sameTeam = r.senses.enemyBotsForTeam('alpha');
    expect(sameTeam.some((e): boolean => e.playerId === 'local')).toBe(false);
  });
});

describe('recentNoises', (): void => {
  it('earshot is 50m and age gate tracks the wire noise TTL', (): void => {
    const r = mkRig();
    r.worldState.explosions.push(
      { pos: v(10, 0, 0), age: 1 },
      { pos: v(10, 0, 0), age: NOISE_TTL_MS / 1000 - 0.01 }, // just inside
      { pos: v(60, 0, 0), age: 1 },                         // out of earshot
      { pos: v(10, 0, 0), age: NOISE_TTL_MS / 1000 + 0.01 }, // too old
    );
    const out = r.senses.recentNoises(v());
    expect(out).toHaveLength(2);
    expect(out.every((o): boolean => o.x === 10)).toBe(true);
  });
});

describe('incomingNear', (): void => {
  it('a round inside 12m only counts while closing', (): void => {
    const r = mkRig();
    // config pinned to a no-splash gun: an unset weaponType falls back
    // to BoltLauncher stats, whose aoeRadius trips the parked-bomb
    // exemption and would count the receding "shell" as a threat.
    const cg = { weaponType: WeaponType.Chaingun };
    r.worldState.projectiles.push(
      { pos: v(5, 0, 0), vel: v(-1, 0, 0), config: cg },  // closing on the origin
      { pos: v(5, 0, 0), vel: v(1, 0, 0), config: cg },   // flying away — no threat
      { pos: v(20, 0, 0), vel: v(-1, 0, 0), config: cg }, // closing but out of range
    );
    const out = r.senses.incomingNear(v());
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBe(5);
  });
});

describe('enemyList', (): void => {
  it('hostile local player + hostile remotes enter; same-team and self stay out', (): void => {
    const r = mkRig();
    r.teamOf.set('local', 'alpha');
    r.teamOf.set('p1', 'alpha');  // hostile remote
    r.teamOf.set('p2', 'bravo');  // the bot's teammate
    const me = mkBot('me', 'bravo');
    r.worldState.remotePlayers.set('me', { pos: v(), vel: v(), isDead: false, isCloakHidden: false, ghostT: 0 });
    r.worldState.remotePlayers.set('p1', { pos: v(5, 0, 0), vel: v(), isDead: false, isCloakHidden: false, ghostT: 0 });
    r.worldState.remotePlayers.set('p2', { pos: v(5, 0, 0), vel: v(), isDead: false, isCloakHidden: false, ghostT: 0 });
    const out = r.senses.enemyList(me);
    const ids = out.map((e): string => e.id);
    expect(ids).toContain('local');
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
    expect(ids).not.toContain('me');
  });

  it('all live scored creatures enter the list; dead and scoreless stay out', (): void => {
    const r = mkRig();
    const me = mkBot('me', 'bravo');
    r.targets.push(
      { id: 'c9', pos: v(60, 0, 0), vel: v(), dead: false } as unknown as Targetable,
      { id: 'c10', pos: v(90, 0, 0), vel: v(), dead: false } as unknown as Targetable,
      { id: 'dead1', pos: v(5, 0, 0), vel: v(), dead: true } as unknown as Targetable,
      { id: 'decor', pos: v(7, 0, 0), vel: v(), dead: false, scoreless: true } as unknown as Targetable,
    );
    const out = r.senses.enemyList(me);
    const ids = out.map((e): string => e.id);
    expect(ids).toContain('creature:c9');
    expect(ids).toContain('creature:c10'); // the whole roster, not just nearest
    expect(ids).not.toContain('creature:dead1');
    expect(ids).not.toContain('creature:decor');
  });
});
