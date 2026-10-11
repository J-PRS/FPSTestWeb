import type { ServerMessage, Vec3, PlayerState } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import { WORLD_MODEL, eventPayload } from '../../shared/worldModel.ts';
import {type WeaponStats, getWeaponStats, WeaponType, ARMORNADE_ARMOR, HEALNADE_HEAL, CONC_JET_DRAIN} from '../../shared/weapons.ts';
import { healPool } from './healPool.ts';
import { perkMods } from '../../shared/perks.ts';
import { classMass } from '../../shared/botClasses.ts';
import { aoeDamage, aoeImpulseT1At, t1Minbox, KNOCKBACK_SCALE, BLAST_IMPULSE_MAX, LG_POP_DMG_CAP, LG_POP_RADIUS_MIN, LG_POP_RADIUS_MAX, SELF_SPLASH_MAX } from '../../shared/combat.ts';
import { POWERUP } from '../../shared/pickups.ts';
import {type ColliderIndex, blastOccluded} from '../../shared/solidWorld.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { rewindPos, shooterTransitMs } from './claimLedger.ts';
import { renderLagOf } from './rewind.ts';
import { logger } from './logger.ts';
import { wallNow , wallMs} from './wallClock.ts';
import { simNow } from './simClock.ts';
import type { RoomEventSink } from './roomEvents.ts';

// How long a hit/knocked-back player stays on the unsuppressed full-rate
// tick path — covers the shooter's predicted-knockback window (~0.6s)
// plus margin so the real trajectory replaces the prediction.
export const FORCE_SEND_MS = 900;

/** One blast's derived envelope — computed once per processAOE, shared
 *  by every target the splash sweep touches. */
interface BlastCtx {
  shooterId: string;
  ping: number;
  lagMs: number;
  /** Per-victim lag map from the shooter's clientStats — overrides lagMs
   *  per target when present (a max-across-remotes rewind overshoots fast
   *  ghosts the shooter tracked at short delay). */
  lagMap?: Record<string, number>;
  bot: boolean;
  pos: Vec3;
  radius: number;
  baseDamage: number;
  scales?: readonly number[];
  impulse: number;
  pull: boolean;
  label: string;
  weapon?: number;
  shotId?: string;
  air?: number; // projectile airtime — rides to the kill feed
}

/** The CombatHandler surface the blast sweep reads. */
export interface BlastHost {
  playerManager: PlayerManager;
  deps: {
    /** Blast aftermath lands as room events — the Room fans each one
     *  out to the subsystem that owns it (deployables, loose flags and
     *  pickups, wildlife, armor sweeps, the move shadow). */
    emit?: RoomEventSink;
    /** Jet-tank access — the concussion payload saps victim energy. */
    drainEnergy?: (playerId: string, amount: number) => void;
    health?: Map<string, number>;
    /** Target uplink-transit estimate (ms) — the same value the tick
     *  broadcast leads remote positions by. */
    transitOf?: (playerId: string) => number;
  };
  sendToPlayer: (playerId: string, msg: ServerMessage) => void;
  solids: readonly StructureCollider[];
  solidIndex: ColliderIndex | null;
  hb(key: string, n?: number): void;
  friendly(shooterId: string, targetId: string): boolean;
  reject(playerId: string, kind: string, reason: string, targetId?: string, weaponType?: number): void;
  applyHit(shooterId: string, targetId: string, damage: number,
           result: { killed: boolean; newHealth: number; newArmor: number },
           opts: { label: string; extra?: Record<string, unknown>; weapon?: number; shotId?: string; air?: number }): void;
  ddMult(shooter: PlayerState): number;
}

/** Every explosion the server resolves: client-claimed blast sweeps,
 *  trusted server blasts (room sims, charge pops), armor-nade plating,
 *  mine blasts — plus the shared splash/shove/occlusion internals.
 *  Split from CombatHandler so the claim-validation half stays readable. */
export class BlastRunner {
  constructor(private h: BlastHost) {}

