import * as THREE from 'three';
import type { TargetEvent } from './types.js';
import { TargetEventType } from './types.js';
import { Ball } from '../entities/balls.js';
import { BallDebris } from '../effects/debris.js';
import { fastForward, type PlaybackWorld } from './playbackReconstruction.js';

// Ball/target replay: spawned/seek-rebuilt balls, smooth-snap drift
// correction, hit flash + debris — everything that reads a TargetEvent.

export function reconstructSeekTarget(world: PlaybackWorld, ev: TargetEvent, deadBallIds: Set<number>, seekTime: number): void {
  const { scene, terrain, balls, debrisList, playbackBallById } = world;
  const playerPos = world.getPlayer().pos;

  if (deadBallIds.has(ev.targetId)) {
    // For Destroyed events on dead balls, spawn debris fast-forwarded to seek time
    if (ev.eventType === TargetEventType.Destroyed) {
      const debris = new BallDebris(scene, terrain, { x: ev.posX, y: ev.posY, z: ev.posZ }, new THREE.Color(0xFFFFFF), 1);
      debrisList.push(debris);
      fastForward(seekTime - ev.timestamp, () => !debris.dead, (s) => debris.update(s));
    }
    return;
  }

  if (ev.eventType === TargetEventType.Spawned) {
    const ball = new Ball(scene, terrain, ev.targetType as 0 | 1 | 2 | 3);
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    playbackBallById.set(ev.targetId, ball);
    balls.push(ball);
    ball.update(0, terrain, playerPos); // sync mesh (ctor doesn't copy pos)
    fastForward(seekTime - ev.timestamp, () => !ball.dead, (s) => ball.update(s, terrain, playerPos));
    return;
  }

  if (ev.eventType === TargetEventType.Bounce || ev.eventType === TargetEventType.StateChanged || ev.eventType === TargetEventType.Hit) {
    const ball = playbackBallById.get(ev.targetId);
    if (!ball || ball.dead) {return;}
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    if (ev.eventType === TargetEventType.Hit) {
      ball.health = ev.health;
      if (ball.health <= 0) {ball.dead = true;}
    }
    ball.update(0, terrain, playerPos);
    fastForward(seekTime - ev.timestamp, () => !ball.dead, (s) => ball.update(s, terrain, playerPos));
  }
}

const PLAYBACK_HARD_SNAP_DIST = 1.5; // meters — large desync -> hard snap
const PLAYBACK_SMOOTH_FACTOR = 0.25; // per-event gentle correction for small drift

function smoothSnapBall(ball: Ball, ...rest: [ex: number, ey: number, ez: number, evx: number, evy: number, evz: number]): void {
  const [ex, ey, ez, evx, evy, evz] = rest;
  const dx = ball.pos.x - ex, dy = ball.pos.y - ey, dz = ball.pos.z - ez;
  const drift = Math.hypot(dx, dy, dz);
  if (drift >= PLAYBACK_HARD_SNAP_DIST) {
    ball.pos.set(ex, ey, ez);
    ball.vel.set(evx, evy, evz);
  } else {
    const a = PLAYBACK_SMOOTH_FACTOR;
    ball.pos.x += (ex - ball.pos.x) * a;
    ball.pos.y += (ey - ball.pos.y) * a;
    ball.pos.z += (ez - ball.pos.z) * a;
    ball.vel.x += (evx - ball.vel.x) * a;
    ball.vel.y += (evy - ball.vel.y) * a;
    ball.vel.z += (evz - ball.vel.z) * a;
  }
}

export function applyPlaybackTargetEvent(world: PlaybackWorld, ev: TargetEvent): void {
  const { scene, terrain, balls, playbackBallById } = world;
  const playerPos = world.getPlayer().pos;

  if (ev.eventType === TargetEventType.Spawned) {
    const ball = new Ball(scene, terrain, ev.targetType as 0 | 1 | 2 | 3);
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    // Apply recorded health when available (e.g. synthetic Spawned from a Hit/Bounce snapshot)
    if (ev.health > 0) {
      ball.health = ev.health;
    }
    playbackBallById.set(ev.targetId, ball);
    balls.push(ball);
    ball.update(0, terrain, playerPos); // sync mesh (ctor doesn't copy pos)
    return;
  }

  const ball = playbackBallById.get(ev.targetId);
  if (!ball || ball.dead) {return;}

  if (ev.eventType === TargetEventType.Bounce || ev.eventType === TargetEventType.StateChanged) {
    // Correct toward recorded keyframe; hard-snap only on large drift
    smoothSnapBall(ball, ev.posX, ev.posY, ev.posZ, ev.velX, ev.velY, ev.velZ);
    ball.update(0, terrain, playerPos);
  } else if (ev.eventType === TargetEventType.Hit) {
    // Snap ball to recorded hit position to ensure explosion aligns
    ball.pos.set(ev.posX, ev.posY, ev.posZ);
    ball.vel.set(ev.velX, ev.velY, ev.velZ);
    // Flash the ball and then sync to the recorded post-hit health
    ball.takeDamage(1); // health is force-synced from the event — amount is cosmetic
    ball.health = ev.health;
    ball.dead = ball.health <= 0;
    ball.update(0, terrain, playerPos);
    world.damageNumberManager.spawn(ball.pos, 1, '#ffffff', world.camera);
    if (ball.dead) {playbackBallById.delete(ev.targetId);}
  } else if (ev.eventType === TargetEventType.Destroyed) {
    ball.dead = true;
    world.debrisList.push(new BallDebris(scene, terrain, ball.pos, ball.color, ball.scale));
    playbackBallById.delete(ev.targetId);
  }
}

