import type { Vec3, ServerMessage, PlayerState } from './types.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import { WORLD_MODEL, eventPayload } from '../../shared/worldModel.ts';
import { FORCE_SEND_MS } from './combatBlast.ts';
import {
  type Deployed, type RoomDeployables,
  TURRET_RANGE, TURRET_FIRE_INTERVAL, TURRET_DAMAGE,
  MINE_TRIGGER_DIST, MINE_DAMAGE, MINE_BLAST_RADIUS, MINE_KNOCKBACK,
  STATION_RANGE, STATION_HEAL_CD, STATION_HP_RATE,
  DRONE_HOVER_UP, DRONE_RANGE, DRONE_DAMAGE, DRONE_FIRE_INTERVAL,
} from './RoomDeployables.ts';
import { healPool } from './healPool.ts';
import { DEPLOY_ITEMS } from '../../shared/deployItems.ts';
import { GRAVITY } from '../../shared/movement.ts';
import { hmNormal, hmHeight } from '../../shared/heightfield.ts';
import { simNow } from './simClock.ts';
import { wallNow , wallMs} from './wallClock.ts';
import { STATUS, shootRevealed } from '../../shared/status.ts';

  /** Structure LOS for the gun scan - a sentry indoors shouldn't plink
   *  players outside through the wall. Target at chest height. */
export function losClear(r: RoomDeployables, from: Vec3, to: Vec3, team?: string): boolean {
    const cols = r.room.ballSim.colliders;
    if (cols.length === 0) {return true;}
    return !segSolidHit(
      { x: from.x, y: from.y + 0.5, z: from.z },
      { x: to.x, y: to.y + 1, z: to.z },
      cols, r.room.ballSim.colliderIndex ?? undefined, team,
    );
  }



// Per-kind deployable ticks - drone escort scan, proximity-mine fuse,
// resupply-pad pulse, structure LOS, sentry fire. RoomDeployables owns
// the item table + lifecycle; the behavior half lives here.

  /** Escort drone: shadow follows the owner's hover anchor, and the same
   *  nearest-hostile scan as the sentry plinks whoever's in range. */
export function tickDrone(r: RoomDeployables, d: Deployed, dt: number): void {
    const owner = r.room.players.getPlayer(d.owner);
    if (!owner || owner.isDead) { r.remove(d.id); return; }
    d.pos.x = owner.position.x;
    d.pos.y = owner.position.y + DRONE_HOVER_UP;
    d.pos.z = owner.position.z;
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    let target: string | null = null;
    let bestD2 = DRONE_RANGE * DRONE_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) {continue;}
      if (!losClear(r, d.pos, p.position, dTeam)) {continue;}
      bestD2 = d2; target = pid;
    }
    if (!target) { d.fireCd = 0.15; return; }
    d.fireCd = DRONE_FIRE_INTERVAL;
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'turretShot', 'id', d.id, { owner: d.owner, targetId: target }) as ServerMessage);
    r.room.messages.turretAttack(d.owner, target, DRONE_DAMAGE);
  }

  /** Proximity mine: after the arm delay, a hostile stepping inside the
   *  fuse radius detonates it — blast applies through the shared AOE
   *  funnel (falloff + knockback + friendly gate), clients paint the boom
   *  off the mineBoom broadcast. */
export function tickMine(r: RoomDeployables, d: Deployed, _dt: number): void {
    d.fireCd -= _dt; // doubles as the arm timer
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      // Spawn grace exempts like the sentry scan — a fresh spawn standing
      // on a fuse shouldn't eat it before control hands over.
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz < MINE_TRIGGER_DIST * MINE_TRIGGER_DIST) {
        r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'mineBoom', 'id', d.id, { owner: d.owner, pos: Object.assign({}, d.pos) }) as ServerMessage);
        r.remove(d.id);
        r.room.messages.mineBlast(d.owner, d.pos, MINE_DAMAGE, MINE_BLAST_RADIUS, MINE_KNOCKBACK);
        return;
      }
    }
  }

  /** Jump pad: after the arm delay, ANY body in the ring rides the
   *  surface normal out - no team check, a pad helps whoever steps on
   *  it. Per-body cooldown keeps a lingerer from re-firing every tick;
   *  the whoosh rides the wire so remote clients see the launch. */
  const _padN = { x: 0, y: 1, z: 0 };