  processAOE(playerId: string, position: Vec3, excludeTargetId: string | null | undefined, stats: WeaponStats, opts: { weapon?: number; trusted?: boolean; shotId?: string; bound?: boolean; air?: number } = {}): void {
    const { weapon, trusted = false, shotId, bound = false, air } = opts;
    const player = this.h.playerManager.getPlayer(playerId);
    // Trusted server blasts still run from dead owners — a corpse's
    // in-flight ordnance and its charge-pop both outlive the kill.
    if (!player || (player.isDead && !trusted)) {return;}
    // A NaN blast center fails every `d > radius` skip below — the whole
    // fan-out (splash, plating, heals, flag/pickup punts) would resolve
    // against NaN distances instead of resolving nothing.
    if (!Number.isFinite(position.x + position.y + position.z)) {return;}

    // Projectile-bound blasts already passed validateAoeClaim (airtime,
    // flight reach, occlusion) — the flat shooter-distance gate is for
    // self-positioned claims only, and wrongly rejects legit cross-map
    // lobs on ~1km maps (652m mortar splash on surreal).
    if (!trusted && !bound && !this.blastInReach(playerId, player, position, weapon)) {return;}

    const pull = stats.forceMode === 'pull';
    // Perk modifies the blast envelope, not the damage numbers — a
    // Sharpshooter's rocket lands tighter, not weaker.
    const radius = stats.aoeRadius * perkMods(player.perk).aoeRadius;
    const ctx: BlastCtx = {
      shooterId: playerId, ping: player.ping, bot: Boolean(player.isBot), pos: position,
      lagMs: player.isBot ? 0 : renderLagOf(player),
      lagMap: player.isBot ? undefined : player.clientStats?.renderLag,
      // Splash pays a banded fraction of the DIRECT hit — aoeDamage on
      // the stat block only survives as the base for damage-only specials
      // (melee arc, injected LG pop charge) that have no directDamage.
      radius, baseDamage: (stats.directDamage || stats.aoeDamage) * this.h.ddMult(player), scales: stats.aoeScales,
      impulse: stats.knockbackForce, pull,
      label: pull ? 'disc AOE' : 'AOE', weapon, shotId, air,
    };

    this.splashTargets(ctx, playerId, excludeTargetId);

    // Deployables in the blast envelope eat the same scaled splash —
    // sentries aren't immortal, you clear a stand with explosives.
    // Two damage lines ride the event: `damage` is the direct-hit pay,
    // `splash` the aoe line — deployables inside their contact radius
    // take the first, everyone else the second's falloff.
    this.h.deps.emit?.({
      type: 'blast', pos: position, damage: ctx.baseDamage, radius, shooterId: playerId, scales: ctx.scales, weapon,
      splash: stats.aoeDamage * this.h.ddMult(player),
    });

    // Loose physical objects — flags, pickups, wildlife — get punted by
    // every blast (claimed or trusted) through this one funnel. The client
    // predicts each shove; the server-side impulse is what makes it stick
    // instead of snapping back on the next truth update.
    this.h.deps.emit?.({ type: 'knock', pos: position, radius, force: stats.knockbackForce, kind: 'flag', pull });
    this.h.deps.emit?.({ type: 'knock', pos: position, radius, force: stats.knockbackForce, kind: 'pickup', pull });
    this.h.deps.emit?.({ type: 'knock', pos: position, radius, force: stats.knockbackForce, kind: 'prey', pull });

    // Armor grenade: the blast's payload is plating, not just damage.
    if (weapon === WeaponType.ArmorGrenade) {this.plateAll(playerId, position, radius, ctx);}
    // Heal burst — allies caught get the strong heal; enemies got their
    // sting through the normal splash sweep above.
    if (weapon === WeaponType.HealGrenade) {this.healAll(playerId, position, radius, ctx);}
  }

