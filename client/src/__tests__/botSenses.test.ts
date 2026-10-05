import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BotSenses, type SenseHost } from '../game/botSenses.js';
import type { GameBot } from '../game/botBrain.js';
import type { Targetable } from '../entities/balls.js';

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const mkBot = (id: string, team: string, over: Record<string, unknown> = {}) =>
  ({ playerId: id, team, isDead: false, isCloakHidden: false, ghostT: 0, pos: v(), vel: v(), position: v(), ...over }) as unknown as GameBot;

interface Rig {
  senses: BotSenses;
  bots: GameBot[];
  teamOf: Map<string, string>;
  worldState: { remotePlayers: Map<string, { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloakHidden: boolean; ghostT: number }>;
                explosions: { pos: THREE.Vector3; age: number }[];
                projectiles: { pos: THREE.Vector3; vel: THREE.Vector3 }[] };
  playerState: { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloaked: boolean; lastFireAt: number };
  state: { modeId: string; creature: Targetable | null; creatureDist: number };
}

const mkRig = (): Rig => {
  const bots: GameBot[] = [];
  const teamOf = new Map<string, string>();
  const worldState = { remotePlayers: new Map<string, { pos: THREE.Vector3; vel: THREE.Vector3; isDead: boolean; isCloakHidden: boolean; ghostT: number }>(), explosions: [] as { pos: THREE.Vector3; age: number }[], projectiles: [] as { pos: THREE.Vector3; vel: THREE.Vector3 }[] };
  const playerState = { pos: v(), vel: v(), isDead: false, isCloaked: false, lastFireAt: -Infinity };
  const state = { modeId: 'ctf', creature: null as Targetable | null, creatureDist: 0 };
  const host = {
    bots, teamOf,
    player: () => playerState,
    world: () => worldState,
    mode: () => state.modeId,
    nearestCreature: (_p: THREE.Vector3, maxDist: number) => { state.creatureDist = maxDist; return state.creature; },
  };
  return { senses: new BotSenses(host as SenseHost), bots, teamOf, worldState, playerState, state };
};

describe('enemyBotsForTeam', () => {
  it('includes the local player only when hostile, and marks cloaked/dead as not alive', () => {
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
    expect(sameTeam.some((e) => e.playerId === 'local')).toBe(false);
  });
});

describe('recentNoises', () => {
  it('earshot is 50m and age gate is 1.5s', () => {
    const r = mkRig();
    r.worldState.explosions.push(
      { pos: v(10, 0, 0), age: 1 },
      { pos: v(60, 0, 0), age: 1 },  // out of earshot
      { pos: v(10, 0, 0), age: 2 },  // too old
    );
    const out = r.senses.recentNoises(v());
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBe(10);
  });
});

describe('incomingNear', () => {
  it('a round inside 12m only counts while closing', () => {
    const r = mkRig();
    r.worldState.projectiles.push(
      { pos: v(5, 0, 0), vel: v(-1, 0, 0) },  // closing on the origin
      { pos: v(5, 0, 0), vel: v(1, 0, 0) },   // flying away — no threat
      { pos: v(20, 0, 0), vel: v(-1, 0, 0) }, // closing but out of range
    );
    const out = r.senses.incomingNear(v());
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBe(5);
  });
});

describe('enemyList', () => {
  it('hostile local player + hostile remotes enter; same-team and self stay out', () => {
    const r = mkRig();
    r.teamOf.set('local', 'alpha');
    r.teamOf.set('p1', 'alpha');  // hostile remote
    r.teamOf.set('p2', 'bravo');  // the bot's teammate
    const me = mkBot('me', 'bravo');
    r.worldState.remotePlayers.set('me', { pos: v(), vel: v(), isDead: false, isCloakHidden: false, ghostT: 0 });
    r.worldState.remotePlayers.set('p1', { pos: v(5, 0, 0), vel: v(), isDead: false, isCloakHidden: false, ghostT: 0 });
    r.worldState.remotePlayers.set('p2', { pos: v(5, 0, 0), vel: v(), isDead: false, isCloakHidden: false, ghostT: 0 });
    const out = r.senses.enemyList(me);
    const ids = out.map((e) => e.id);
    expect(ids).toContain('local');
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
    expect(ids).not.toContain('me');
  });

  it('creatures enter with the creature: prefix; nuggets mode senses farther', () => {
    const r = mkRig();
    const me = mkBot('me', 'bravo');
    const creature = { id: 'c9', pos: v(60, 0, 0), vel: v(), dead: false } as unknown as Targetable;
    r.state.creature = creature;
    r.state.modeId = 'nuggets';
    const out = r.senses.enemyList(me);
    expect(r.state.creatureDist).toBe(80);
    expect(out.some((e) => e.id === 'creature:c9')).toBe(true);
    r.state.modeId = 'ctf';
    r.senses.enemyList(me);
    expect(r.state.creatureDist).toBe(35);
  });
});
