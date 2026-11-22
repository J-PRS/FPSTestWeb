/*
 * BotSelfBlast - the self-preservation half of BotArsenal: every gate
 * that decides whether a pull would frag the shooter. Geometric march
 * of the real ballistic path, entity-intercept sweeps inside the blast
 * envelope, and the survivable-splash HP/courage/budget policy. Owns
 * nothing itself - it reads the arsenal's room + selfDamageBudget and
 * the shared weapon tables, and every veto it returns kills the shot
 * before RoomProjectiles ever sees it.
 */
import type { Vec3, PlayerState } from './types.ts';
import type { BotArsenal, BotBody } from './botArsenal.ts';
import { type WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import { aoeDamageAt } from '../../shared/combat.ts';
import { perkMods } from '../../shared/perks.ts';
import { GRAVITY } from '../../shared/movement.ts';
import { hmHeight, hmChord, type Heightfield } from '../../shared/heightfield.ts';
import { botRand } from '../../shared/botRand.ts';

export class BotSelfBlast {
  constructor(private ar: BotArsenal) {}
  private get room(): BotArsenal['room'] { return this.ar.room; }

  /** The geometric half of self-preservation: does my own splash cone
   *  catch me? ~5% of pulls skip the check entirely - humans say
   *  "fuck it" too. true = geometric veto. */
  blastGate(p: BotBody, a: { muzzle: Vec3; dir: Vec3; wt: number }, imperfect: boolean): boolean {
    return !(imperfect && (getWeaponStats(a.wt)?.aoeRadius ?? 0) > 0)
      && this.selfBlastBlocked(a.muzzle, a.dir, a.wt, p.velocity, p.id, this.room.players.getPlayer(p.id)?.team ?? undefined);
  }

  /** Self-blast + survivable-splash veto for a target pull. The blast
   *  geometry runs first (a lip or body inside the envelope kills the
   *  shot outright); the HP/budget policy only prices splash at
   *  this range - courage scales the threshold, the flag-carrier shot
   *  and the kill-shot override both fire anyway (heroic, not rigid).
   *  ~5% of pulls skip the checks entirely - humans say "fuck it" too. */
  selfBlastVeto(p: BotBody, target: PlayerState, targetId: string, a: { muzzle: Vec3; dir: Vec3; wt: number; dist: number }): boolean {
    const { wt, dist } = a;
    const statsW2 = getWeaponStats(wt);
    // Human imperfection: occasionally skip self-splash checks entirely,
    // simulating "fuck it" moments or not paying attention. No absolutes.
    const imperfect = botRand() < 0.05;
    if (this.blastGate(p, a, imperfect)) {return true;}
    // Self-splash HP gate: don't fire splash weapons if the bot can't
    // survive its own blast at the target's distance. Use the actual
    // splash damage at that range, not the flat SELF_SPLASH_MAX.
    // Heroic exception: if the shot will kill the target, fire anyway
    // (the bot accepts the self-damage for the kill). No rigid rules.
    if (!statsW2 || statsW2.aoeRadius <= 0) {return false;}
    const me = this.room.players.getAllPlayers().get(p.id);
    const selfSplash = aoeDamageAt(Math.max(0.5, dist), wt);
    // Cumulative self-damage budget: if the bot has taken too much
    // self-damage recently, hold fire unless the shot will kill the
    // target (heroic) or the situation is urgent (carrier chase -
    // a shot at a flag carrier buys cap denial, not a duel).
    const urgent = [...(this.room.flags?.flags.values() ?? [])].some((f): boolean => f.carrier === targetId);
    const budget = this.ar.selfDamageBudget.get(p.id) ?? 100;
    const perk = perkMods(me?.perk);
    if (selfSplash > 0 && !urgent && this.splashHpVeto(p, target, { statsW2, scaledSplash: selfSplash * perk.selfDamage, hp: me?.health ?? 100, budget, imperfect })) {
      return true;
    }
    // Decrement budget on fire (regenerates in step())
    if (selfSplash > 0) {
      this.ar.selfDamageBudget.set(p.id, budget - selfSplash * perk.selfDamage);
    }
    return false;
  }

  /** The survivable-splash veto: courage scales how much self-splash a
   *  bot eats before holding fire (brave 0.9 fires unless HP is under
   *  half the splash, timid 0.3 holds at 2x). The kill shot always
   *  fires - heroic, not rigid. true = veto. */
  private splashHpVeto(p: BotBody, target: PlayerState, a: { statsW2: ReturnType<typeof getWeaponStats>; scaledSplash: number; hp: number; budget: number; imperfect: boolean }): boolean {
    const { statsW2, scaledSplash, hp, budget, imperfect } = a;
    if (target.health <= statsW2.directDamage) {return false;} // willKill - accept the self-damage for the kill
    const courage = this.ar.skillOfCb?.(p.id)?.courage ?? 0.5;
    const threshold = scaledSplash * (2 - courage);
    if (!imperfect && hp <= threshold + 5 && botRand() > 0.1) { return true; }
    return budget < scaledSplash * 0.5 && botRand() > 0.05;
  }

  /** The point-shot survivable-splash gate: no target, so no willKill
   *  or urgent override - just survive the blast and stay inside the
   *  self-damage budget. true = veto. */
  pointHpVeto(p: BotBody, wt: number, dist: number): boolean {
    const statsW2 = getWeaponStats(wt);
    if (!statsW2 || statsW2.aoeRadius <= 0) {return false;}
    const me = this.room.players.getAllPlayers().get(p.id);
    const selfSplash = aoeDamageAt(Math.max(0.5, dist), wt);
    if (selfSplash <= 0) {return false;}
    const scaled = selfSplash * perkMods(me?.perk).selfDamage;
    if ((me?.health ?? 100) <= scaled * 1.5 + 5) {return true;} // can't survive 1.5 hits
    const budget = this.ar.selfDamageBudget.get(p.id) ?? 100;
    if (budget < scaled) {return true;} // budget exhausted
    // Decrement budget on fire (regenerates in step())
    this.ar.selfDamageBudget.set(p.id, budget - scaled);
    return false;
  }

  /** Self-radius clearance: an AOE shell that detonates on terrain or a
   *  structure inside its own blast radius of the muzzle is a guaranteed
   *  self-splash - humans see the hump between them and the target and
   *  hold the rocket. March the ray fine enough not to skip a lip; if
   *  ground or a wall top crosses it inside the blast envelope, the
   *  shot doesn't exist to be taken. */
  selfBlastBlocked(muzzle: Vec3, dir: Vec3, wt: WeaponType, ownerVel: Vec3, shooterId?: string, shooterTeam?: string): boolean {
    const stats = getWeaponStats(wt);
    const aoer = stats?.aoeRadius ?? 0;
    if (!this.room.field || !stats || aoer <= 0) {return false;}
    const { field } = this.room;
    // March the REAL ballistic path, not the aim ray: the shell inherits
    // half the shooter's velocity, so a bot skiing downhill bends every
    // shot below the checked line and clips lips the ray clears (soak
    // autopsy: all self-frag blasts <2m over ground @~6m from muzzle).
    const inh = stats.inherit ?? 0.5;
    const foes = [...this.room.players.getAllPlayers().values()]
      .filter((q): boolean => q.id !== shooterId && !q.isDead && (!shooterTeam || q.team !== shooterTeam));
    const march = this.blastMarch({
      muzzle, field, foes, aoer, bodyRadius: stats.bodyRadius, aoeDamage: stats.aoeDamage,
      v: { x: dir.x * stats.speed + ownerVel.x * inh, y: dir.y * stats.speed + ownerVel.y * inh, z: dir.z * stats.speed + ownerVel.z * inh },
      g: stats.gravity ? GRAVITY : 0,
    });
    if (march.blocked) {return true;}
    // A body hit that survives the trade test still has to clear the
    // self-catch projection.
    if (march.hit && !march.bodyHit && this.selfCatch(muzzle, march.hit, ownerVel, march.flightT, aoer)) {return true;}
    return this.blastEnvelopeHit(muzzle, dir, aoer, shooterId, shooterTeam);
  }

  /** Point-sample march of the ballistic path: a razor lip apex between
   *  two samples is invisible to the check but real to the sim (residual
   *  lip selfK @4-5m), so the blast envelope marches fine (5ms) and the
   *  rest coarse (20ms). Reports where/after how long the shell pops. */
  private blastMarch(a: { muzzle: Vec3; v: Vec3; g: number; aoer: number; bodyRadius: number; aoeDamage: number; field: Heightfield; foes: PlayerState[] }): { blocked: boolean; hit: Vec3 | null; flightT: number; bodyHit: PlayerState | null } {
    let vy = a.v.y;
    let px = a.muzzle.x, py = a.muzzle.y, pz = a.muzzle.z;
    let travelled = 0, flightT = 0;
    let hit: Vec3 | null = null, bodyHit: PlayerState | null = null;
    const out = (blocked: boolean): { blocked: boolean; hit: Vec3 | null; flightT: number; bodyHit: PlayerState | null } => ({ blocked, hit, flightT, bodyHit });
    for (let stepN = 0; stepN < 400 && travelled < 80; stepN += 1) {
      const dt = travelled < a.aoer + 3 ? 0.005 : 0.02;
      vy += a.g * dt;
      px += a.v.x * dt; py += vy * dt; pz += a.v.z * dt;
      flightT += dt;
      travelled += (a.v.x * a.v.x + vy * vy + a.v.z * a.v.z) ** 0.5 * dt;
      const ground = Math.max(hmHeight(a.field, px, pz), hmChord(a.field, px, pz), this.room.moveSim.structureTop(px, pz));
      if (ground > py + a.bodyRadius) {
        if (travelled < a.aoer) {return out(true);}
        hit = { x: px, y: py, z: pz };
        break;
      }
      const foe = this.foeScan(a.foes, { x: px, y: py, z: pz }, travelled, a.aoer, a.aoeDamage);
      if (foe === 'blocked') {return out(true);}
      if (foe !== null) {
        hit = { x: px, y: py, z: pz };
        bodyHit = foe === 'hit' ? null : foe;
        break;
      }
    }
    return out(false);
  }

  /** Enemy bodies on the path pop the shell too - an intercept at 5m
   *  self-splashes exactly like a lip hit, and "a point-blank trade is
   *  a trade" only holds when the blast actually kills him (soak
   *  autopsy: most untraded selfK was a foe body eating the shell
   *  inside the shooter's blast envelope and surviving it). */
  private foeScan(foes: PlayerState[], at: Vec3, travelled: number, aoer: number, aoeDamage: number): PlayerState | 'hit' | 'blocked' | null {
    for (const f of foes) {
      const bx = f.position.x - at.x, by = f.position.y + 1 - at.y, bz = f.position.z - at.z;
      if (bx * bx + by * by + bz * bz >= 2.6) {continue;}
      if (travelled >= aoer) {return 'hit';} // pop beyond the blast envelope - just ends the march
      // Trade test: the pop lands inside our own blast envelope, so the
      // shot only exists if the splash likely kills the body it's about
      // to hit - a sacrifice, not a whiff.
      return f.health <= aoeDamage * 0.8 ? f : 'blocked';
    }
    return null;
  }

  /** Self-collision ahead: the blast radius is measured shooter→pop at
   *  detonation, and a bot skiing INTO his own shot covers real distance
   *  during flight - a rocket the muzzle clears still frags him if his
   *  velocity delivers him inside the radius by impact time. */
  private selfCatch(muzzle: Vec3, hit: Vec3, ownerVel: Vec3, flightT: number, aoer: number): boolean {
    const sx = muzzle.x + ownerVel.x * flightT - hit.x;
    const sy = muzzle.y + ownerVel.y * flightT - hit.y;
    const sz = muzzle.z + ownerVel.z * flightT - hit.z;
    // The projection assumes constant speed, but a skier on a descent
    // (or a mid-flight propel - soak autopsy: propelK:0, aimed shots
    // are the lip selfK) gains real m/s before the shell lands. Price
    // the gain a downhill runner actually picks up in-flight (~half
    // his speed again over the short flight), not a full safety band.
    const speedGain = Math.min(6, Math.hypot(ownerVel.x, ownerVel.z) * flightT * 0.5);
    const reach = aoer + speedGain;
    return sx * sx + sy * sy + sz * sz < reach * reach;
  }

  /** Entity intercepts inside the blast envelope: a wandering ball,
   *  a species pop, an enemy dome edge, or a teammate body on the
   *  muzzle line pops the shell at ITS distance - inside the shooter's
   *  own blast radius, for zero enemy damage (soak: point-blank selfK
   *  @5m, foe@140m). Enemy bodies stay legal - a point-blank trade is
   *  a trade. */
  private blastEnvelopeHit(muzzle: Vec3, dir: Vec3, aoer: number, shooterId?: string, shooterTeam?: string): boolean {
    const to = { x: muzzle.x + dir.x * aoer, y: muzzle.y + dir.y * aoer, z: muzzle.z + dir.z * aoer };
    // Enemy domes eat the shell at the field edge - the flight sweep
    // models them (projContact.shieldBlock), the clearance march can't
    // miss what flight will hit: a bot firing across a dome edge pops
    // his own shell inside his own blast envelope.
    if (this.room.deployables.shieldBlock(muzzle, to, shooterId ?? '') !== null) {return true;}
    if (this.room.ballSim?.sweepHit(muzzle, to, 1)) {return true;}
    if (this.room.creatureSim?.sweepHit(muzzle, to, 1)) {return true;}
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === shooterId || q.isDead) {continue;}
      if (shooterTeam && q.team !== shooterTeam) {continue;}
      const ex = q.position.x - muzzle.x, ey = q.position.y - muzzle.y, ez = q.position.z - muzzle.z;
      const t = Math.max(0, Math.min(1, (ex * dir.x + ey * dir.y + ez * dir.z) / aoer));
      const rx = ex - dir.x * aoer * t, ry = ey - dir.y * aoer * t, rz = ez - dir.z * aoer * t;
      if (rx * rx + ry * ry + rz * rz < 4) {return true;}
    }
    return false;
  }
}
