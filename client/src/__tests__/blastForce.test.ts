import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createBlastForce, type BlastArgs } from '../game/blastForce.js';
import type { CombatDeps } from '../game/combat.js';
import type { Targetable } from '../entities/balls.js';
const SELF_AOE_SCALE = 0.15; // mirrors blastForce.ts — rocket jumps are nominal, not lethal

interface Rig {
  deps: CombatDeps;
  blast: ReturnType<typeof createBlastForce>;
  player: { pos: THREE.Vector3; isDead: boolean; isShielded: boolean; mods: { knockbackTaken: number; selfDamage: number }; knock: ReturnType<typeof vi.fn>; pull: ReturnType<typeof vi.fn>; absorbShieldDamage: ReturnType<typeof vi.fn>; lastDamageSource: string };
  hud: { showHitMarker: ReturnType<typeof vi.fn>; showDamage: ReturnType<typeof vi.fn>; showShieldDamage: ReturnType<typeof vi.fn> };
  hbs: { predictDamage: ReturnType<typeof vi.fn>; spawnBall: ReturnType<typeof vi.fn> };
  dmgNumbers: { spawn: ReturnType<typeof vi.fn> };
  net: { sendEnvironmentDamage: ReturnType<typeof vi.fn> };
  remotes: Map<string, any>;
  balls: Targetable[];
  nuggets: any[];
  stamps: { x: number; y: number; z: number; t: number }[];
  hooks: { onTargetDestroyed: ReturnType<typeof vi.fn> };
}

const mkRig = (): Rig => {
  const player = {
    pos: new THREE.Vector3(0, 0, 0),
    isDead: false,
    isShielded: false,
    mods: { knockbackTaken: 1, selfDamage: 1 },
    knock: vi.fn(),
    pull: vi.fn(),
    absorbShieldDamage: vi.fn(),
    lastDamageSource: '',
  };
  Object.assign(player, { applyKnockback: player.knock, applyPull: player.pull });

  const hud = { showHitMarker: vi.fn(), showDamage: vi.fn(), showShieldDamage: vi.fn() };
  const hbs = { predictDamage: vi.fn(), spawnBall: vi.fn() };
  const dmgNumbers = { spawn: vi.fn() };
  const net = { sendEnvironmentDamage: vi.fn() };
  const remotes = new Map<string, any>();
  const balls: Targetable[] = [];
  const nuggets: any[] = [];
  const stamps: { x: number; y: number; z: number; t: number }[] = [];
  const hooks = { onTargetDestroyed: vi.fn() };

  const deps = {
    targets: balls,
    nuggets,
    world: { remotePlayers: remotes, selfBlastStamps: stamps },
    lazyPlayer: () => player,
    lazyHud: () => hud,
    lazyHealthBarSystem: () => hbs,
    lazyDamageNumbers: () => dmgNumbers,
    lazyCamera: () => null,
    lazyNetworkManager: () => net,
    lazyDemoManager: () => null,
  } as unknown as CombatDeps;

  return {
    deps, blast: createBlastForce(deps, hooks), player, hud, hbs, dmgNumbers, net,
    remotes, balls, nuggets, stamps, hooks,
  };
};

const args = (over: Partial<BlastArgs> = {}): BlastArgs => ({
  pos: new THREE.Vector3(0, 0, 0),
  radius: 10,
  force: 20,
  forceMode: 'push',
  falloffMultiplier: 1,
  collisionMultiplier: 1,
  forceMultiplier: 1,
  aoeDamage: 40,
  directHitTargetId: null,
  ...over,
});

describe('applyExplosionForce — local player', () => {
  it('own blast shoves the player and stamps the prediction', () => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0);
    r.blast.applyExplosionForce(args());
    expect(r.player.knock).toHaveBeenCalled();
    expect(r.stamps).toHaveLength(1);
    expect(r.stamps[0]).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('self splash is scaled down hard; enemy blast is full falloff damage', () => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0); // dist 5 of radius 10 → falloff dmg = 40 * 0.5 = 20
    r.blast.applyExplosionForce(args());
    // own blast → 20 * selfAoeScale * selfDamage
    expect(r.net.sendEnvironmentDamage).toHaveBeenCalledWith(20 * SELF_AOE_SCALE * 1, undefined);

    const r2 = mkRig();
    r2.player.pos.set(5, 0, 0);
    r2.blast.applyExplosionForce(args({ shooterId: 'bot:7' }));
    expect(r2.net.sendEnvironmentDamage).toHaveBeenCalledWith(20, 'bot:7');
    expect(r2.player.lastDamageSource).toContain('blast');
  });

  it('shielded self splash burns energy instead of health', () => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0);
    r.player.isShielded = true;
    r.blast.applyExplosionForce(args());
    expect(r.player.absorbShieldDamage).toHaveBeenCalled();
    expect(r.net.sendEnvironmentDamage).not.toHaveBeenCalled();
  });

  it('own direct hit on self pays direct*selfDamage once via env claim', () => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0);
    // My own shell tags 'local' — the shot claim can't resolve, so the
    // blast pays the direct amount (no splash on top). Self-damage mod 1.
    r.blast.applyExplosionForce(args({ directHitTargetId: 'local' }));
    expect(r.player.knock).toHaveBeenCalled();
    expect(r.net.sendEnvironmentDamage).toHaveBeenCalledWith(40, undefined);
  });

  it('enemy shell direct-hit on me is server-paid — no self claim', () => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0);
    r.blast.applyExplosionForce(args({ shooterId: 'bot:7', directHitTargetId: 'local' }));
    expect(r.player.knock).toHaveBeenCalled();
    expect(r.net.sendEnvironmentDamage).not.toHaveBeenCalled();
  });

  it('outside knockback reach → no shove, no stamp, no damage', () => {
    const r = mkRig();
    r.player.pos.set(50, 0, 0);
    r.blast.applyExplosionForce(args());
    expect(r.player.knock).not.toHaveBeenCalled();
    expect(r.stamps).toHaveLength(0);
    expect(r.net.sendEnvironmentDamage).not.toHaveBeenCalled();
  });
});

