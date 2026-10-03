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
import { CLASS_STATS, type ArmorClass } from '../../shared/botClasses.ts';
import { BOT_LOADOUTS, botClassForLoadout, type BotLoadout } from '../../shared/botLoadouts.ts';
import { botRand } from '../../shared/botRand.ts';
import { BOT_NAMES } from '../../shared/botNames.ts';
import { CLASS_FITNESS, ROLE_PRIORITY, STRICT_CLASS, type BotRole } from '../../shared/flagGoals.ts';
import { isSuper } from './superBot.ts';
import { healPool } from './healPool.ts';
import { simNow } from './simClock.ts';

// FPS_SOAK_RANDLO=1: every slot draws from the union of weapons the
// authored kits place there — measures raw per-weapon lethality with
// kit frequency removed (innate per-weapon skill still biases picks).
const RANDLO = (() => {
  const slot = (k: 'near' | 'mid' | 'far' | 'belt' | 'side') =>
    [...new Set(BOT_LOADOUTS.map((l) => l[k]))];
  return { near: slot('near'), mid: slot('mid'), far: slot('far'), belt: slot('belt'), side: slot('side') };
})();
const pickOf = <T,>(pool: T[]): T => pool[Math.floor(botRand() * pool.length) % pool.length]!;

/** Strict-tier roles re-fit a donor's body (shared/flagGoals.ts —
 *  the offline lobby applies the same table). */


