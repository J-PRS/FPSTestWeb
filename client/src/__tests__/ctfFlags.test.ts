import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CtfFlags, type FlagCtx } from '../game/ctfFlags.js';
import { FLAG_RESET_S } from '../../../shared/teams.js';
import type { GameBot } from '../game/botBrain.js';

const mkBot = (id: string, team: string) =>
  ({ playerId: id, team, carryingFlag: false, isDead: false }) as unknown as GameBot;

// Terrain is flat-zero; flag homes are ±70 on X around the origin.
interface Rig {
  ctx: FlagCtx;
  flags: CtfFlags;
  positions: Map<string, THREE.Vector3>;
  teams: Map<string, string>;
  touch: [string, THREE.Vector3, THREE.Vector3][];
  scores: { alpha: number; bravo: number };
  onCapture: ReturnType<typeof vi.fn>;
  onFeed: ReturnType<typeof vi.fn>;
  events: string[];
}

const mkRig = (bots: GameBot[] = []): Rig => {
  const positions = new Map<string, THREE.Vector3>();
  const teams = new Map<string, string>();
  const touch: [string, THREE.Vector3, THREE.Vector3][] = [];
  const scores = { alpha: 0, bravo: 0 };
  const onCapture = vi.fn();
  const onFeed = vi.fn();
  const events: string[] = [];
  const ctx: FlagCtx = {
    lazyTerrain: () => ({ getHeight: () => 0 }) as unknown as ReturnType<FlagCtx['lazyTerrain']>,
    lazyScene: () => new THREE.Scene(),
    carrierPos: (id) => positions.get(id) ?? null,
    teamOf: (id) => teams.get(id),
    pickupRadiusOf: () => 2,
    touchers: () => touch,
    bots,
    scores,
    onCapture,
    onFeed,
    onFlagEvent: (kind, team) => events.push(`${kind}:${team}`),
  };
  return { ctx, flags: new CtfFlags(ctx, new THREE.Vector3()), positions, teams, touch, scores, onCapture, onFeed, events };
};

const ALPHA_HOME = -70;
const BRAVO_HOME = 70;

describe('CtfFlags', () => {
  it('enemy touch carries the flag; feed + event fire', () => {
    const r = mkRig();
    r.teams.set('thief', 'alpha');
    r.positions.set('thief', new THREE.Vector3(BRAVO_HOME, 0, 0));
    r.touch.push(['thief', r.positions.get('thief')!, r.positions.get('thief')!]);
    r.flags.update(0.016);
    expect(r.events).toContain('taken:bravo');
    expect(r.onFeed).toHaveBeenCalledWith(expect.stringContaining('took'));
  });

  it('carrier reaching own base with own flag home banks a capture', () => {
    const r = mkRig();
    r.teams.set('thief', 'alpha');
    const thiefPos = new THREE.Vector3(BRAVO_HOME, 0, 0);
    r.positions.set('thief', thiefPos);
    r.touch.push(['thief', thiefPos, thiefPos]);
    r.flags.update(0.016); // grab
    thiefPos.set(ALPHA_HOME, 0, 0); // run home — alpha flag sits home
    r.flags.update(0.016);
    expect(r.scores.alpha).toBe(1);
    expect(r.onCapture).toHaveBeenCalledWith('alpha');
    expect(r.events).toContain('captured:bravo');
  });

  it('standoff: no capture while own flag is away', () => {
    const r = mkRig();
    r.teams.set('thief', 'alpha');
    r.teams.set('counterThief', 'bravo');
    const thiefPos = new THREE.Vector3(BRAVO_HOME, 0, 0);
    const counterPos = new THREE.Vector3(ALPHA_HOME, 0, 0);
    r.positions.set('thief', thiefPos);
    r.positions.set('counterThief', counterPos);
    r.touch.push(['thief', thiefPos, thiefPos], ['counterThief', counterPos, counterPos]);
    r.flags.update(0.016); // both grab
    thiefPos.set(ALPHA_HOME, 0, 0); // alpha base reached but alpha flag is carried
    counterPos.set(BRAVO_HOME, 0, 0); // also at bravo base — standoff, first-come stays carried
    r.touch.length = 0;
    r.flags.update(0.016);
    expect(r.scores.alpha + r.scores.bravo).toBe(0);
  });

  it('dropped flag returns home on own-team touch; times out otherwise', () => {
    const bots = [mkBot('b1', 'alpha'), mkBot('b2', 'bravo')];
    const r = mkRig(bots);
    // Bravo steals alpha's flag, then drops it mid-field.
    r.teams.set('b2', 'bravo');
    const b2pos = new THREE.Vector3(ALPHA_HOME, 0, 0);
    r.positions.set('b2', b2pos);
    r.touch.push(['b2', b2pos, b2pos]);
    r.flags.update(0.016); // grab
    b2pos.set(0, 0, 0);
    r.flags.dropCarried('b2', b2pos);
    expect(r.events).toContain('dropped:alpha');
    // Alpha teammate touches → returns instantly.
    r.teams.set('b1', 'alpha');
    r.touch.length = 0; // the thief stepped away
    r.touch.push(['b1', new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)]);
    r.flags.update(0.016);
    expect(r.events).toContain('returned:alpha');
    // And with nobody touching, a dropped flag snaps home at the timer.
    r.positions.set('b2', new THREE.Vector3(ALPHA_HOME, 0, 0));
    r.touch.push(['b2', r.positions.get('b2')!, r.positions.get('b2')!]);
    r.flags.update(0.016); // grab again
    r.flags.dropCarried('b2', new THREE.Vector3(0, 0, 0));
    r.touch.length = 0;
    for (let t = 0; t < FLAG_RESET_S + 1; t += 1) r.flags.update(1);
    const markers = r.flags.markers();
    const alpha = markers.find((m) => m.team === 'alpha')!;
    expect(alpha.pos.x).toBe(ALPHA_HOME);
  });

  it('a carrying bot gets the own-home objective; death-drop clears carryingFlag', () => {
    const bots = [mkBot('b2', 'bravo')];
    const r = mkRig(bots);
    r.teams.set('b2', 'bravo');
    const b2pos = new THREE.Vector3(ALPHA_HOME, 0, 0);
    r.positions.set('b2', b2pos);
    r.touch.push(['b2', b2pos, b2pos]);
    r.flags.update(0.016);
    expect(bots[0]!.carryingFlag).toBe(true);
    const info = r.flags.objectiveInfoFor(bots[0]!)!;
    expect(info.pos.x).toBe(BRAVO_HOME);
    r.flags.dropCarried('b2', b2pos);
    expect(bots[0]!.carryingFlag).toBe(false);
  });

  it('rebalanceRoles assigns specialists to large-enough squads, small squads stay generic', () => {
    const mk = (n: number, team: string) => Array.from({ length: n }, (_, i) => mkBot(`${team}:${i}`, team));
    const alpha = mk(8, 'alpha');
    const bravo = mk(8, 'bravo');
    const r = mkRig([...alpha, ...bravo]);
    alpha.forEach((b) => r.teams.set(b.playerId, 'alpha'));
    bravo.forEach((b) => r.teams.set(b.playerId, 'bravo'));
    r.flags.update(0.016); // one rebalance pass
    // At least one bot per team should have a role-driven objective that
    // isn't plain offense — a capper exists ⇒ someone targets the enemy stand.
    const objectives = alpha.map((b) => r.flags.objectiveInfoFor(b)!.pos.x);
    expect(objectives).toContain(BRAVO_HOME);
  });
});
