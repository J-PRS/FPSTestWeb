/**
 * BotFire - how offline bots actually shoot. The brain returns an aim
 * point; this module turns it into REAL projectiles pushed into the
 * same sweep/blast pipeline the player's shells use (travel time,
 * gravity, splash, misses all honest), plus the belt lob and the
 * disc-jump propel. The claim fallback (melee/beam/connected room)
 * resolves instantly through the damage funnel - no dice-roll tracers.
 */

import * as THREE from 'three';
import { GameBot, BOT_DMG } from './botBrain.js';
import { BOT_LOADOUTS, pickBotWeaponSafe } from '../../../../shared/botLoadouts.js';
import { aimSkillFor } from '../../../../shared/botSkill.js';

/** cos(20°): settle cone a pull waits inside - see botArsenal SETTLE_COS. */
const SETTLE_COS = Math.cos(0.35);
import { getProjectileConfig } from '../../projectiles/index.js';
import { Projectile } from '../../projectiles/Projectile.js';
import { SLOT_DEFS } from '../../weapons.js';
import { WeaponType, getWeaponStats, WEAPON_FIRE_INTERVAL_S, spendAmmo } from '../../../../shared/weapons.js';
import { GRAVITY } from '../../../../shared/movement.js';
import { MELEE_RANGE, MELEE_DAMAGE } from '../../core/config.js';
import * as sfx from '../../core/sfx.js';
import { claimShot, tickBolts, disposeBolts } from './botBolts.js';
import { poissonDisc } from '../../utils/poissonSpread.js';
import type { RemotePlayer } from '../../entities/RemotePlayer.js';
import type { Targetable } from '../../entities/balls.js';
import { classCanFire, type ArmorClass } from '../../../../shared/botClasses.js';
import { gunGameWeapon } from '../../../../shared/gunGame.js';
import { gunRungOf } from '../gunGame.js';
import { simRand } from '../../../../shared/simRand.js';

const _shotDir = new THREE.Vector3();
const _shotMuzzle = new THREE.Vector3();
const _pelletRight = new THREE.Vector3();
const _pelletUp = new THREE.Vector3();
const _pelletUp0 = new THREE.Vector3(0, 1, 0);

export interface FireHost {
  scene(): THREE.Scene;
  player(): { pos: THREE.Vector3; isDead: boolean; appliedClass: ArmorClass };
  world(): { projectiles: Projectile[]; remotePlayers: Map<string, RemotePlayer>; instagib?: boolean; gungame?: boolean; igun?: boolean; gunRungs?: Map<string, number> };
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

/** Pellet fan for flak/shotgun bots - one random cone dir per pellet;
 *  count 1 collapses to a single straight shot. */
function pelletDirs(dir: THREE.Vector3, count: number, spread: number): THREE.Vector3[] {
  if (count <= 1 || spread <= 0) {return [dir.clone()];}
  _pelletRight.crossVectors(dir, _pelletUp0);
  if (_pelletRight.lengthSq() < 1e-8) {_pelletRight.set(1, 0, 0);} else {_pelletRight.normalize();}
  _pelletUp.crossVectors(_pelletRight, dir);
  const rot = simRand() * Math.PI * 2;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  return poissonDisc(count).map((pt): THREE.Vector3 => {
    const ox = (pt.x * cs - pt.y * sn) * spread;
    const oy = (pt.x * sn + pt.y * cs) * spread;
    return dir.clone().addScaledVector(_pelletRight, ox).addScaledVector(_pelletUp, oy).normalize();
  });
}




export class BotFire {
  // Bolt tracers share a pool - a fresh BufferGeometry per shot meant a
  // GL buffer upload + dispose for a 120ms visual.
  bolts: { line: THREE.Line; t: number }[] = [];
  boltPool: THREE.Line[] = [];
  private lastShotAt = new Map<string, number>();

  /** Jersey swap - cadence receipts follow the body like the other
   *  id-keyed meters (see Bots.rekeyBot). */
  rekey(oldId: string, newId: string): void {
    const v = this.lastShotAt.get(oldId);
    this.lastShotAt.delete(oldId);
    if (v !== undefined) {this.lastShotAt.set(newId, v);}
  }

  constructor(public host: FireHost) {}

