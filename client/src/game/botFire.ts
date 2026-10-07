/**
 * BotFire — how offline bots actually shoot. The brain returns an aim
 * point; this module turns it into REAL projectiles pushed into the
 * same sweep/blast pipeline the player's shells use (travel time,
 * gravity, splash, misses all honest), plus the belt lob and the
 * disc-jump propel. The claim fallback (melee/beam/connected room)
 * resolves instantly through the damage funnel — no dice-roll tracers.
 */

import * as THREE from 'three';
import { GameBot, BOT_DMG } from './botBrain.js';
import { BOT_LOADOUTS, pickBotWeaponSafe } from '../../../shared/botLoadouts.js';
import { aimSkillFor } from '../../../shared/botSkill.js';
import { getProjectileConfig } from '../projectiles/index.js';
import { Projectile } from '../projectiles/Projectile.js';
import { SLOT_DEFS } from '../weapons.js';
import { WeaponType, getWeaponStats, WEAPON_FIRE_INTERVAL_S } from '../../../shared/weapons.js';
import { GRAVITY } from '../../../shared/movement.js';
import { MELEE_RANGE, MELEE_DAMAGE } from '../core/config.js';
import * as sfx from '../core/sfx.js';
import { claimShot, tickBolts, disposeBolts } from './botBolts.js';
import { poissonDisc } from '../utils/poissonSpread.js';
import type { RemotePlayer } from '../entities/RemotePlayer.js';
import type { Targetable } from '../entities/balls.js';
import type { ArmorClass } from '../../../shared/botClasses.js';

const _shotDir = new THREE.Vector3();
const _shotMuzzle = new THREE.Vector3();
const _pelletRight = new THREE.Vector3();
const _pelletUp = new THREE.Vector3();
const _pelletUp0 = new THREE.Vector3(0, 1, 0);

export interface FireHost {
  scene(): THREE.Scene;
  player(): { pos: THREE.Vector3; isDead: boolean; appliedClass: ArmorClass };
  world(): { projectiles: Projectile[]; remotePlayers: Map<string, RemotePlayer> };
  targets: Targetable[];
  /** Connected room → real spawns would misattribute to the local
   *  player; everything routes through the claim path instead. */
  online(): boolean;
  logger: { debug(msg: string): void };
  damageCreature(id: number, dmg: number, attackerId: string): boolean;
  creditKill(id: string, isCreature: boolean): void;
  botKilled(killerId: string, bot: GameBot, weapon?: number): void;
  hurtLocal(dmg: number, fromPos: THREE.Vector3, src: string, melee: boolean, attackerId: string): void;
}


export class BotFire {
  // Bolt tracers share a pool — a fresh BufferGeometry per shot meant a
  // GL buffer upload + dispose for a 120ms visual.
  bolts: { line: THREE.Line; t: number }[] = [];
  boltPool: THREE.Line[] = [];
  private lastShotAt = new Map<string, number>();

  /** Jersey swap — cadence receipts follow the body like the other
   *  id-keyed meters (see Bots.rekeyBot). */
  rekey(oldId: string, newId: string): void {
    const v = this.lastShotAt.get(oldId);
    this.lastShotAt.delete(oldId);
    if (v !== undefined) this.lastShotAt.set(newId, v);
  }

  constructor(public host: FireHost) {}

  /** Resolve a bot's shot. Range-band pick comes from the shared loadout
   *  roster; the trigger pull then spawns a REAL projectile — same sweep
   *  + blast pipeline as the player's own shells, so travel time,
   *  gravity, splash, and misses are all honest. Only offline: in a
   *  connected room a shell landing on a WIRE remote would misattribute
   *  the claim to the local player — server bots own that case anyway. */
  resolveShot(bot: GameBot, targetId: string, aim: THREE.Vector3): void {
    const lo = bot.loadout ?? BOT_LOADOUTS[0]!;
    const dx = aim.x - bot.position.x, dy = aim.y - bot.position.y, dz = aim.z - bot.position.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const wt = pickBotWeaponSafe(lo, Math.hypot(dx, dz), dist, bot.botHp,
      bot.skill ? (t) => aimSkillFor(bot.skill, t, 0) : undefined, bot.skill?.courage);
    const melee = wt === WeaponType.Melee || dist <= MELEE_RANGE;
    if (!this.canFire(bot.playerId, melee ? WeaponType.Melee : (wt as WeaponType))) {return;}
    const cfg = melee ? undefined : getProjectileConfig(wt);

    // The claim path exists ONLY for wire-remote targets: a locally
    // spawned shell landing on a remote player would misattribute to
    // the local player (server bots own that case). In P2P-host mode
    // every other target — bots, creatures, 'local' — is a local entity
    // the host is authoritative for, so they get REAL shells there too.
    const wireRemote = this.host.online()
      && targetId !== 'local'
      && !(this.host.world().remotePlayers.get(targetId) instanceof GameBot);
    if (melee || !cfg || cfg.speed <= 0 || wireRemote) {
      this.claimShot(bot, targetId, aim, melee, melee ? MELEE_DAMAGE : BOT_DMG, wt);
      return;
    }
    this.spawnShells(bot, wt, cfg, dx / dist, dy / dist, dz / dist);
  }