export class BotRoster {
  private roles = new Map<string, BotRole>();
  private classes = new Map<string, ArmorClass>();
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
    for (let i = 0; i < n; i++) {
      // Callsign from the shared pool, not the room name — 'BOT-escalade-11'
      // read as a map tag, not a pilot. Index suffix keeps ids unique.
      const idx = this.nextIdx++;
      const id = `BOT-${BOT_NAMES[(idx - 1) % BOT_NAMES.length]}-${String(idx).padStart(2, '0')}`;
      const loadout = process.env.FPS_SOAK_RANDLO === '1'
        ? { perk: 'vitality' as const, near: pickOf(RANDLO.near), mid: pickOf(RANDLO.mid), far: pickOf(RANDLO.far), belt: pickOf(RANDLO.belt), side: pickOf(RANDLO.side) }
        : BOT_LOADOUTS[(this.nextIdx - 2 + BOT_LOADOUTS.length) % BOT_LOADOUTS.length]!;
      // Kit picks the body, then the squad's weighted fill picks the
      // job — plated/mortar kits anchor heavy, featherjets flies light,
      // everything else runs medium until rebalance assigns a role.
      const cls = botClassForLoadout(loadout);
      const p = this.room.players.addPlayer(id, undefined, loadout.perk, cls);
      this.loadouts.set(id, loadout);
      this.roles.set(id, 'offense');
      this.applyClass(p, cls);
      p.isBot = true;
      if (isSuper(id)) p.health = 400; // superbot tanks a beating
      p.lastSeen = simNow();
      this.room.assignTeam(p);
      this.room.broadcast({
        type: 'playerJoined',
        playerId: id,
        internalId: p.internalId,
        position: p.position,
        rotation: p.rotation,
        team: p.team,
        armorClass: cls,
      });
      this.brains.set(id, new BotBrain(p.position));
      this.thinkPhase.set(id, this.nextIdx % this.thinkDiv);
      // Legal body: the bot gets a move shadow exactly like a human join —
      // brains emit inputs, the sim owns motion, energy model included.
      this.room.moveSim.track(id, p.position, p.rotation.yaw, p.perk);
    }
    if (n > 0) logger.info('Bots spawned', { room: this.room.name, count: n });
  }

  /** Re-fit a bot's body to its CURRENT loadout — scenarios that swap
   *  kits post-spawn call this so the armor follows the new kit, not
   *  whatever the spawn roll handed out. */
  public refitClass(id: string): void {
    const lo = this.loadouts.get(id);
    const p = this.room.players.getPlayer(id);
    if (!lo || !p) return;
    p.armorClass = botClassForLoadout(lo);
    this.applyClass(p, p.armorClass as ArmorClass);
  }

  /** Apply the armor class to a live bot record: maxHealth shifts and
   *  current HP follows the delta (gaining plating grants the points,
   *  dropping it just clamps). The move shadow's ground scale makes the
   *  class legally different — a light capper really out-runs a heavy. */
  private applyClass(p: { id: string; maxHealth: number; health: number }, cls: ArmorClass): void {
    const prev = this.classes.get(p.id);
    if (prev === cls) return;
    const base = p.maxHealth - (prev ? CLASS_STATS[prev].maxHealth : 0);
    this.classes.set(p.id, cls);
    // Heavies shoulder the mortar — tier-locked ordnance is what makes the
    // class read as an anchor instead of just a slower medium.
    if (cls === 'heavy') {
      const lo = this.loadouts.get(p.id);
      if (lo && lo.far !== WeaponType.Mortar) this.loadouts.set(p.id, { ...lo, far: WeaponType.Mortar });
    }
    const delta = base + CLASS_STATS[cls].maxHealth - p.maxHealth;
    p.maxHealth += delta;
    healPool(p, Math.max(0, delta));
    this.room.moveSim.setSpeedScale(p.id, CLASS_STATS[cls].speedScale);
    this.room.moveSim.setBody(p.id, CLASS_STATS[cls].mass, CLASS_STATS[cls].eyeHeight, CLASS_STATS[cls].radius);
  }

  /** Rebalance squad roles ~every 5s. Needs are computed per team: a flag
   *  mode wants a capper; a bigger squad earns a HoF anchor, a technician
   *  and an infiltrator; the rest split offense/defense. Reassignment
   *  skips carriers mid-run — the flagGoal carrier check owns them. */
  private rebalanceRoles(now: number): void {
    if (!this.room.flags || now < this.roleT) return;
    this.roleT = now + 5000;
    const byTeam = new Map<string, string[]>();
    for (const id of this.brains.keys()) {
      const p = this.room.players.getPlayer(id);
      if (!p?.team) continue;
      (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)!).push(id);
    }
    for (const ids of byTeam.values()) this.rebalanceTeam(ids);
  }

  /** One team's role fill: walk ROLE_PRIORITY (capper@3 … infiltrator@7)
   *  so a 3-stack gets capper+LD and specialists only show once the
   *  lanes they free up are actually covered. */
  private rebalanceTeam(ids: string[]): void {
    // Never reassign a carrier — the flagGoal carrier check owns them.
    const free = ids.filter((id) => {
      const p = this.room.players.getPlayer(id);
      if (!p || p.isDead) return true; // corpses re-role freely on respawn
      for (const f of this.room.flags!.flags.values()) {
        if (f.carrier === id) return false;
      }
      return true;
    });
    // Specialists are sticky: donors only come from the generic pool
    // (offense/defense), and a bot is consumed once per cycle — else the
    // same body flip-flops capper→hof→technician on every pass.
    const donors = free.filter((id) => !ROLE_PRIORITY.some((w) => this.roles.get(id) === w.role));
    for (const { role: want, want: need, minSquad } of ROLE_PRIORITY) {
      if (ids.length < minSquad) break;
      let have = 0;
      for (const id of ids) if (this.roles.get(id) === want) have++;
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
        if (!donor) break;
        donors.splice(donors.indexOf(donor), 1);
        this.roles.set(donor, want);
        const strict = STRICT_CLASS[want];
        const donorP = this.room.players.getPlayer(donor);
        if (donorP && strict) {
          // The sim re-fit alone leaves the wire record on the kit
          // class — a strict hof would stream 'medium' while playing
          // heavy mass/speed, i.e. a medium skin on a heavy sim.
          donorP.armorClass = strict;
          this.applyClass(donorP, strict);
        }
        // Technician is the only role that promises the deploy kit —
        // pin its builder trait instead of trusting the spawn roll.
        // HoF gets the same nudge: mines+shields ARE the job. (The
        // deploy itself stays stochastic — a guideline, not a script.)
        if (want === 'technician' || want === 'hof') this.brains.get(donor)?.setBuilder(true);
        // A HoF that blasts off the flag on every nearby shell is a
        // HoF that isn't ON the flag — juggernaut is the perk a human
        // anchor would pick, and it's what makes "planted" physically
        // true instead of a goal the sim keeps vetoing.
        if (want === 'hof' && donorP) donorP.perk = 'juggernaut';
        // A capper who PREFERS pull rides the implosion disc — the
        // forward launch needs no heel-shot turnaround. Push-style
        // cappers keep their drawn belt and blast off their heels;
        // lobbies want both kinds of runner.
        if (want === 'capper') {
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
            this.loadouts.set(donor, { ...lo, far, mid });
          }
          if (lo && this.brains.get(donor)?.skill.beltPull && getWeaponStats(lo.belt)?.forceMode !== 'pull') {
            this.loadouts.set(donor, { ...lo, belt: WeaponType.DiscPull });
          }
          // Energy economy IS the capper's weapon — a 500m route's
          // sustained jet burns matter far more than any burst or
          // survival perk, so the slot pins featherjets. The shadow
          // baked its perk mods at track time: setPerk re-applies.
          if (donorP) {
            donorP.perk = 'featherjets';
            this.room.moveSim.setPerk(donor, 'featherjets');
          }
        }
        // The medic role is the DEDICATED kit — a fighter carrying a
        // heal nade is a hybrid, the medic carries the whole archetype.
        if (want === 'medic') {
          const lo = this.loadouts.get(donor);
          if (lo) this.loadouts.set(donor, { ...lo, near: WeaponType.HealBeam, belt: WeaponType.HealGrenade });
        }
        // The chaser (LD) lives or dies on catching 30-45 m/s carriers —
        // a mortar or rocket rack can't lead that, and a shotgun can't
        // reach it. Swap only the anti-pursuit slots, keep the rest of
        // the drawn kit (personality over uniformity).
        if (want === 'ldefense') {
          const lo = this.loadouts.get(donor);
          if (lo) {
            const slowFar = new Set([WeaponType.Mortar, WeaponType.RocketLauncher, WeaponType.PlasmaCannon]);
            const closeNear = new Set([WeaponType.Shotgun, WeaponType.Flak, WeaponType.HealBeam]);
            const far = slowFar.has(lo.far) ? WeaponType.Railgun : lo.far;
            // Beam over spray: tracking a jinking carrier favors the
            // lightning gun's hold-on-target model; chaingun when the
            // kit doesn't field beam mechanics anyway.
            const near = closeNear.has(lo.near) ? WeaponType.Lightning : lo.near;
            if (far !== lo.far || near !== lo.near) this.loadouts.set(donor, { ...lo, far, near });
          }
        }
        logger.info('Bot role', { id: donor, role: want, room: this.room.name });
        have++;
      }
    }
  }

  /** botFill floor — once a second, top up or retire bots so the room
   *  holds `spec.botFill` total bodies. Retirees prefer a dead bot
   *  (popping a live one mid-fight reads as a vanish). */
  maintain(now: number): void {
    this.rebalanceRoles(now);
    const fill = this.room.spec.botFill;
    if (!fill || now < this.maintainAt) return;
    this.maintainAt = now + 1000;
    const humans = this.room.playerCount() - this.brains.size;
    const want = Math.max(0, Math.min(16, fill - humans));
    if (this.brains.size < want) {
      this.populate(want - this.brains.size);
      return;
    }
    let excess = this.brains.size - want;
    if (excess <= 0) return;
    // Map iterators tolerate mid-loop delete — no snapshot needed.
    for (const id of this.brains.keys()) {
      if (excess <= 0) break;
      const p = this.room.players.getPlayer(id);
      if (p && !p.isDead) continue; // keep live bots, kill the corpse queue first
      this.retire(id);
      excess--;
    }
    for (const id of this.brains.keys()) {
      if (excess <= 0) break;
      this.retire(id);
      excess--;
    }
  }

  private retire(id: string): void {
    this.untrackBot(id);
    this.room.removePlayerCompletely(id, 'botFill', (m, o) => logger.info(m, o));
  }

  /** Forget a removed bot's roster state — untrack stays in ServerBots
   *  (it drains every subsystem's map) and calls back into this. */
  forget(id: string): void {
    this.roles.delete(id);
    this.classes.delete(id);
  }

  /** The role map — senses read it for infiltrator raids / carrier
   *  lure checks; the roster owns writes. */
  get roleInfo(): Map<string, BotRole> { return this.roles; }
}
