/**
 * botDrive  -  turning a brain's destination into legal player inputs and
 * stepping the body. ServerBots owns the think/fire cadence; this file
 * owns the contract that keeps bots honest: every motion goes through
 * the room's MoveSim shadow with key-level inputs (forward/yaw/jump/jet)
 * exactly like a human client's inputMove  -  no injected positions, no
 * injected velocities.
 * The no-heightfield legacy fallback lives here too.
 */
import type { Vec3 } from './types.ts';
import { hmHeight, hmChord, type Heightfield } from '../../shared/heightfield.ts';
import { classCapsule } from '../../shared/botClasses.ts';
import type { BrainOut } from '../../shared/botBrain.ts';
import { MOVEMENT_CONFIG, type MoveState } from '../../shared/movement.ts';
import type { BotSheepMeter } from './botSheep.ts';
import type { BotArsenal } from './botArsenal.ts';
import { isSuper } from './superBot.ts';
import { inv } from '../../shared/invariants.ts';
import type { MobilityWatchdog, MobilitySample } from './botMobility.ts';
import type { BotSlew } from '../../shared/botSlew.ts';
import type { BotSkill } from '../../shared/botSkill.ts';
import type { Room } from './Room.ts';

const SPEED = 14;          // m/s ground move (legacy path)

/** Flat-field bag the drive functions read/write  -  ServerBots publishes
 *  itself. */
export interface DriveHost {
  room: Room;
  sheep: BotSheepMeter;
  arsenal: BotArsenal;
  watchdog: MobilityWatchdog;
  readonly foeNear: Map<string, number>;
  readonly field: Heightfield | null;
  checkSheep(id: string, p: { position: Vec3 }, m: MobilitySample, now: number): void;
  /** The brain's shared slew tracker (spring+noise aim turn model). */
  slewFor(id: string): BotSlew | undefined;
  /** The bot's skill matrix — the slew's per-bot tuning input. */
  skillOf(id: string): BotSkill | undefined;
}

/** The bot's intent becomes input keys  -  only what a player's fingers
 *  could press. `move` is the dest direction already projected onto the
 *  body's facing (strafe decomposition: forward/right are the WASD a
 *  human holds while looking somewhere else). The arsenal's post-throw
 *  jet pin rides the same held bit as the brain's own jet key. */
function commitMoveInput(h: DriveHost, id: string, p: { status: number }, out: BrainOut, move: { forward: number; right: number }, now: number): void {
  const moving = (move.forward !== 0 || move.right !== 0) && !out.move?.park;
  h.room.moveSim.setInput(id, moving ? {
    forward: move.forward, right: move.right,
    jumpPressed: Boolean(out.move?.jump), jumpHeld: Boolean(out.move?.jump),
    skiHeld: Boolean(out.move?.ski),
    jetHeld: Boolean(out.move?.jet) || h.arsenal.jetPinUntil(id) > now,
  } : {
    // Idle = every key released. Omitting jetHeld left a stale 1 pinned
    // in the shadow (setInput treats undefined as "unchanged"), so one
    // transient commit kept jetWanted true forever  -  the tank burned
    // every regen tick and sat at ~0 for the rest of the match.
    forward: 0, right: 0,
    jumpPressed: false, jumpHeld: false, skiHeld: false, jetHeld: false,
    // No seq: bots never reconcile, so the per-call journal entry (a
    // state+input+energy snapshot plus a Map evict) would be pure churn
    // every tick for every bot  -  the journal exists for wire replay.
  }, p.status);
}



/** Legal path: convert the brain's destination into human inputs
 *  (heading → yaw, walk = forward key) and let the sim integrate.
 *  Commit happens on the NEXT tick  -  sims[] order puts moveSim.tick
 *  after bots.tick, so this reads the fresh post-step state. */