export function tickPad(r: RoomDeployables, d: Deployed, _dt: number): void {
    d.fireCd -= _dt; // doubles as the arm timer - same convention as the mine
    if (d.fireCd > 0) {return;}
    const def = DEPLOY_ITEMS.pad;
    const tr = def.triggerDist!, sp = def.launchSpeed!;
    const n = _padN;
    n.x = 0; n.y = 1; n.z = 0;
    const onStruct = padStructNormal(r, d, n);
    if (!onStruct && r.room.field) {hmNormal(r.room.field, d.pos.x, d.pos.z, n);}
    padHits(r, d, n, sp, tr);
  }

  // The surface the pad actually SITS on keys the launch dir: on a
  // dome cap it's radial, on a flat structure top it's up - the
  // terrain normal under the floor is wrong for both.
  function padStructNormal(r: RoomDeployables, d: Deployed, n: { x: number; y: number; z: number }): boolean {
    for (const c of r.room.ballSim.colliders) {
      const dx = d.pos.x - c.cx, dz = d.pos.z - c.cz;
      let surfY: number, nx = 0, ny = 1, nz = 0;
      if (c.dome) {
        const d2 = dx * dx + dz * dz;
        if (d2 >= c.dome * c.dome) {continue;}
        surfY = (c.cy - c.hy) + Math.sqrt(c.dome * c.dome - d2);
        nx = dx; ny = d.pos.y - (c.cy - c.hy); nz = dz;
      } else {
        const lx = dx * c.cos + dz * c.sin, lz = -dx * c.sin + dz * c.cos;
        if (Math.abs(lx) > c.hx || Math.abs(lz) > c.hz) {continue;}
        surfY = c.cy + c.hy;
      }
      if (Math.abs(d.pos.y - surfY) > 1.5) {continue;}
      const il = 1 / (Math.hypot(nx, ny, nz) || 1);
      n.x = nx * il; n.y = ny * il; n.z = nz * il;
      return true;
    }
    return false;
  }

  function padHits(r: RoomDeployables, d: Deployed, n: { x: number; y: number; z: number }, sp: number, tr: number): void {
    const now = simNow();
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz >= tr * tr) {continue;}
      const last = d.padHits?.get(pid) ?? -1e9;
      if (now - last < 1500) {continue;}
      (d.padHits ??= new Map()).set(pid, now);
      // A little extra up-lift on top of the normal so a flat pad still
      // throws a body skyward instead of sliding it along the dirt.
      const dv = { x: n.x * sp, y: n.y * sp + 6, z: n.z * sp };
      r.room.moveSim.applyImpulse(pid, dv);
      r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'padBoing', 'id', d.id, {
        pos: { x: d.pos.x, y: d.pos.y, z: d.pos.z },
        nx: dv.x / sp, ny: dv.y / sp, nz: dv.z / sp,
      }) as ServerMessage);
    }
  }

  /** Loiter munition: after the arm delay it circles over the plant spot
   *  and watches a dive ring (LOS-gated like a sentry - no kamikaze
   *  through walls). A hostile inside commits it: a powered dive on the
   *  led line, detonating on proximity, fuse expiry, or ground contact.
   *  The loiterDive edge carries the launch velocity so replicas fly the
   *  identical swoop; the blast lands through the mineBoom funnel. */