  /** Resolve a bot's shot. Range-band pick comes from the shared loadout
   *  roster; the trigger pull then spawns a REAL projectile - same sweep
   *  + blast pipeline as the player's own shells, so travel time,
   *  gravity, splash, and misses are all honest. Only offline: in a
   *  connected room a shell landing on a WIRE remote would misattribute
   *  the claim to the local player - server bots own that case anyway. */
  resolveShot(bot: GameBot, targetId: string, aim: THREE.Vector3): void {
    const lo = bot.loadout ?? BOT_LOADOUTS[0]!;
    const w = this.host.world();
    const insta = w.instagib === true;
    const gg = w.gungame === true;
    const dx = aim.x - bot.position.x, dy = aim.y - bot.position.y, dz = aim.z - bot.position.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    // Fire-along-facing: the pull waits until the body has swung inside
    // ~20° of the aim (Quake's rule - the crosshair IS the view). Still
    // turning = no shot, no ammo spent; the brain re-pulls next think.
    const cp = Math.cos(bot.rotation.pitch);
    const fx = Math.sin(bot.rotation.yaw) * cp, fy = -Math.sin(bot.rotation.pitch), fz = Math.cos(bot.rotation.yaw) * cp;
    if ((fx * dx + fy * dy + fz * dz) / dist < SETTLE_COS) {return;}
    // Gun game: the ladder owns the pick outright - same rung the server
    // gate would admit, not whatever the loadout drifted to.
    const picked0 = insta ? WeaponType.Railgun
      : gg ? gunGameWeapon(gunRungOf(w, bot.playerId), w.igun === true)
      : pickBotWeaponSafe(lo, Math.hypot(dx, dz), dist, bot.botHp,
        bot.skill ? (t): number => aimSkillFor(bot.skill, t, 0) : undefined, bot.skill?.courage);
    // Deploy artillery only draws feet-down - same fallback the server's
    // arsenal picks: airborne body + groundedOnly pick = next legal slot,
    // not a dry pull that never fires.
    const picked = getWeaponStats(picked0).groundedOnly && !bot.grounded
      ? ([lo.far, lo.mid, lo.near, lo.side].find((w): boolean => !getWeaponStats(w).groundedOnly && classCanFire(bot.armorClass, w)) ?? picked0)
      : picked0;
    // Kit locks have no melee - knife range still shoots the held gun.
    const melee = !insta && !gg && (picked === WeaponType.Melee || dist <= MELEE_RANGE);
    // Same class gate the server holds players to - a pick the body can't
    // legally shoulder falls back to the first legal slot, never fires.
    // Gun game bypasses it outright: the ladder crosses armor tiers, so
    // the rung weapon is legal on any chassis (server shotAdmit agrees).
    const wt = gg || melee || classCanFire(bot.armorClass, picked) ? picked
      : ([lo.side, lo.near, lo.mid, lo.far].find((w): boolean => classCanFire(bot.armorClass, w)) ?? -1);
    if (!melee && wt < 0) {return;}
    if (!this.canFire(bot, melee ? WeaponType.Melee : (wt as WeaponType))) {return;}
    // Mirror the pick to the hand prop - offline bots never ride the wire
    // path that reveals a remote's weapon, so they held the generic gun
    // forever. Same convention: melee swings keep the last real gun out.
    if (!melee) {bot.model?.setWeapon(wt);}
    const cfg = melee ? undefined : getProjectileConfig(wt);

    // The claim path exists ONLY for wire-remote targets: a locally
    // spawned shell landing on a remote player would misattribute to
    // the local player (server bots own that case). In P2P-host mode
    // every other target - bots, creatures, 'local' - is a local entity
    // the host is authoritative for, so they get REAL shells there too.
    const wireRemote = this.host.online()
      && targetId !== 'local'
      && !(this.host.world().remotePlayers.get(targetId) instanceof GameBot);
    if (melee || !cfg || cfg.speed <= 0 || wireRemote) {
      this.claimShot(bot, targetId, aim, melee, melee ? MELEE_DAMAGE : BOT_DMG, wt);
      return;
    }
    // Launcher recoil (howitzer): offline bots feel the same kick the
    // server applies through moveSim - vel drives the brain's sim.
    const recoil = getWeaponStats(wt).recoilImpulse ?? 0;
    if (recoil > 0) {bot.vel.addScaledVector(_shotDir.set(fx, fy, fz), -recoil);}
    this.spawnShells(bot, wt, cfg, fx, fy, fz);
  }

