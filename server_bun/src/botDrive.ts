/**
 * botDrive — turning a brain's destination into legal player inputs and
 * stepping the body. ServerBots owns the think/fire cadence; this file
 * owns the contract that keeps bots honest: every motion goes through
 * the room's MoveSim shadow with key-level inputs (forward/yaw/jump/jet)
 * exactly like a human client's inputMove — no injected positions, no
 * injected velocities.
 * The no-heightfield legacy fallback lives here too.
 */
import type { Vec3 } from './types.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { EYE_OFFSET } from '../../shared/constants.ts';
import type { BrainOut } from '../../shared/botBrain.ts';
import type { MoveState } from '../../shared/movement.ts';
import type { BotSheepMeter } from './botSheep.ts';
import type { BotArsenal } from './botArsenal.ts';
import { isSuper } from './superBot.ts';
import type { BotWatchdog, MobilitySample } from './botWatchdog.ts';
import type { Room } from './Room.ts';

const SPEED = 14;          // m/s ground move (legacy path)

/** Flat-field bag the drive functions read/write — ServerBots publishes
 *  itself; seq is the inputMove ordering key the shadow drops non-
 *  increasing values on. */
export interface DriveHost {
  room: Room;
  sheep: BotSheepMeter;
  arsenal: BotArsenal;
  watchdog: BotWatchdog;
  readonly foeNear: Map<string, number>;
  readonly field: Heightfield | null;
  seq: number;
  checkSheep(id: string, p: { position: Vec3 }, m: MobilitySample, now: number): void;
}

/** Legal path: convert the brain's destination into human inputs
 *  (heading → yaw, walk = forward key) and let the sim integrate.
 *  Commit happens on the NEXT tick — sims[] order puts moveSim.tick
 *  after bots.tick, so this reads the fresh post-step state. */
export function driveMove(h: DriveHost, id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number }; status: number; skiing: number }, out: BrainOut, sh: MoveState, dt: number, now: number): void {
  const dx = out.dest.x - p.position.x;
  const dz = out.dest.z - p.position.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const sheepGround = Math.max(
    h.field ? hmHeight(h.field, p.position.x, p.position.z) : p.position.y,
    h.room.moveSim.structureTop(p.position.x, p.position.z),
  );
  const sheepHeight = Math.max(0, p.position.y - EYE_OFFSET - sheepGround);
  h.sheep.check(id, p, { out, airborne: !sh.onGround, hasDest: dist >= 0.5, foe: (h.foeNear.get(id) ?? 0) > now, dt, height: sheepHeight }, now);
  if (dist >= 0.5) {
    // Wrist-speed turn — a snapped 180° reads as a fly-flick while an
    // arc at ~5 rad/s reads as a player swinging their view around.
    const want = Math.atan2(dx, dz);
    let dyaw = want - p.rotation.yaw;
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const yaw = p.rotation.yaw + Math.max(-5 * dt, Math.min(5 * dt, dyaw));
    h.room.moveSim.faceYaw(id, yaw);
    p.rotation.yaw = yaw;
  }
  commitMoveInput(h, id, p, out, { moving: dist >= 0.5 }, now);
  h.checkSheep(id, p, { trying: dist >= 0.5, ski: !!out.move?.ski, airborne: !sh.onGround, jetting: !!out.move?.jet, dt }, now);
  p.position.x = sh.pos.x; p.position.y = sh.pos.y; p.position.z = sh.pos.z;
  p.velocity.x = sh.vel.x; p.velocity.y = sh.vel.y; p.velocity.z = sh.vel.z;
  // Ski bit rides the tick flag byte (bit 2) — drives remote dust.
  p.skiing = out.move?.ski ? 1 : 0;
}

/** The bot's intent becomes input keys — only what a player's fingers
 *  could press. The arsenal's post-throw jet pin rides the same held
 *  bit as the brain's own jet key. */
function commitMoveInput(h: DriveHost, id: string, p: { status: number }, out: BrainOut, intent: { moving: boolean }, now: number): void {
  h.room.moveSim.setInput(id, intent.moving ? {
    forward: 1, right: 0,
    jumpPressed: !!out.move?.jump, jumpHeld: !!out.move?.jump,
    skiHeld: !!out.move?.ski,
    jetHeld: !!out.move?.jet || h.arsenal.jetPinUntil(id) > now,
  } : {
    forward: 0, right: 0,
  }, p.status, h.seq++);
}

/** No heightfield → no shadow → legacy direct-write fallback.
 *  Returns true when the parked case already finished the tick. */
export function legacyMove(h: DriveHost, id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number }; lastSeq: number }, dest: Vec3, dt: number): boolean {
  const dx = dest.x - p.position.x;
  const dz = dest.z - p.position.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.5) { p.velocity.x = 0; p.velocity.z = 0; p.lastSeq++; return true; }
  const nx = dx / dist, nz = dz / dist;
  const speed = isSuper(id) ? SPEED * 3 : SPEED;
  p.velocity.x = nx * speed;
  p.velocity.z = nz * speed;
  const groundY = Math.max(
    h.field ? hmHeight(h.field, p.position.x, p.position.z) : p.position.y,
    h.room.moveSim.structureTop(p.position.x, p.position.z),
  );
  // p.position is EYE-height (the wire convention — clients render
  // feet at pos.y - EYE_OFFSET); groundY+0.1 parked the model 1.7m
  // underground.
  const targetY = Math.max(groundY + EYE_OFFSET, p.position.y - 9 * dt);
  const hopping = p.position.y > groundY + EYE_OFFSET + 1.1;
  p.velocity.y = hopping ? p.velocity.y - 30 * dt : 0;
  p.position.x += p.velocity.x * dt;
  p.position.z += p.velocity.z * dt;
  p.position.y += p.velocity.y * dt;
  if (p.position.y < targetY) { p.position.y = targetY; p.velocity.y = 0; }
  p.rotation.yaw = Math.atan2(nx, nz);
  return false;
}
