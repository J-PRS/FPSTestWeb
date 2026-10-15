// creature ids. Ordered to match shared/deployItems.ts — keep stable.

import type { ResultToken } from '../../../shared/resultToken.ts';

export const TARGETTYPE_KILL = 224;

// Demo system data types - binary-efficient structures for recording/replay



export const DEMO_MAGIC = 0x44; // 'D'

export const DEMO_FORMAT_VERSION = 7;



// Remote-frame flag bitmasks

export const RemoteFrameFlags = {

  None: 0,

  // oxlint-disable-next-line prefer-math-trunc -- int32 wrap is the point

  Dead: 1 << 0,

  Ski: 1 << 1,

} as const;



// Input flag bitmasks

export const InputFlags = {

  None: 0,

  // oxlint-disable-next-line prefer-math-trunc -- int32 wrap is the point

  Forward: 1 << 0,

  Backward: 1 << 1,

  Left: 1 << 2,

  Right: 1 << 3,

  Jump: 1 << 4,

  Ski: 1 << 5,

  Fire: 1 << 6,

  Disc: 1 << 7,

} as const;



// Jetpack flag bitmasks

export const JetpackFlags = {

  None: 0,

  // oxlint-disable-next-line prefer-math-trunc -- int32 wrap is the point

  Active: 1 << 0,

} as const;



export enum ProjectileEventType {

  Fired = 0,

  Bounce = 1,

  Hit = 2,

  Destroyed = 3,

}



export enum TargetEventType {

  Spawned = 0,

  Bounce = 1,

  Hit = 2,

  Destroyed = 3,

  StateChanged = 4,

}



// v4 target space: targetType 0-63 = ball variants (0-3 used today); 64+

// is the creature lane, 64 + index into DEMO_SPECIES. Playback splits lanes

// on this, so creature targetIds only need uniqueness among themselves —

// CREATURE_ID_FLAG sets the top bit anyway so raw ids never alias ball ids.

export const TARGETTYPE_CREATURE_BASE = 64;

export const CREATURE_ID_FLAG = 0x80_00;

// Ordered to match shared/species.ts — keep stable, ids land in the file.

export const DEMO_SPECIES = ['crawler', 'scarab', 'rakk', 'gnat', 'roller', 'snake', 'baneling', 'totem'] as const;

export function demoSpeciesIndex(species: string): number {

  const i = DEMO_SPECIES.indexOf(species as (typeof DEMO_SPECIES)[number]);

  return i === -1 ? 0 : i;

}

export function creatureDemoId(netId: number): number {

  // 14-bit mask, not 15: creatures must stay 0x8000–0xbfff. 0x7fff let a

  // creature netId ≥ 0x4000 wrap into the flag (0xc000+) and pickup

  // (0xe000+) lanes — cross-lane corruption every 16k spawns. NetIds past

  // 0x3fff now self-collide within the creature lane only, which the

  // composite (targetType, targetId) keys keep bounded.

  return CREATURE_ID_FLAG | (netId & 0x3F_FF);

}

export function isCreatureTargetType(targetType: number): boolean {

  return targetType >= TARGETTYPE_CREATURE_BASE && targetType < TARGETTYPE_DEPLOY_BASE;

}



// Deployable lane — same shape as creatures: 128 + index into

// DEMO_DEPLOY_KINDS, top-bit-below demo id so it can't alias ball or

export const TARGETTYPE_DEPLOY_BASE = 128;

export const DEPLOY_ID_FLAG = 0x40_00;

export const DEMO_DEPLOY_KINDS = ['turret', 'mine', 'station', 'drone', 'shield', 'nugget', 'beacon', 'generator', 'sensor', 'baseturret'] as const;

export function demoDeployKindIndex(kind: string): number {

  const i = DEMO_DEPLOY_KINDS.indexOf(kind as (typeof DEMO_DEPLOY_KINDS)[number]);

  return i === -1 ? 0 : i;

}

export function deployDemoId(netId: number): number {

  return DEPLOY_ID_FLAG | (netId & 0x3F_FF);

}

export function isDeployTargetType(targetType: number): boolean {

  return targetType >= TARGETTYPE_DEPLOY_BASE && targetType < TARGETTYPE_KILL;

}



// Marker lanes — game-state edges that aren't bodies on the field:

// 224 kill marker (targetId = victim roster idx, health = weapon,