export function tickLoiter(r: RoomDeployables, d: Deployed, dt: number): void {
    const def = DEPLOY_ITEMS.loiter;
    if (d.loiterDive) { tickLoiterDive(r, d, dt, def); return; }
    d.fireCd -= dt; // doubles as the arm timer - same convention as the mine
    loiterOrbit(d, def, dt);
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    const hover = { x: d.pos.x, y: d.pos.y + def.hoverUp!, z: d.pos.z };
    const pick = nearestFoe(r, d, dTeam, hover, def.triggerDist!);
    if (!pick) { d.fireCd = 0.15; return; }
    const { target: tid, tp, tv, dist } = pick;
    // Lead the runner on the straight dive - a still target eats it dead
    // on, a skier crossing at speed watches it land behind them.
    const sp = def.launchSpeed!;
    const flight = dist / sp;
    const aim = { x: tp.x + tv.x * flight, y: tp.y + tv.y * flight, z: tp.z + tv.z * flight };
    const dx = aim.x - hover.x, dy = aim.y - hover.y, dz = aim.z - hover.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const vx = dx / len * sp, vy = dy / len * sp, vz = dz / len * sp;
    d.loiterDive = { x: hover.x, y: hover.y, z: hover.z, vx, vy, vz, t: 0, tid };
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'loiterDive', 'id', d.id, {
      pos: Object.assign({}, hover), vx, vy, vz,
    }) as ServerMessage);
  }

  // Committed dive: fly the led line, detonate on proximity, fuse
  // expiry (2s), or ground contact - the blast lands through the
  // mineBoom funnel at the server's true point.
  function tickLoiterDive(r: RoomDeployables, d: Deployed, dt: number, def: NonNullable<typeof DEPLOY_ITEMS.loiter>): void {
    const dv = d.loiterDive!;
    dv.t += dt;
    dv.x += dv.vx * dt; dv.y += dv.vy * dt; dv.z += dv.vz * dt;
    // Proximity fuze on ANY hostile, not just the committed target - a
    // juke means the led line misses tid but still flies past a body,
    // and air-bursting the near miss beats whistling into dirt.
    const fuze2 = 2.5 * 2.5;
    const dTeam = r.teamOf(d);
    let hit = false;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (!sentryFoe(d, dTeam, pid, p)) {continue;}
      const dx = p.position.x - dv.x, dy = p.position.y - dv.y, dz = p.position.z - dv.z;
      if (dx * dx + dy * dy + dz * dz < fuze2) {hit = true; break;}
    }
    const ground = r.room.field ? dv.y <= hmHeight(r.room.field, dv.x, dv.z) + 0.4 : false;
    if (!hit && !ground && dv.t <= 2) {return;}
    const pos = { x: dv.x, y: dv.y, z: dv.z };
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'mineBoom', 'id', d.id, { owner: d.owner, pos }) as ServerMessage);
    r.remove(d.id);
    r.room.messages.mineBlast(d.owner, pos, def.blastDamage!, def.blastRadius!, def.knockback!);
  }

  // Orbit the plant anchor every tick - the munition CIRCLES while it
  // watches, so "loiter" reads as a patrol, not a parked balloon. The
  // anchor is the plant point (pos drifts once the ring starts);
  // replicas orbit because pos chases the ring each tick.
  function loiterOrbit(d: Deployed, def: NonNullable<typeof DEPLOY_ITEMS.loiter>, dt: number): void {
    d.orbitA = (d.orbitA ?? 0) + (def.orbitRate ?? 0) * dt;
    if (d.orbitC === undefined) {d.orbitC = { x: d.pos.x, z: d.pos.z };}
    const oR = def.orbitR ?? 0;
    if (oR > 0) {
      d.pos.x = d.orbitC.x + Math.cos(d.orbitA!) * oR;
      d.pos.z = d.orbitC.z + Math.sin(d.orbitA!) * oR;
    }
  }

  /** Spider mine: the ground-bound loiter - after the arm it scuttles
   *  toward the nearest GROUNDED hostile in its ring and detonates in
   *  reach. Air is the hard counter: an airborne body never trips it
   *  (sim onGround, or the no-shadow fallback near the surface). d.pos
   *  IS the spider - it crawls. No wire for the crawl: replicas mirror
   *  the chase like drones mirror their owner; the blast lands through
   *  the mineBoom funnel at the server's true point. */
export function tickSpider(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt; // doubles as the arm timer - same convention as the mine
    if (d.fireCd > 0) {return;}
    const def = DEPLOY_ITEMS.spider;
    const sp = def.launchSpeed!;
    const pick = spiderTarget(r, d, def.triggerDist!);
    if (!pick) {return;}
    const { tp } = pick;
    const dx = tp.x - d.pos.x, dz = tp.z - d.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-4) {
      const step = Math.min(sp * dt, dist);
      d.pos.x += dx / dist * step;
      d.pos.z += dz / dist * step;
    }
    if (r.room.field) {d.pos.y = hmHeight(r.room.field, d.pos.x, d.pos.z);}
    const dy = tp.y - d.pos.y;
    if (dist < 2.2 && Math.abs(dy) < 2.5) {
      r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'mineBoom', 'id', d.id, { owner: d.owner, pos: Object.assign({}, d.pos) }) as ServerMessage);
      r.remove(d.id);
      r.room.messages.mineBlast(d.owner, d.pos, def.blastDamage!, def.blastRadius!, def.knockback!);
    }
  }

  /** Resupply pad: friendlies in the envelope get a slow health refill.
   *  Energy stays client-side (the move shadow doesn't model the tank
   *  top-off) — health is the server-owned half of the pad's job. */
