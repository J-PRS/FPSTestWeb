/**
 * ServerBotSenses — the brain's sensorium for a server-driven bot.
 * Every channel a legal client could read from the wire: positions,
 * pickups, inbound shells, noises, wall occlusion, the move shadow's
 * honest energy tank. Split out of ServerBots so that file stays about
 * driving bodies; this one only builds what the brain is allowed to see.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { losClear, type BotEnemy, type BotVec, type BrainCtx } from '../../shared/botBrain.ts';
import { STATUS } from '../../shared/status.ts';
import { getWeaponStats } from '../../shared/weapons.ts';
import { BOT_LOADOUTS, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import { roleObjective, type BotRole } from '../../shared/flagGoals.ts';

export class ServerBotSenses {
  constructor(
    private readonly room: Room,
    private readonly field: Heightfield | null,
    private readonly loadouts: Map<string, BotLoadout>,
    private readonly roles: Map<string, BotRole>,
    /** Visible-enemy-present flags (epoch ms expiry) — markFoeNear writes,
     *  ServerBots reads for the sheep charge. */
    private readonly foeNear: Map<string, number>,
  ) {}

  /** Hostiles this bot may hunt. Team modes fight the other side; FFA
   *  bots pick any non-bot (fighting filler-vs-filler burns ticks nobody
   *  asked for). */
  enemiesOf(p: { id: string; team?: string }): BotEnemy[] {
    const out: BotEnemy[] = [];
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === p.id || q.isDead) continue;
      if (this.room.modeSpec?.teams) {
        if (q.team === p.team) continue;
      } else if (q.isBot) continue;
      if (q.status & STATUS.CLOAK) continue; // bots can't aim what they can't see
      out.push({ id: q.id, pos: q.position, vel: q.velocity, alive: !q.isDead });
    }
    // Creatures are huntable too — in nuggets rooms they're the whole
    // objective (each kill drops the gem that scores), and shooting
    // hunters off your back is correct behavior in every mode.
    for (const b of this.room.ballSim.roster()) {
      out.push({ id: `b:${b.id}`, pos: b.position, vel: b.velocity, alive: true });
    }
    return out;
  }

  /** Positions of every other live player — the brain's separation
   *  sense, so a squad spreads instead of stacking on one slot. */
  othersOf(p: { id: string }): Vec3[] {
    const out: Vec3[] = [];
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === p.id || q.isDead) continue;
      out.push(q.position);
    }
    return out;
  }

  /** Hostile emplacement the bot can legally see — a turret/mine/drone
   *  owned by the other team, near the bot and near what it's after.
   *  The stand's kill-zone is knowledge the room advertises anyway. */
  hostileGear(p: { id: string; team?: string; position: Vec3 }, goal: BotVec | null, sabotage = false): Vec3 | null {
    if (!goal && !sabotage) return null;
    let best: Vec3 | null = null;
    // Lob from the edge of turret sight (42m) — a bot that must first
    // survive to 30m never gets the shot off.
    let bestD = 40;
    for (const d of this.room.deployables.snapshot()) {
      if (d.kind === 'station') continue; // pads aren't a threat
      const owner = this.room.players.getPlayer(d.owner);
      if (p.team && owner?.team === p.team) continue;
      if (!p.team && d.owner === p.id) continue;
      const bd = Math.hypot(d.pos.x - p.position.x, d.pos.z - p.position.z);
      // A saboteur wrecks whatever gear it can reach — goal proximity
      // only gates the objective-driven lobbers.
      const gd = goal ? Math.hypot(d.pos.x - goal.x, d.pos.z - goal.z) : 0;
      if (bd < bestD && (sabotage || gd < 50)) { bestD = bd; best = d.pos; }
    }
    return best;
  }

  /** Ignoring-the-enemy evidence for the sheep meter: a live visible
   *  enemy PLAYER within 60m while the brain elects not to fire is the
   *  fastest cowardice tell there is. Creatures don't count — walking
   *  past wildlife isn't fear. Computed at think cadence; the flag
   *  decays in half a second so a bot that out-skis a duel isn't
   *  re-charged while it's gone. */
  markFoeNear(id: string, ctx: BrainCtx, pos: Vec3, yaw: number, now: number): void {
    for (const e of ctx.enemies) {
      if (e.id.startsWith('b:')) continue;
      const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z;
      const d = Math.hypot(dx, e.pos.y - pos.y, dz);
      // Brawl range, not spotting range — a foe it can't reach yet is a
      // marching target, not an ignored duel.
      if (d < 45 && losClear(ctx, pos, e.pos)) {
        // Only counts when the bot is actually LOOKING at the foe —
        // an enemy outside the ~130° view cone is invisible to it, so
        // "ignoring" it is a false positive that yeet-loops honest bots.
        const fx = Math.sin(yaw), fz = Math.cos(yaw);
        const gd = Math.hypot(dx, dz) || 1;
        if ((dx * fx + dz * fz) / gd < -0.4) continue;
        this.foeNear.set(id, now + 500);
        return;
      }
    }
    this.foeNear.set(id, 0);
  }

  /** CTF objective for a bot: carrying the enemy flag → own base; own flag
   *  carried off → run down the carrier (the carrier's position IS known —
   *  tickUpdate streams it, this is a legal pursuit not a wallhack); own
   *  flag dropped → touch it home; a teammate carrying → escort them;
   *  enemy flag reachable → go grab it. Defenders invert it: their flag
   *  recovery/intercept outranks pressing the enemy stand. */
  flagGoal(p: { id: string; team?: string; position: Vec3 }): { pos: BotVec; infiltrating: boolean } | null {
    const flags = this.room.flags;
    if (!flags || !p.team) return null;
    const me = p.team as 'alpha' | 'bravo';
    const enemy = flags.flags.get(me === 'alpha' ? 'bravo' : 'alpha');
    const own = flags.flags.get(me);
    if (!enemy || !own) return null;
    if (enemy.carrier === p.id) return { pos: own.home, infiltrating: false };

    const enemyStand = enemy.state !== 'carried' ? enemy.pos : null;
    // One role table for both runtimes — shared/flagGoals.ts.
    const pick = roleObjective(this.roles.get(p.id) ?? 'offense', {
      home: own.home,
      // Own flag's carrier — chase the thief, not the base.
      thief: own.state === 'carried' && own.carrier
        ? this.room.players.getPlayer(own.carrier)?.position ?? null : null,
      // Own flag dropped — anyone close enough touches it home.
      dropped: own.state === 'dropped' ? own.pos : null,
      enemyStand,
      escort: this.escortSpot(enemy.carrier, me),
    });
    // Pressing the enemy stand is the infiltrate signal — the brain reads
    // it as cloak intent on the approach.
    return { pos: pick, infiltrating: pick === enemyStand && enemyStand !== null };
  }

  /** A teammate carrying the enemy flag is the escort point — the
   *  carrier's position is already on the wire, no wallhack needed. */
  private escortSpot(carrier: string | null | undefined, me: 'alpha' | 'bravo'): Vec3 | null {
    const escortP = carrier ? this.room.players.getPlayer(carrier) : null;
    return escortP && escortP.team === me ? escortP.position : null;
  }

  /** The sensorium for one think tick — see file header for what's legal
   *  on each channel. */
  build(id: string, p: { id: string; team?: string; position: Vec3; velocity: Vec3; health: number; maxHealth: number }, goal: { pos: BotVec; infiltrating: boolean } | null, now: number): BrainCtx {
    return {
      pos: p.position,
      vel: p.velocity,
      enemies: this.enemiesOf(p),
      objective: goal?.pos ?? null,
      infiltrating: goal?.infiltrating ?? false,
      // Team rooms drop nuggets on creature kills — bots farm them too,
      // which is what keeps a bot-filled match's scoreboard moving.
      pickup: this.room.pickups?.nearest(p.position) ?? undefined,
      // Gem-economy rooms make hunting creatures the actual objective;
      // on any map that spawns real creatures they're threats worth
      // shooting too. Structureless-free: pops is {} where spec doesn't
      // declare `creatures`.
      huntCreatures: this.room.mode === 'nuggets'
        || Object.values(this.room.creatureSim.pops).some((cap) => cap > 0),
      // Structures read as raised ground — brains route around walls
      // and onto platforms instead of pushing into solid geometry.
      groundY: (x, z) => Math.max(
        this.field ? hmHeight(this.field, x, z) : p.position.y,
        this.room.moveSim.structureTop(x, z),
      ),
      others: this.othersOf(p),
      // Aim lead uses the muzzle speed of the weapon this bot would
      // pick at that range — same band select fireAt runs.
      weaponSpeed: (d) => {
        const w = pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d);
        return getWeaponStats(w).speed || 60;
      },
      // Lobbed shells need the arc's drop added back on the aim point.
      weaponGravity: (d) =>
        getWeaponStats(pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d)).gravity,
      // Wall occlusion for the LOS sense — bots stop wasting ammo on
      // targets behind structures they'd never see through anyway.
      solids: this.room.ballSim.colliders,
      solidIndex: this.room.ballSim.colliderIndex,
      // The shadow tank is the truth — brains read it to gate jets,
      // shields, mends. Null field → undefined → full-tank behavior.
      energy: this.room.moveSim.energyOf(id) ?? undefined,
      healthFrac: p.maxHealth > 0 ? p.health / p.maxHealth : 1,
      // Inbound shells feed the dodge sense — bots sidestep rockets
      // like a human reading the arc instead of eating every volley.
      threats: this.room.projectiles.incomingNear(p.position, 12),
      sounds: this.room.noisesNear(p.position, 50),
      now,
    };
  }
}
