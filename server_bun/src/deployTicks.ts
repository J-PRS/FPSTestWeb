import type { Vec3, ServerMessage } from './types.ts';
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
import { hmNormal } from '../../shared/heightfield.ts';
import { simNow } from './simClock.ts';
import { wallNow , wallMs} from './wallClock.ts';

  /** Structure LOS for the gun scan — a sentry indoors shouldn't plink
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



// Per-kind deployable ticks — drone escort scan, proximity-mine fuse,
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
    // The surface the pad actually SITS on keys the launch dir: on a
    // dome cap it's radial, on a flat structure top it's up - the
    // terrain normal under the floor is wrong for both.
    let onStruct = false;
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
      onStruct = true;
      break;
    }
    if (!onStruct && r.room.field) {hmNormal(r.room.field, d.pos.x, d.pos.z, n);}
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
export function tickSentry(r: RoomDeployables, d: Deployed, dt: number): void {
    d.fireCd -= dt;
    if (d.fireCd > 0) {return;}
    const dTeam = r.teamOf(d);
    let target: string | null = null;
    let tp: { x: number; y: number; z: number } | null = null;
    let tv = { x: 0, y: 0, z: 0 };
    let bestD2 = SENTRY_RANGE * SENTRY_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD2) {continue;}
      if (!losClear(r, d.pos, p.position, dTeam)) {continue;}
      bestD2 = d2; target = pid; tp = p.position;
      tv = { x: p.velocity?.x ?? 0, y: p.velocity?.y ?? 0, z: p.velocity?.z ?? 0 };
    }
    if (!target || !tp) { d.fireCd = 0.15; return; }
    d.fireCd = SENTRY_FIRE_INTERVAL;
    const dist = Math.sqrt(bestD2);
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
    const dTeam = r.teamOf(d);
    let target: { x: number; y: number; z: number } | null = null;
    let tv = { x: 0, y: 0, z: 0 };
    let bestD2 = MORTAR_RANGE * MORTAR_RANGE;
    const minD2 = MORTAR_MIN_RANGE * MORTAR_MIN_RANGE;
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead || pid === d.owner) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      if (p.protectedUntil > simNow()) {continue;}
      const dx = p.position.x - d.pos.x, dz = p.position.z - d.pos.z;
      const d2 = dx * dx + dz * dz; // horizontal band — the arc eats height
      if (d2 >= bestD2 || d2 < minD2) {continue;}
      bestD2 = d2; target = p.position;
      tv = { x: p.velocity?.x ?? 0, y: p.velocity?.y ?? 0, z: p.velocity?.z ?? 0 };
    }
    if (!target) { d.fireCd = 0.25; return; }
    // One lead iteration: solve the arc to the led point. Low branch of
    // asin — same family the bot lob solver uses.
    const g = Math.abs(GRAVITY);
    const mx = d.pos.x, my = d.pos.y + MORTAR_MUZZLE_UP, mz = d.pos.z;
    let aim = target;
    let vx = 0, vy = 0, vz = 0, flight = 0;
    for (let it = 0; it < 2; it += 1) {
      const dx = aim.x - mx, dz = aim.z - mz;
      const R = Math.hypot(dx, dz);
      const dy = aim.y + 0.5 - my;
      const s = MORTAR_SHELL_SPEED;
      const s2 = s * s;
      const disc = s2 * s2 - g * (g * R * R + 2 * dy * s2);
      if (disc <= 0) {target = null; break;} // beyond the envelope's reach
      const pitch = Math.atan2(s2 - Math.sqrt(disc), g * R); // low lob
      flight = R / (s * Math.cos(pitch));
      vx = (dx / R) * s * Math.cos(pitch);
      vy = s * Math.sin(pitch);
      vz = (dz / R) * s * Math.cos(pitch);
      aim = { x: target.x + tv.x * flight, y: target.y + tv.y * flight * 0.5, z: target.z + tv.z * flight };
    }
    if (!target) { d.fireCd = 0.5; return; }
    d.fireCd = MORTAR_FIRE_INTERVAL;
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'mortarShot', 'id', d.id, { owner: d.owner, vx, vy, vz }) as ServerMessage);
    r.bolts.push({ at: { x: aim.x, y: aim.y, z: aim.z }, ttl: flight, owner: d.owner, dmg: MORTAR_DAMAGE, rad: MORTAR_BLAST_RADIUS, kb: MORTAR_KNOCKBACK });
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
    for (const [pid, p] of r.room.players.getAllPlayers()) {
      if (p.isDead) {continue;}
      if (dTeam && p.team === dTeam) {continue;}
      const dx = p.position.x - d.pos.x, dy = p.position.y - d.pos.y, dz = p.position.z - d.pos.z;
      if (dx * dx + dy * dy + dz * dz > SENSOR_RANGE * SENSOR_RANGE) {continue;}
      targets.push({ id: pid, x: p.position.x, y: p.position.y, z: p.position.z });
    }
    if (targets.length === 0) {return;}
    r.room.broadcast(eventPayload(WORLD_MODEL.deploy!, 'sensorPing', 'id', d.id, { team: dTeam, targets }) as ServerMessage);
}