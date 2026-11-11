/* oxlint-disable typescript/no-explicit-any -- test stubs are deliberately loosely typed */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createBlastForce, type BlastArgs } from '../game/blastForce.js';
import { Projectile } from '../projectiles/Projectile.js';
import { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { CombatDeps } from '../game/combat.js';
import type { Targetable } from '../entities/balls.js';

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
    world: { remotePlayers: remotes, selfBlastStamps: stamps, recentKb: [] },
    explosionTracker: new ExplosionTracker(),
    lazyPlayer: () => player,
    lazyHud: () => hud,
    lazyHealthBarSystem: () => hbs,
    lazyDamageNumbers: () => dmgNumbers,
    lazyCamera: (): null => null,
    lazyNetworkManager: () => net,
    lazyDemoManager: (): null => null,
  } as unknown as CombatDeps;

  return {
    deps, blast: createBlastForce(deps, hooks), player, hud, hbs, dmgNumbers, net,
    remotes, balls, nuggets, stamps, hooks,
  };
};

const args = (over: Partial<BlastArgs> = {}): BlastArgs => ((((Object.assign({}, {pos: new THREE.Vector3(0, 0, 0),radius: 10,force: 20,forceMode: 'push',forceMultiplier: 1,aoeDamage: 40,directHitTargetId: null}, over)))));

