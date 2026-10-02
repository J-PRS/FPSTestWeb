// NetBot behavior — a REAL BotBrain driving a REAL wire client. Movement
// goes out on the position channel (the bot owns its own kinematics like a
// v1 client); fire decisions go through the real claim chain the browser
// client uses: spawn `shot` → hit claim `shot` / blast claim `aoeShot`,
// bound by shotId. That chain is exactly what the deferred-claim and
// seq-watermark fixes protect, which is what this harness exists to
// exercise — a server-internal bot can never produce a reject.

import { BotBrain, type BotEnemy, type BrainCtx } from '../../shared/botBrain.ts';
import { MoveSim, ENERGY, GRAVITY } from '../../shared/movement.ts';

import { BOT_LOADOUTS, botClassForLoadout, pickBotWeapon, type BotLoadout } from '../../shared/botLoadouts.ts';
import { aimSkillFor } from '../../shared/botSkill.ts';
import { WEAPONS } from '../../shared/weaponTable.ts';
import { WEAPON_FIRE_INTERVAL_S } from '../../shared/weapons.ts';
import { HEAVY_ONLY_WEAPONS } from '../../shared/botClasses.ts';
import type { WeaponType } from '../../shared/weaponTable.ts';
import type { ClientMessage, Vec3 } from '../../shared/protocol.ts';
import { assignRole, roleObjective, WIRE_ROLES, type BotRole, type FlagSituation } from '../../shared/flagGoals.ts';
import type { NetClient, RemoteEntry } from './netClient.ts';

const THINK_S = 0.3;
const POS_HZ = 10;
/** Client-side cruise speed — roughly a medium on skis. */
const CRUISE = 32;
/** Bots miss on purpose — a claim rate humans actually produce. */
const DIRECT_P = 0.55;
const BLAST_P = 0.25;

interface Shell {
  shotId: string;
  weaponType: number;
  targetId: string;
  /** Flight seconds — the claim's airtime value. */
  flightS: number;
  /** When the client-side flight should land. */
  impactAt: number;
  impactPos: Vec3;
  /** Spawn origin + launch velocity — the shell's legal endpoint is a
   *  point ON its own arc, not wherever the target happened to stand;
   *  claiming blast at the target reads as a forged trajectory (reach
   *  rejects prove the server checks exactly this). */
  origin: Vec3;
  launchVel: Vec3;
  /** 'b' = ball, 'c' = crawler — creature targets claim via the
   *  creatureHit/crawlerHit wire path instead of a `shot` hit. */
  creature: '' | 'b' | 'c';
  rolled: boolean;
}

export class NetBot {
  private brain: BotBrain;
  private loadout = BOT_LOADOUTS[Math.floor(Math.random() * BOT_LOADOUTS.length)] ?? BOT_LOADOUTS[0]!;
  private get cls() { return botClassForLoadout(this.loadout); }
  private shells: Shell[] = [];
  /** Spawn claims awaiting their projectileCreated echo — a client on a
   *  lossy transport retransmits (the server dedups by shotId, so resends
   *  are idempotent); on reliable lanes the echo always beats the timer
   *  and this stays empty. */
  private spawns = new Map<string, { msg: ClientMessage; at: number }>();
  private shotN = 0;
  private thinkTimer: ReturnType<typeof setInterval> | null = null;
  private lastFireAt = 0;
  private posTimer: ReturnType<typeof setInterval> | null = null;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private hopTimer: ReturnType<typeof setInterval> | null = null;
  /** Fire silence during the last stretch before a room hop — jittered
   *  claims sent right up to the switch land in the NEW room carrying
   *  the old position, and the server rightly rejects them as
   *  implausible spawns. A player stops shooting while they click the
   *  room-switch UI; the bot does the same. */
  private holdFireUntil = 0;
  private rand: () => number;

