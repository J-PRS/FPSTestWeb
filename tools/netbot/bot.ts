// NetBot behavior — a REAL BotBrain driving a REAL wire client. Movement
// goes out on the position channel (the bot owns its own kinematics like a
// v1 client); fire decisions go through the real claim chain the browser
// client uses: spawn `shot` → hit claim `shot` / blast claim `aoeShot`,
// bound by shotId. That chain is exactly what the deferred-claim and
// seq-watermark fixes protect, which is what this harness exists to
// exercise — a server-internal bot can never produce a reject.

import { BotBrain, type BotEnemy, type BrainCtx } from '../../shared/botBrain.ts';
import { MoveSim, ENERGY } from '../../shared/movement.ts';
import { CLASS_STATS,HEAVY_ONLY_WEAPONS } from '../../shared/botClasses.ts';

import { BOT_LOADOUTS, botClassForLoadout, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import { aimSkillFor } from '../../shared/botSkill.ts';
import { WEAPONS } from '../../shared/weaponRows.ts';
import { WEAPON_FIRE_INTERVAL_S } from '../../shared/weapons.ts';
import type { WeaponType } from '../../shared/weaponTable.ts';
import type { ClientMessage, Vec3 } from '../../shared/protocol.ts';
import { assignRole, roleObjective, WIRE_ROLES, type BotRole, type FlagSituation } from '../../shared/flagGoals.ts';
import type { NetClient, RemoteEntry } from './netClient.ts';

const THINK_S = 0.3;
const POS_HZ = 10;
/** Client-side cruise speed — roughly a medium on skis. */
const CRUISE = 32;

export class NetBot {
  private brain: BotBrain;
  private loadout = BOT_LOADOUTS[Math.floor(Math.random() * BOT_LOADOUTS.length)] ?? BOT_LOADOUTS[0]!;
  private get cls() { return botClassForLoadout(this.loadout); }
  private shotN = 0;
  private thinkTimer: ReturnType<typeof setInterval> | null = null;
  private lastFireAt = 0;
  private posTimer: ReturnType<typeof setInterval> | null = null;
  private hopTimer: ReturnType<typeof setInterval> | null = null;
  private dropTimer: ReturnType<typeof setInterval> | null = null;
  /** Fire silence during the last stretch before a room hop — jittered
   *  claims sent right up to the switch land in the NEW room carrying
   *  the old position, and the server rightly rejects them as
   *  implausible spawns. A player stops shooting while they click the
   *  room-switch UI; the bot does the same. */
  private holdFireUntil = 0;
  private rand: () => number;

  constructor(private nc: NetClient, opts: { hopEveryMs?: number; dropEveryMs?: number; seed?: () => number; loadout?: BotLoadout; capper?: boolean; skier?: boolean } = {}) {
    if (opts.loadout) {this.loadout = opts.loadout;}
    this.forceCapper = Boolean(opts.capper);
    this.forceSkier = Boolean(opts.skier);
    this.brain = new BotBrain({ x: 0, y: 60, z: 0 });
    this.rand = opts.seed ?? Math.random;
    // Blast shoves hit the server shadow via applyImpulse — the local
    // MoveSim must take the same dv or every blast is a ~60m divergence.
    // Same math as combatBlast.shove / client playerImpulse.applyKnockback.
    nc.onKnockback = (pos, force, pull) => this.takeShove(pos, force, pull);
    if (opts.hopEveryMs) {
      this.hopTimer = setInterval(() => {
        // Hold fire for the jitter window first, THEN send the switch —
        // see holdFireUntil.
        this.holdFireUntil = Date.now() + 300;
        setTimeout(() => {
          nc.send({ type: 'switchRoom', room: this.rand() < 0.5 ? 'netbot-a' : 'netbot-b', mode: 'dm' });
          nc.send({ type: 'switchRoom', room: this.rand() < 0.5 ? 'netbot-a' : 'netbot-b', mode: 'dm' });
          nc.tel.hops++;
        }, 200);
      }, opts.hopEveryMs);
    }
    // Periodic raw socket drop — the reclaim path's long-run churn. The
    // reconnect rejoins under the same identity token, so a healthy
    // server restores state instead of logging a fresh join every time.
    if (opts.dropEveryMs) {
      this.dropTimer = setInterval(() => {
        void (async () => {
          this.nc.ws?.close();
          await new Promise((r) => setTimeout(r, 300));
          await this.nc.connect();
        })();
      }, opts.dropEveryMs);
    }
  }

  start(): void {
    this.thinkTimer = setInterval(() => this.think(), THINK_S * 1000);
    this.posTimer = setInterval(() => this.sendPos(), 1000 / POS_HZ);
  }

  stop(): void {
    for (const t of [this.thinkTimer, this.posTimer, this.hopTimer, this.dropTimer]) {
      if (t) {clearInterval(t);}
    }
  }

  private enemies(): BotEnemy[] {
    const out: BotEnemy[] = [];
    for (const [id, e] of this.nc.roster) {
      if (e.isDead) {continue;}
      if (this.nc.self.team && e.team === this.nc.self.team) {continue;}
      out.push({ id, pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z }, vel: { x: e.vel.x, y: e.vel.y, z: e.vel.z }, alive: true });
    }
    // Creatures join the foe list like the server sense does — hunting
    // them is the actual objective in nuggets rooms, and the creatureHit
    // wire path only gets exercised if wire bots shoot them. Engagement
    // range caps the list: a knocked-high or roaming ball across the map
    // would otherwise soak the fire slot and reach the range gate as a
    // forever-unreachable target.
    const me = this.nc.self.pos;
    for (const [bid, b] of this.nc.balls) {
      if ((b.pos.x - me.x) ** 2 + (b.pos.y - me.y) ** 2 + (b.pos.z - me.z) ** 2 > 200 * 200) {continue;}
      out.push({ id: `b:${bid}`, pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z }, vel: { x: b.vel.x, y: b.vel.y, z: b.vel.z }, alive: true });
    }
    for (const [cid, c] of this.nc.crawlers) {
      if ((c.pos.x - me.x) ** 2 + (c.pos.y - me.y) ** 2 + (c.pos.z - me.z) ** 2 > 200 * 200) {continue;}
      out.push({ id: `c:${cid}`, pos: { x: c.pos.x, y: c.pos.y, z: c.pos.z }, vel: { x: c.vel.x, y: c.vel.y, z: c.vel.z }, alive: true });
    }
    return out;
  }

  /** Look up a fire target — players live in the roster, creatures in
   *  their own wire-fed maps keyed `b:<id>` / `c:<id>` like the server
   *  sense names them. */
  private targetEntry(targetId: string): RemoteEntry | null {
    if (targetId.startsWith('b:')) {return this.nc.balls.get(Number(targetId.slice(2))) ?? null;}
    if (targetId.startsWith('c:')) {return this.nc.crawlers.get(Number(targetId.slice(2))) ?? null;}
    return this.nc.roster.get(targetId) ?? null;
  }

  /** CTF objective from the wire flag states — same roleObjective table
   *  the server and offline bots run, so a wire bot plays the same CTF.
   *  Netbots default to offense/capper (the roles that need no deploy or
   *  cloak intent). */
  private flagObjective(): Vec3 | null {
    const {nc} = this;
    const myTeam = nc.self.team;
    if (!myTeam || nc.flags.size === 0) {return null;}
    const foeTeam = myTeam === 'alpha' ? 'bravo' : 'alpha';
    const mine = nc.flags.get(myTeam);
    const theirs = nc.flags.get(foeTeam);
    if (!mine || !theirs) {return null;}
    const s: FlagSituation = {
      home: mine.pos,
      thief: mine.state === 'carried' && mine.carrier ? this.rosterPos(mine.carrier) : null,
      dropped: mine.state === 'dropped' ? mine.pos : null,
      enemyStand: theirs.state === 'carried' ? null : theirs.pos,
      escort: theirs.state === 'carried' && theirs.carrier ? this.rosterPos(theirs.carrier) : null,
      threat: this.standThreat(mine.pos, myTeam),
    };
    const role: BotRole = this.squadRole();
    return roleObjective(role, s, this.brain.dutyLevel);
  }

  private rosterPos(id: string): Vec3 | null {
    const e = this.nc.roster.get(id);
    return e ? { ...e.pos } : null;
  }

  /** Closest hostile inside the home ring — feeds the HoF body block. */
  private standThreat(home: Vec3, myTeam: string): Vec3 | null {
    let best: Vec3 | null = null, bestD = 45;
    for (const e of this.nc.roster.values()) {
      if (e.team === myTeam || e.isDead) {continue;}
      const d = Math.hypot(e.pos.x - home.x, e.pos.z - home.z);
      if (d < bestD) { bestD = d; best = e.pos; }
    }
    return best;
  }

  /** Squad role computed each call: every peer sorts the same roster and
   *  walks assignRole's fill order, so the whole wire squad converges on
   *  one layout without a coordinator — specialist slots land on whoever
   *  sorts into them. Commitment matters more than optimality though:
   *  a bot holds its current role for a window before accepting a
   *  re-shuffle, so mid-route cappers don't flip to defense on every
   *  roster ping-pong. */
  private role: BotRole = 'offense';
  private roleT = 0;
  /** Harness pin: guarantees a runner exists for flag-lane coverage
   *  where squad fill might never assign one. */
  private forceCapper = false;
  /** Skier probe bot: fixed heading, full forward + jet, no strafe or
   *  think-steering — a straight-line fast mover to prove remote
   *  interpolation is smooth when the input stream isn't jerky. */
  private forceSkier = false;
  private skiDest: { x: number; y: number; z: number } | null = null;

  private squadRole(): BotRole {
    if (this.forceCapper) {return 'capper';}
    this.roleT -= 0.3; // think cadence — close enough for a soft window
    if (this.roleT > 0) {return this.role;}
    const mates = [this.nc.id];
    for (const [id, e] of this.nc.roster) {
      if (e.team === this.nc.self.team) {mates.push(id);}
    }
    // Kit-weighted squad fill — every peer sees the same armorClass in
    // roster entries, so argmax lands on the same bodies on all sides.
    const next = assignRole(this.nc.id, mates, WIRE_ROLES, (id) =>
      id === this.nc.id ? this.cls : this.nc.roster.get(id)?.cls);
    if (next !== this.role) {this.roleT = 8;}
    this.role = next;
    return this.role;
  }

  private ctx(): BrainCtx {
    const {nc} = this;
    return {
      pos: { x: nc.self.pos.x, y: nc.self.pos.y, z: nc.self.pos.z },
      vel: { x: nc.self.vel.x, y: nc.self.vel.y, z: nc.self.vel.z },
      enemies: this.enemies(),
      objective: this.flagObjective(),
      groundY: (x, z) => nc.surface ? nc.surface.getHeight(x, z) : nc.self.pos.y,
      now: Date.now(),
      healthFrac: nc.self.health / 100,
      energy: 100,
      weaponSpeed: (dist) => WEAPONS[this.legalWeapon(dist)]?.speed ?? 60,
      weaponGravity: (dist) => WEAPONS[this.legalWeapon(dist)]?.gravity ?? false,
      aimSkill: (dist, targetSpeed) => aimSkillFor(this.brain.skill, this.legalWeapon(dist), targetSpeed),
    };
  }

  /** The brain picks by range band, but a light-class bot can't claim
   *  heavy-tier ordnance — the server's class-lock gate would (rightly)
   *  reject it as a doctored-client claim. Fall back to the sidearm. */
  private legalWeapon(dist: number): number {
    const w = pickBotWeapon(this.loadout, dist, dist, (t) => aimSkillFor(this.brain.skill, t, 0));
    if (!HEAVY_ONLY_WEAPONS.has(w) && (WEAPONS[w]?.speed ?? 0) > 0) {return w;}
    // Beam/throw picks have no projectile claim shape — a bot that draws
    // Lightning would hold it and never claim. Fall to the nearest
    // claimable slot (splash mid > near > far > side) so the draw still
    // produces wire traffic.
    for (const alt of [this.loadout.mid, this.loadout.near, this.loadout.far, this.loadout.side]) {
      if (!HEAVY_ONLY_WEAPONS.has(alt) && (WEAPONS[alt]?.speed ?? 0) > 0) {return alt;}
    }
    return this.loadout.side;
  }

  /** Pain bookkeeping — a hit the client hasn't flinched to yet. */
  private lastPainAt = 0;

  private think(): void {
    const {nc} = this;
    if (nc.self.isDead) {
      return;
    }
    // Getting shot is a priority interrupt — a bot that keeps walking
    // while hit reads as exactly the sheep the meter counts on 'ignore'.
    const pain = nc.lastAttacker;
    if (pain && pain.at > this.lastPainAt) {
      this.lastPainAt = pain.at;
      const shooter = pain.shooterId ? nc.roster.get(pain.shooterId) : null;
      this.brain.takeHit(shooter ? { ...shooter.pos } : { ...nc.self.pos });
    }
    const out = this.brain.think(THINK_S, this.ctx());
    // The forceCapper pin exists for harness lane coverage — the brain's
    // utility goals still outrank the route otherwise, so hard-steer.
    if (this.forceCapper) {
      const fo = this.flagObjective();
      if (fo) {
        out.dest = fo;
        // Grab needs feet near the deck: any sustained thrust keeps the
        // body at cruise altitude 10-20m over the flag where the 6m
        // touch cap can't reach. Cappers walk the approach.
        const d0 = Math.hypot(nc.self.pos.x - fo.x, nc.self.pos.z - fo.z);
        if (out.move && d0 < 25) {out.move.jet = false;}
      }
    }

    // The brain's objective goals ignore enemies it can't see, and a
    // 8s test can't wait for spawns 250m apart to wander into LOS —
    // steer toward the nearest live enemy when the brain isn't firing.
    // An objective (flag route) outranks the steer though: a capper
    // detouring to every near enemy never reaches the stand.
    if (!out.fire && !this.flagObjective()) {
      let nearest: BotEnemy | null = null;
      let nd = Infinity;
      for (const e of this.ctx().enemies) {
        const d = Math.hypot(e.pos.x - nc.self.pos.x, e.pos.y - nc.self.pos.y, e.pos.z - nc.self.pos.z);
        if (d < nd) { nd = d; nearest = e; }
      }
      if (nearest && nd > 30) {out.dest = { ...nearest.pos };}
    }

    // Locomotion intent → the MoveSim turns it into real physics in
    // sendPos. Without terrain the bot keeps its old eased kinematics —
    // a fake, but better than standing still.
    const dx = out.dest.x - nc.self.pos.x;
    const dz = out.dest.z - nc.self.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.5) {this.targetYaw = Math.atan2(dx, dz);}
    this.strafePhase += THINK_S * (1.5 + this.brain.skill.movement);
    this.wantMove = {
      yaw: this.wantMove.yaw, // eased in sendPos
      // Humans feather the stick, weave under fire, and let off when
      // arriving — a rail-to-rail forward is what the sheep meter eats.
      forward: d > 0.5 ? Math.min(1, 0.65 + this.rand() * 0.4) : 0,
      right: d > 8 ? Math.sin(this.strafePhase) * 0.6 : 0,
      // Real players jet the flats and the uphills — skiing alone leaves
      // a bot crawling valleys the fake kinematics used to skip over.
      // The vertical term stands alone: a stand parked overhead has
      // ~zero XZ distance, so gating it on d strands bots underneath.
      // The diveRun cut matches botMoves: inside graze range with the
      // target at deck level, thrust is what holds the body airborne —
      // cut it and let momentum graze the stand.
      jet: this.forceCapper && d < 25
        // Final approach on foot: thrust this close keeps the body at
        // cruise altitude over the flag where the 6m touch cap can't
        // reach — the grab needs feet near deck level.
        ? false
        : ((Boolean(out.move?.jet) || d > 60 || out.dest.y > nc.self.pos.y + 4)
          && !(d < 45 && out.dest.y < nc.self.pos.y + 4)),
      jump: Boolean(out.move?.jump),
    };
    if (this.forceSkier) {
      // Long straight fast legs: pick a far anchor, ski to it, pick
      // another on arrival — minimal turns, full throttle.
      if (!this.skiDest || Math.hypot(this.skiDest.x - nc.self.pos.x, this.skiDest.z - nc.self.pos.z) < 30) {
        const a = this.rand() * Math.PI * 2;
        this.skiDest = { x: nc.self.pos.x + Math.cos(a) * 400, y: nc.self.pos.y, z: nc.self.pos.z + Math.sin(a) * 400 };
        this.targetYaw = Math.atan2(this.skiDest.x - nc.self.pos.x, this.skiDest.z - nc.self.pos.z);
      }
      this.wantMove = { yaw: this.wantMove.yaw, forward: 1, right: 0, jet: true, jump: false };
      return;
    }
    if (!nc.surface) {
      if (d > 0.5) {
        const step = Math.min(CRUISE * THINK_S, d);
        nc.self.pos.x += (dx / d) * step;
        nc.self.pos.z += (dz / d) * step;
        nc.self.pos.y += (out.dest.y - nc.self.pos.y) * 0.2;
        nc.self.vel = { x: (dx / d) * CRUISE, y: 0, z: (dz / d) * CRUISE };
      } else {
        nc.self.vel = { x: 0, y: 0, z: 0 };
      }
    }
    if (out.move?.jump) {nc.send({ type: 'jump', position: { ...nc.self.pos } });}
    if (out.move?.jet) {nc.send({ type: 'jetpack', position: { ...nc.self.pos } });}

    if (out.fire) { nc.tel.fireIntents++; this.fire(out.fire.targetId, out.fire.aim); }
  }

  /** Spawn claim → the shell exists server-side; impact claims go out at
   *  flight time. Mirrors fire.ts sendShot + impact.ts claims. */
  private fire(targetId: string, aim: { x: number; y: number; z: number }): void {
    const {nc} = this;
    const blocked = (why: string) => {
      nc.tel.fireBlocked.set(why, (nc.tel.fireBlocked.get(why) ?? 0) + 1);
    };
    const target = this.targetEntry(targetId);
    if (!target || target.isDead) {return blocked('dead');}
    const dist = Math.hypot(target.pos.x - nc.self.pos.x, target.pos.y - nc.self.pos.y, target.pos.z - nc.self.pos.z);
    // Long shots are unclaimable on jitter — a shell in the air >0.5s
    // leaves the target too much room to dodge past the legal radius
    // by the time the hit claim lands. Real fights close first anyway.
    if (dist > 45) {return blocked('dist');}
    // No wounded-target gate: a real player keeps firing at sub-50hp
    // enemies — it's the most human shot there is. A claim that lands
    // after the target dies hits the same server reject any player's
    // late volley would.
    const weaponType = this.legalWeapon(dist);
    const w = WEAPONS[weaponType];
    if (!w || w.speed <= 0) {return blocked('speed0');} // hitscan kinds — skip for now, beams need their own claim shape
    // The server enforces WEAPON_FIRE_INTERVAL_S per spawn claim — fire
    // slower than it and every spawn claim reads as spam.
    const interval = (WEAPON_FIRE_INTERVAL_S[weaponType as WeaponType] ?? 0.1) * 1000;
    if (Date.now() - this.lastFireAt < interval) {return blocked('interval');}
    if (Date.now() < this.holdFireUntil) {return blocked('holdfire');}
    this.lastFireAt = Date.now();

    const dir = {
      x: aim.x - nc.self.pos.x,
      y: aim.y - nc.self.pos.y,
      z: aim.z - nc.self.pos.z,
    };
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const shotId = `${nc.id}-s${++this.shotN}`;
    // Claimless: one fire intent carries aim only — the server sims the
    // shell and declares every outcome. No spawn claim, no hit claim,
    // no settle bookkeeping; a real client predicts and stops there.
    nc.send({
      type: 'shotFired', weaponType,
      dir: { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl },
      pos: { x: nc.self.pos.x, y: nc.self.pos.y, z: nc.self.pos.z },
      shotId,
      fireAt: nc.serverNowMs(),
    } as ClientMessage);
    nc.tel.shots++;
  }

  private inSeq = 0;
  private sim: MoveSim | null = null;
  private wantMove = { yaw: 0, forward: 0, right: 0, jet: false, jump: false };
  /** Where the nose should end up — sendPos eases yaw toward this at a
   *  mouse-speed turn rate so the heading doesn't snap per think. */
  private targetYaw = 0;
  private strafePhase = Math.random() * Math.PI * 2;
  /** Local mirror of the server shadow's jet tank — it only thrusts
   *  while energy > 0, so an always-on jet claim would diverge the
   *  moment the modeled tank emptied. */
  private energy: number = ENERGY.max;
  private jetting = false;

  /** One local MoveSim per bot, fed the same input stream it sends — the
   *  server's shadow replays the identical class on the identical field,
   *  so divergence shrinks to packet loss, not a fake-kinematics gap. */
  private ensureSim(): MoveSim | null {
    const {nc} = this;
    if (!nc.surface) {return null;}
    if (!this.sim) {
      this.sim = new MoveSim(nc.surface, {
        pos: { ...nc.self.pos }, vel: { ...nc.self.vel },
        yaw: 0, pitch: 0, onGround: true,
      });
      // Same class body as the server shadow — mass/eye/radius/speed all
      // ride the class row or the contact resolve diverges by design.
      const st = CLASS_STATS[this.cls];
      this.sim.speedScale = st.speedScale;
      this.sim.mass = st.mass;
      this.sim.eyeHeight = st.eyeHeight;
      this.sim.bodyRadius = st.radius;
    }
    return this.sim;
  }

  /** The wire knockback echo → the local sim's velocity. Mirrors
   *  combatBlast.shove: eff = force/class mass, dir = self − blast,
   *  push lifts 0.5·eff, pull sucks and lifts 0.3·eff. */
  private takeShove(from: Vec3, force: number, pull?: boolean): void {
    const eff = force / CLASS_STATS[this.cls].mass;
    const ox = this.nc.self.pos.x - from.x;
    const oy = this.nc.self.pos.y - from.y;
    const oz = this.nc.self.pos.z - from.z;
    const d = Math.hypot(ox, oy, oz);
    if (d <= 0) {return;}
    const s = pull ? -1 : 1;
    const dv = { x: s * (ox / d) * eff, y: (pull ? 0.3 : 0.5) * eff, z: s * (oz / d) * eff };
    this.nc.self.vel.x += dv.x; this.nc.self.vel.y += dv.y; this.nc.self.vel.z += dv.z;
    const {sim} = this;
    if (sim) {
      sim.state.vel.x += dv.x; sim.state.vel.y += dv.y; sim.state.vel.z += dv.z;
      sim.state.onGround = false; // blast ungrounds — friction would eat the shove
    }
  }

  /** Set while dead — the first post-respawn sendPos force-reseats the
   *  local sim (a corpse within 20m of the spawn point would otherwise
   *  keep its stale position AND stale momentum). */
  private wasDead = false;

  private sendPos(): void {
    const {nc} = this;
    if (nc.self.isDead) { this.wasDead = true; return; }
    const sim = this.ensureSim();
    if (sim) {
      // A server-side snap (respawn, correction, room-hop gameState) is
      // the truth — reseat the local sim on it instead of gliding over.
      const ddx = nc.self.pos.x - sim.state.pos.x;
      const ddy = nc.self.pos.y - sim.state.pos.y;
      const ddz = nc.self.pos.z - sim.state.pos.z;
      if (this.wasDead || ddx * ddx + ddy * ddy + ddz * ddz > 20 * 20) {
        sim.setState({ pos: { ...nc.self.pos }, vel: { ...nc.self.vel }, yaw: this.wantMove.yaw, pitch: 0, onGround: true });
      }
      this.wasDead = false;
      // Mouse-speed turn toward targetYaw — an instant snap per think
      // is the dead giveaway the sheep meter was built to catch.
      const TURN = 6.5 / POS_HZ;
      let dy = this.targetYaw - this.wantMove.yaw;
      dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      this.wantMove.yaw += Math.abs(dy) < TURN ? dy : Math.sign(dy) * TURN;
      sim.state.yaw = this.wantMove.yaw;
      this.jetting = this.wantMove.jet && this.energy > 0;
      this.energy = Math.max(0, Math.min(ENERGY.max,
        this.energy + (this.jetting ? -ENERGY.jetDrain : ENERGY.jetCharge) * (1 / POS_HZ)));
      sim.setInput({ forward: this.wantMove.forward, right: this.wantMove.right, jumpHeld: this.wantMove.jump, skiHeld: true, jetHeld: this.jetting });
      // Body contact: the server shadow resolves every live roster body,
      // so the local mirror sees the same shoves or it reads divergence.
      const {bodies} = sim;
      bodies.length = 0;
      for (const [id, r] of nc.roster) {
        if (r.isDead) {continue;}
        const st = CLASS_STATS[r.cls as keyof typeof CLASS_STATS] ?? CLASS_STATS.medium;
        bodies.push({ id, x: r.pos.x, y: r.pos.y, z: r.pos.z, h: st.eyeHeight, mass: st.mass, r: st.radius, vx: r.vel.x, vz: r.vel.z });
      }
      sim.update(1 / POS_HZ);
      nc.self.pos = { x: sim.state.pos.x, y: sim.state.pos.y, z: sim.state.pos.z };
      nc.self.vel = { x: sim.state.vel.x, y: sim.state.vel.y, z: sim.state.vel.z };
    }
    const yaw = sim ? sim.state.yaw : Math.atan2(nc.self.vel.x, nc.self.vel.z);
    this.inSeq++;
    nc.send({
      type: 'inputMove', seq: this.inSeq,
      input: { forward: this.wantMove.forward, right: this.wantMove.right, jump: this.wantMove.jump ? 1 : 0, ski: 1, jet: this.jetting ? 1 : 0 },
      rotation: { yaw, pitch: 0 },
    }, true);
    // Movement stays ordered (steady) — jitter lives on the claim channel,
    // matching how the real client keeps movement seq-gated.
    // Real clients ride their ping in every position frame — omitting it
    // leaves the roster row ping-less, which the remote-liveness gate
    // reads as a dead socket: the render entity goes staleHidden and its
    // position freezes at spawn while the wire records keep flowing.
    nc.send({ type: 'position', position: { ...nc.self.pos }, rotation: { yaw, pitch: 0 }, velocity: { ...nc.self.vel }, inputSeq: this.inSeq, ping: nc.pingMs }, true);
  }
}
