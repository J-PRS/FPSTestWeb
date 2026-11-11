/**
 * BotRoster — the squad bookkeeping family for ServerBots: spawning
 * roster entries, armor-class swaps, role rebalancing, and the botFill
 * population floor. Kept apart so ServerBots's tick loop owns "what does
 * each bot do this frame" while this owns "who is in the squad".
 */
import type { Room } from './Room.ts';
import { BotBrain } from '../../shared/botBrain.ts';
import { logger } from './logger.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import { gunGameWeapon, igunChassis } from '../../shared/gunGame.ts';
import { CLASS_STATS, classCanFire, type ArmorClass } from '../../shared/botClasses.ts';
import { BOT_LOADOUTS, BOT_ALT_SLOTS, WILDCARD_SLOTS, botClassForLoadout, rollWildcard, rollBotPerk, adaptLoadout, type BotLoadout, type LoadoutSlot } from '../../shared/botLoadouts.ts';
import { aimSkillFor , type BotSkillSpec } from '../../shared/botSkill.ts';
import { botRand } from '../../shared/botRand.ts';
import { BOT_NAMES } from '../../shared/botNames.ts';
import { CLASS_FITNESS, ROLE_PRIORITY, STRICT_CLASS, misfitClass, type BotRole } from '../../shared/flagGoals.ts';
import { isSuper } from './superBot.ts';
import { invEq } from '../../shared/invariants.ts';
import { perkMods } from '../../shared/perks.ts';
import { CONFIG } from './config.ts';
import { healPool } from './healPool.ts';
import { wallNow } from './wallClock.ts';
import { WORLD_MODEL, spawnPayload } from '../../shared/worldModel.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

// FPS_SOAK_RANDLO=1: every slot draws from the union of weapons the
// authored kits place there — measures raw per-weapon lethality with
// kit frequency removed (innate per-weapon skill still biases picks).
const slot = (k: 'near' | 'mid' | 'far' | 'belt' | 'side'): WeaponType[] =>
  [...new Set(BOT_LOADOUTS.map((l): WeaponType => l[k]))];

const RANDLO = (() => {
  return { near: slot('near'), mid: slot('mid'), far: slot('far'), belt: slot('belt'), side: slot('side') };
})();
const pickOf = <T,>(pool: T[]): T => pool[Math.floor(botRand() * pool.length) % pool.length]!;

/** Strict-tier roles re-fit a donor's body (shared/flagGoals.ts —
 *  the offline lobby applies the same table). */


export class BotRoster {
  private roles = new Map<string, BotRole>();
  private classes = new Map<string, ArmorClass>();
  /** The slot candidates each bot may reroll — authored alternates for
   *  table kits, the full combat pools for wildcards. Respawn
   *  adaptation reads this to drift the kit toward what the bot hits
   *  with; a wildcard keeps every slot live. */
  private alts = new Map<string, Partial<Record<LoadoutSlot, WeaponType[]>>>();
  private nextIdx = 1;
  private maintainAt = 0;
  private roleT = 0;

  constructor(
    private room: Room,
    private brains: Map<string, BotBrain>,
    private loadouts: Map<string, BotLoadout>,
    private thinkPhase: Map<string, number>,
    private untrackBot: (id: string) => void,
    private thinkDiv: number,
  ) {}