//     peakPosX = shooter roster idx + 1),

// 225 flag (health = state code 0 home/1 carried/2 dropped, peakPosX =

//     carrier roster idx + 1),

// 226+ pickup (226 + index into DEMO_PICKUP_KINDS).

export const TARGETTYPE_FLAG = 225;

export const TARGETTYPE_PICKUP_BASE = 226;

export const FLAG_DEMO_ID_BASE = 0xC0_00; // |teamIdx — one flag per team

export const PICKUP_ID_FLAG = 0xE0_00;

// Ordered to match shared/pickups.ts — keep stable, ids land in the file.

export const DEMO_PICKUP_KINDS = ['gem', 'tag', 'heal', 'armor', 'regen', 'dd'] as const;

export function demoPickupKindIndex(kind: string): number {

  const i = DEMO_PICKUP_KINDS.indexOf(kind as (typeof DEMO_PICKUP_KINDS)[number]);

  return i === -1 ? 0 : i;

}

export function flagDemoId(teamIdx: number): number {

  return FLAG_DEMO_ID_BASE | (teamIdx & 0xF);

}

export function pickupDemoId(netId: number): number {

  return PICKUP_ID_FLAG | (netId & 0x1F_FF);

}

export function isMiscTargetType(targetType: number): boolean {

  return targetType >= TARGETTYPE_KILL;

}



/** Every target event keys on the wire netId for net-driven targets —

 *  the client's 0x40xx id namespace creates phantom lanes whose edges

 *  match nothing else (orphan kills, duplicate baseline spawns). */

export function targetDemoId(t: { id: number; netDriven?: boolean; netId?: number }): number {

  return t.netDriven ? (t.netId ?? t.id) : t.id;

}



// Flat frame structure for efficient recording (~49 bytes)

export interface DemoFrame {

  frameNumber: number;       // uint16

  timestamp: number;         // float32

  posX: number; posY: number; posZ: number;       // 3 * float32

  velX: number; velY: number; velZ: number;       // 3 * float32

  yaw: number; pitch: number;                      // 2 * float32

  inputFlags: number;       // uint8

  mouseDeltaX: number;      // int16

  mouseDeltaY: number;      // int16

  jetpackFlags: number;     // uint8

  jetpackFuel: number;      // float32

  // v4: held weapon so replays can rebuild the viewmodel. Agnostic on

  // purpose — if the weapon is deleted from the build, playback swaps in

  // a stock model rather than refusing to load the clip.

  weaponType: number;       // uint8

}



export interface ProjectileEvent {

  eventType: ProjectileEventType;  // uint8

  timestamp: number;               // float32

  posX: number; posY: number; posZ: number;

  velX: number; velY: number; velZ: number;

  projectileId: number;            // uint16

  weaponType: number;             // uint8

  surfaceNormalX: number; surfaceNormalY: number; surfaceNormalZ: number;

  targetId: number;               // uint16

  // v6: which demo lane targetId addresses on Hit — the ball variant

  // (0-63) for ball hits, HIT_TARGET_NONE for terrain/player hits.

  // Without it a non-ball id aliasing a live ball mis-scores the frag.

  targetType: number;             // uint8

  hasPeakPosition: boolean;

  peakPosX: number; peakPosY: number; peakPosZ: number;

}



// Projectile Hit events: targetType when targetId is not a ball reference.

export const HIT_TARGET_NONE = 255;



export interface TargetEvent {

  eventType: TargetEventType;      // uint8

  timestamp: number;              // float32

  posX: number; posY: number; posZ: number;

  velX: number; velY: number; velZ: number;

  targetId: number;               // uint16

  targetType: number;             // uint8

  health: number;                 // float32

  hasPeakPosition: boolean;

  peakPosX: number; peakPosY: number; peakPosZ: number;

}



export interface DemoHeader {

  magic: number;              // uint8 - must be DEMO_MAGIC

  formatVersion: number;      // int32

  gameVersion: string;        // variable length string

  timestamp: number;          // int64 (as number, stored as two int32)

  duration: number;           // float32

  totalFrames: number;        // uint32

  projectileEventCount: number; // uint32

  targetEventCount: number;   // uint32

  checksum: number;           // uint32

  description: string;        // variable length string

  startPosX: number; startPosY: number; startPosZ: number;

