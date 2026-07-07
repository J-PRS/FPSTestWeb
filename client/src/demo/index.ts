// Barrel export for the demo system

export { DemoManager } from './DemoManager.js';
export type { CoolShotEntry } from './DemoManager.js';
export { DemoRecorder } from './DemoRecorder.js';
export type { IProjectileEventRecorder, ITargetEventRecorder } from './DemoRecorder.js';
export { DemoSerializer } from './DemoSerializer.js';
export { DemoPlayer } from './DemoPlayer.js';
export type { PlaybackState, PlaybackCallbacks } from './DemoPlayer.js';
export { DemoUI } from './DemoUI.js';
export type { DemoUICallbacks } from './DemoUI.js';
export { CircularBuffer } from './CircularBuffer.js';
export type { IPlayerDataProvider, IInputProvider, IProjectileEventSource, ITargetEventSource, Vec3 } from './interfaces.js';
export type {
  DemoFrame, ProjectileEvent, TargetEvent, DemoHeader, DemoFile, DemoClip,
} from './types.js';
export {
  InputFlags, JetpackFlags, ProjectileEventType, TargetEventType,
  DEMO_MAGIC, DEMO_FORMAT_VERSION,
  createFrame, createHeader,
} from './types.js';
