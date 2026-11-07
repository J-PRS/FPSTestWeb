import * as THREE from 'three';
import { TargetEventType, type TargetEvent } from './types.js';
import { Ball } from '../entities/balls.js';
import { BallDebris } from '../effects/debris.js';
import { fastForward } from './playbackFF.js';
import { SPAWN_POP_S } from '../entities/ballVisual.js';
import { breakDropDebugPin } from '../effects/debugPins.js';
import { GRAVITY } from '../core/config.js';
import type { PlaybackWorld } from './playbackReconstruction.js';
import * as sfxWorld from '../core/sfx/world.js';

// Ball/target replay: spawned/seek-rebuilt balls, smooth-snap drift
// correction, hit flash + debris - everything that reads a TargetEvent.

/** Re-seed a playback ball's local sim at the RECORDED state. The Ball
 *  ctor builds the sim at a random ambient ring spot; left alone,
 *  tickLocal writes that spot over pos on frame 1 — every playback ball
 *  teleported ~200m from its recorded track. The sim must stay (it
 *  supplies terrain bounces between sparse edges), it just has to start
 *  where the recording says. */
function seedSim(ball: Ball, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
  ball.edgeDriven = true; // physics-only sim: edges own state + decisions
  const s = ball.netS.sim;
  if (!s) {return;}
  s.x = x; s.y = y; s.z = z;
  s.vx = vx; s.vy = vy; s.vz = vz;
  s.gt = 0; // stale cached probe, same write applyKnockback makes
}

export function reconstructSeekTarget(world: PlaybackWorld, ev: TargetEvent, deadBallIds: Set<number>, seekTime: number): void {
  const { scene, terrain, balls, debrisList, playbackBallById } = world;
  const playerPos = world.getPlayer().pos;

  if (deadBallIds.has(ev.targetType * 65_536 + ev.targetId)) {
    // For Destroyed events on dead balls, spawn debris fast-forwarded to seek time
    if (ev.eventType === TargetEventType.Destroyed) {
      const debris = new BallDebris(scene, terrain, { x: ev.posX, y: ev.posY, z: ev.posZ }, new THREE.Color(0xFF_FF_FF), 1);
      debrisList.push(debris);
      fastForward(seekTime - ev.timestamp, (): boolean => !debris.dead, (s): void => debris.update(s));
    }
    return;
  }

  if (ev.eventType === TargetEventType.Spawned) {
    const ball = new Ball(scene, terrain, ev.targetType as 0 | 1 | 2 | 3);
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    seedSim(ball, ev.posX, ev.posY, ev.posZ, ev.velX, ev.velY, ev.velZ);
    playbackBallById.set(ev.targetId, ball);
    balls.push(ball);
    ball.update(0, terrain, playerPos); // sync mesh (ctor doesn't copy pos)
    fastForward(seekTime - ev.timestamp, (): boolean => !ball.dead, (s): void => ball.update(s, terrain, playerPos));
    return;
  }

  if (ev.eventType === TargetEventType.Bounce || ev.eventType === TargetEventType.StateChanged || ev.eventType === TargetEventType.Hit) {
    const ball = playbackBallById.get(ev.targetId);
    if (!ball || ball.dead) {return;}
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    seedSim(ball, ev.posX, ev.posY, ev.posZ, ev.velX, ev.velY, ev.velZ);
    if (ev.eventType === TargetEventType.Hit) {
      ball.health = ev.health;
      if (ball.health <= 0) {ball.dead = true;}
    }
    ball.update(0, terrain, playerPos);
    fastForward(seekTime - ev.timestamp, (): boolean => !ball.dead, (s): void => ball.update(s, terrain, playerPos));
  }
}

const PLAYBACK_HARD_SNAP_DIST = 1.5; // meters - large desync -> hard snap
// Per-frame blend pull toward the last recorded keyframe - the event
// stream becomes a moving target instead of a stair-step correction,
// so motion stays smooth between the ~5-10Hz keyframes.
const PLAYBACK_BLEND_HZ = 12;

