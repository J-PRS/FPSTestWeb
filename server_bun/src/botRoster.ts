/**
 * BotRoster — the squad bookkeeping family for ServerBots: spawning
 * roster entries, armor-class swaps, role rebalancing, and the botFill
 * population floor. Kept apart so ServerBots's tick loop owns "what does
 * each bot do this frame" while this owns "who is in the squad".
 */
import type { Room } from './Room.ts';
import { BotBrain } from '../../shared/botBrain.ts';
import { logger } from './logger.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { CLASS_STATS, type ArmorClass } from '../../shared/botClasses.ts';
import { BOT_LOADOUTS, type BotLoadout } from '../../shared/botLoadouts.ts';
import { BOT_NAMES } from '../../shared/botNames.ts';
import { ROLE_PRIORITY, type BotRole } from '../../shared/flagGoals.ts';
import { isSuper } from './superBot.ts';

/** Armor class follows the role — Tribes pacing lives on this: cappers
 *  and infiltrators fly light, HoF and technicians anchor heavy, the
 *  fighting middle wears medium. */
const ROLE_CLASS: Record<BotRole, ArmorClass> = {
  capper: 'light', infiltrator: 'light',
  offense: 'medium', ldefense: 'medium', defense: 'medium',
  hof: 'heavy', technician: 'heavy',
};

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
      const loadout = BOT_LOADOUTS[(this.nextIdx - 2 + BOT_LOADOUTS.length) % BOT_LOADOUTS.length]!;
      const p = this.room.players.addPlayer(id, undefined, loadout.perk);
      this.loadouts.set(id, loadout);
      // CTF role from the loadout: plated anchors hold home, everyone else
      // presses. A whole team grabbing leaves the stand unguarded.
      this.roles.set(id, loadout.perk === 'plated' ? 'hof' : 'offense');
      this.applyClass(p, ROLE_CLASS[this.roles.get(id)!]);
      p.isBot = true;
      if (isSuper(id)) p.health = 400; // superbot tanks a beating
      p.lastSeen = Date.now();
      this.room.assignTeam(p);
      this.room.broadcast({
        type: 'playerJoined',
        playerId: id,
        internalId: p.internalId,
        position: p.position,
        rotation: p.rotation,
        team: p.team,
      });
      this.brains.set(id, new BotBrain(p.position));
      this.thinkPhase.set(id, this.nextIdx % this.thinkDiv);
      // Legal body: the bot gets a move shadow exactly like a human join —
      // brains emit inputs, the sim owns motion, energy model included.
      this.room.moveSim.track(id, p.position, p.rotation.yaw, p.perk);
    }
    if (n > 0) logger.info('Bots spawned', { room: this.room.name, count: n });
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
    p.health = Math.min(p.maxHealth, p.health + Math.max(0, delta));
    this.room.moveSim.setSpeedScale(p.id, CLASS_STATS[cls].speedScale);
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
        const donor = donors.shift();
        if (!donor) break;
        this.roles.set(donor, want);
        const donorP = this.room.players.getPlayer(donor);
        if (donorP) this.applyClass(donorP, ROLE_CLASS[want]);
        // Technician is the only role that promises the deploy kit —
        // pin its builder trait instead of trusting the spawn roll.
        if (want === 'technician') this.brains.get(donor)?.setBuilder(true);
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