  /** The brain's volley cadence is weapon-blind — a 0.45s burst pick of
   *  Mortar would out-cadence a player holding the same gun (2.0s).
   *  Same gate the server's botArsenal applies to its bots. */
  private canFire(botId: string, wt: WeaponType): boolean {
    const interval = WEAPON_FIRE_INTERVAL_S[wt] ?? 0.1;
    const last = this.lastShotAt.get(botId) ?? -interval * 1000;
    const now = performance.now();
    if (now - last < interval * 1000) {return false;}
    this.lastShotAt.set(botId, now);
    return true;
  }

  /** Real shells into the world projectile list — pellet weapons fan
   *  out per their def, everything else lobs a single round. */
  private spawnShells(bot: GameBot, wt: number, cfg: NonNullable<ReturnType<typeof getProjectileConfig>>, nx: number, ny: number, nz: number): void {
    const dir = _shotDir.set(nx, ny, nz);
    const muzzle = _shotMuzzle.set(bot.position.x, bot.position.y + 1.4, bot.position.z);
    const pellets = SLOT_DEFS.find(w => w.weaponType === wt)?.pellets;
    for (const d of pelletDirs(dir, pellets?.count ?? 1, pellets?.spread ?? 0)) {
      // Perk mods the server folds in: bombardier widens the boom,
      // sharpshooter tightens it (damage scaling lands at claim time).
      const radius = cfg.aoeRadius * bot.perkMods.aoeRadius;
      const dmg = cfg.aoeDamage * bot.perkMods.directDamage;
      const p = new Projectile(this.host.scene(), muzzle, d, bot.vel,
        { ...cfg, aoeRadius: radius, aoeDamage: dmg, needsServerTracking: false });
      p.shooterId = bot.playerId;
      // 'local' isn't in remotePlayerPositions — this lets a bot shell
      // actually CONNECT with you instead of relying on a trigger-time claim.
      p.sweepLocal = () => {
        const pl = this.host.player();
        return pl.isDead ? null : pl.pos;
      };
      p.localClass = () => this.host.player().appliedClass;
      this.host.world().projectiles.push(p);
    }
    // Positional — sfx.shoot is the LOCAL voice (full volume at the ear);
    // a bot firing through it sounded adjacent no matter the range.
    sfx.shotAt(_shotMuzzle, wt, bot.vel);
  }

  /** Live position of a brain hunt target — belt throws arc at it. */
  private targetPos(targetId: string | null): THREE.Vector3 | null {
    if (!targetId) {return null;}
    if (targetId === 'local') { const p = this.host.player(); return p.isDead ? null : p.pos; }
    if (targetId.startsWith('creature:')) {
      const t = this.host.targets.find(x => x.id === Number(targetId.slice(9)));
      return t && !t.dead ? t.pos : null;
    }
    const rp = this.host.world().remotePlayers.get(targetId);
    return rp && !rp.isDead ? rp.pos : null;
  }

  /** Belt throw — a lobbed grenade at the hunt's last-seen spot. Mirrors
   *  ServerBots.throwBelt: real projectile, ballistic pitch, 50% vel
   *  inheritance handled inside the Projectile ctor. */
  throwBelt(bot: GameBot): void {
    bot.wantBelt = false;
    const aim = this.targetPos(bot.huntTargetId);
    if (aim) {this.lobAt(bot, aim);}
  }

  /** Lob the belt weapon at an explicit point — ballistic arc solves
   *  θ from the target's range instead of a flat guess. */
  private lobAt(bot: GameBot, aim: { x: number; y: number; z: number }): void {
    const wt = bot.loadout?.belt ?? WeaponType.Grenade;
    const stats = getWeaponStats(wt);
    const cfg = getProjectileConfig(wt);
    if (!stats || stats.speed <= 0 || !cfg) {return;}
    const dx = aim.x - bot.position.x, dz = aim.z - bot.position.z;
    const d = Math.hypot(dx, dz) || 1;
    let pitch: number;
    if (stats.rayDelay) {
      pitch = 0.15;
    } else {
      const g = Math.abs(GRAVITY);
      const sin2t = Math.min(0.98, (d * g) / (stats.speed * stats.speed));
      pitch = Math.asin(sin2t) / 2;
    }
    const dir = { x: dx / d, y: Math.tan(pitch), z: dz / d };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    // The ctor inherits half the bot's velocity — steer the launch
    // against the carry the same way the server does.
    const vx = (dir.x / len) * stats.speed - bot.vel.x * 0.5;
    const vy = (dir.y / len) * stats.speed - bot.vel.y * 0.5;
    const vz = (dir.z / len) * stats.speed - bot.vel.z * 0.5;
    const vl = Math.hypot(vx, vy, vz) || 1;
    const p = new Projectile(this.host.scene(),
      _shotMuzzle.set(bot.position.x, bot.position.y + 1.4, bot.position.z),
      _shotDir.set(vx / vl, vy / vl, vz / vl), bot.vel,
      { ...cfg, aoeRadius: cfg.aoeRadius * bot.perkMods.aoeRadius,
        aoeDamage: cfg.aoeDamage * bot.perkMods.directDamage,
        needsServerTracking: false });
    p.shooterId = bot.playerId;
    p.sweepLocal = () => { const pl = this.host.player(); return pl.isDead ? null : pl.pos; };
    p.localClass = () => this.host.player().appliedClass;
    this.host.world().projectiles.push(p);
    sfx.shotAt(_shotMuzzle, wt, bot.vel);
  }