function smoothSnapBall(ball: Ball, ...rest: [ex: number, ey: number, ez: number, evx: number, evy: number, evz: number, et: number]): void {
  const [ex, ey, ez, evx, evy, evz, et] = rest;
  const dx = ball.pos.x - ex, dy = ball.pos.y - ey, dz = ball.pos.z - ez;
  const drift = Math.hypot(dx, dy, dz);
  const pb = ball as Ball & { pbTarget?: THREE.Vector3; pbTargetVel?: THREE.Vector3; pbEdge?: { x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number } };
  pb.pbTarget ??= new THREE.Vector3();
  pb.pbTargetVel ??= new THREE.Vector3();
  pb.pbTarget.set(ex, ey, ez);
  pb.pbTargetVel.set(evx, evy, evz);
  // Teleport = the RECORDED EDGES can't be connected by the recorded
  // velocity (ball jumped in the data itself), not the sim-vs-edge drift.
  // A fast ball legitimately drifts 25m+ between sparse edges — popping
  // the spawn spring on each one reads as rhythmic pulsation.
  let edgeJump = true;
  if (pb.pbEdge) {
    const dt = et - pb.pbEdge.t;
    const px = pb.pbEdge.x + pb.pbEdge.vx * dt;
    const py = pb.pbEdge.y + pb.pbEdge.vy * dt - 0.5 * GRAVITY * dt * dt;
    const pz = pb.pbEdge.z + pb.pbEdge.vz * dt;
    edgeJump = Math.hypot(ex - px, ey - py, ez - pz) > 8;
  }
  pb.pbEdge ??= { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0 };
  pb.pbEdge.x = ex; pb.pbEdge.y = ey; pb.pbEdge.z = ez;
  pb.pbEdge.vx = evx; pb.pbEdge.vy = evy; pb.pbEdge.vz = evz;
  pb.pbEdge.t = et;
  if (edgeJump) {
    // Real teleport (edges unreachable via their own recorded vel): the
    // old tails must end here — snap everything, no sweep, trail cuts.
    ball.pos.set(ex, ey, ez);
    ball.vel.set(evx, evy, evz);
    seedSim(ball, ex, ey, ez, evx, evy, evz);
    ball.renderOffset.set(0, 0, 0);
    ball._rpos.copy(ball.pos);
    if (drift >= 25) {
      ball.spawnPopT = SPAWN_POP_S;
      ball.retireRibbons();
      ball.trails.burst(12, ball.pos, ball.radius, ball.color);
    }
    breakDropDebugPin(ball, ball.pos); // declared break - the strip ends at the old spot
    return;
  }
  // Continuous edges: NEVER teleport pos. The blend target (set above)
  // converges sim+render+trail smoothly onto the recorded arc; a mid-air
  // pos jump is what chopped trails and popped the spawn spring at
  // every sparse-edge correction.
  // Small drift: the SIM still gets the edge — tickLocal writes s.x/y/z
  // over pos every frame, so an un-corrected sim stomps the blend and
  // walks its own track (the phantom-ring bug). Reseeding is the only
  // write that survives.
  seedSim(ball, ex, ey, ez, evx, evy, evz);
}

/** Continuous keyframe smoothing - call every playback tick after the
 *  ball's own sim update. pos/vel pull toward the last recorded keyframe
 *  at PLAYBACK_BLEND_HZ; the sim keeps collisions/bounces, the blend
 *  eats drift so the track never stairs between events. */
export function blendPlaybackBall(ball: Ball, dt: number): void {
  const pb = ball as Ball & { pbTarget?: THREE.Vector3; pbTargetVel?: THREE.Vector3 };
  if (!pb.pbTarget || !pb.pbTargetVel || ball.dead) {return;}
  // Dead-reckon the target: the recorded point is where the ball WAS at
  // the edge; pulling pos toward it drags a ball that flew past back-
  // wards — the rubberband. Advancing the target at the recorded vel
  // (+gravity) makes the blend converge on where the ball should be NOW.
  const g = GRAVITY;
  pb.pbTarget.x += pb.pbTargetVel.x * dt;
  pb.pbTarget.y += pb.pbTargetVel.y * dt;
  pb.pbTarget.z += pb.pbTargetVel.z * dt;
  pb.pbTargetVel.y -= g * dt;
  const k = 1 - Math.exp(-PLAYBACK_BLEND_HZ * dt);
  ball.pos.lerp(pb.pbTarget, k);
  ball.vel.lerp(pb.pbTargetVel, k);
}