  /** Spawn n bots — each is a real roster entry (playerJoined broadcasts)
   *  minus a socket. Call once at room creation, before human joins, so
   *  team balancing lands humans on the emptier side. */
  populate(n: number): void {
    for (let i = 0; i < n; i += 1) {
      // Callsign from the shared pool, not the room name — 'BOT-escalade-11'
      // read as a map tag, not a pilot. The index suffix stays IN THE ID:
      // per-id seeds (routePref, jitteredTtl) hash the string, and display
      // strips it via botDisplayName — pilots on screen, unique seeds on
      // the wire.
      const idx = ((this.nextIdx += 1) - 1);
      const id = `BOT-${BOT_NAMES[(idx - 1) % BOT_NAMES.length]}-${String(idx).padStart(2, '0')}`;
      const kitIdx = (this.nextIdx - 2 + BOT_LOADOUTS.length) % BOT_LOADOUTS.length;
      const wildcard = botRand() < 0.125;
      const insta = this.room.mods.instagib === true;
      let loadout;
      if (insta) {
        // Instagib kit: every band slot is the railgun, the belt is the
        // hook - pickBotWeapon can only ever draw legal weapons, and an
        // empty alt table freezes adaptOnRespawn's reroll too.
        loadout = { perk: 'jumpstart' as const, near: WeaponType.Railgun, mid: WeaponType.Railgun, far: WeaponType.Railgun, belt: WeaponType.Hook, side: WeaponType.Railgun };
      } else if (process.env.FPS_SOAK_RANDLO === '1') {loadout = { perk: 'lifesteal' as const, near: pickOf(RANDLO.near), mid: pickOf(RANDLO.mid), far: pickOf(RANDLO.far), belt: pickOf(RANDLO.belt), side: pickOf(RANDLO.side) };}
      else {
        loadout = wildcard ? rollWildcard(botRand) : BOT_LOADOUTS[kitIdx]!;
        // Perk is a spawn roll, not kit identity - the authored table
        // fields the weapons, the perk table fields the person.
        loadout = Object.assign({}, loadout, {perk: rollBotPerk(loadout, botRand)});
      }
      this.alts.set(id, insta ? {} : (wildcard ? WILDCARD_SLOTS : (BOT_ALT_SLOTS[kitIdx] ?? {})));
      // Kit picks the body, then the squad's weighted fill picks the
      // job — plated/mortar kits anchor heavy, featherjets flies light,
      // everything else runs medium until rebalance assigns a role.
      const cls = botClassForLoadout(loadout);
      // Team BEFORE spawn — addPlayer picks the point, and an unaffiliated
      // pick falls back to the flat pool which straddles both bases
      // (bastion): the bot materializes inside the enemy's defended base.
      const p = this.room.players.addPlayer(id, this.room.nextTeam(), loadout.perk, cls, true);
      this.loadouts.set(id, loadout);
      this.roles.set(id, 'offense');
      p.weapon = loadout.near; // best guess until a real shell spawns — the roster carries it
      this.applyClass(p, cls);
      p.isBot = true;
      // Q-skill: a per-class pool so lights favor mobility teleports,
      // heavies favor the dive/endurance - a seat without a declared
      // skill has nothing legal to press at all.
      p.skill = cls === 'light' ? (botRand() < 0.6 ? 'blink' : 'dash')
        : cls === 'heavy' ? (botRand() < 0.5 ? 'slam' : 'medkit')
        : (['dash', 'bounce', 'warp', 'shield'] as const)[Math.floor(botRand() * 4)]!;
      if (isSuper(id)) {p.health = 400;} // superbot tanks a beating
      p.lastSeen = wallNow();
      this.room.assignTeam(p);
      this.brains.set(id, new BotBrain(p.position, this.tierFor(p.team)));
      // The spawn pick is thoughtful, not flat: the fresh brain's skill
      // matrix rerolls every open slot toward what this bot hits with.
      this.adaptOnRespawn(id, (w): number => aimSkillFor(this.brains.get(id)!.skill, w, 0), 'spawn');
      // Reveal the post-adapt gun: adapt can swap the near slot, and
      // the roster/broadcast read p.weapon as the held silhouette.
      p.weapon = this.loadouts.get(id)!.near;
      this.room.broadcast(spawnPayload(WORLD_MODEL.player!, id, 'playerId', {
        name: p.name,
        internalId: p.internalId,
        position: p.position,
        rotation: p.rotation,
        team: p.team,
        transport: p.transport,
        armorClass: cls,
        weapon: p.weapon,
        health: p.health,
        isDead: p.isDead,
      }) as ServerMessage);
      if (wildcard) {logger.info('Bot wildcard kit', { id, room: this.room.name, kit: { near: this.loadouts.get(id)!.near, mid: this.loadouts.get(id)!.mid, far: this.loadouts.get(id)!.far, belt: this.loadouts.get(id)!.belt, side: this.loadouts.get(id)!.side, perk: loadout.perk } });}
      // Phase by name-hash, not roster order: sequential assignment put
      // every alternating team's brain first in a majority of phase
      // groups (alphas think+fire before bravos in 3 of 5 groups every
      // tick) - a small first-mover edge that headhunt's economy then
      // amplified into a side bias (map-seat soaks measured alpha
      // K/D ~1.4-1.56 from this alone).
      let ph = 0;
      for (const c of id) {ph = (ph * 31 + c.charCodeAt(0)) >>> 0;}
      this.thinkPhase.set(id, ph % this.thinkDiv);
      // Legal body: the bot gets a move shadow exactly like a human join —
      // brains emit inputs, the sim owns motion, energy model included.
      this.room.moveSim.track(id, p.position, p.rotation.yaw, p.perk, p.team, true, cls);
    }
    if (n > 0) {logger.info('Bots spawned', { room: this.room.name, count: n });}
  }