  /** Cheat prevention: bound the blast to plausible projectile range —
   *  legit long shots (mortar arcs, cross-map rockets) fly hundreds of
   *  metres; 200m was rejecting real hits. 500m still catches the cheat
   *  this guards: a blast teleported to a victim across the map. */
  private blastInReach(playerId: string, player: PlayerState, position: Vec3, weapon?: number): boolean {
    const dx = player.position.x - position.x;
    const dy = player.position.y - position.y;
    const dz = player.position.z - position.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq <= 250_000) {return true;} // 500m squared
    this.h.reject(playerId, 'AOE', `blast too far from shooter (${Math.sqrt(distSq).toFixed(0)}m)`, undefined, weapon);
    return false;
  }

  /** Every live player except the direct-hit victim takes the splash
   *  roll — including the shooter, but only for bots: a bot's velocity is
   *  server truth so a disc-jump blast must land here, while human
   *  clients self-predict their own displacement and would double-apply. */
  private splashTargets(ctx: BlastCtx, playerId: string, excludeTargetId: string | null | undefined): void {
    for (const [targetId, target] of this.h.playerManager.getAllPlayers()) {
      if (target.isDead) {continue;}
      // The direct-hit victim already paid direct damage through the hit
      // claim — but the blast still launches them: every client predicted
      // the shove on everyone in radius, so skipping the impulse left
      // server-owned bodies unmoved (bots snapped back from the predicted
      // arc) and a knocked human's reports read as divergence.
      if (targetId === excludeTargetId) {
        this.splashOne(ctx, targetId, target, false, undefined, true);
        continue;
      }
      this.splashOne(ctx, targetId, target, targetId === playerId);
    }
  }

  /** Armor-grenade plating sweep: coats EVERY player caught — friend or
   *  foe (arming the enemy is the thrower's cost) — plus the creature
   *  sweep. Same lag-comp + occlusion rules as damage. */
  private plateAll(playerId: string, position: Vec3, radius: number, ctx: BlastCtx): void {
    for (const [targetId, target] of this.h.playerManager.getAllPlayers()) {
      if (target.isDead) {continue;}
      const tpos = this.rewindTarget(target, targetId, ctx.shooterId, ctx.ping, ctx.bot, ctx.lagMs, ctx.lagMap);
      const d = Math.hypot(tpos.x - position.x, tpos.y - position.y, tpos.z - position.z);
      if (d > radius) {continue;}
      if (this.h.solids.length > 0 && this.blastBlocked(position, tpos)) {continue;}
      target.armor = Math.min(POWERUP.maxArmor, target.armor + ARMORNADE_ARMOR);
      target.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
      this.h.hb('armor.nade');
      logger.info('Armor grenade plated player', { shooter: playerId, target: targetId, armor: target.armor });
    }
    this.h.deps.emit?.({ type: 'armor', pos: position, amount: ARMORNADE_ARMOR, radius });
  }

  /** Heal-grenade sweep: self + allies only — a heal that tops off the
   *  enemy squad is strictly worse than a mortar. friendly() returns
   *  false for self (self-splash law) and for everyone in FFA, so the
   *  thrower is admitted explicitly or a feet-heal — the kit's most
   *  common use — lands nothing. Heal fades with distance like damage
   *  does, same lag-comp + occlusion rules. */
  private healAll(playerId: string, position: Vec3, radius: number, ctx: BlastCtx): void {
    for (const [targetId, target] of this.h.playerManager.getAllPlayers()) {
      if (target.isDead || (targetId !== playerId && !this.h.friendly(playerId, targetId))) {continue;}
      const tpos = this.rewindTarget(target, targetId, ctx.shooterId, ctx.ping, ctx.bot, ctx.lagMs, ctx.lagMap);
      const d = Math.hypot(tpos.x - position.x, tpos.y - position.y, tpos.z - position.z);
      if (d > radius) {continue;}
      if (this.h.solids.length > 0 && this.blastBlocked(position, tpos)) {continue;}
      // Center-of-blast heals full, the rim heals half — worth leading
      // the throw, not just tossing it over the wall.
      healPool(target, HEALNADE_HEAL * (1 - 0.5 * (d / radius)));
      target.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
      this.h.hb('heal.nade');
      logger.debug('Heal grenade', { shooter: playerId, target: targetId, hp: target.health });
    }
  }

  /** Rewind a victim to where it sat on the SHOOTER's screen. The
   *  rendered ghost = broadcast(sim(t − shooterTransit − interpDelay)
   *  + vel·lead) and rewind history rides the target's uplink, so the
   *  terms cancel to shooterTransit + interpDelay − targetTransit:
   *  one-way hops only — a full-RTT term validates ~RTT/2 behind the
   *  ghost (hits landing on a model the shooter already left behind). */
  private rewindTarget(target: PlayerState, targetId: string, shooterId: string, ping: number, bot: boolean, lagMs: number, lagMap?: Record<string, number>): Vec3 {
    lagMs = lagMap?.[targetId] === undefined ? lagMs : Math.min(Math.max(lagMap[targetId]!, 0), 800);
    // Bots read live positions — a bot shooter has no render pipeline,
    // so there is no ghost to rewind toward.
    if (bot) {return { x: target.position.x, y: target.position.y, z: target.position.z };}
    const targetTransit = this.h.deps.transitOf?.(targetId) ?? 0;
    const back = shooterTransitMs(this.h.deps.transitOf, shooterId, ping) + lagMs - targetTransit;
    return rewindPos(target, Math.max(0, back));
  }

  /** One target inside (or outside) a blast envelope: lag-comp position,
   *  wall occlusion, scaled damage, knockback impulse, friendly gate. */
  splashOne(ctx: BlastCtx, targetId: string, target: PlayerState, shoveOnly = false, directDmg?: number, impulseOnly = false): void {
    // Lag-comp the victim position the same as hitscan — a rocket
    // that exploded on the shooter's screen should hit the ghost.
    // The SHOOTER is exempt: their own blast already popped under their
    // feet on their screen — rewinding their ghost ~lagMs behind a fast
    // ski drops it outside the envelope, and self-damage silently dies.
    const tpos = targetId === ctx.shooterId
      ? { x: target.position.x, y: target.position.y, z: target.position.z }
      : this.rewindTarget(target, targetId, ctx.shooterId, ctx.ping, ctx.bot, ctx.lagMs, ctx.lagMap);
    const tdx = tpos.x - ctx.pos.x;
    const tdy = tpos.y - ctx.pos.y;
    const tdz = tpos.z - ctx.pos.z;
    const dist = Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz);
    // T1 impulse reaches to surface distance = radius (~minbox past the
    // center rim) — the early cut has to use the same envelope.
    if (!Number.isFinite(dist) || dist - t1Minbox(target.armorClass) > ctx.radius) {return;}

    // Wall occlusion — a blast outside a structure doesn't splash
    // targets inside it (and vice versa). Blasts can legitimately
    // sit INSIDE geometry (shell popped at the face), so a contact
    // at t≈0 is stepped past rather than counted.
    if (this.h.solids.length > 0 && this.blastBlocked(ctx.pos, tpos)) {return;}

    // Spawn-shielded victim: damage already returns early inside
    // applyDamage, but the shove landed anyway — an "invulnerable" target
    // that still launches reads as a phantom push with zero feedback.
    // Self/friendly assists unaffected: the shooter's own shield dies at
    // trigger-pull, and jump-boosts are beneficial by design. The hit
    // itself still registers (applyHit runs — shooter sees the contact,
    // victim just doesn't move).
    const protectedTarget = targetId !== ctx.shooterId && simNow() < target.protectedUntil && !this.h.friendly(ctx.shooterId, targetId);

    const impulseMag = Math.min(
      aoeImpulseT1At(ctx.impulse, ctx.pos, tpos, ctx.radius, target.armorClass) * KNOCKBACK_SCALE * perkMods(target.perk).knockbackTaken,
      BLAST_IMPULSE_MAX);
    // impulseOnly: the direct-hit victim — damage was paid through the
    // hit claim, but the blast displacement is still owed (wire notify +
    // shadow impulse + forceSend, same as a splash shove).
    if (impulseOnly) {
      if (!protectedTarget) {this.shove(targetId, target, { x: tdx, y: tdy, z: tdz }, impulseMag, ctx.pos, ctx.pull);}
      return;
    }

    // shared/combat.ts — same formula the client predicts with; beam ticks
    // pass a flat figure (the ramp already IS the falloff)
    const damage = directDmg ?? aoeDamage(ctx.baseDamage, dist, ctx.radius, ctx.scales);
    if (damage <= 0) {return;}

    // Humans self-predict their own displacement — server only shoves
    // the self-target when it's a bot (server velocity truth).
    if ((!shoveOnly || target.isBot) && !protectedTarget) {
      this.shove(targetId, target, { x: tdx, y: tdy, z: tdz }, impulseMag, ctx.pos, ctx.pull);
    }
    if (shoveOnly && ctx.weapon === WeaponType.Melee) {return;}
    // A swing is not a feet-blast — the punch point sits inside its own
    // envelope by design, so the self-splash tax charged every punch.
    // Slam keeps paying: diving into the ground IS a self-blast.
    if (shoveOnly) {
      // Self-propulsion still pays blood: the cost fades with distance
      // inside the blast radius — a feet blast lands near SELF_SPLASH_MAX,
      // a rim graze costs scraps. Continuous, so no cliff-edge price.
      // Feet blasts pay the full disc-jump price; past 3m the cost
      // falls off linearly to the rim — a stray shell popping a
      // few meters out still costs a real chunk, not a third of
      // the bar (fully quadratic read sterile — humans self-frag
      // sloppier than ~0.5% of kills).
      const near = Math.max(0, 1 - Math.max(0, dist - 3) / Math.max(1, ctx.radius - 3));
      // Perk mods reach this path too — lightfoot's selfDamage:0.5 was
      // client-only, so bots drawing the perk paid full blood for every
      // propel while the roster pin (capper=lightfoot) did nothing.
      const selfDmg = Math.min(damage + SELF_SPLASH_MAX * (1 - dist / ctx.radius), SELF_SPLASH_MAX) * near * perkMods(target.perk).selfDamage;
      if (selfDmg > 0) {
        const result = this.h.playerManager.applyDamage(targetId, selfDmg);
        this.h.applyHit(ctx.shooterId, targetId, selfDmg, result, { label: `Player ${ctx.label} self-blast`, extra: { dist: Number(dist.toFixed(2)), pos: ctx.pos }, weapon: ctx.weapon, shotId: ctx.shotId, air: ctx.air });
      }
      return;
    }

    // Splash still displaces teammates (jump-boost assists); it just
    // never deals damage to them in team rooms.
    if (this.h.friendly(ctx.shooterId, targetId)) {return;}
    const result = this.h.playerManager.applyDamage(targetId, damage);
    this.h.applyHit(ctx.shooterId, targetId, damage, result, { label: `Player ${ctx.label} hit`, extra: { dist: Number(dist.toFixed(2)) }, weapon: ctx.weapon, shotId: ctx.shotId, air: ctx.air });
    // Concussion payload: the conc's whole job is stripping the flag —
    // a carrier clipped by the blast fumbles it like in T2, and the
    // victim's jet tank takes a bite so the escape is hobbled too.
    if (ctx.weapon === WeaponType.Concussion) {
      this.h.deps.emit?.({ type: 'flagDrop', playerId: targetId });
      this.h.deps.drainEnergy?.(targetId, CONC_JET_DRAIN);
    }
  }

  /** One blast shove: velocity impulse + knockback wire notify + the
   *  forceSend flag that makes the next position update authoritative.
   *  `offset` is target-from-blast; `pull` reverses direction and
   *  flattens the up-vector (disc suck). */
  private shove(targetId: string, target: PlayerState, offset: Vec3, impulseMag: number, pos: Vec3, pull: boolean): void {
    const dist = Math.hypot(offset.x, offset.y, offset.z);
    // NaN comparisons pass below (dist<=0 on NaN is false) — a poisoned
    // impulse or offset would write NaN velocity the shadow never shakes.
    if (!(dist > 0) || !Number.isFinite(impulseMag)) {return;}
    // Mass is real now — a heavy mech eats 20% less shove, a light sails
    // 33% further. The wire force stays pre-mass: the victim's own
    // applyKnockback divides by its class, so both ends land the same dv.
    const m = classMass(target.armorClass);
    const eff = impulseMag / m;
    const dv: Vec3 = pull
      ? { x: -(offset.x / dist) * eff, y: 0.3 * eff, z: -(offset.z / dist) * eff }
      : { x: (offset.x / dist) * eff, y: 0.5 * eff, z: (offset.z / dist) * eff };
    target.velocity.x += dv.x;
    target.velocity.y += dv.y;
    target.velocity.z += dv.z;
    this.h.deps.emit?.({ type: 'impulse', playerId: targetId, dv });
    target.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
    this.h.sendToPlayer(targetId, eventPayload(WORLD_MODEL.player!, 'knockback', 'targetId', targetId, {
      position: pos, force: impulseMag, pull: pull || undefined,
    }) as ServerMessage);
  }

  /** The charge pop itself — a Lightning-stat blast scaled by the amount
   *  detonated, credited to the detonating shooter. ChargeBank decides
   *  when this fires; the blast is ours. */
  pop(ownerId: string, pos: Vec3, amount: number): void {
    const lgStats = getWeaponStats(WeaponType.Lightning);
    this.processAOE(ownerId, { ...pos}, null, { ...lgStats, aoeDamage: Math.min(amount, LG_POP_DMG_CAP),aoeRadius: Math.min(LG_POP_RADIUS_MIN + amount * 0.12, LG_POP_RADIUS_MAX),knockbackForce: 30}, { weapon: WeaponType.Lightning, trusted: true });
  }

  /** True when a wall stands between blast point and target chest.
   *  The blast point itself may sit inside geometry (a shell that just
   *  kissed a face) — step 0.4m past each t=0 contact, up to 3 hops,
   *  before concluding the target is really occluded. */
  private blastBlocked(from: Vec3, toEye: Vec3): boolean {
    return blastOccluded(from, toEye, this.h.solids, this.h.solidIndex ?? undefined);
  }

  /** Server-owned blast — the room's projectile/deployable sims decided
   *  where this pops, so the shooter-distance sanity check doesn't apply. */
  serverBlast(ownerId: string, position: Vec3, weaponType: number, excludeTargetId?: string | null, shotId?: string, attribWeaponType?: number, power?: number): void {
    const base = getWeaponStats(weaponType);
    if (!base || base.aoeRadius <= 0) {return;}
    // Power-scaled variants (Slam dive-speed blast) keep the identity
    // fields and multiply the payload envelope — same formula the client
    // predicts with.
    const stats = power === undefined ? base : ({ ...base, aoeDamage: base.aoeDamage * power,aoeRadius: base.aoeRadius * power,knockbackForce: base.knockbackForce * power});
    this.processAOE(ownerId, position, excludeTargetId, stats, { weapon: attribWeaponType ?? weaponType, trusted: true, shotId });
    // Live nuggets are fair game too — a shell near a gem can punt it.
    // Both loose objects' knocks live inside processAOE above.
  }

  /** Server-owned mine blast — owner is the shooter for scoring/friendly
   *  checks, but the sim decided to detonate. Position check skipped: the
   *  blast center is the mine's own spot, not the owner's. */
  mineBlast(ownerId: string, pos: Vec3, maxDamage: number, radius: number, knockback: number): void {
    const owner = this.h.playerManager.getPlayer(ownerId);
    const baseDamage = maxDamage * (owner ? this.h.ddMult(owner) : 1);
    this.h.deps.emit?.({ type: 'knock', pos, radius, force: knockback, kind: 'pickup' });
    this.h.deps.emit?.({ type: 'knock', pos, radius, force: knockback, kind: 'flag' });
    this.h.deps.emit?.({ type: 'knock', pos, radius, force: knockback, kind: 'prey' });
    // Wildlife isn't mine-savvy — a popping trap catches the swarm too.
    this.h.deps.emit?.({ type: 'preySplash', ownerId, pos, radius, maxDamage: baseDamage });
    for (const [targetId, target] of this.h.playerManager.getAllPlayers()) {
      if (target.isDead) {continue;}
      const dx = target.position.x - pos.x;
      const dy = target.position.y - pos.y;
      const dz = target.position.z - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist - t1Minbox(target.armorClass) > radius) {continue;}
      // Spawn-shielded targets take the hit but not the shove — same gap
      // splashOne closes: "invulnerable" targets that still launch read
      // as phantom wind.
      const protectedTarget = targetId !== ownerId && simNow() < target.protectedUntil && !this.h.friendly(ownerId, targetId);
      // Falloff + shove from shared formulas — client predicts the same hit.
      const damage = targetId === ownerId ? 0 : aoeDamage(baseDamage, dist, radius);
      const impulseMag = aoeImpulseT1At(knockback, pos, target.position, radius, target.armorClass) * KNOCKBACK_SCALE * perkMods(target.perk).knockbackTaken;
      if (!protectedTarget) {this.shove(targetId, target, { x: dx, y: dy, z: dz }, impulseMag, pos, false);}
      // Owner eats the blast too — mines don't pick friends.
      if (!this.h.friendly(ownerId, targetId) && damage > 0) {
        const result = this.h.playerManager.applyDamage(targetId, damage);
        target.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
        this.h.applyHit(ownerId, targetId, damage, result, { label: 'Mine hit', extra: { dist: Number(dist.toFixed(2)) } });
      }
    }
  }
}