function spawnPlaybackBall(world: PlaybackWorld, ev: TargetEvent): void {
  const { scene, terrain, balls, playbackBallById } = world;
  const playerPos = world.getPlayer().pos;
  const existing = playbackBallById.get(ev.targetId);
  if (existing && !existing.dead) {
    // Id reuse (allocator wrap, or a synthetic+real pair straddling a
    // clip boundary): re-keying the map while pushing a second Ball would
    // orphan the old one - updated by nothing, frozen in the scene.
    existing.pos.set(ev.posX, ev.posY, ev.posZ);
    existing.vel.set(ev.velX, ev.velY, ev.velZ);
    seedSim(existing, ev.posX, ev.posY, ev.posZ, ev.velX, ev.velY, ev.velZ);
    if (ev.health > 0) {existing.health = ev.health;}
    existing.update(0, terrain, playerPos);
    return;
  }
  if (existing) {
    // Dead corpse still fading - re-keying would orphan it out of the
    // map (never ticked = frozen ghost). Hard-remove; the fade is lost
    // but a frozen ghost is worse.
    existing.dispose();
    const i = balls.indexOf(existing);
    if (i !== -1) {balls.splice(i, 1);}
  }
  const ball = new Ball(scene, terrain, ev.targetType as 0 | 1 | 2 | 3);
  ball.pos.set(ev.posX, ev.posY, ev.posZ);
  ball.vel.set(ev.velX, ev.velY, ev.velZ);
  seedSim(ball, ev.posX, ev.posY, ev.posZ, ev.velX, ev.velY, ev.velZ);
  // Apply recorded health when available (e.g. synthetic Spawned from a Hit/Bounce snapshot)
  if (ev.health > 0) {
    ball.health = ev.health;
  }
  playbackBallById.set(ev.targetId, ball);
  balls.push(ball);
  ball.update(0, terrain, playerPos); // sync mesh (ctor doesn't copy pos)
}

export function applyPlaybackTargetEvent(world: PlaybackWorld, ev: TargetEvent): void {
  const { terrain, playbackBallById } = world;
  const playerPos = world.getPlayer().pos;

  if (ev.eventType === TargetEventType.Spawned) {
    spawnPlaybackBall(world, ev);
    return;
  }

  const ball = playbackBallById.get(ev.targetId);
  if (!ball || ball.dead) {return;}

  if (ev.eventType === TargetEventType.Bounce || ev.eventType === TargetEventType.StateChanged) {
    // Correct toward recorded keyframe; hard-snap only on large drift
    smoothSnapBall(ball, ev.posX, ev.posY, ev.posZ, ev.velX, ev.velY, ev.velZ, ev.timestamp);
    ball.update(0, terrain, playerPos);
  } else if (ev.eventType === TargetEventType.Hit) {
    // Snap ball to recorded hit position to ensure explosion aligns
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    seedSim(ball, ev.posX, ev.posY, ev.posZ, ev.velX, ev.velY, ev.velZ);
    // Flash the ball and then sync to the recorded post-hit health
    ball.takeDamage(1); // health is force-synced from the event - amount is cosmetic
    ball.health = ev.health;
    ball.dead = ball.health <= 0;
    ball.update(0, terrain, playerPos);
    // A killing Hit bursts like a Destroyed — without debris the body
    // loses its swarm slot instantly and only the trail wisp remains,
    // which reads as "the ball vanished" on midair kills.
    if (ball.dead) {
      world.debrisList.push(new BallDebris(world.scene, terrain, ball.pos, ball.color, ball.scale));
    }
    world.damageNumberManager.spawn(ball.pos, 1, '#ffffff', world.camera);
    // Dead stays mapped - updateBallsPlayback ticks updateBallDead (trail
    // fade, slot free) and splices on `disposed`. Unmapping here freezes
    // the corpse midair.
  } else if (ev.eventType === TargetEventType.Destroyed) {
    // Terminal edge: seat the corpse at the recorded spot before debris —
    // an edge-starved ball can sit 100m+ off its last bounce keyframe,
    // and the gibs must burst where the kill actually happened.
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.dead = true;
    // Same death bark the live kill path cues (combat/impact.ts).
    sfxWorld.enemyCue(ball.pos, (ball as Ball & { dieCue?: 'die' | 'splat' | 'rustle' | 'squawk' }).dieCue ?? 'die');
    world.debrisList.push(new BallDebris(world.scene, terrain, ball.pos, ball.color, ball.scale));
  }
}