export function tickStation(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    d.fireCd = STATION_HEAL_CD;
    const dTeam = r.teamOf(d);
    for (const [_pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead) {continue;}
      if (dTeam && p.team !== dTeam) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > STATION_RANGE * STATION_RANGE) {continue;}
      if (p.health >= p.maxHealth) {continue;}
      healPool(p, p.maxHealth * STATION_HP_RATE * STATION_HEAL_CD);
      p.forceSendUntil = wallMs(wallNow() + FORCE_SEND_MS);
    }
  }

  /** Water sphere: a pocket of sea on the ground. Every ENEMY wading
   *  through it gets the water dome on their move shadow, which slows
   *  them (the sea's drag law + a speed cap). The planter and their team
   *  walk through dry — the counterplay is to walk around it or shell
   *  it, not to out-sprint it. */
  export function tickWatersphere(r: RoomDeployables, d: Deployed, _dt: number): void {
    const def = DEPLOY_ITEMS.watersphere;
    const radius = def.waterRadius ?? 7;
    const dTeam = r.teamOf(d);
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead) {continue;}
      const dx = p.position.x - d.pos.x, dz = p.position.z - d.pos.z;
      const inside = dx * dx + dz * dz < radius * radius;
      // Same team (or no teams) walks dry.
      const friendly = !dTeam || p.team === dTeam;
      if (inside && !friendly) {
        r.room.moveSim.setWaterDome(pid, { x: d.pos.x, y: d.pos.y, z: d.pos.z, r: radius });
      } else {
        r.room.moveSim.setWaterDome(pid, undefined);
      }
    }
  }

  /** Server-side sentry fire: nearest hostile player in the envelope gets
   *  a bolt every TURRET_FIRE_INTERVAL. Damage rides the shared funnel so
   *  kill credit, spawn protection and respawn all behave — the client
   *  visual layer shows the matching rocket via the turretShot broadcast. */
export function tickTurret(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    let target: string | null = null;
    let bestD2 = TURRET_RANGE * TURRET_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) {continue;}
      if (!losClear(r, d.pos, p.position, dTeam)) {continue;}
      bestD2 = d2; target = pid;
    }
    if (!target) { d.fireCd = Math.min(d.fireCd + 0.15, 0.15); return; } // idle scan: cheap re-check
    d.fireCd = TURRET_FIRE_INTERVAL;
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'turretShot', 'id', d.id, { owner: d.owner, targetId: target }) as ServerMessage);
    r.room.messages.turretAttack(d.owner, target, TURRET_DAMAGE);}

const CG_RANGE = DEPLOY_ITEMS.cgturret.range!;
const CG_FIRE_INTERVAL = DEPLOY_ITEMS.cgturret.fireInterval!;
const CG_DAMAGE = DEPLOY_ITEMS.cgturret.damage!;

/** Chaingun turret: same nearest-hostile + LOS scan as the sentry, but
 *  the pulse pays a ~3-bolt burst's damage on the turretShot wire — the
 *  spray is cosmetic (client paints tracers), the outcome rides the same
 *  turretAttack funnel so kill credit/protection behave identically. */
export function tickCg(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    let target: string | null = null;
    let bestD2 = CG_RANGE * CG_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) {continue;}
      if (!losClear(r, d.pos, p.position, dTeam)) {continue;}
      bestD2 = d2; target = pid;
    }
    if (!target) { d.fireCd = 0.15; return; }
    d.fireCd = CG_FIRE_INTERVAL;
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'turretShot', 'id', d.id, { owner: d.owner, targetId: target }) as ServerMessage);
    r.room.messages.turretAttack(d.owner, target, CG_DAMAGE);
}