  /** Team's difficulty spec from spec.botSkill — a bare tier covers
   *  the lobby, {alpha,bravo} handicaps sides, and either can be an
   *  axis mix ({aim:'impossible',move:'easy'}); unset is medium. */
  private tierFor(team: string | undefined): BotSkillSpec {
    const s = this.room.spec.botSkill;
    // A team wrapper always carries alpha or bravo; a bare spec is a
    // string or an axis mix, which never does.
    if (typeof s === 'string' || (s && !('alpha' in s) && !('bravo' in s))) {return s as BotSkillSpec;}
    if (s) {return (team === 'alpha' ? s.alpha : s.bravo) ?? 'medium';}
    return 'medium';
  }

  /** Re-fit a bot's body to its CURRENT loadout — scenarios that swap
   *  kits post-spawn call this so the armor follows the new kit, not
   *  whatever the spawn roll handed out. */
  public refitClass(id: string): void {
    const lo = this.loadouts.get(id);
    const p = this.room.players.getPlayer(id);
    if (!lo || !p) {return;}
    p.armorClass = this.room.mods.igun === true
      ? igunChassis(this.room.mods.gungame === true ? gunGameWeapon(this.room.gunRungOf(id), true) : p.weapon)
      : botClassForLoadout(lo);
    this.applyClass(p, p.armorClass as ArmorClass);
  }

  /** Apply the armor class to a live bot record: maxHealth shifts and
   *  current HP follows the delta (gaining plating grants the points,
   *  dropping it just clamps). The move shadow's ground scale makes the
   *  class legally different — a light capper really out-runs a heavy. */
  private applyClass(p: { id: string; perk: string; maxHealth: number; health: number }, cls: ArmorClass): void {
    // Unseeded map means the class bonus is ALREADY baked into maxHealth
    // by addPlayer (spawn calls this right after) — treating prev as
    // "no class" re-adds the bonus: heavies read 300, mediums 150, and
    // lights got a negative delta down to 50.
    const prev = this.classes.get(p.id) ?? cls;
    this.classes.set(p.id, cls);
    // Heavies shoulder the mortar — tier-locked ordnance is what makes the
    // class read as an anchor instead of just a slower medium. MRV is the
    // one legal peer pick: a fuse carrier the bot now engages at carry
    // range (preferredRange/fuse solve) rather than a dead far slot.
    if (cls === 'heavy') {
      const lo = this.loadouts.get(p.id);
      if (lo && lo.far !== WeaponType.Mortar && lo.far !== WeaponType.MRVLauncher) {this.loadouts.set(p.id, Object.assign({}, lo, {far: WeaponType.Mortar}));}
    }
    const delta = CLASS_STATS[cls].maxHealth - CLASS_STATS[prev].maxHealth;
    p.maxHealth += delta;
    healPool(p, Math.max(0, delta));
    // The pool is base+perk+class, always — a double-add or a stale-prev
    // refit breaks it and the badge/HUD start lying. invEq fires with
    // the offending numbers instead of another 300hp-heavy report.
    invEq('health-pool-formula', p.maxHealth,
      CONFIG.playerMaxHealth + perkMods(p.perk).maxHealth + CLASS_STATS[cls].maxHealth,
      0.01, { id: p.id, cls, prev, perk: p.perk });
    this.room.moveSim.setSpeedScale(p.id, CLASS_STATS[cls].speedScale);
    this.room.moveSim.setBody(p.id, CLASS_STATS[cls].mass, CLASS_STATS[cls].eyeHeight, CLASS_STATS[cls].radius);
    // Same class of bug as the unbury loop: record and sim must agree on
    // the body. The shadow may not exist yet (spawn applies the class
    // before track) — when it does, its eye IS the class eye.
    const simEye = this.room.moveSim.eyeOf(p.id);
    if (simEye !== undefined) {invEq('sim-eye-class-eye', simEye, CLASS_STATS[cls].eyeHeight,
      0.001, { id: p.id, cls });}
  }

