import type { Vec3, PlayerState } from './types.ts';
import { wallNow } from './wallClock.ts';
import { hermiteBounded, dhypot3 } from '../../shared/dmath.ts';
import { hmHeight, hmChord, type Heightfield } from '../../shared/heightfield.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import { finiteVec } from '../../shared/wire.ts';

// Lag compensation: clamp self-reported ping to a sane rewind window —
// unclamped, a forged 60s "ping" could rewind targets anywhere.
const MAX_REWIND_MS = 400;

export function clampPing(ping: number): number {
  // NaN ping: Math.max(NaN,0)=NaN — rewindPos then walks history with a
  // NaN target and validates against a garbage sample. No ping = 0.
  if (!Number.isFinite(ping)) {return 0;}
  return Math.min(Math.max(ping, 0), MAX_REWIND_MS);
}

/** The shooter's one-way uplink transit. transitOf already IS one-way
 *  (feedTransit stores rtt/2; feedUplink stores arrival−fireAt) — it
 *  passes through verbatim. Only the cold-probe fallback is an RTT and
 *  earns the halve. (A blanket /2 here under-rewound every lag-comp
 *  ghost by half the real uplink — the same class as the 0.35·RTT
 *  client mirror.) */
export function shooterTransitMs(transitOf: ((playerId: string) => number) | undefined, shooterId: string, fallbackPingRtt: number): number {
  const t = transitOf?.(shooterId) ?? 0;
  return t > 0 ? t : clampPing(fallbackPingRtt) / 2;
}

// Interpolated position at (now - backMs) from the player's rewind buffer.
// `field` opts into the rendered-floor mirror: the client lifts a
// ground-contacted remote to the drawn clipmap chord (humans ground on
// the plain field, so a gully body renders above its wire Y). Validating
// at raw wire then whiffs shots aimed at the visible body — every rg
// outlier in the ghost soak was pure Y. Same gate as the client: feet
// at/below the sim field only — airborne wire stays put.
export function rewindPos(target: PlayerState, backMs: number, field?: Heightfield | null): { x: number; y: number; z: number } {
  const h = target.history;
  let tp: { x: number; y: number; z: number };
  // NaN backMs: every t-comparison below is false — the walk returns a
  // garbage sample instead of the present. Present is the safe answer.
  if (h.length === 0 || !Number.isFinite(backMs)) {tp = target.position;}
  else {
    const tAt = wallNow() - backMs;
    if (tAt <= h[0]!.t) {tp = h[0]!;}
    else {
      const last = h[h.length - 1]!;
      if (tAt >= last.t) {tp = target.position;}
      else {
        tp = last;
        for (let i = h.length - 1; i > 0; i -= 1) {
          if (h[i - 1]!.t <= tAt) {
            const a = h[i - 1]!, b = h[i]!;
            const spanMs = Math.max(b.t - a.t, 1);
            // Hermite (shared/dmath) — the ghost rides the same curve the
            // shooter's renderer drew; the linear chord was the rg tail on
            // fast/curved movers.
            const r = { x: 0, y: 0, z: 0 };
            hermiteBounded(a, b, (tAt - a.t) / spanMs, spanMs / 1000, r);
            tp = r;
            break;
          }
        }
      }
    }
  }
  if (field) {
    const {eye} = classCapsule(target.armorClass);
    if (tp.y - eye <= hmHeight(field, tp.x, tp.z) + 0.5) {
      const floor = Math.max(hmHeight(field, tp.x, tp.z), hmChord(field, tp.x, tp.z)) + eye;
      if (tp.y < floor) {return { x: tp.x, y: floor, z: tp.z };}
    }
  }
  return tp;
}

function dist3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}



// The shooter's view is stale by ping + jitter + interp buffer, so an
// honest claim can land where the target WAS anywhere across the lag
// window, not only at the rewound instant. Nearest point on the
// target's recorded path in [now-backMs-extraMs, now] bounds the error
// by the target's own measured motion instead of a flat slack.
export function rewindNearest(target: PlayerState, backMs: number, extraMs: number, pt: Vec3): Vec3 {
  const floor = wallNow() - backMs - extraMs;
  let best = rewindPos(target, backMs);
  let bestD = dist3(best, pt);
  for (const s of target.history) {
    if (s.t < floor) {continue;}
    const d = dist3(s, pt);
    if (d < bestD) { bestD = d; best = s; }
  }
  const d = dist3(target.position, pt);
  if (d < bestD) {best = target.position;}
  return best;
}

