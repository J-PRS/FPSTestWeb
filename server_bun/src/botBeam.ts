/**
 * botBeam — the non-shell fire paths of BotArsenal: creature shots
 * (real shells sweep live balls), and projectile-less beam-class weapons
 * where an honest ray decides contact (earliest of terrain/wall/player/
 * creature pays; a whiff is a real miss). Extracted from botArsenal so
 * the arsenal keeps only trigger timing + lobs.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import { segFieldHit, segPointDist, segPointT } from '../../shared/projSim.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { BotLoadout } from '../../shared/botLoadouts.ts';
import { isSuper } from './superBot.ts';
import { weaponStats } from './weaponStats.ts';

const BOLT_SPEED = 60; // m/s visual bolt + hitscan travel is instant

type BotBody = { id: string; position: Vec3; velocity: Vec3 };

/** Minimal arsenal surface the beam family needs — the arsenal keeps the
 *  private maps; these are the helpers already public-ish on it. */
export interface BeamHost {
  room: Room;
  pickWeapon(lo: BotLoadout, distXZ: number, dist: number): number;
  rateOk(id: string, wt: number): boolean;
  lastHunt(id: string): string | null;
  loadouts: Map<string, BotLoadout>;
}

/** Projectile-less weapons (beam-class): an honest ray decides contact —
 *  earliest of terrain/wall/player/creature pays, a whiff is a real
 *  miss. Damage lands via the same funnels the projectile paths use. */
export function fireSpeedless(h: BeamHost, id: string, muzzle: Vec3, dir: Vec3, wt: number): void {
  const stats = getWeaponStats(wt);
  const c = isSuper(id) ? null : beamContact(h, id, muzzle, dir);
  const playerId = isSuper(id) ? h.lastHunt(id) : (c?.playerId ?? null);
  h.room.messages.botFire(id, playerId, muzzle,
    { x: dir.x * BOLT_SPEED, y: dir.y * BOLT_SPEED, z: dir.z * BOLT_SPEED }, wt, Boolean(playerId));
  if (c?.ballId !== undefined && stats) {
    const dmg = stats.directDamage || stats.aoeDamage;
    const {killed} = h.room.ballSim.handleHit(id, c.ballId, dmg);
    weaponStats.record(h.room.mode, `w${wt}:prey`, dmg, killed, true);
  }
  if (c?.crawlerId !== undefined && stats) {
    const dmg = stats.directDamage || stats.aoeDamage;
    const {killed} = h.room.creatureSim.handleHit(id, c.crawlerId, dmg);
    weaponStats.record(h.room.mode, `w${wt}:prey`, dmg, killed, true);
  }
}



/** Creature targets fire REAL shells — the projectile sim sweeps them
 *  against live balls and pays through handleHit, so a bot kill drops
 *  its gem/FFA point identically to a player's. Melee and projectile-
 *  less weapons keep the honest geometric checks. */
export function fireAtBall(h: BeamHost, p: BotBody, ball: number, aim: Vec3, pickDefault: BotLoadout): void {
  const muzzle = { x: p.position.x, y: p.position.y + 1.4, z: p.position.z };
  const dxb = aim.x - muzzle.x;
  const dyb = aim.y - muzzle.y;
  const dzb = aim.z - muzzle.z;
  const lenb = (dxb * dxb + dyb * dyb + dzb * dzb) ** 0.5 || 1;
  const lo = h.loadouts.get(p.id) ?? pickDefault;
  const wt = h.pickWeapon(lo, Math.hypot(dxb, dzb), lenb);
  if (!h.rateOk(p.id, wt)) {return;}
  if (wt === WeaponType.Melee) {
    // The punch lands if the creature is inside the swing's reach —
    // geometry decides, not a dice roll.
    const b = h.room.ballSim.ballAt(ball);
    const stats = getWeaponStats(WeaponType.Melee);
    if (b && stats) {
      const d = Math.hypot(b.x - muzzle.x, b.y - muzzle.y, b.z - muzzle.z);
      if (d <= stats.aoeRadius + b.radius) {
        const dmg = isSuper(p.id) ? 300 : stats.aoeDamage;
        const {killed} = h.room.ballSim.handleHit(p.id, ball, dmg);
        weaponStats.record(h.room.mode, `w${wt}:prey`, dmg, killed, true);
      }
    }
    return;
  }
  if (!h.room.projectiles.spawn(p.id, wt, muzzle,
    { x: dxb / lenb, y: dyb / lenb, z: dzb / lenb }, p.velocity)) {
    fireSpeedless(h, p.id, muzzle, { x: dxb / lenb, y: dyb / lenb, z: dzb / lenb }, wt);
  }
}

/** First thing a 60m ray actually strikes: terrain face, wall, player
 *  chest, or creature — earliest contact wins, like dischargeRay. */
function beamContact(h: BeamHost, shooterId: string, muzzle: Vec3, dir: Vec3, range = 60): { playerId?: string; ballId?: number; crawlerId?: number } | null {
  const end = { x: muzzle.x + dir.x * range, y: muzzle.y + dir.y * range, z: muzzle.z + dir.z * range };
  let bestT = 1;
  if (h.room.field) {
    const th = segFieldHit(muzzle, end, h.room.field);
    if (th) {bestT = segPointT(muzzle, end, th);}
  }
  const solids = h.room.projectiles.solidColliders;
  if (solids.length > 0) {
    const sh = segSolidHit(muzzle, end, solids, undefined, h.room.players.getPlayer(shooterId)?.team);
    if (sh) {bestT = Math.min(bestT, segPointT(muzzle, end, sh));}
  }
  return beamEntityAt(h, shooterId, muzzle, end, bestT);
}



/** Players and creatures the ray reaches before its first world
 *  contact — earliest wins; none = the beam ended in dirt. */
function beamEntityAt(h: BeamHost, shooterId: string, muzzle: Vec3, end: Vec3, worldT: number): { playerId?: string; ballId?: number; crawlerId?: number } | null {
  let bestT = worldT;
  let playerId: string | undefined = undefined;
  for (const [pid, t] of h.room.players.getAllPlayers()) {
    if (pid === shooterId || t.isDead) {continue;}
    const cap = classCapsule(t.armorClass);
    const c = { x: t.position.x, y: t.position.y + cap.centerOff, z: t.position.z };
    if (segPointDist(muzzle, end, c) > cap.radius + 0.2 + cap.half) {continue;}
    const tt = segPointT(muzzle, end, c);
    if (tt <= bestT) { bestT = tt; playerId = pid; }
  }
  const bc = h.room.ballSim?.sweepHit(muzzle, end, 0.2);
  if (bc && bc.t <= bestT) {return { ballId: bc.id };}
  const cc = h.room.creatureSim?.sweepHit(muzzle, end, 0.2);
  if (cc && cc.t <= bestT) {return { crawlerId: cc.id };}
  if (playerId !== undefined) {return { playerId };}
  return worldT < 1 ? {} : null;
}