  startYaw: number; startPitch: number;

  startVelX: number; startVelY: number; startVelZ: number;

  projectileLifetime: number;   // float32 — airtime of the cool shot (0 for full recordings)

  // v3: match context — a demo recorded on quicksand replayed on raindance

  // reconstructs nonsense; carrying the room/mode makes clips self-describing

  // and lets the UI flag wrong-map playback before it happens.

  room: string;               // variable length string

  mode: string;               // variable length string

  playerName: string;         // variable length string

  // v6: crc32 of the persisted enum tables (species/deploy/pickup kinds,

  // ball variants) at record time — a later table reorder flags old clips

  // instead of silently remapping them. See demoTables.ts.

  tableHash: number;            // uint32

  // v7: the run's sim-RNG seed — replays that re-seed walk the identical
  // dice stream, so a fabricated Spawned/moved event can't hide inside
  // "random luck". Stamped by the writer at serialize time.
  runSeed: number;              // uint32

}



// v3: every other player in the room, sampled at ~20Hz so an MP demo isn't

// an empty battlefield. The roster table dedupes names out of the hot stream.

export interface DemoRosterEntry {

  name: string;               // variable length string (the wire player id)

}



export interface RemoteFrame {

  timestamp: number;          // float32

  rosterIdx: number;          // uint16 — index into roster

  posX: number; posY: number; posZ: number;

  velX: number; velY: number; velZ: number;

  yaw: number; pitch: number;

  flags: number;              // uint8 — RemoteFrameFlags

}



// v5: optional embedded heightmap trailer — a coarse u8 grid sampled

// off the live field so the clip replays a shaped battlefield even when

// the map file no longer exists. See demoHmap.ts for encode/decode.

export interface DemoHeightmap {

  gridN: number;              // uint16 — samples per side (square)

  heightScale: number;        // float32 — field gain (spec.heightScale)

  worldScale: number;         // float32 — meters per tile wrap

  srcHash: number;            // uint32 — crc32 of the source field bytes

  data: Uint8Array;           // gridN² u8 heights (stride-1 Heightfield)

}



export interface DemoFile {

  header: DemoHeader;

  frames: DemoFrame[];

  projectileEvents: ProjectileEvent[];

  targetEvents: TargetEvent[];

  roster: DemoRosterEntry[];       // empty on v1/v2 files

  remoteFrames: RemoteFrame[];     // empty on v1/v2 files

  heightmap?: DemoHeightmap;       // absent unless the recorder saw terrain
  // v7 trailer: server-signed result receipt (SECTION_TOKEN) — the
  // leaderboard submission pairs demo+token in one file. Absent offline.
  matchToken?: ResultToken;
  // Seek checkpoints (SECTION_SNAP): ascending elapsed-time marks where
  // the recorder guarantees a bounded tail replay (see
  // _docs/2026-10-14_DEMO_SEEK_CHECKPOINTS.md). Absent on old files —
  // seek falls back to replay-from-0.
  snapshots?: number[];

}



export interface DemoClip {

  startTime: number;

  endTime: number;

  startFrameIndex: number;

  endFrameIndex: number;

  description: string;

}



// Helper to create a blank frame

export function createFrame(frameNumber: number, timestamp: number): DemoFrame {

  return {

    frameNumber, timestamp,

    posX: 0, posY: 0, posZ: 0,

    velX: 0, velY: 0, velZ: 0,

    yaw: 0, pitch: 0,

    inputFlags: 0, mouseDeltaX: 0, mouseDeltaY: 0,

    jetpackFlags: 0, jetpackFuel: 0, weaponType: 0,

  };

}



// Helper to create a default header

export function createHeader(): DemoHeader {

  return {

    magic: DEMO_MAGIC,

    formatVersion: DEMO_FORMAT_VERSION,

    gameVersion: '1.0.0',

    timestamp: Date.now(),

    duration: 0,

    totalFrames: 0,

    projectileEventCount: 0,

    targetEventCount: 0,

    checksum: 0,

    description: '',

    startPosX: 0, startPosY: 0, startPosZ: 0,

    startYaw: 0, startPitch: 0,

    startVelX: 0, startVelY: 0, startVelZ: 0,

    projectileLifetime: 0,

    room: '',

    mode: '',

    playerName: '',

    tableHash: 0,

    runSeed: 0,

  };

}

