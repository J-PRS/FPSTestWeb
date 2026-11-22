/*
 * botTrackAim - the held-trigger aim model: where a human's crosshair
 * would actually sit while tracking a target. Pursuit lag (a jink
 * pulls ahead honestly), an Ornstein-Uhlenbeck wander weighted along
 * the target's motion axis, and flight-time lead + gravity drop for
 * stream projectiles. Pure functions over the trigger record - the
 * arsenal's step() calls these per live pull.
 */
import type { Vec3 } from './types.ts';
import type { Room } from './Room.ts';
import type { TriggerRec } from './botArsenal.ts';
import { getWeaponStats } from '../../shared/weapons.ts';
import { GRAVITY } from '../../shared/movement.ts';
import { botRand } from '../../shared/botRand.ts';

/** Non-pursuit holds ride the target's frame delta - a sweeping beam
 *  tracks the runner instead of painting where he was. */
export function deltaRide(tr: TriggerRec, live: Vec3 | null): void {
  if (live && tr.lastPos) {
    tr.aim.x += live.x - tr.lastPos.x;
    tr.aim.y += live.y - tr.lastPos.y;
    tr.aim.z += live.z - tr.lastPos.z;
  }
}

/** The tracked aim point: pursuit lag + OU wander + flight-time lead,
 *  then the write. Where a human's crosshair would actually sit. */
export function trackAim(room: Room, tr: TriggerRec, live: Vec3 | null, dt: number, id: string): void {
  if (live) {pursueLag(tr, live, dt);}
  aimNoise(tr, dt);
  const tp = tr.lag ?? tr.aim;
  const lead = aimLead(room, tr, tp, id);
  tr.aim.x = tp.x + tr.err.x + lead.x;
  tr.aim.y = tp.y + 1.2 + tr.err.y + lead.y; // capsule midpoint off the feet pos
  tr.aim.z = tp.z + tr.err.z + lead.z;
}

/** Smooth pursuit: the aim point chases the live target with a ~100ms
 *  lag (a jink pulls ahead honestly). Also prices the target's
 *  unpredictability into `diff` - the signal humans read when they
 *  decide a shot is easy. */
function pursueLag(tr: TriggerRec, live: Vec3, dt: number): void {
  if (!tr.lag) {tr.lag = Object.assign({}, live);}
  // Beams pursue tighter: 0.85/tick is ~230ms of lag = ~2.3m of
  // permanent miss on a strafing target - fair for a lobbed bolt,
  // but a hitscan shaft owes no flight time. 0.96 lands ~45%
  // shaft-uptime on impossible skill (the T:Tribes LG bar) while
  // still leaving jink reaction room.
  const chase = (tr.wt !== undefined && (getWeaponStats(tr.wt)?.speed ?? 1) === 0) ? 0.96 : 0.85;
  tr.lag.x += (live.x - tr.lag.x) * chase;
  tr.lag.y += (live.y - tr.lag.y) * chase;
  tr.lag.z += (live.z - tr.lag.z) * chase;
  // Instantaneous velocity + its turn rate - the difficulty
  // signal humans price in when they decide a shot is easy.
  if (tr.lastPos && dt > 0) {
    const vx = (live.x - tr.lastPos.x) / dt;
    const vy = (live.y - tr.lastPos.y) / dt;
    const vz = (live.z - tr.lastPos.z) / dt;
    const turn = tr.tv ? Math.hypot(vx - tr.tv.x, vy - tr.tv.y, vz - tr.tv.z) : 0;
    tr.tv = { x: vx, y: vy, z: vz };
    const speed = Math.hypot(vx, vy, vz);
    const goal = Math.min(1, speed * 0.02 + turn * 0.04);
    tr.diff += (goal - tr.diff) * 0.3; // ease so one jink tick doesn't flip the grade
  }
}

/** Ornstein-Uhlenbeck wander weighted along the target's motion axis:
 *  strong lead/lag oscillation, light perpendicular wobble - real
 *  tracking overshoots ahead then lags behind, and its size scales
 *  with `diff`. Mutates tr.err. */
function aimNoise(tr: TriggerRec, dt: number): void {
  const e = tr.err, s = (dt) ** 0.5;
  // Beams (speed-0) wander far less than projectile aim - a shaft
  // misses through tracking lag, not ballistic uncertainty; full-
  // strength scatter just sweeps the ray across the target instead
  // of dwelling (~22% uptime measured vs the ~85% a human holds).
  const beam = tr.wt !== undefined && (getWeaponStats(tr.wt)?.speed ?? 1) === 0;
  const sig = tr.sig * (0.35 + 1.3 * tr.diff) * (beam ? 0.35 : 1);
  // Unit motion axis for ahead/behind weighting (zero speed → isotropic).
  const v = tr.tv, vl = v ? Math.hypot(v.x, v.y, v.z) : 0;
  const ax = vl > 1 ? v!.x / vl : 1, ay = vl > 1 ? v!.y / vl : 0, az = vl > 1 ? v!.z / vl : 0;
  // Noise: strong along the motion axis (lead/lag oscillation),
  // light perpendicular (settled wobble).
  const n1 = (botRand() - 0.5) * 2, n2 = (botRand() - 0.5) * 2, n3 = (botRand() - 0.5) * 2;
  const dot = n1 * ax + n2 * ay + n3 * az;
  const amp = 1.6 * sig * s;
  e.x += -2.5 * e.x * dt + amp * (n1 * 0.7 + ax * dot * 0.8);
  e.y += -2.5 * e.y * dt + amp * (n2 * 0.7 + ay * dot * 0.8);
  e.z += -2.5 * e.z * dt + amp * (n3 * 0.7 + az * dot * 0.8);
}

/** Stream projectiles (sprinkler hose, chaingun) track like beams but
 *  the aim point still owes flight-time lead + gravity drop - the
 *  pursuit lag alone lands every bolt behind the runner. */
function aimLead(room: Room, tr: TriggerRec, tp: Vec3, id: string): Vec3 {
  const zero = { x: 0, y: 0, z: 0 };
  if (tr.wt === undefined) {return zero;}
  const st = getWeaponStats(tr.wt);
  const p0 = room.players.getPlayer(id);
  if (!st || st.speed <= 0 || !p0) {return zero;}
  const dx = tp.x - p0.position.x, dy = tp.y - p0.position.y, dz = tp.z - p0.position.z;
  const dist = Math.hypot(dx, dy, dz);
  const inh = st.inherit ?? 0;
  // Effective muzzle speed: the shell carries `inherit` of the
  // shooter's velocity, so a bot charging the shot throws a
  // faster projectile (shorter flightT) and one backpedaling
  // throws slower. flightT off by that term misleads magnitude.
  const pv = p0.velocity;
  const effSpeed = st.speed + inh * (pv.x * dx + pv.y * dy + pv.z * dz) / (dist || 1);
  const flightT = dist / Math.max(1, effSpeed);
  const {tv} = tr;
  // Relative lead on all three axes: target-motion minus the
  // momentum already lent to the shell - including vy, which
  // the old code dropped entirely (an airborne bot's downward
  // dive handed every shell a free downward kick it never
  // aimed out). Without it a 30m/s cruiser aims as if static.
  return {
    x: ((tv?.x ?? 0) - pv.x * inh) * flightT,
    y: ((tv?.y ?? 0) - pv.y * inh) * flightT + (st.gravity ? 0.5 * GRAVITY * flightT * flightT : 0),
    z: ((tv?.z ?? 0) - pv.z * inh) * flightT,
  };
}
