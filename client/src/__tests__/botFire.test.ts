// Bot fire integrity — "bots are legal players" means their trigger
// pull must spawn REAL projectiles in the same pipeline as the player's
// shells. These tests prove the actual gun leaves the barrel: pellet
// counts, muzzle speed, gravity, shooter attribution, and that the
// instant-claim fallback only runs where a real shell can't be honest
// (melee, beam weapons, connected rooms).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { BotFire, type FireHost } from '../game/botFire.js';
import { Projectile } from '../projectiles/Projectile.js';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.js';
import { WeaponType, getWeaponStats } from '../../../shared/weapons.js';
import { perkMods } from '../../../shared/perks.js';
import { SLOT_DEFS } from '../weapons.js';
import { GameBot } from '../game/botBrain.js';

const scene = new THREE.Scene();

function fakeBot(loadoutIdx = 0, pos = new THREE.Vector3()): GameBot {
  const mods = perkMods(BOT_LOADOUTS[loadoutIdx]!.perk);
  return {
    playerId: `bot:T${loadoutIdx}`,
    position: pos.clone(),
    vel: new THREE.Vector3(),
    loadout: BOT_LOADOUTS[loadoutIdx]!,
    perkMods: mods,
    propelUntil: 0,
    propelJetT: 0,
    grounded: false,
    wantBelt: false,
    huntTargetId: null,
    lastDest: new THREE.Vector3(),
  } as unknown as GameBot;
}

interface Ctx {
  host: FireHost;
  fire: BotFire;
  projectiles: Projectile[];
  hurtLocal: { dmg: number; src: string }[];
  kills: { killer: string; weapon?: number }[];
  creatures: { id: number; dmg: number; attacker: string }[];
  remotePlayers: Map<string, unknown>;
}

function ctx(online = false): Ctx {
  const projectiles: Projectile[] = [];
  const remotePlayers = new Map<string, unknown>();
  const c: Ctx = {
    projectiles,
    hurtLocal: [],
    kills: [],
    creatures: [],
    remotePlayers,
    host: undefined as unknown as FireHost,
    fire: undefined as unknown as BotFire,
  };
  c.host = {
    scene: () => scene,
    player: () => ({ pos: new THREE.Vector3(1e6, 0, 1e6), isDead: false, appliedClass: 'medium' as const }),
    world: () => ({ projectiles, remotePlayers: remotePlayers as Map<string, never> }),
    targets: [],
    online: () => online,
    logger: { debug: () => {} },
    damageCreature: (id, dmg, attackerId) => { c.creatures.push({ id, dmg, attacker: attackerId }); return false; },
    creditKill: () => {},
    botKilled: (killerId, _b, weapon) => { c.kills.push({ killer: killerId, weapon }); },
    hurtLocal: (dmg, _fp, src) => { c.hurtLocal.push({ dmg, src }); },
  };
  c.fire = new BotFire(c.host);
  return c;
}

const aimAt = (dx: number, dy = 0, dz = 0) => new THREE.Vector3(dx, dy, dz);

describe('bot real-weapon fire', () => {
  it('every loadout fires a real Projectile at mid range', () => {
    for (let i = 0; i < BOT_LOADOUTS.length; i++) {
      const c = ctx();
      c.fire.resolveShot(fakeBot(i), 'e1', aimAt(30, 1.6, 0));
      const spawned = c.projectiles;
      expect(spawned.length, `loadout ${i} spawned a shell`).toBeGreaterThanOrEqual(1);
      for (const p of spawned) {
        expect(p).toBeInstanceOf(Projectile);
        expect(p.shooterId).toBe(`bot:T${i}`);
        expect(p.vel.length()).toBeGreaterThan(1); // real muzzle velocity
      }
    }
  });

  it('shell speed and gravity match the weapon table — no invented ballistics', () => {
    // Force a known weapon: loadout primary at close-mid band.
    const c = ctx();
    const bot = fakeBot(0);
    c.fire.resolveShot(bot, 'e1', aimAt(25, 1.6, 0));
    const p = c.projectiles[0]!;
    // Projectile ctor: vel = dir * config.speed + 0.5 * playerVel (playerVel=0)
    const stats = getWeaponStats(p.config.weaponType);
    expect(p.vel.length()).toBeCloseTo(stats.speed, 0);
    expect(p.config.gravity).toBe(stats.gravity);
  });

  it('shotgun/flak weapons spawn the full pellet fan', () => {
    // Locate a (loadout, band-range) pair whose pick carries pellets,
    // then fire inside that band and count the fan.
    let fired = false;
    for (let i = 0; i < BOT_LOADOUTS.length && !fired; i++) {
      const lo = BOT_LOADOUTS[i]!;
      for (const [wt, range] of [[lo.near, 12], [lo.mid, 25], [lo.far, 80]] as const) {
        const pellets = SLOT_DEFS.find(w => w.weaponType === wt)?.pellets;
        if (!pellets || pellets.count <= 1) continue;
        const c = ctx();
        c.fire.resolveShot(fakeBot(i), 'e1', aimAt(range, 1.6, 0));
        expect(c.projectiles.length).toBe(pellets.count);
        for (const p of c.projectiles) expect(p.shooterId).toBe(`bot:T${i}`);
        fired = true;
        break;
      }
    }
    expect(fired, 'a pellet loadout exists and fanned').toBe(true);
  });

  it('melee range never spawns a shell — it resolves as a legal melee swing', () => {
    const c = ctx();
    c.fire.resolveShot(fakeBot(0), 'e1', aimAt(1.0, 0, 0));
    expect(c.projectiles.length).toBe(0);
  });

  it('connected rooms never spawn local shells — the claim path owns attribution', () => {
    const c = ctx(true); // online
    c.fire.resolveShot(fakeBot(0), 'e1', aimAt(30, 1.6, 0));
    expect(c.projectiles.length).toBe(0);
  });

  it('kill claims carry the real weapon id through to the kill feed', () => {
    const c = ctx();
    // claimShot gates on `instanceof GameBot` — borrow its prototype.
    const victim = Object.setPrototypeOf({
      pos: new THREE.Vector3(1.0, 0, 0),
      isDead: false,
      takeDamageLocal: () => true,
    }, GameBot.prototype) as GameBot;
    c.remotePlayers.set('victim', victim);
    c.fire.resolveShot(fakeBot(0), 'victim', aimAt(1.0, 0, 0));
    expect(c.kills.length).toBe(1);
    expect(c.kills[0]!.weapon).toBe(WeaponType.Melee);
  });

  it('belt throws spawn a real lobbed grenade projectile', () => {
    const c = ctx();
    const bot = fakeBot(0);
    bot.wantBelt = true;
    (bot as unknown as { huntTargetId: string }).huntTargetId = 'e1';
    c.remotePlayers.set('e1', {
      pos: new THREE.Vector3(40, 0, 0), isDead: false,
    });
    c.fire.throwBelt(bot);
    expect(bot.wantBelt).toBe(false);
    const p = c.projectiles[0];
    expect(p).toBeInstanceOf(Projectile);
    expect(getWeaponStats(bot.loadout!.belt).speed).toBeGreaterThan(0);
    expect(p!.vel.y).toBeGreaterThan(0); // ballistic arc — pitched up
  });
});