  /** The brain's volley cadence is weapon-blind - a 0.45s burst pick of
   *  Mortar would out-cadence a player holding the same gun (2.0s).
   *  Same gate the server's botArsenal applies to its bots. */
  private canFire(bot: GameBot, wt: WeaponType): boolean {
    const interval = WEAPON_FIRE_INTERVAL_S[wt] ?? 0.1;
    const last = this.lastShotAt.get(bot.playerId) ?? -interval * 1000;
    const now = performance.now();
    if (now - last < interval * 1000) {return false;}
    // Pool ammo - offline bots obey the same clip rule humans do; the
    // pool lives on the body so respawn() refills it like the server's.
    // Deploy weapons: offline bots obey groundedOnly the same as the
    // server's arsenal gate - brain moveState carries the ground truth.
    const st = getWeaponStats(wt);
    if (st.groundedOnly && !bot.grounded) {return false;}
    if (!spendAmmo(bot.ammoPool, wt, now / 1000)) {return false;}
    this.lastShotAt.set(bot.playerId, now);
    return true;
  }

  /** Real shells into the world projectile list - pellet weapons fan
   *  out per their def, everything else lobs a single round. */
  private spawnShells(bot: GameBot, wt: number, cfg: NonNullable<ReturnType<typeof getProjectileConfig>>, nx: number, ny: number, nz: number): void {
    const dir = _shotDir.set(nx, ny, nz);
    const muzzle = _shotMuzzle.set(bot.position.x, bot.position.y + 1.4, bot.position.z);
    const pellets = SLOT_DEFS.find((w): boolean => w.weaponType === wt)?.pellets;
    for (const d of pelletDirs(dir, pellets?.count ?? 1, pellets?.spread ?? 0)) {
      // Perk mods the server folds in: bombardier widens the boom,
      // sharpshooter tightens it (damage scaling lands at claim time).
      const radius = cfg.aoeRadius * bot.perkMods.aoeRadius;
      const dmg = cfg.aoeDamage * bot.perkMods.directDamage;
      const p = new Projectile(this.host.scene(), muzzle, d, bot.vel,
        ((((((Object.assign({}, cfg, {aoeRadius: radius,aoeDamage: dmg,needsServerTracking: false}))))))));
      p.shooterId = bot.playerId;
      p.shooterTeam = bot.team;
      // 'local' isn't in remotePlayerPositions - this lets a bot shell
      // actually CONNECT with you instead of relying on a trigger-time claim.
      p.sweepLocal = (): THREE.Vector3 | null => {
        const pl = this.host.player();
        return pl.isDead ? null : pl.pos;
      };
      p.localClass = (): "light" | "medium" | "heavy" => this.host.player().appliedClass;
      this.host.world().projectiles.push(p);
    }
    // Positional - sfx.shoot is the LOCAL voice (full volume at the ear);
    // a bot firing through it sounded adjacent no matter the range.
    sfx.shotAt(_shotMuzzle, wt, bot.vel);
  }

  /** Live position of a brain hunt target - belt throws arc at it. */
  private targetPos(targetId: string | null): THREE.Vector3 | null {
    if (!targetId) {return null;}
    if (targetId === 'local') { const p = this.host.player(); return p.isDead ? null : p.pos; }
    if (targetId.startsWith('creature:')) {
      const t = this.host.targets.find((x): boolean => x.id === Number(targetId.slice(9)));
      return t && !t.dead ? t.pos : null;
    }
    const rp = this.host.world().remotePlayers.get(targetId);
    return rp && !rp.isDead ? rp.pos : null;
  }

  /** Belt throw - a lobbed grenade at the hunt's last-seen spot. Mirrors
   *  ServerBots.throwBelt: real projectile, ballistic pitch, 50% vel
   *  inheritance handled inside the Projectile ctor. */
  throwBelt(bot: GameBot): void {
    bot.wantBelt = false;
    const aim = this.targetPos(bot.huntTargetId);
    if (aim) {this.lobAt(bot, aim);}
  }