  constructor(private nc: NetClient, opts: { hopEveryMs?: number; seed?: () => number; loadout?: BotLoadout } = {}) {
    if (opts.loadout) this.loadout = opts.loadout;
    this.brain = new BotBrain({ x: 0, y: 60, z: 0 });
    this.rand = opts.seed ?? Math.random;
    if (opts.hopEveryMs) {
      this.hopTimer = setInterval(() => {
        // Hold fire for the jitter window first, THEN send the switch —
        // see holdFireUntil.
        this.holdFireUntil = Date.now() + 300;
        setTimeout(() => {
          // Mid-match room hop — the seq-watermark bug class lives here.
          // Shells don't cross rooms: un-acked spawns and in-flight
          // impact claims for the old room's sky would retransmit into
          // the new room with stale positions and earn implausible-spawn
          // rejects — a real client's projectiles die with the room too.
          this.spawns.clear();
          this.shells.length = 0;
          nc.send({ type: 'switchRoom', room: this.rand() < 0.5 ? 'netbot-a' : 'netbot-b', mode: 'dm' });
          nc.tel.hops++;
        }, 200);
      }, opts.hopEveryMs);
    }
  }

  start(): void {
    this.thinkTimer = setInterval(() => this.think(), THINK_S * 1000);
    this.posTimer = setInterval(() => this.sendPos(), 1000 / POS_HZ);
    this.claimTimer = setInterval(() => this.settle(), 50);
  }

  stop(): void {
    for (const t of [this.thinkTimer, this.posTimer, this.claimTimer, this.hopTimer]) {
      if (t) clearInterval(t);
    }
  }