const mkRemote = (x: number) => ({
  position: new THREE.Vector3(x, 0, 0),
  isDead: false,
  applyPredictedKnockback: vi.fn(),
});

describe('applyForceToRemotes', () => {

  it('remote inside radius gets predicted knockback + health-bar damage', () => {
    const r = mkRig();
    const rp = mkRemote(5);
    r.remotes.set('p1', rp);
    r.blast.applyExplosionForce(args());
    expect(rp.applyPredictedKnockback).toHaveBeenCalled();
    expect(r.hbs.predictDamage).toHaveBeenCalledWith('p1', 20); // 40 * 0.5
    expect(r.hud.showHitMarker).toHaveBeenCalled();
  });

  it('a direct-hit target gets knockback but no splash preview', () => {
    const r = mkRig();
    const rp = mkRemote(5);
    r.remotes.set('p1', rp);
    r.blast.applyExplosionForce(args({ directHitTargetId: 'p1' }));
    expect(rp.applyPredictedKnockback).toHaveBeenCalled();
    expect(r.hbs.predictDamage).not.toHaveBeenCalled();
    expect(r.hud.showHitMarker).not.toHaveBeenCalled();
  });

  it('bot-authored blast skips MY hitmarker and routes through botHit', () => {
    const r = mkRig();
    const rp = mkRemote(5);
    r.remotes.set('p1', rp);
    const botHit = vi.fn().mockReturnValue(true);
    (r.deps as { botHit?: typeof botHit }).botHit = botHit;
    r.blast.applyExplosionForce(args({ shooterId: 'bot:9' }));
    expect(botHit).toHaveBeenCalled();
    expect(r.hud.showHitMarker).not.toHaveBeenCalled();
    expect(r.hbs.predictDamage).not.toHaveBeenCalled();
  });

  it('remote outside radius → nothing predicted', () => {
    const r = mkRig();
    const rp = mkRemote(50);
    r.remotes.set('p1', rp);
    r.blast.applyExplosionForce(args());
    expect(rp.applyPredictedKnockback).not.toHaveBeenCalled();
  });
});

describe('applyExplosionForce — balls and nuggets', () => {
  const mkBall = (x: number, hp = 30) => {
    let health = hp;
    return {
      pos: new THREE.Vector3(x, 0, 0),
      vel: new THREE.Vector3(),
      dead: false, radius: 1, hitRadius: 1, variant: 0, id: 'ball1', hideHealthBar: false,
      get health() { return health; },
      applyKnockback: vi.fn(), applyPull: vi.fn(),
      takeDamage: vi.fn((d: number) => { health -= d; if (health <= 0) { (ball as { dead: boolean }).dead = true; return true; } return false; }),
    } as unknown as Targetable & { health: number };
  };
  let ball: Targetable & { health: number };

  it('ball in radius takes falloff damage; lethal hit reports destroyed', () => {
    const r = mkRig();
    ball = mkBall(5, 10); // 20 dmg at dist 5 > 10 hp
    r.balls.push(ball);
    r.blast.applyExplosionForce(args());
    expect(ball.takeDamage).toHaveBeenCalledWith(20);
    expect(r.hooks.onTargetDestroyed).toHaveBeenCalled();
  });

  it('ball outside radius untouched; surviving hit spawns health bar', () => {
    const r = mkRig();
    const far = mkBall(50);
    const near = mkBall(5, 100); // survives 20
    r.balls.push(far, near);
    r.blast.applyExplosionForce(args());
    expect(far.takeDamage).not.toHaveBeenCalled();
    expect(r.hbs.spawnBall).toHaveBeenCalled();
  });

  it('nuggets scatter at boosted force, dead/collected skip', () => {
    const r = mkRig();
    const live = { pos: new THREE.Vector3(5, 0, 0), dead: false, collected: false, applyKnockback: vi.fn(), applyPull: vi.fn() };
    const dead = { pos: new THREE.Vector3(5, 0, 0), dead: true, collected: false, applyKnockback: vi.fn(), applyPull: vi.fn() };
    const taken = { pos: new THREE.Vector3(5, 0, 0), dead: false, collected: true, applyKnockback: vi.fn(), applyPull: vi.fn() };
    r.nuggets.push(live, dead, taken);
    r.blast.applyExplosionForce(args({ force: 10 }));
    // nugget boost: kbForce(10*KNOCKBACK_SCALE) * 1 * 1.3
    expect(live.applyKnockback).toHaveBeenCalled();
    expect(dead.applyKnockback).not.toHaveBeenCalled();
    expect(taken.applyKnockback).not.toHaveBeenCalled();
  });
});