describe('applyExplosionForce - local player', (): void => {
  it('own blast shoves the player and stamps the prediction', (): void => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0);
    r.blast.applyExplosionForce(args());
    expect(r.player.knock).toHaveBeenCalled();
    expect(r.stamps).toHaveLength(1);
    expect(r.stamps[0]).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('self splash is scaled down hard; enemy blast is full falloff damage', (): void => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0); // dist 5 of radius 10 → falloff dmg = 40 * 0.5 = 20
    r.blast.applyExplosionForce(args());
    // Own blast: the server charges the self-splash authoritatively — the
    // client only flashes the prediction, it never claims env damage.
    expect(r.net.sendEnvironmentDamage).not.toHaveBeenCalled();

    const r2 = mkRig();
    r2.player.pos.set(5, 0, 0);
    r2.blast.applyExplosionForce(args({ shooterId: 'bot:7' }));
    expect(r2.net.sendEnvironmentDamage).toHaveBeenCalledWith(20, 'bot:7');
    expect(r2.player.lastDamageSource).toContain('blast');
  });

  it('shielded self splash burns energy instead of health', (): void => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0);
    r.player.isShielded = true;
    r.blast.applyExplosionForce(args());
    expect(r.player.absorbShieldDamage).toHaveBeenCalled();
    expect(r.net.sendEnvironmentDamage).not.toHaveBeenCalled();
  });

  it('own direct hit on self flashes the direct amount; server pays the damage', (): void => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0);
    // My own shell tags 'local' — the shot claim can't resolve, so the
    // blast shows the direct amount (no splash flash on top). The actual
    // health cost is server-side selfDmg, not an env claim.
    r.blast.applyExplosionForce(args({ directHitTargetId: 'local' }));
    expect(r.player.knock).toHaveBeenCalled();
    expect(r.net.sendEnvironmentDamage).not.toHaveBeenCalled();
  });

  it('enemy shell direct-hit on me is server-paid — no self claim', (): void => {
    const r = mkRig();
    r.player.pos.set(5, 0, 0);
    r.blast.applyExplosionForce(args({ shooterId: 'bot:7', directHitTargetId: 'local' }));
    expect(r.player.knock).toHaveBeenCalled();
    expect(r.net.sendEnvironmentDamage).not.toHaveBeenCalled();
  });

  it('outside knockback reach → no shove, no stamp, no damage', (): void => {
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

describe('applyForceToRemotes', (): void => {

  it('remote inside radius gets health-bar damage, no predicted knockback', (): void => {
    const r = mkRig();
    const rp = mkRemote(5);
    r.remotes.set('p1', rp);
    r.blast.applyExplosionForce(args());
    // Remote kb prediction disabled — wire carries the real shove.
    expect(rp.applyPredictedKnockback).not.toHaveBeenCalled();
    expect(r.hbs.predictDamage).toHaveBeenCalledWith('p1', 20); // 40 * 0.5
    expect(r.hud.showHitMarker).toHaveBeenCalled();
  });

  it('a direct-hit target gets no splash preview', (): void => {
    const r = mkRig();
    const rp = mkRemote(5);
    r.remotes.set('p1', rp);
    r.blast.applyExplosionForce(args({ directHitTargetId: 'p1' }));
    expect(rp.applyPredictedKnockback).not.toHaveBeenCalled();
    expect(r.hbs.predictDamage).not.toHaveBeenCalled();
    expect(r.hud.showHitMarker).not.toHaveBeenCalled();
  });

  it('bot-authored blast skips MY hitmarker and routes through botHit', (): void => {
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

  it('friendly splash shows NOTHING - number, predicted dip and flash all suppressed', (): void => {
    const r = mkRig();
    const rp = mkRemote(5);
    r.remotes.set('p1', rp);
    // Same team as the shooter - hitF swallows the hit (zero damage),
    // so every feedback channel must stay silent or it lies.
    (r.deps.world as { localTeam?: string }).localTeam = 'alpha';
    (r.deps as { lazyNetworkManager: () => unknown }).lazyNetworkManager = () => ({
      getPlayers: (): Map<string, { team: string }> => new Map([['p1', { team: 'alpha' }]]),
      authoritySims: (): boolean => false,
    });
    r.blast.applyExplosionForce(args());
    expect(r.dmgNumbers.spawn).not.toHaveBeenCalled();
    expect(r.hbs.predictDamage).not.toHaveBeenCalled();
  });

  it('occluded remote gets no splash feedback - a wall between blast and victim silences all of it', (): void => {
    const r = mkRig();
    const rp = mkRemote(5);
    r.remotes.set('p1', rp);
    // Solid slab between blast origin and the victim - the Stryker
    // survivor that proved this gate untested: deleting occluded() must
    // now fail this case.
    const wall = { cx: 2.5, cy: 2, cz: 0, hx: 0.3, hy: 5, hz: 5, cos: 1, sin: 0 };
    const prev = Projectile.solidColliders;
    Projectile.solidColliders = [wall as never];
    try {
      r.blast.applyExplosionForce(args());
    } finally {
      Projectile.solidColliders = prev;
    }
    expect(r.dmgNumbers.spawn).not.toHaveBeenCalled();
    expect(r.hbs.predictDamage).not.toHaveBeenCalled();
    expect(r.hud.showHitMarker).not.toHaveBeenCalled();
  });

  it('deployables get the blast relay - blastRemotes fires with the envelope', (): void => {
    const r = mkRig();
    const blastRemotes = vi.fn();
    (r.deps as { lazyDeployables?: () => { blastRemotes: typeof blastRemotes } }).lazyDeployables = () => ({ blastRemotes });
    r.blast.applyExplosionForce(args({ pos: new THREE.Vector3(1, 2, 3), aoeDamage: 40, radius: 10 }));
    expect(blastRemotes).toHaveBeenCalled();
    expect(blastRemotes.mock.calls[0]![0]).toMatchObject({ x: 1, y: 2, z: 3 });
  });

  it('remote outside radius → nothing predicted', (): void => {
    const r = mkRig();
    const rp = mkRemote(50);
    r.remotes.set('p1', rp);
    r.blast.applyExplosionForce(args());
    expect(rp.applyPredictedKnockback).not.toHaveBeenCalled();
  });
});

describe('applyExplosionForce — balls and nuggets', (): void => {
  const mkBall = (x: number, hp = 30): Targetable & { health: number; } => {
    let health = hp;
    return {
      pos: new THREE.Vector3(x, 0, 0),
      vel: new THREE.Vector3(),
      dead: false, radius: 1, hitRadius: 1, variant: 0, id: 'ball1', hideHealthBar: false,
      get health(): number { return health; },
      applyKnockback: vi.fn(), applyPull: vi.fn(),
      takeDamage: vi.fn((d: number): boolean => { health -= d; if (health <= 0) { (ball as { dead: boolean }).dead = true; return true; } return false; }),
    } as unknown as Targetable & { health: number };
  };
  // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
  let ball!: Targetable & { health: number };

  it('ball in radius takes falloff damage; lethal hit reports destroyed', (): void => {
    const r = mkRig();
    ball = mkBall(5, 10); // 20 dmg at dist 5 > 10 hp
    r.balls.push(ball);
    r.blast.applyExplosionForce(args());
    // No weaponType on this blast → a deployable-style pop, which still
    // claims (no server sim owns it); weapon blasts pass serverPaid:true.
    expect(ball.takeDamage).toHaveBeenCalledWith(20, { serverPaid: false });
    expect(r.hooks.onTargetDestroyed).toHaveBeenCalled();
  });

  it('ball outside radius untouched; surviving hit spawns health bar', (): void => {
    const r = mkRig();
    const far = mkBall(50);
    const near = mkBall(5, 100); // survives 20
    r.balls.push(far, near);
    r.blast.applyExplosionForce(args());
    expect(far.takeDamage).not.toHaveBeenCalled();
    expect(r.hbs.spawnBall).toHaveBeenCalled();
  });

  it('nuggets scatter at boosted force, dead/collected skip', (): void => {
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

// Remote-blast prediction: the replica is visual-only for damage, but the
// shove must be predicted so its wire knockback dedupes — and the echo
// that raced in BEFORE the replica exploded must consume, not double.
describe('predictLocalShove — remote-blast knockback dedup', (): void => {
  it('shoves + stamps so the server echo is eaten', (): void => {
    const r = mkRig();
    const applied = r.blast.predictLocalShove(new THREE.Vector3(5, 0, 0), 10, 30, 'push', 'bot:ENEMY-1');
    expect(applied).toBe(true);
    expect(r.player.knock).toHaveBeenCalledOnce();
    expect(r.stamps).toHaveLength(1);
    expect(r.stamps[0].x).toBe(5);
  });

  it('a raced raw echo at the same center consumes — no second shove', (): void => {
    const r = mkRig();
    (r.deps.world as { recentKb: { x: number; y: number; z: number; t: number }[] }).recentKb
      .push({ x: 5, y: 0, z: 0, t: performance.now() });
    const applied = r.blast.predictLocalShove(new THREE.Vector3(5, 0, 0), 10, 30, 'push', 'bot:ENEMY-1');
    expect(applied).toBe(true);
    expect(r.player.knock).not.toHaveBeenCalled();
    expect(r.stamps).toHaveLength(0);
    expect((r.deps.world as { recentKb: unknown[] }).recentKb).toHaveLength(0);
  });

  it('outside the envelope: no shove, no stamp, untouched echo survives', (): void => {
    const r = mkRig();
    const w = r.deps.world as { recentKb: { x: number; y: number; z: number; t: number }[] };
    w.recentKb.push({ x: 60, y: 0, z: 0, t: performance.now() });
    const applied = r.blast.predictLocalShove(new THREE.Vector3(60, 0, 0), 10, 30, 'push', 'bot:ENEMY-1');
    expect(applied).toBe(false);
    expect(r.player.knock).not.toHaveBeenCalled();
    expect(r.stamps).toHaveLength(0);
    expect(w.recentKb).toHaveLength(1); // a different blast's echo — keep it
  });

  it('a refused verdict reverses the recorded impulse off the body', (): void => {
    const r = mkRig();
    // The reversal writes player.vel directly — give the stub a real
    // vector and a knockback that moves it, so iv records a true delta.
    const vel = new THREE.Vector3();
    (r.player as { vel?: THREE.Vector3 }).vel = vel;
    (r.player as { appliedClass?: string }).appliedClass = 'scout';
    const appliedF: number[] = [];
    (r.player as { applyKnockback?: unknown }).applyKnockback =
      (pos: THREE.Vector3, f: number): void => {
        appliedF.push(f);
        vel.addScaledVector(new THREE.Vector3().subVectors(r.player.pos, pos).normalize(), f);
      };
    // Connected authority + a REMOTE shooter → the stamp audits (self=false).
    (r.net as { isConnected?: () => boolean }).isConnected = (): boolean => true;
    (r.net as { serverPingMs?: number }).serverPingMs = 40;
    (r.net as { msSinceLiveRx?: () => number }).msSinceLiveRx = (): number => 0;

    r.player.pos.set(1, 0, 0); // off-center so the push dir is nonzero
    r.blast.predictLocalShove(new THREE.Vector3(0, 0, 0), 10, 30, 'push', 'enemy-1');
    expect(r.stamps).toHaveLength(1);
    const afterFirst = vel.x;
    expect(afterFirst).toBeGreaterThan(0); // pushed +x off the blast

    // No echo lands → the stamp's deadline passes; the NEXT shove's settle
    // sweep is what expires it. A distant second blast applies + reverses.
    r.stamps[0]!.t -= 20_000;
    r.player.pos.set(50.5, 0, 0);
    r.blast.predictLocalShove(new THREE.Vector3(50, 0, 0), 10, 30, 'push', 'enemy-1');
    // vel now carries only the second blast's impulse: the first was
    // undone, not left poisoning the body.
    expect(appliedF).toHaveLength(2);
    expect(vel.x).toBeCloseTo(appliedF[1]!, 5);
    expect(r.stamps).toHaveLength(1); // only the second stamp remains
  });

  it('a dead body never predicts a shove', (): void => {
    const r = mkRig();
    r.player.isDead = true;
    const applied = r.blast.predictLocalShove(new THREE.Vector3(0, 0, 0), 10, 30, 'push', 'enemy-1');
    expect(applied).toBe(false);
    expect(r.player.knock).not.toHaveBeenCalled();
    expect(r.stamps).toHaveLength(0);
  });
});