  /** Shell a static point with the belt weapon - siege lobs at hostile
   *  emplacements; the ballistic arc solver already handles range. */
  siegeLob(bot: GameBot, aim: { x: number; y: number; z: number }): void {
    this.lobAt(bot, aim);
  }

  /** Lob the belt weapon at an explicit point - ballistic arc solves
   *  θ from the target's range instead of a flat guess. */
  private lobAt(bot: GameBot, aim: { x: number; y: number; z: number }): void {
    const want = bot.loadout?.belt ?? WeaponType.Grenade;
    const wt = classCanFire(bot.armorClass, want) ? want : WeaponType.Grenade;
    bot.model?.setWeapon(wt);
    const stats = getWeaponStats(wt);
    const cfg = getProjectileConfig(wt);
    if (!stats || stats.speed <= 0 || !cfg) {return;}
    const dx = aim.x - bot.position.x, dz = aim.z - bot.position.z;
    const d = Math.hypot(dx, dz) || 1;
    // oxlint-disable-next-line init-declarations -- assigned later
    let pitch!: number;
    if (stats.rayDelay) {
      pitch = 0.15;
    } else {
      const g = Math.abs(GRAVITY);
      const sin2t = Math.min(0.98, (d * g) / (stats.speed * stats.speed));
      pitch = Math.asin(sin2t) / 2;
    }
    const dir = { x: dx / d, y: Math.tan(pitch), z: dz / d };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    // The ctor inherits half the bot's velocity - steer the launch
    // against the carry the same way the server does.
    const vx = (dir.x / len) * stats.speed - bot.vel.x * 0.5;
    const vy = (dir.y / len) * stats.speed - bot.vel.y * 0.5;
    const vz = (dir.z / len) * stats.speed - bot.vel.z * 0.5;
    const vl = Math.hypot(vx, vy, vz) || 1;
    // The throwing flick - a lob isn't a held trigger, so the honest
    // read is the body snapping onto the launch dir as it throws.
    bot.rotation.yaw = Math.atan2(vx / vl, vz / vl);
    bot.rotation.pitch = -Math.asin(Math.max(-1, Math.min(1, vy / vl)));
    const p = new Projectile(this.host.scene(),
      _shotMuzzle.set(bot.position.x, bot.position.y + 1.4, bot.position.z),
      _shotDir.set(vx / vl, vy / vl, vz / vl), bot.vel,
      ((((((Object.assign({}, cfg, {aoeRadius: cfg.aoeRadius * bot.perkMods.aoeRadius,aoeDamage: cfg.aoeDamage * bot.perkMods.directDamage,needsServerTracking: false}))))))));
    p.shooterId = bot.playerId;
    p.sweepLocal = (): THREE.Vector3 | null => { const pl = this.host.player(); return pl.isDead ? null : pl.pos; };
    p.localClass = (): "light" | "medium" | "heavy" => this.host.player().appliedClass;
    this.host.world().projectiles.push(p);
    sfx.shotAt(_shotMuzzle, wt, bot.vel);
  }

  /** First push-class AOE weapon in the kit that can actually LAUNCH -
   *  pull weapons would drag the bot toward its own feet, and splash
   *  without shove (Bombard: 9m radius, 12 m/s knockback) is a feet
   *  blast that costs health and goes nowhere. Mirrors the server's
   *  botArsenal.propelWeapon - same kit, same pick. */
  private propelWeapon(bot: GameBot): number {
    const lo = bot.loadout ?? BOT_LOADOUTS[0]!;
    const pick = [lo.mid, lo.far].find((wt): boolean => {
      const s = getWeaponStats(wt);
      return s && s.aoeRadius > 0 && s.speed > 0 && s.forceMode !== 'pull' && s.knockbackForce >= 20;
    });
    return pick ?? WeaponType.Disc;
  }

  /** Disc-jump / implosion ride - a grounded bot starting a long open
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
    if (Math.hypot(v.x, v.z) > 12) {return;} // already moving - boost is for launches
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
          ((((((Object.assign({}, cfg, {needsServerTracking: false}))))))));
        p.shooterId = bot.playerId;
        p.shooterTeam = bot.team;
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