const SENTRY_RANGE = DEPLOY_ITEMS.baseturret.range!;
const SENTRY_FIRE_INTERVAL = DEPLOY_ITEMS.baseturret.fireInterval!;
const SENTRY_DAMAGE = DEPLOY_ITEMS.baseturret.damage!;
const SENTRY_BOLT_SPEED = DEPLOY_ITEMS.baseturret.projSpeed!;
const SENTRY_BLAST_RADIUS = DEPLOY_ITEMS.baseturret.blastRadius!;
const SENTRY_KNOCKBACK = DEPLOY_ITEMS.baseturret.knockback!;

/** Base sentry: same nearest-hostile scan as the field turret, but the
 *  shell is a REAL bolt — it aims at the target's lead point (pos +
 *  vel × flight time), flies there, then blasts whoever's still inside
 *  the small radius. Moving targets are dodged honestly: nothing homes.
 *  The sentryShot broadcast carries the aim point so clients paint the
 *  same straight-line flight. */
// A live, unprotected, non-owner, non-teammate body the sentry may shoot.
function sentryFoe(d: Deployed, dTeam: string | undefined, pid: string, p: PlayerState): boolean {
  if (p.isDead || pid === d.owner) {return false;}
  if (dTeam && p.team === dTeam) {return false;}
  return p.protectedUntil <= simNow();
}

// Nearest living non-owner non-teammate in range with clear LOS from
// `from` — shared by the sentry gun and the loiter dive pick. Returns
// the lead inputs the aim needs, or null to idle-cool.
function nearestFoe(r: RoomDeployables, d: Deployed, dTeam: string | undefined, from: Vec3, range: number): { target: string; tp: Vec3; tv: { x: number; y: number; z: number }; dist: number } | null {
  let target: string | null = null;
  let tp: Vec3 | null = null;
  let tv = { x: 0, y: 0, z: 0 };
  let bestD2 = range * range;
  for (const [pid, p] of r.room.players.getAllPlayers()) {
    if (!sentryFoe(d, dTeam, pid, p)) {continue;}
    const dx = p.position.x - from.x, dy = p.position.y - from.y, dz = p.position.z - from.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= bestD2) {continue;}
    if (!losClear(r, from, p.position, dTeam)) {continue;}
    bestD2 = d2; target = pid; tp = p.position;
    tv = { x: p.velocity?.x ?? 0, y: p.velocity?.y ?? 0, z: p.velocity?.z ?? 0 };
  }
  if (!target || !tp) {return null;}
  return { target, tp, tv, dist: Math.sqrt(bestD2) };
}

function sentryTarget(r: RoomDeployables, d: Deployed): { target: string; tp: Vec3; tv: { x: number; y: number; z: number }; dist: number } | null {
  return nearestFoe(r, d, r.teamOf(d), d.pos, SENTRY_RANGE);
}

// Spider pick: nearest GROUNDED hostile in the ring — air is the hard
// counter, so an airborne body never trips it. No LOS check: the spider
// is ground-bound and its blast is point-blank.
function spiderTarget(r: RoomDeployables, d: Deployed, tr: number): { tp: Vec3 } | null {
  const dTeam = r.teamOf(d);
  let tp: Vec3 | null = null, bestD2 = tr * tr;
  for (const [pid, p] of r.room.players.getAllPlayers()) {
    if (!sentryFoe(d, dTeam, pid, p)) {continue;}
    const grounded = r.room.moveSim.simState(pid)?.onGround === true
      || (r.room.field ? p.position.y - hmHeight(r.room.field, p.position.x, p.position.z) < 2.5 : false);
    if (!grounded) {continue;}
    const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {bestD2 = d2; tp = p.position;}
  }
  return tp ? { tp } : null;
}

export function tickSentry(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    const pick = sentryTarget(r, d);
    if (!pick) { d.fireCd = 0.15; return; }
    const { tp, tv, dist } = pick;
    d.fireCd = SENTRY_FIRE_INTERVAL;
    const flight = dist / SENTRY_BOLT_SPEED;
    // Lead the runner at chest height — a still target gets the bolt dead
    // on, a skier crossing at 40 m/s watches it land behind them.
    const aim = {
      x: tp.x + tv.x * flight,
      y: tp.y + 1 + tv.y * flight * 0.5, // partial vertical lead — bolts drop nothing anyway
      z: tp.z + tv.z * flight,
    };
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'sentryShot', 'id', d.id, { owner: d.owner, x: aim.x, y: aim.y, z: aim.z }) as ServerMessage);
    r.bolts.push({ at: aim, ttl: flight, owner: d.owner, dmg: SENTRY_DAMAGE, rad: SENTRY_BLAST_RADIUS, kb: SENTRY_KNOCKBACK });
}