  /** Rebalance squad roles ~every 5s. Needs are computed per team: a flag
   *  mode wants a capper; a bigger squad earns a HoF anchor, a technician
   *  and an infiltrator; the rest split offense/defense. Reassignment
   *  skips carriers mid-run — the flagGoal carrier check owns them. */
  private rebalanceRoles(now: number): void {
    if (!this.room.flags || now < this.roleT) {return;}
    this.roleT = now + 5000;
    const byTeam = new Map<string, string[]>();
    for (const id of this.brains.keys()) {
      const p = this.room.players.getPlayer(id);
      if (!p?.team) {continue;}
      (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)!).push(id);
    }
    for (const ids of byTeam.values()) {this.rebalanceTeam(ids);}
  }

  /** One team's role fill: walk ROLE_PRIORITY (capper@3 … infiltrator@7)
   *  so a 3-stack gets capper+LD and specialists only show once the
   *  lanes they free up are actually covered. */
  private rebalanceTeam(ids: string[]): void {
    // Never reassign a carrier — the flagGoal carrier check owns them.
    const free = ids.filter((id): boolean => {
      const p = this.room.players.getPlayer(id);
      if (!p || p.isDead) {return true;} // corpses re-role freely on respawn
      for (const f of this.room.flags!.flags.values()) {
        if (f.carrier === id) {return false;}
      }
      return true;
    });
    // Specialists are sticky: donors only come from the generic pool
    // (offense/defense), and a bot is consumed once per cycle — else the
    // same body flip-flops capper→hof→technician on every pass.
    const donors = free.filter((id): boolean => !ROLE_PRIORITY.some((w): boolean => this.roles.get(id) === w.role));
    for (const { role: want, want: need, minSquad } of ROLE_PRIORITY) {
      if (ids.length < minSquad) {break;}
      let have = 0;
      for (const id of ids) {if (this.roles.get(id) === want) {have += 1;}}
      while (have < need) {
        // Kit-weighted pick: the best-fit donor takes the slot
        // (CLASS_FITNESS argmax, id tiebreak) — a pull, not a gate, so
        // a squad of mediums still fills its capper slot.
        let donor: string | null = null;
        let bestFit = -Infinity;
        for (const id of donors) {
          const f = CLASS_FITNESS[this.room.players.getPlayer(id)?.armorClass ?? '']?.[want] ?? 1;
          if (f > bestFit || (f === bestFit && donor !== null && id < donor)) { bestFit = f; donor = id; }
        }
        if (!donor) {break;}
        donors.splice(donors.indexOf(donor), 1);
        this.roles.set(donor, want);
        const strict = STRICT_CLASS[want];
        // Rare misfit body: the role still reads, the chassis lies —
        // a heavy capper or light HoF is comedy, not a roster bug.
        const cls = strict && misfitClass(strict, botRand);
        const donorP = this.room.players.getPlayer(donor);
        // Instagib: roles still assign, but kit/class/perk mutations
        // would break the light+railgun contract the modifier owns.
        const instaKit = this.room.mods.instagib === true;
        if (!instaKit && donorP && cls) {
          // The sim re-fit alone leaves the wire record on the kit
          // class — a strict hof would stream 'medium' while playing
          // heavy mass/speed, i.e. a medium skin on a heavy sim.
          donorP.armorClass = cls;
          this.applyClass(donorP, cls);
          // A strict body can't carry class-locked guns — a heavy forced
          // onto a beam-rider kit would hold a railgun it may not fire.
          // Swap each illegal slot for a legal staple of the same band.
          const lo = this.loadouts.get(donor);
          if (lo) {
            const legal = (w: number, fb: WeaponType): number => classCanFire(cls, w) ? w : fb;
            this.loadouts.set(donor, Object.assign({}, lo, { near: legal(lo.near, WeaponType.Chaingun),mid: legal(lo.mid, WeaponType.Disc),far: legal(lo.far, WeaponType.BoltLauncher),side: legal(lo.side, WeaponType.Pistol)}));
          }
        }
        // Technician is the only role that promises the deploy kit —
        // pin its builder trait instead of trusting the spawn roll.
        // HoF gets the same nudge: mines+shields ARE the job. (The
        // deploy itself stays stochastic — a guideline, not a script.)
        if (want === 'technician' || want === 'hof') {this.brains.get(donor)?.setBuilder(true);}
        // A HoF that blasts off the flag on every nearby shell is a
        // HoF that isn't ON the flag — juggernaut is the perk a human
        // anchor would pick, and it's what makes "planted" physically
        // true instead of a goal the sim keeps vetoing.
        if (want === 'hof' && donorP && !instaKit) {donorP.perk = 'juggernaut';}
        // A capper who PREFERS pull rides the implosion disc — the
        // forward launch needs no heel-shot turnaround. Push-style
        // cappers keep their drawn belt and blast off their heels;
        // lobbies want both kinds of runner.
        if (!instaKit && want === 'capper') {
          const lo = this.loadouts.get(donor);
          // The spinfusor is the capper's one-tool-fits-all: instant
          // contact detonation is the jump engine and the knockback
          // sweeps the stand on the fly-through (Tribes canon). A donor
          // kit without it blasts off the Arsenal's hidden-Disc
          // fallback — legal, but it means the runner's real inventory
          // doesn't show the gun he's actually using.
          if (lo) {
            const far = getWeaponStats(lo.far)?.aoeRadius > 0 && getWeaponStats(lo.far)?.forceMode !== 'pull' ? lo.far : WeaponType.Disc;
            const mid = getWeaponStats(lo.mid)?.aoeRadius > 0 ? lo.mid : WeaponType.GrenadeLauncher;
            this.loadouts.set(donor, Object.assign({}, lo, {far,mid}));
          }
          if (lo && this.brains.get(donor)?.skill.beltPull && getWeaponStats(lo.belt)?.forceMode !== 'pull') {
            this.loadouts.set(donor, Object.assign({}, lo, {belt: WeaponType.Implodisc}));
          }
          // Energy economy IS the capper's weapon — a 500m route's
          // sustained jet burns matter far more than any burst or
          // survival perk, so the slot pins featherjets. The shadow
          // baked its perk mods at track time: setPerk re-applies.
          // (lightfoot/regenerator REVERTED: losing the 0.7 drain +
          // 1.5x regen stranded more climbs than the extra blast
          // budget bought speed — kata/peaks went 0 caps.)
          if (donorP) {
            donorP.perk = 'featherjets';
            this.room.moveSim.setPerk(donor, 'featherjets');
          }
        }
        // The medic role is the DEDICATED kit — a fighter carrying a
        // heal nade is a hybrid, the medic carries the whole archetype.
        if (!instaKit && want === 'medic') {
          const lo = this.loadouts.get(donor);
          if (lo) {this.loadouts.set(donor, Object.assign({}, lo, {near: WeaponType.HealBeam,belt: WeaponType.HealGrenade}));}
        }
        // The chaser (LD) lives or dies on catching 30-45 m/s carriers —
        // a mortar or rocket rack can't lead that, and a shotgun can't
        // reach it. Swap only the anti-pursuit slots, keep the rest of
        // the drawn kit (personality over uniformity).
        if (!instaKit && want === 'ldefense') {
          const lo = this.loadouts.get(donor);
          if (lo) {
            const slowFar = new Set([WeaponType.Mortar, WeaponType.MissileLauncher, WeaponType.PlasmaCannon]);
            const closeNear = new Set([WeaponType.Shotgun, WeaponType.Flak, WeaponType.HealBeam]);
            const far = slowFar.has(lo.far) ? WeaponType.Railgun : lo.far;
            // Beam over spray: tracking a jinking carrier favors the
            // lightning gun's hold-on-target model; chaingun when the
            // kit doesn't field beam mechanics anyway.
            const near = closeNear.has(lo.near) ? WeaponType.Lightning : lo.near;
            if (far !== lo.far || near !== lo.near) {this.loadouts.set(donor, Object.assign({}, lo, {far,near}));}
          }
        }
        // The sniper IS the railgun — a mortar/rack kit on the perch
        // can't do the one job the role exists for.
        if (!instaKit && want === 'sniper') {
          const lo = this.loadouts.get(donor);
          if (lo && lo.far !== WeaponType.Railgun) {this.loadouts.set(donor, Object.assign({}, lo, {far: WeaponType.Railgun}));}
        }
        // Role kit edits (LD's beam, capper's disc) can change the body's
        // legal tier — an LD donor grafted Lightning must run light or
        // the class gate makes its own guns contraband. Strict roles
        // already re-fit above; everyone else re-derives from the kit.
        if (!instaKit && !strict) {this.refitClass(donor);}
        logger.info('Bot role', { id: donor, role: want, room: this.room.name });
have += 1;
      }
    }
  }

  /** botFill floor — once a second, top up or retire bots so the room
   *  holds `spec.botFill` total bodies. Retirees prefer a dead bot
   *  (popping a live one mid-fight reads as a vanish). */
  maintain(now: number): void {
    this.rebalanceRoles(now);
    const fill = this.room.spec.botFill;
    if (!fill || now < this.maintainAt) {return;}
    this.maintainAt = now + 1000;
    const humans = this.room.playerCount() - this.brains.size;
    // Empty rooms don't mint a roster — a 0-audience room would
    // hibernate its fill anyway, and every minted bot eats a global-cap
    // seat that a real joiner could take (stress fleets hit this).
    if (humans === 0 && this.brains.size === 0) {return;}
    // The 16 clamp was a hidden ceiling: a map asking botFill=40 quietly
    // got 16. Specs are trusted up to a still-sane bound — a runaway fill
    // is a perf question for capSoak, not a silent override here.
    const want = Math.max(0, Math.min(128, fill - humans));
    if (this.brains.size < want) {
      this.populate(want - this.brains.size);
      this.room.balanceTeams(); // fill spawns can land lopsided
      return;
    }
    let excess = this.brains.size - want;
    if (excess <= 0) {return;}
    // Map iterators tolerate mid-loop delete — no snapshot needed.
    for (const id of this.brains.keys()) {
      if (excess <= 0) {break;}
      const p = this.room.players.getPlayer(id);
      if (p && !p.isDead) {continue;} // keep live bots, kill the corpse queue first
      this.retire(id);
excess -= 1;
    }
    for (const id of this.brains.keys()) {
      if (excess <= 0) {break;}
      this.retire(id);
excess -= 1;
    }
    this.room.balanceTeams(); // retirements can strip one side bare
  }

  /** Respawn-time kit drift: each rerollable slot keeps whichever
   *  candidate the skill matrix scores highest — a bot's kit converges
   *  on what it actually hits with. Class re-derives from the new kit
   *  so a fresh heavy-only pick swaps the body legally. */
  adaptOnRespawn(id: string, skill: (w: number) => number, at: 'spawn' | 'respawn' = 'respawn'): void {
    const lo = this.loadouts.get(id);
    const alts = this.alts.get(id);
    if (!lo || !alts) {return;}
    const next = adaptLoadout(lo, alts, skill, botRand);
    const moved = (['near', 'mid', 'far', 'belt', 'side'] as const).filter((s): boolean => next[s] !== lo[s]);
    if (moved.length === 0) {return;}
    this.loadouts.set(id, next);
    logger.info('Bot adapted kit', { id, room: this.room.name, at, swapped: moved.map((s): string => `${s}:${lo[s]}->${next[s]}`) });
    this.refitClass(id);
  }

  private retire(id: string): void {
    this.untrackBot(id);
    this.room.removePlayerCompletely(id, 'botFill', (m, o): void => logger.info(m, o));
  }

  /** A human joined `team` — their seat replaces a bot's so the sides
   *  stay even. Prefer a corpse (popping a live one mid-fight reads as
   *  a vanish), else the lowest kills−deaths on that side. */
  retireWorst(team: string | undefined): void {
    if (!team) {return;}
    let pick: string | null = null;
    let pickDead = false;
    let pickScore = Infinity;
    for (const id of this.brains.keys()) {
      const p = this.room.players.getPlayer(id);
      if (!p || p.team !== team) {continue;}
      const score = p.kills - p.deaths;
      if (pick === null || (p.isDead && !pickDead) || (p.isDead === pickDead && score < pickScore)) {
        pick = id; pickDead = p.isDead; pickScore = score;
      }
    }
    if (pick !== null) {this.retire(pick);}
  }

  /** Forget a removed bot's roster state — untrack stays in ServerBots
   *  (it drains every subsystem's map) and calls back into this. */
  forget(id: string): void {
    this.roles.delete(id);
    this.classes.delete(id);
    this.alts.delete(id);
  }

  /** The role map — senses read it for infiltrator raids / carrier
   *  lure checks; the roster owns writes. */
  get roleInfo(): Map<string, BotRole> { return this.roles; }
}
