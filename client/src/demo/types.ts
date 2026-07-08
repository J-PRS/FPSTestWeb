// Demo system data types - binary-efficient structures for recording/replay

export const DEMO_MAGIC = 0x44; // 'D'
export const DEMO_FORMAT_VERSION = 2;

// Input flag bitmasks
export const InputFlags = {
  None: 0,
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

// Flat frame structure for efficient recording (~44 bytes)
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
  hasPeakPosition: boolean;
  peakPosX: number; peakPosY: number; peakPosZ: number;
}

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
}

export interface DemoFile {
  header: DemoHeader;
  frames: DemoFrame[];
  projectileEvents: ProjectileEvent[];
  targetEvents: TargetEvent[];
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
    jetpackFlags: 0, jetpackFuel: 0,
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
  };
}