const MORTAR_RANGE = DEPLOY_ITEMS.mortar.range!;
const MORTAR_MIN_RANGE = DEPLOY_ITEMS.mortar.minRange!;
const MORTAR_FIRE_INTERVAL = DEPLOY_ITEMS.mortar.fireInterval!;
const MORTAR_DAMAGE = DEPLOY_ITEMS.mortar.damage!;
const MORTAR_BLAST_RADIUS = DEPLOY_ITEMS.mortar.blastRadius!;
const MORTAR_KNOCKBACK = DEPLOY_ITEMS.mortar.knockback!;
const MORTAR_SHELL_SPEED = DEPLOY_ITEMS.mortar.projSpeed!;
const MORTAR_MUZZLE_UP = 1.6; // tube mouth above the tripod base

/** Field mortar — lobs REAL mortar shells (weapon row 4 gravity/speed)
 *  over cover onto the nearest hostile inside the [minRange, range]
 *  band. Deliberately NO losClear: artillery exists to drop over the
 *  hill the sentry can't shoot through. The bolt lands at the solved
 *  impact point; the mortarShot broadcast carries launch velocity so
 *  clients replay the identical arc as a visible shell. */
export function tickMortar(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    const pick = mortarTarget(r, d);
    if (!pick) { d.fireCd = 0.25; return; }
    const { target, tv } = pick;
    // One lead iteration: solve the arc to the led point. Low branch of
    // asin — same family the bot lob solver uses.
    const arc = solveMortarArc(d.pos, target, tv);
    if (!arc) { d.fireCd = 0.5; return; }
    d.fireCd = MORTAR_FIRE_INTERVAL;
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'mortarShot', 'id', d.id, { owner: d.owner, vx: arc.vx, vy: arc.vy, vz: arc.vz }) as ServerMessage);
    r.bolts.push({ at: arc.aim, ttl: arc.flight, owner: d.owner, dmg: MORTAR_DAMAGE, rad: MORTAR_BLAST_RADIUS, kb: MORTAR_KNOCKBACK });
  }

  // Nearest hostile inside the [minRange, range] horizontal band — the
  // arc eats height, so the band check is 2D. No LOS: artillery exists
  // to drop over the hill the sentry can't shoot through.
  function mortarTarget(r: RoomDeployables, d: Deployed): { target: Vec3; tv: { x: number; y: number; z: number } } | null {
    const dTeam = r.teamOf(d);
    let target: Vec3 | null = null;
    let tv = { x: 0, y: 0, z: 0 };
    let bestD2 = MORTAR_RANGE * MORTAR_RANGE;
    const minD2 = MORTAR_MIN_RANGE * MORTAR_MIN_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (!sentryFoe(d, dTeam, pid, p)) {continue;}
      const dx = p.position.x - d.pos.x, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD2 || d2 < minD2) {continue;}
      bestD2 = d2; target = p.position;
      tv = { x: p.velocity?.x ?? 0, y: p.velocity?.y ?? 0, z: p.velocity?.z ?? 0 };
    }
    return target ? { target, tv } : null;
  }

  // Two lead iterations: solve the low-branch lob to the velocity-led
  // aim point. Returns null when the target sits beyond the envelope's
  // ballistic reach (discriminant <= 0).
  function solveMortarArc(muzzle: Vec3, target: Vec3, tv: { x: number; y: number; z: number }): { aim: Vec3; vx: number; vy: number; vz: number; flight: number } | null {
    const g = Math.abs(GRAVITY);
    const mx = muzzle.x, my = muzzle.y + MORTAR_MUZZLE_UP, mz = muzzle.z;
    let aim: Vec3 = target;
    let vx = 0, vy = 0, vz = 0, flight = 0;
    for (let it = 0; it < 2; it += 1) {
      const dx = aim.x - mx, dz = aim.z - mz;
      const R = Math.hypot(dx, dz);
      const dy = aim.y + 0.5 - my;
      const s = MORTAR_SHELL_SPEED;
      const s2 = s * s;
      const disc = s2 * s2 - g * (g * R * R + 2 * dy * s2);
      if (disc <= 0) {return null;}
      const pitch = Math.atan2(s2 - Math.sqrt(disc), g * R); // low lob
      flight = R / (s * Math.cos(pitch));
      vx = (dx / R) * s * Math.cos(pitch);
      vy = s * Math.sin(pitch);
      vz = (dz / R) * s * Math.cos(pitch);
      aim = { x: target.x + tv.x * flight, y: target.y + tv.y * flight * 0.5, z: target.z + tv.z * flight };
    }
    return { aim, vx, vy, vz, flight };
  }

