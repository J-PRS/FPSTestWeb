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
import type { ChatterKind } from '../../shared/botTaunts.ts';
import { STATUS } from '../../shared/status.ts';
import { getWeaponStats } from '../../shared/weapons.ts';
import { BOT_LOADOUTS, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import { aimSkillFor, type BotSkill } from '../../shared/botSkill.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { roleObjective, type BotRole } from '../../shared/flagGoals.ts';
import { DEPLOY_HP } from '../../shared/deployables.ts';
import type { TeamId } from '../../shared/teams.ts';
import { simNow } from './simClock.ts';

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

  /** A room event the squad may react to — delivered to each bot on its
   *  OWN think phase (phases are offset across the squad), so reactions
   *  scatter naturally; the taunt cooldown+dice thin out who speaks.
   *  Nothing dispatches "a crowd" — the chattiness is emergent. */
  private pendingNotice: { kind: ChatterKind; actorId: string; actorTeam?: string; stamp: number } | null = null;
  private noticed = new Map<string, number>();

  /** Bot left the room — drop its notice receipt so the map can't grow
   *  one entry per retired bot for the room's life. */
  forget(id: string): void {
    this.noticed.delete(id);
  }

  /** Room code reports an event worth a reaction (flag cap/grab/return/
   *  drop). Actor's own line is separate — the actor never gets a notice. */
  notice(kind: ChatterKind, actorId: string, actorTeam?: string): void {
    this.pendingNotice = { kind, actorId, actorTeam, stamp: simNow() };
  }

  /** Translate the pending event into THIS bot's side of it — allies
   *  cheer their team's score, enemies groan, defenders get the alert. */
  private noticeFor(id: string, team: string | undefined, now: number): { kind: ChatterKind; actor: string } | undefined {
    const n = this.pendingNotice;
    if (!n) return undefined;
    if (now - n.stamp > 2000) { this.pendingNotice = null; return undefined; }
    if (n.actorId === id || (this.noticed.get(id) ?? 0) >= n.stamp) return undefined;
    this.noticed.set(id, n.stamp);
    const mine = n.actorTeam !== undefined && n.actorTeam === team;
    switch (n.kind) {
      case 'flagcap': case 'flagreturn': return { kind: mine ? 'cheer' : 'groan', actor: n.actorId };
      case 'flaggrab': return { kind: mine ? 'cheer' : 'alert', actor: n.actorId };
      case 'flagdrop': return { kind: mine ? 'groan' : 'cheer', actor: n.actorId };
      default: return { kind: n.kind, actor: n.actorId };
    }
  }

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
      out.push({ id: q.id, pos: q.position, vel: q.velocity, alive: !q.isDead,
        aimY: classCapsule(q.armorClass).centerOff });
    }
    // Creatures are huntable too — in nuggets rooms they're the whole
    // objective (each kill drops the gem that scores), and shooting
    // hunters off your back is correct behavior in every mode.
    for (const b of this.room.ballSim.roster()) {
      out.push({ id: `b:${b.id}`, pos: b.position, vel: b.velocity, alive: true, aimY: 0 });
    }
    return out;
  }

  /** Live teammates only — the rally channel. An enemy body is the
   *  worst place a hurt bot could fold onto, so separation keeps
   *  reading `others` while retreat reads this. FFA → empty (nobody
   *  to rally to). */
  private alliesOf(p: { id: string; team?: string }): Vec3[] {
    if (!p.team) return [];
    const out: Vec3[] = [];
    for (const q of this.room.players.getAllPlayers().values()) {
      if (q.id === p.id || q.isDead || q.team !== p.team) continue;
      out.push(q.position);
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

  /** Friendly gear that needs a weld — nearest damaged item within the
   *  reach a builder would reasonably walk to. Deployables broadcast
   *  their state to every client, so a bot noticing a hurt turret is
   *  reading public info, same as a human watching the stand. */
  repairJob(p: { id: string; team?: string; position: Vec3 }): { key: string; pos: BotVec; frac: number } | null {
    let best: { key: string; pos: BotVec; frac: number } | null = null;
    let bestD = 45;
    for (const d of this.room.deployables.items.values()) {
      const cap = DEPLOY_HP[d.kind];
      if (d.hp >= cap) continue;
      if (d.owner !== p.id) {
        const owner = this.room.players.getPlayer(d.owner);
        if (!p.team || owner?.team !== p.team) continue;
      }
      const bd = Math.hypot(d.pos.x - p.position.x, d.pos.z - p.position.z);
      if (bd < bestD) { bestD = bd; best = { key: String(d.id), pos: d.pos, frac: d.hp / cap }; }
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
        // "ignoring" it is a false positive that maxes out honest bots.
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
  flagGoal(p: { id: string; team?: string; position: Vec3 }, duty = 1): { pos: BotVec; infiltrating: boolean; running?: boolean; runner?: boolean } | null {
    const flags = this.room.flags;
    if (!flags || !p.team) return null;
    const me = p.team as TeamId;
    const enemy = flags.flags.get(me === 'alpha' ? 'bravo' : 'alpha');
    const own = flags.flags.get(me);
    if (!enemy || !own) return null;
    if (enemy.carrier === p.id) {
      // Own flag dropped in the field: touching it home re-opens the
      // cap window — a carrier that can reach it goes for the touch.
      if (own.state === 'dropped') return { pos: own.pos, infiltrating: false, running: true, runner: true };
      // The cap line is blocked while our own flag is in the field —
      // standing on the stand just paints a target. Fall back to a
      // covered wait-spot behind the base and re-approach when the
      // flag comes home. The lean scales with duty: a slack carrier
      // still edges toward the stand.
      if (own.state === 'carried') {
        const ref = enemy.home;
        const dx = own.home.x - ref.x, dz = own.home.z - ref.z;
        const d = Math.hypot(dx, dz);
        if (d > 1) {
          const back = 90 + 60 * (1 - duty);
          const wx = own.home.x + (dx / d) * back, wz = own.home.z + (dz / d) * back;
          const wy = this.field ? hmHeight(this.field, wx, wz) : own.home.y;
          return { pos: { x: wx, y: wy, z: wz }, infiltrating: false, running: true, runner: true };
        }
      }
      return { pos: own.home, infiltrating: false, running: true, runner: true };
    }

    const enemyStand = enemy.state !== 'carried' ? enemy.pos : null;
    // One role table for both runtimes — shared/flagGoals.ts.
    const pick = roleObjective(this.roles.get(p.id) ?? 'offense', {
      home: own.home,
      // Own flag's carrier — chase the thief, not the base.
      thief: this.thiefOf(me)?.pos ?? null,
      // Own flag dropped — anyone close enough touches it home.
      dropped: own.state === 'dropped' ? own.pos : null,
      enemyStand,
      escort: this.escortSpot(enemy.carrier, me),
      threat: this.standThreat(own.home, me),
    }, duty);
    const role = this.roles.get(p.id);
    // A presser doesn't beeline to the stand — it attacks from a side
    // the terrain actually opens on. Cappers want the high side for a
    // downhill graze at speed; everyone pressing a rimmed stand still
    // needs a reachable entry or they die on the wall below the lip.
    // The entry is probed live off the terrain every goal cycle: no
    // baked routes, and it re-plans as the bot moves (the arc emerges
    // per-mountain).
    let goalPos: BotVec = pick;
    if (pick === enemyStand && enemyStand !== null && this.field) {
      const capper = role === 'capper';
      const dStand = Math.hypot(enemyStand.x - p.position.x, enemyStand.z - p.position.z);
      if (dStand > (capper ? 90 : 40)) {
        let best = enemyStand, bestScore = -Infinity;
        for (let a = 0; a < 24; a++) {
          // Three radii: close entries are cheap, a closed rim wall
          // only breaks further out — a plateau stand needs the far
          // rings to find the saddle where its massif opens.
          const ring = a < 8 ? 85 : a < 16 ? 170 : 300;
          const ang = ((a % 8) / 8) * Math.PI * 2 + (a < 8 ? 0 : (a < 16 ? Math.PI / 8 : Math.PI / 4));
          const ex = enemyStand.x + Math.cos(ang) * ring;
          const ez = enemyStand.z + Math.sin(ang) * ring;
          const ey = hmHeight(this.field, ex, ez);
          const high = ey - enemyStand.y;
          const detour = Math.hypot(ex - p.position.x, ez - p.position.z) - dStand;
          // Elevated over the stand = a dive-in entry — worth a lot to
          // a capper, little to a fighter. An entry the bot must CLIMB
          // to costs the whole advantage either way.
          let score = high * (capper ? 1.2 : 0.3) - Math.max(0, ey - p.position.y) * 2 - Math.max(0, detour) * 0.8;
          // An entry behind a rim wall is dead — a plateau base sits
          // exactly like this, with stand height close to the rim and
          // every approach rising. Trace the line bot→entry and charge
          // for ridge height above the straight climb; an open slope
          // has ridge ≈ linear, a wall route peaks higher.
          let ridge = 0;
          for (let s = 1; s < 8; s++) {
            const t = s / 8;
            const lx = p.position.x + (ex - p.position.x) * t;
            const lz = p.position.z + (ez - p.position.z) * t;
            const lh = hmHeight(this.field, lx, lz);
            ridge = Math.max(ridge, lh - (p.position.y + (ey - p.position.y) * t));
          }
          score -= ridge * 2.5;
          // The last leg is where plateau rims hide: the entry may be
          // reachable while entry→stand crosses a sheer lip. Same trace,
          // entry→stand — terrain ABOVE the straight chord is a wall.
          let lip = 0;
          for (let s = 1; s < 8; s++) {
            const t = s / 8;
            const lx = ex + (enemyStand.x - ex) * t;
            const lz = ez + (enemyStand.z - ez) * t;
            const lh = hmHeight(this.field, lx, lz);
            lip = Math.max(lip, lh - (ey + (enemyStand.y - ey) * t));
          }
          score -= lip * 3;
          if (score > bestScore) { bestScore = score; best = { x: ex, y: ey, z: ez }; }
        }
        goalPos = best;
      }
    }
    // Cloak intent only for the infiltrator: the drain is speed-scaled,
    // so a light capper burning RMB-to-stand empties its tank mid-route
    // and arrives with no jet fuel — infiltration is the saboteur's job.
    return { pos: goalPos, infiltrating: pick === enemyStand && enemyStand !== null
      && role === 'infiltrator', runner: role === 'capper' };
  }

  /** A teammate carrying the enemy flag is the escort point — the
   *  carrier's position is already on the wire, no wallhack needed. */
  private escortSpot(carrier: string | null | undefined, me: TeamId): Vec3 | null {
    const escortP = carrier ? this.room.players.getPlayer(carrier) : null;
    return escortP && escortP.team === me ? escortP.position : null;
  }

  /** Closest hostile pressing our stand — the HoF body-block anchor.
   *  Only counts enemies inside the ring so a fighter out in the field
   *  doesn't drag the anchor off the flag. */
  private standThreat(home: Vec3, me: TeamId): Vec3 | null {
    let best: Vec3 | null = null, bestD = 45;
    for (const [, q] of this.room.players.getAllPlayers()) {
      if (q.team === me || q.isDead) continue;
      const d = Math.hypot(q.position.x - home.x, q.position.z - home.z);
      if (d < bestD) { bestD = d; best = q.position; }
    }
    return best;
  }

  /** Who's carrying OUR flag — pos+vel are beacon info (the wire streams
   *  the carrier anyway), so returning them to the brain is not a wallhack.
   *  pickHunt consumes this to actually ENGAGE the thief, not just run at
   *  the flag's old stand position. */
  private thiefOf(team: string): BotEnemy | null {
    const flags = this.room.flags;
    if (!flags || (team !== 'alpha' && team !== 'bravo')) return null;
    const own = flags.flags.get(team);
    if (!own || own.state !== 'carried' || !own.carrier) return null;
    const t = this.room.players.getPlayer(own.carrier);
    if (!t || t.isDead) return null;
    return { id: t.id, pos: t.position, vel: t.velocity, alive: true,
      aimY: classCapsule(t.armorClass).centerOff };
  }

  /** The sensorium for one think tick — see file header for what's legal
   *  on each channel. */
  build(id: string, p: { id: string; team?: string; position: Vec3; velocity: Vec3; health: number; maxHealth: number }, goal: { pos: BotVec; infiltrating: boolean; running?: boolean; runner?: boolean } | null, now: number, skill?: BotSkill): BrainCtx {
    // Competence-biased draw: the weapon pick and the aim error read
    // the same matrix, so a phenom both reaches for its gun and lands it.
    const bias = skill ? (t: number) => aimSkillFor(skill, t, 0) : undefined;
    return {
      pos: p.position,
      vel: p.velocity,
      enemies: this.enemiesOf(p),
      objective: goal?.pos ?? null,
      infiltrating: goal?.infiltrating ?? false,
      running: goal?.running ?? false,
      runner: goal?.runner ?? false,
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
      allies: this.alliesOf(p),
      // Mortar heavies acquire siege-range targets; everyone else holds
      // the duel band. The shared brain takes max(FIRE_RANGE, this).
      engageRange: this.loadouts.get(id)?.far === WeaponType.Mortar ? 95 : undefined,
      thief: this.thiefOf(p.team ?? ''),
      // Aim lead uses the muzzle speed of the weapon this bot would
      // pick at that range — same band select fireAt runs.
      weaponSpeed: (d) => {
        const w = pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias);
        return getWeaponStats(w).speed || 60;
      },
      // Lobbed shells need the arc's drop added back on the aim point.
      weaponGravity: (d) =>
        getWeaponStats(pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias)).gravity,
      // The bot's skill matrix scored against the weapon it would
      // actually draw at that range — pick and aim stay consistent.
      ...(skill ? {
        aimSkill: (d: number, targetSpeed: number) =>
          aimSkillFor(skill, pickBotWeapon(this.loadouts.get(id) ?? BOT_LOADOUTS[0]!, d, d, bias), targetSpeed),
      } : {}),
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
      notice: this.noticeFor(id, p.team, now),
      repair: this.repairJob(p),
      now,
    };
  }
}