// C7 (derive, don't arbitrate): the shooter's OWN shadow at the fire
// instant is the spawn frame - position hermites like rewindPos and
// velocity lerps the recorded samples, so the shell inherits what the
// server measured the shooter doing then, never a claim field. null
// when the journal doesn't reach backMs (join, reconnect, tab-resume):
// nothing recorded can't be derived, and the caller falls back to the
// gated claim path.
export function rewindFrame(target: PlayerState, backMs: number): { at: Vec3; vel: Vec3 } | null {
  const h = target.history;
  if (h.length === 0) {return null;}
  const tAt = wallNow() - backMs;
  if (tAt <= h[0]!.t) {return null;} // fire instant predates the journal - thin
  const last = h[h.length - 1]!;
  if (tAt >= last.t) {return { at: target.position, vel: target.velocity };}
  for (let i = h.length - 1; i > 0; i -= 1) {
    if (h[i - 1]!.t <= tAt) {
      const a = h[i - 1]!, b = h[i]!;
      const spanMs = Math.max(b.t - a.t, 1);
      const t = (tAt - a.t) / spanMs;
      const r = { x: 0, y: 0, z: 0 };
      hermiteBounded(a, b, t, spanMs / 1000, r);
      return {
        at: r,
        vel: {
          x: a.vx + (b.vx - a.vx) * t,
          y: a.vy + (b.vy - a.vy) * t,
          z: a.vz + (b.vz - a.vz) * t,
        },
      };
    }
  }
  return { at: last, vel: { x: last.vx, y: last.vy, z: last.vz } };
}

/** Physics cap on a claimed shot velocity - generous over max
 *  attainable speed; bounds a forged arc without refusing honest
 *  skiing speeds. See ownerVelOf. */
const OWNER_VEL_CAP = 140;
/** Claim-vel slack around the derived shadow velocity (C7): covers
 *  one unreceived blast impulse (~35 m/s) inside the uplink window. */
const VEL_FRAME_SLACK = 45;

/** Claim-driven origin: the shooter's reported eye/muzzle point,
 *  bounded to honest reach of its uplink window - a teleported claim
 *  clamps to the nearest recorded body sample instead of being taken
 *  verbatim. No transit estimate: pos is claim truth, the window is
 *  measured uplink. */
export function claimOrigin(player: PlayerState, uplinkMs: number, pos: Vec3 | undefined): Vec3 {
  const at = rewindPos(player, uplinkMs);
  if (pos && finiteVec(pos)) {
    const bound = rewindNearest(player, uplinkMs + 150, 150, pos);
    const gap = dhypot3(bound.x - pos.x, bound.y - pos.y, bound.z - pos.z);
    // A real muzzle sits within reach of some recorded body sample in
    // the window - but reach is speed-scaled, not a fixed 3m: at ski
    // speed an honest mover covers 3m in 100ms of uplink, so the fixed
    // clamp refused exactly the fast post-respawn shots (bigSoak flake:
    // thin-journal spawns clamped with originGap ~3). The velocity of
    // the newest journal sample is server-measured, so the scaled
    // window stays unforgeable; 3m remains the floor for slow bodies.
    const last = player.history[player.history.length - 1];
    const speed = last ? dhypot3(last.vx, last.vy, last.vz) : 0;
    const accept = Math.max(3, 1 + (speed * (uplinkMs + 150)) / 1000);
    if (gap <= accept) {return { x: pos.x, y: pos.y, z: pos.z };}
  }
  return at;
}

/** Shell-owner velocity for inherit: take the CLAIMED vector, not the
 *  shadow. The shadow lags the newest impulses the client already
 *  predicted (a painted disc after a knockback), so a shadow-diff gate
 *  drops honest velocity exactly when it diverges - and bent the arc
 *  past every rewind check (pd 16-41m body refuses, 2026-11-23). A
 *  forged vel only bends the arc the victim-side reachability gates
 *  still police, so the bound is a physics cap, not shadow distance. */
export function ownerVelOf(player: PlayerState, vel: Vec3 | undefined, frameVel: Vec3 | undefined, hb: (key: string) => void): Vec3 {
  const cv = vel;
  // C7: with a derived frame the claim is a refinement INSIDE the
  // shadow, not an independent number. The shadow's fire-aged velocity
  // misses impulses younger than the uplink window (a knockback the
  // client predicted but hasn't reported yet), so the claim wins
  // within one blast worth of slack; beyond it the claim is forged or
  // stale and the shadow's measured velocity takes the spawn whole.
  if (frameVel) {
    if (cv && finiteVec(cv)) {
      const gap = dhypot3(cv.x - frameVel.x, cv.y - frameVel.y, cv.z - frameVel.z);
      if (gap <= VEL_FRAME_SLACK) {return { x: cv.x, y: cv.y, z: cv.z };}
      hb('shot.frameVelBound');
    }
    return frameVel;
  }
  if (!cv || !finiteVec(cv)) {return player.velocity;}
  const gap = dhypot3(cv.x - player.velocity.x, cv.y - player.velocity.y, cv.z - player.velocity.z);
  if (gap > 20) {hb('shot.velGap');}
  const mag = dhypot3(cv.x, cv.y, cv.z);
  if (mag <= OWNER_VEL_CAP) {return { x: cv.x, y: cv.y, z: cv.z };}
  hb('shot.velClamp');
  const s = OWNER_VEL_CAP / mag;
  return { x: cv.x * s, y: cv.y * s, z: cv.z * s };
}