const SENSOR_RANGE = DEPLOY_ITEMS.sensor.range!;
const SENSOR_SCAN_S = DEPLOY_ITEMS.sensor.fireInterval!;

/** Base sensor mast: sweeps its radius for hostiles and relays them to
 *  the owning team — the compound's early-warning net. Clients draw the
 *  pings as map blips; enemies learn to kill the mast first, which is
 *  the point of a raid prep phase. */
export function tickSensor(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    d.fireCd = SENSOR_SCAN_S;
    const dTeam = r.teamOf(d);
    const targets: { id: string; x: number; y: number; z: number }[] = [];
    // The mast sweeps from its crown (bodyH ~9.8) - a ridge that hides a
    // runner at eye level still reads at mast height, like the real
    // Tribes pulse sensor's elevated perch.
    const eye = { x: d.pos.x, y: d.pos.y + DEPLOY_ITEMS.sensor.bodyH!, z: d.pos.z };
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      // Pulse sensors can't see cloak - only his own shots re-open him.
      if ((p.status & STATUS.CLOAK) !== 0 && !shootRevealed(p.lastFireSim, simNow())) {continue;}
      // A friendly jammer bubble hides its side from the pulse sweep -
      // visual sightings and motion sensors still read them.
      if (r.jammed(p, p.position)) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > SENSOR_RANGE * SENSOR_RANGE) {continue;}
      // Terrain + structures occlude the sweep - the authentic pulse read.
      if (!r.room.intel.los(dTeam, eye, p.position)) {continue;}
      targets.push({ id: pid, x: p.position.x, y: p.position.y, z: p.position.z });
    }
    if (targets.length === 0) {return;}
    r.room.intel.noteSensor(d.owner, dTeam, targets);
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'sensorPing', 'id', d.id, { team: dTeam, targets }) as ServerMessage);
}

const MOTION_RANGE = DEPLOY_ITEMS.motion.range!;
const MOTION_SCAN_S = DEPLOY_ITEMS.motion.fireInterval!;
/** Below this speed a body reads as "still" - the motion sensor's whole
 *  contract is that standing still drops you off the net. */
const MOTION_STILL2 = 0.25;

/** Deployable motion sensor - the Tribes pack item: detects MOVING
 *  hostiles in range with no LOS check and THROUGH cloak (it reads
 *  movement, not light). Sightings feed the same team intel feed the
 *  mast does, so a moving capper lights up on friendly IFF even behind
 *  a ridge - stand still and you're dark again. Jammers don't touch it:
 *  they kill pulses, not motion. */
export function tickMotion(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    d.fireCd = MOTION_SCAN_S;
    const dTeam = r.teamOf(d);
    const targets: { id: string; x: number; y: number; z: number }[] = [];
    const range2 = MOTION_RANGE * MOTION_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > range2) {continue;}
      // Velocity truth is the move shadow - p.velocity only mirrors it
      // under moveAuthority for humans, so reading the record would leave
      // every bot (and non-authority client) permanently "still".
      const v = r.room.moveSim.simState(pid)?.vel ?? p.velocity;
      if (v.x * v.x + v.y * v.y + v.z * v.z < MOTION_STILL2) {continue;}
      targets.push({ id: pid, x: p.position.x, y: p.position.y, z: p.position.z });
    }
    if (targets.length === 0) {return;}
    r.room.intel.noteSensor(d.owner, dTeam, targets);
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'sensorPing', 'id', d.id, { team: dTeam, targets }) as ServerMessage);
}

/** Jammer emitter - no scan of its own; the aura is read by tickSensor's
 *  jammed() check. The tick only ages the arm delay. */
export function tickJammer(_r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd = Math.max(0, d.fireCd - dt);
}