export function driveMove(h: DriveHost, id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number; pitch: number }; status: number; skiing: number; jetting: number; armorClass: string }, frame: { out: BrainOut; sh: MoveState; dt: number; now: number }): void {
  const { out, sh, dt, now } = frame;
  const dx = out.dest.x - p.position.x;
  const dz = out.dest.z - p.position.z;
  const dist = (dx * dx + dz * dz) ** 0.5;
  const sheepGround = Math.max(
    h.field ? hmHeight(h.field, p.position.x, p.position.z) : p.position.y,
    h.field ? hmChord(h.field, p.position.x, p.position.z) : p.position.y,
    h.room.moveSim.structureTop(p.position.x, p.position.z),
  );
  const sheepHeight = Number.isFinite(sheepGround) ? Math.max(0, p.position.y - classCapsule(p.armorClass).eye - sheepGround) : 0;
  h.sheep.check(id, p, { out, airborne: !sh.onGround, hasDest: dist >= 0.5, foe: (h.foeNear.get(id) ?? 0) > now, dt, height: sheepHeight }, now);
  const aim = h.arsenal.aimPoint(id);
  if (aim || dist >= 0.5) {
    // A bot's yaw is its crosshair (like a human's): while a trigger is
    // live it faces the TARGET, not the destination  -  a body strafing
    // sideways while its shots land on you reads as a silent aimbot.
    const wantYaw = aim
      ? Math.atan2(aim.x - p.position.x, aim.z - p.position.z)
      : Math.atan2(dx, dz);
    // Wire pitch is negated  -  positive looks down  -  and a disengaged
    // bot relaxes back to level. Pitched at the MUZZLE (+1.4 over eye),
    // not the eye: shots launch along this dir, so a facing solved at
    // eye height would loft every shell 1.4m over the capsule top.
    const wantPitch = aim ? -Math.atan2(aim.y - (p.position.y + 1.4), Math.hypot(aim.x - p.position.x, aim.z - p.position.z)) : 0;
    // Human-shaped turn — shared/botSlew spring + settling noise, the
    // same drive the offline host uses (was a flat 5 rad/s slew).
    const f = h.slewFor(id)?.face(dt, p.rotation.yaw, wantYaw, p.rotation.pitch, wantPitch, h.skillOf(id));
    if (f) {
      h.room.moveSim.faceYaw(id, f.yaw);
      p.rotation.yaw = f.yaw;
      p.rotation.pitch = f.pitch;
    }
  }
  // Landing flare  -  the T1 damage floor means a 25+ m/s arrival costs
  // real health; a human feathers jets on the way down, and the reflex
  // lives below the brain (a splat is a reflex, not a decision). Gate is
  // world fall speed + ~0.8s to contact: slope-parallel descents carry
  // the same vel.y with v·n≈0 and burn a little tank for nothing  - 
  // under-flare is cheap, a splat is not.
  if (out.move && !sh.onGround && sh.vel.y < -MOVEMENT_CONFIG.fallDamageMinSpeed
    && sheepHeight < -sh.vel.y * 0.8) { out.move.jet = true; }
  // Travel intent in world space → yaw-relative keys, so aiming and
  // moving decouple like a human's hands: a bot facing its target still
  // strafes/backpedals toward its destination instead of being dragged
  // onto the crosshair. Quantized to the 8 legal WASD chords - the edge
  // wire is int8 anyway, so the shadow, the broadcast, and remote edge
  // replay all run the identical keys a human could hold.
  let fwdIn = 0, rgtIn = 0;
  if (dist >= 0.5) {
    const fx = Math.sin(p.rotation.yaw), fz = Math.cos(p.rotation.yaw);
    const nx = dx / dist, nz = dz / dist;
    fwdIn = Math.round(nx * fx + nz * fz);      // d·fwd
    rgtIn = Math.round(nx * -fz + nz * fx);     // d·right, right = (-fwdZ, fwdX)
  }
  commitMoveInput(h, id, p, out, { forward: fwdIn, right: rgtIn }, now);
  // 'trying' needs reach, not intent: out.dest re-rolls each think and
  // can hover a meter off the position (steerer micro-orbit), which
  // would count a bot that has effectively arrived as grinding forever.
  h.checkSheep(id, p, { trying: dist >= 2 && !out.move?.park, ski: Boolean(out.move?.ski), airborne: !sh.onGround, jetting: Boolean(out.move?.jet), dt }, now);
  // The shadow's write is the bot's whole wire truth  -  a NaN/Infinity
  // here broadcasts poison to every observer with no warn. Named once.
  inv('bot-pos-finite',
    Number.isFinite(sh.pos.x + sh.pos.y + sh.pos.z + sh.vel.x + sh.vel.y + sh.vel.z),
    { id, pos: { x: Number(sh.pos.x.toFixed(1)), y: Number(sh.pos.y.toFixed(1)), z: Number(sh.pos.z.toFixed(1)) } });
  p.position.x = sh.pos.x; p.position.y = sh.pos.y; p.position.z = sh.pos.z;
  p.velocity.x = sh.vel.x; p.velocity.y = sh.vel.y; p.velocity.z = sh.vel.z;
  // Ski bit rides the tick flag byte (bit 2)  -  drives remote dust.
  p.skiing = out.move?.ski ? 1 : 0;
  // Jet bit mirrors the held-input the shadow actually burns  -  the
  // arsenal's post-throw pin counts as jetting too.
  p.jetting = (out.move?.jet || h.arsenal.jetPinUntil(id) > now) ? 1 : 0;
}

/** No heightfield → no shadow → legacy direct-write fallback.
 *  Returns true when the parked case already finished the tick. */
export function legacyMove(h: DriveHost, id: string, p: { position: Vec3; velocity: Vec3; rotation: { yaw: number }; lastSeq: number; armorClass: string }, dest: Vec3, dt: number): boolean {
  const dx = dest.x - p.position.x;
  const dz = dest.z - p.position.z;
  const dist = (dx * dx + dz * dz) ** 0.5;
  if (dist < 0.5) { p.velocity.x = 0; p.velocity.z = 0;p.lastSeq += 1; return true; }
  const nx = dx / dist, nz = dz / dist;
  const speed = isSuper(id) ? SPEED * 3 : SPEED;
  p.velocity.x = nx * speed;
  p.velocity.z = nz * speed;
  // Chord is the rendered surface  -  a bot clamped to the smooth field
  // alone sinks under the level-0 mesh in gullies on every client's screen.
  const rawGroundY = Math.max(
    h.field ? hmHeight(h.field, p.position.x, p.position.z) : p.position.y,
    h.field ? hmChord(h.field, p.position.x, p.position.z) : p.position.y,
    h.room.moveSim.structureTop(p.position.x, p.position.z),
  );
  const groundY = Number.isFinite(rawGroundY) ? rawGroundY : p.position.y;
  // p.position is EYE-height (the wire convention  -  clients render
  // feet at pos.y - eyeHeight); groundY+0.1 parked the model underground.
  const {eye} = classCapsule(p.armorClass);
  const targetY = Math.max(groundY + eye, p.position.y - 9 * dt);
  const hopping = p.position.y > groundY + eye + 1.1;
  p.velocity.y = hopping ? p.velocity.y - 30 * dt : 0;
  p.position.x += p.velocity.x * dt;
  p.position.z += p.velocity.z * dt;
  p.position.y += p.velocity.y * dt;
  if (p.position.y < targetY) { p.position.y = targetY; p.velocity.y = 0; }
  p.rotation.yaw = Math.atan2(nx, nz);
  return false;
}