  private enemies(): BotEnemy[] {
    const out: BotEnemy[] = [];
    for (const [id, e] of this.nc.roster) {
      if (e.isDead) continue;
      if (this.nc.self.team && e.team === this.nc.self.team) continue;
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
      if ((b.pos.x - me.x) ** 2 + (b.pos.y - me.y) ** 2 + (b.pos.z - me.z) ** 2 > 200 * 200) continue;
      out.push({ id: `b:${bid}`, pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z }, vel: { x: b.vel.x, y: b.vel.y, z: b.vel.z }, alive: true });
    }
    for (const [cid, c] of this.nc.crawlers) {
      if ((c.pos.x - me.x) ** 2 + (c.pos.y - me.y) ** 2 + (c.pos.z - me.z) ** 2 > 200 * 200) continue;
      out.push({ id: `c:${cid}`, pos: { x: c.pos.x, y: c.pos.y, z: c.pos.z }, vel: { x: c.vel.x, y: c.vel.y, z: c.vel.z }, alive: true });
    }
    return out;
  }

  /** Look up a fire target — players live in the roster, creatures in
   *  their own wire-fed maps keyed `b:<id>` / `c:<id>` like the server
   *  sense names them. */
  private targetEntry(targetId: string): RemoteEntry | null {
    if (targetId.startsWith('b:')) return this.nc.balls.get(+targetId.slice(2)) ?? null;
    if (targetId.startsWith('c:')) return this.nc.crawlers.get(+targetId.slice(2)) ?? null;
    return this.nc.roster.get(targetId) ?? null;
  }

  /** CTF objective from the wire flag states — same roleObjective table
   *  the server and offline bots run, so a wire bot plays the same CTF.
   *  Netbots default to offense/capper (the roles that need no deploy or
   *  cloak intent). */
  private flagObjective(): Vec3 | null {
    const nc = this.nc;
    const myTeam = nc.self.team;
    if (!myTeam || nc.flags.size === 0) return null;
    const foeTeam = myTeam === 'alpha' ? 'bravo' : 'alpha';
    const mine = nc.flags.get(myTeam);
    const theirs = nc.flags.get(foeTeam);
    if (!mine || !theirs) return null;
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
      if (e.team === myTeam || e.isDead) continue;
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

  private squadRole(): BotRole {
    this.roleT -= 0.3; // think cadence — close enough for a soft window
    if (this.roleT > 0) return this.role;
    const mates = [this.nc.id];
    for (const [id, e] of this.nc.roster) {
      if (e.team === this.nc.self.team) mates.push(id);
    }
    // Kit-weighted squad fill — every peer sees the same armorClass in
    // roster entries, so argmax lands on the same bodies on all sides.
    const next = assignRole(this.nc.id, mates, WIRE_ROLES, (id) =>
      id === this.nc.id ? this.cls : this.nc.roster.get(id)?.cls);
    if (next !== this.role) this.roleT = 8;
    this.role = next;
    return this.role;
  }

  private ctx(): BrainCtx {
    const nc = this.nc;
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
    if (!HEAVY_ONLY_WEAPONS.has(w) && (WEAPONS[w]?.speed ?? 0) > 0) return w;
    // Beam/throw picks have no projectile claim shape — a bot that draws
    // Lightning would hold it and never claim. Fall to the nearest
    // claimable slot (splash mid > near > far > side) so the draw still
    // produces wire traffic.
    for (const alt of [this.loadout.mid, this.loadout.near, this.loadout.far, this.loadout.side]) {
      if (!HEAVY_ONLY_WEAPONS.has(alt) && (WEAPONS[alt]?.speed ?? 0) > 0) return alt;
    }
    return this.loadout.side;
  }

  /** Pain bookkeeping — a hit the client hasn't flinched to yet. */
  private lastPainAt = 0;

  private think(): void {
    const nc = this.nc;
    if (nc.self.isDead) return;
    // Getting shot is a priority interrupt — a bot that keeps walking
    // while hit reads as exactly the sheep the meter counts on 'ignore'.
    const pain = nc.lastAttacker;
    if (pain && pain.at > this.lastPainAt) {
      this.lastPainAt = pain.at;
      const shooter = pain.shooterId ? nc.roster.get(pain.shooterId) : null;
      this.brain.takeHit(shooter ? { ...shooter.pos } : { ...nc.self.pos });
    }
    const out = this.brain.think(THINK_S, this.ctx());

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
      if (nearest && nd > 30) out.dest = { ...nearest.pos };
    }

    // Locomotion intent → the MoveSim turns it into real physics in
    // sendPos. Without terrain the bot keeps its old eased kinematics —
    // a fake, but better than standing still.
    const dx = out.dest.x - nc.self.pos.x;
    const dz = out.dest.z - nc.self.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.5) this.targetYaw = Math.atan2(dx, dz);
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
      jet: (!!out.move?.jet || d > 60 || out.dest.y > nc.self.pos.y + 4)
        && !(d < 45 && out.dest.y < nc.self.pos.y + 4),
      jump: !!out.move?.jump,
    };
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
    if (out.move?.jump) nc.send({ type: 'jump', position: { ...nc.self.pos } });
    if (out.move?.jet) nc.send({ type: 'jetpack', position: { ...nc.self.pos } });

    if (out.fire) { nc.tel.fireIntents++; this.fire(out.fire.targetId, out.fire.aim); }
  }

  /** Spawn claim → the shell exists server-side; impact claims go out at
   *  flight time. Mirrors fire.ts sendShot + impact.ts claims. */
  private fire(targetId: string, aim: { x: number; y: number; z: number }): void {
    const nc = this.nc;
    const blocked = (why: string) => {
      nc.tel.fireBlocked.set(why, (nc.tel.fireBlocked.get(why) ?? 0) + 1);
    };
    const target = this.targetEntry(targetId);
    if (!target || target.isDead) return blocked('dead');
    const dist = Math.hypot(target.pos.x - nc.self.pos.x, target.pos.y - nc.self.pos.y, target.pos.z - nc.self.pos.z);
    // Long shots are unclaimable on jitter — a shell in the air >0.5s
    // leaves the target too much room to dodge past the legal radius
    // by the time the hit claim lands. Real fights close first anyway.
    if (dist > 45) return blocked('dist');
    // No wounded-target gate: a real player keeps firing at sub-50hp
    // enemies — it's the most human shot there is. A claim that lands
    // after the target dies hits the same server reject any player's
    // late volley would.
    const isCreature = targetId.startsWith('b:') || targetId.startsWith('c:');
    const weaponType = this.legalWeapon(dist);
    const w = WEAPONS[weaponType];
    if (!w || w.speed <= 0) return blocked('speed0'); // hitscan kinds — skip for now, beams need their own claim shape
    // The server enforces WEAPON_FIRE_INTERVAL_S per spawn claim — fire
    // slower than it and every spawn claim reads as spam.
    const interval = (WEAPON_FIRE_INTERVAL_S[weaponType as WeaponType] ?? 0.1) * 1000;
    if (Date.now() - this.lastFireAt < interval) return blocked('interval');
    if (Date.now() < this.holdFireUntil) return blocked('holdfire');
    this.lastFireAt = Date.now();

    const dir = {
      x: aim.x - nc.self.pos.x,
      y: aim.y - nc.self.pos.y,
      z: aim.z - nc.self.pos.z,
    };
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const shotId = `${nc.id}-s${++this.shotN}`;
    const spawnMsg: ClientMessage = {
      type: 'shot', targetId: null, weaponType,
      position: { x: nc.self.pos.x, y: nc.self.pos.y, z: nc.self.pos.z },
      velocity: { x: (dir.x / dl) * w.speed, y: (dir.y / dl) * w.speed, z: (dir.z / dl) * w.speed },
      shotId,
      timestamp: Date.now(), // client fire clock — the fire-rate gate's jitter escape hatch
    };
    nc.send(spawnMsg);
    this.spawns.set(shotId, { msg: spawnMsg, at: Date.now() });
    nc.tel.shots++;
    const flightS = dist / w.speed;
    // Lead the claim like a real client does — the shell lands where
    // the target will BE at impact, and the server validates that point
    // against the rewound position (a stale pos reads as a forged hit).
    this.shells.push({
      shotId, weaponType, targetId,
      flightS,
      impactAt: Date.now() + flightS * 1000,
      origin: { x: nc.self.pos.x, y: nc.self.pos.y, z: nc.self.pos.z },
      launchVel: { x: (dir.x / dl) * w.speed, y: (dir.y / dl) * w.speed, z: (dir.z / dl) * w.speed },
      impactPos: {
        x: target.pos.x + target.vel.x * flightS,
        y: target.pos.y + target.vel.y * flightS,
        z: target.pos.z + target.vel.z * flightS,
      },
      creature: isCreature ? (targetId.startsWith('b:') ? 'b' : 'c') : '',
      rolled: false,
    });
  }

  /** Impact bookkeeping — when the client-side flight should have landed,
   *  emit the same claim pair impact.ts emits (direct `shot` + blast
   *  `aoeShot`), with honest misses interleaved. */
  private settle(): void {
    const nc = this.nc;
    const now = Date.now();
    // Retransmit spawns the server never acked — the projectileCreated
    // echo is the ack. Beyond ~2s the shell's flight is over anyway.
    for (const [shotId, sp] of this.spawns) {
      if (nc.projectiles.has(shotId) || now - sp.at > 2000) { this.spawns.delete(shotId); continue; }
      if (now - sp.at > 400) { nc.send(sp.msg); sp.at = now - 200; }
    }
    this.shells = this.shells.filter((sh) => {
      if (now < sh.impactAt) return true;
      if (sh.rolled) return false;
      sh.rolled = true;
      const airtime = sh.flightS;
      const w = WEAPONS[sh.weaponType];
      const projId = nc.projectiles.get(sh.shotId);
      const roll = this.rand();
      const aoe = (w?.aoeRadius ?? 0) > 0;
      const target = this.targetEntry(sh.targetId);
      // Where the shell really is at flight end — the blast claims this
      // point, not the target's position; a shell can't detonate off
      // its own arc and the server's reach check knows it.
      const drop = w?.gravity ? 0.5 * GRAVITY * sh.flightS * sh.flightS : 0;
      const endPos = {
        x: sh.origin.x + sh.launchVel.x * sh.flightS,
        y: sh.origin.y + sh.launchVel.y * sh.flightS + drop,
        z: sh.origin.z + sh.launchVel.z * sh.flightS,
      };

      if (roll < DIRECT_P && target && !target.isDead) {
        // Direct claims need the target's position at claim-land time —
        // the server rewinds it by our ping. Our roster copy is up to a
        // tick stale plus the link latency, so a sprinting target is
        // already outside the ~1-3m legal radius no matter the lead:
        // honest players splash those, they only body-claim the slow
        // ones. Sprinting targets take the blast branch instead.
        if (sh.creature) {
          // Creature hits don't rewind a player — the server sanity-
          // clamps damage against its own sim. Same claim a real
          // client's contact path emits.
          const dmg = WEAPONS[sh.weaponType]?.directDamage ?? 0;
          nc.send({
            type: sh.creature === 'b' ? 'creatureHit' : 'crawlerHit',
            id: +sh.targetId.slice(2), damage: dmg,
          } as ClientMessage);
          nc.tel.claims++;
          return false;
        }
        const speed = Math.hypot(target.vel.x, target.vel.z);
        const leadS = nc.pingMs / 2000 + 0.05;
        const hitPos = {
          x: target.pos.x + target.vel.x * leadS,
          y: target.pos.y + target.vel.y * leadS,
          z: target.pos.z + target.vel.z * leadS,
        };
        // Even slow targets get dodged: a juking player ends up meters
        // from where the shell lands, and a real client sees that whiff —
        // it never claims the hit. Only claim when the impact point still
        // overlaps the capsule our own model renders, else take the miss
        // branch like the real impact path does.
        const contact = Math.hypot(sh.impactPos.x - target.pos.x, sh.impactPos.y - target.pos.y, sh.impactPos.z - target.pos.z);
        if (speed > 15 || contact > 1.0) {
          if (aoe) {
            nc.send({
              type: 'aoeShot', position: endPos, weaponType: sh.weaponType,
              projectileId: projId ?? null, shotId: sh.shotId, airtime,
            });
            nc.tel.claims++;
          } else if (projId) {
            // No splash to offer — a sprinting target is unclaimable,
            // so the shell just dies like a real whiffed shot.
            nc.send({ type: 'projectileDestroy', projectileId: projId, shotId: sh.shotId });
          }
          return false;
        }
        nc.send({ type: 'shot', targetId: sh.targetId, weaponType: sh.weaponType, position: hitPos, projectileId: projId ?? null, shotId: sh.shotId, airtime });
        nc.tel.claims++;
        if (aoe) {
          nc.send({
            type: 'aoeShot', position: hitPos, weaponType: sh.weaponType,
            excludeTargetId: sh.targetId, projectileId: projId ?? null, shotId: sh.shotId,
            airtime, directHit: true,
          });
          nc.tel.claims++;
        }
      } else if (roll < DIRECT_P + BLAST_P && aoe) {
        // Blast-only: near miss that still splashes — claimed where
        // the shell's own arc ends, not at the target.
        nc.send({
          type: 'aoeShot', position: endPos, weaponType: sh.weaponType,
          projectileId: projId ?? null, shotId: sh.shotId, airtime,
        });
        nc.tel.claims++;
      } else if (projId) {
        // Clean miss — shell dies at terrain/fuse like a real shot.
        nc.send({ type: 'projectileDestroy', projectileId: projId, shotId: sh.shotId });
      }
      return false;
    });
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
    const nc = this.nc;
    if (!nc.surface) return null;
    if (!this.sim) {
      this.sim = new MoveSim(nc.surface, {
        pos: { ...nc.self.pos }, vel: { ...nc.self.vel },
        yaw: 0, pitch: 0, onGround: true,
      });
    }
    return this.sim;
  }

  private sendPos(): void {
    const nc = this.nc;
    if (nc.self.isDead) return;
    const sim = this.ensureSim();
    if (sim) {
      // A server-side snap (respawn, correction, room-hop gameState) is
      // the truth — reseat the local sim on it instead of gliding over.
      const ddx = nc.self.pos.x - sim.state.pos.x;
      const ddy = nc.self.pos.y - sim.state.pos.y;
      const ddz = nc.self.pos.z - sim.state.pos.z;
      if (ddx * ddx + ddy * ddy + ddz * ddz > 20 * 20) {
        sim.setState({ pos: { ...nc.self.pos }, vel: { ...nc.self.vel }, yaw: this.wantMove.yaw, pitch: 0, onGround: true });
      }
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
    nc.send({ type: 'position', position: { ...nc.self.pos }, rotation: { yaw, pitch: 0 }, velocity: { ...nc.self.vel }, inputSeq: this.inSeq }, true);
  }
}