  /** First push-class AOE weapon in the kit — pull weapons would drag
   *  the bot toward its own feet. */
  private propelWeapon(bot: GameBot): number {
    const lo = bot.loadout ?? BOT_LOADOUTS[0]!;
    const pick = [lo.mid, lo.far].find((wt) => {
      const s = getWeaponStats(wt);
      return s && s.aoeRadius > 0 && s.speed > 0 && s.forceMode !== 'pull';
    });
    return pick ?? WeaponType.Disc;
  }

  /** Disc-jump / implosion ride — a grounded bot starting a long open
   *  run detonates an explosive at its heels and surfs the blast (or
   *  lobs a pull-belt implosion ahead and rides the drag). Same gates
   *  as ServerBots.tryPropel: long run, low speed, fuel for the climb,
   *  never mid-firefight. */
  tryPropel(bot: GameBot, firing: boolean): void {
    const now = performance.now();
    if (firing || !bot.grounded || bot.propelUntil > now) {return;}
    const dx = bot.lastDest.x - bot.position.x, dz = bot.lastDest.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 35) {return;}
    const v = bot.vel;
    if (Math.hypot(v.x, v.z) > 12) {return;} // already moving — boost is for launches
    if (bot.energy < 30) {return;}
    const nx = dx / dist, nz = dz / dist;
    if (getWeaponStats(bot.loadout?.belt)?.forceMode === 'pull') {
      this.lobAt(bot, { x: bot.position.x + nx * 18, y: bot.position.y - 1, z: bot.position.z + nz * 18 });
    } else {
      const wt = this.propelWeapon(bot);
      const cfg = getProjectileConfig(wt);
      if (cfg && cfg.speed > 0) {
        const mx = bot.position.x, my = bot.position.y + 1.4, mz = bot.position.z;
        const hx = bot.position.x - nx * 1.8 - mx;
        const hy = bot.position.y - 1.8 - my;
        const hz = bot.position.z - nz * 1.8 - mz;
        const len = Math.hypot(hx, hy, hz) || 1;
        const p = new Projectile(this.host.scene(),
          _shotMuzzle.set(mx, my, mz), _shotDir.set(hx / len, hy / len, hz / len), bot.vel,
          { ...cfg, needsServerTracking: false });
        p.shooterId = bot.playerId;
        this.host.world().projectiles.push(p);
        sfx.shotAt(_shotMuzzle, wt, bot.vel);
      }
    }
    bot.propelUntil = now + 8000;
    bot.propelJetT = 0.9; // ride the shove skyward like a real disc-jump
    this.host.logger.debug(`bot ${bot.playerId} propel`);
  }

  /** Instant-claim resolution: melee, beams, and connected rooms where
   *  local shells can't own the attribution. */
  private claimShot(bot: GameBot, targetId: string, aim: THREE.Vector3, melee: boolean, dmg: number, weapon?: number): void {
    claimShot(this, bot, targetId, { aim, melee, dmg, weapon });
  }

  tickBolts(dt: number): void { tickBolts(this, dt); }

  dispose(): void { disposeBolts(this); }
}

/** Pellet fan for flak/shotgun bots — one random cone dir per pellet;
 *  count 1 collapses to a single straight shot. */
function pelletDirs(dir: THREE.Vector3, count: number, spread: number): THREE.Vector3[] {
  if (count <= 1 || spread <= 0) {return [dir.clone()];}
  _pelletRight.crossVectors(dir, _pelletUp0);
  if (_pelletRight.lengthSq() < 1e-8) {_pelletRight.set(1, 0, 0);} else {_pelletRight.normalize();}
  _pelletUp.crossVectors(_pelletRight, dir);
  const rot = Math.random() * Math.PI * 2;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  return poissonDisc(count).map(pt => {
    const ox = (pt.x * cs - pt.y * sn) * spread;
    const oy = (pt.x * sn + pt.y * cs) * spread;
    return dir.clone().addScaledVector(_pelletRight, ox).addScaledVector(_pelletUp, oy).normalize();
  });
}
