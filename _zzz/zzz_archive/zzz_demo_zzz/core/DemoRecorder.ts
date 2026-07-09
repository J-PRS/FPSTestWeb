import * as THREE from 'three';
import { CircularBuffer } from './CircularBuffer.js';
import {
  DemoFrame,
  createDefaultDemoFrame,
  ProjectileEvent,
  createDefaultProjectileEvent,
  TargetEvent,
  createDefaultTargetEvent,
  DemoFile,
  createDefaultDemoFile,
  DemoClip,
} from '../types/index.js';
import {
  IPlayerDataProvider,
  IInputProvider,
  IProjectileEventSource,
  ITargetEventSource,
} from '../interfaces/index.js';
import { ProjectileEventType } from '../types/ProjectileEvent.js';
import { TargetEventType } from '../types/TargetEvent.js';

/**
 * Recording mode options.
 */
export enum RecordingMode {
  /**
   * Record every frame at variable framerate.
   * Simpler, adaptive to performance, interpolation smooths replay.
   * Recommended for highlight clips.
   */
  VariableFramerate,

  /**
   * Record at fixed tick rate (deterministic).
   * Independent of actual FPS, consistent timing.
   * Recommended for debugging/deterministic replay.
   */
  FixedTimestep,
}

/**
 * Main recording component for capturing gameplay events.
 * Uses continuous circular buffer recording with selective extraction.
 * Designed for minimal runtime overhead.
 * Minimally coupled to game systems via interfaces.
 */
export class DemoRecorder implements IProjectileEventSource, ITargetEventSource {
  // Recording settings
  private bufferDuration: number = 30; // Seconds of data to keep in buffer
  private recordingMode: RecordingMode = RecordingMode.VariableFramerate;
  private recordInputs: boolean = false;
  private autoRecord: boolean = true;
  private recordingTickRate: number = 60; // Fixed tick rate (only for FixedTimestep mode)
  private requireDataProviders: boolean = true;

  // Keyframe options
  private recordPeakPositions: boolean = false;

  // Limits
  private maxEventsPerSecond: number = 1000;
  private maxTotalEvents: number = 10000;

  // Debug
  private showDebugInfo: boolean = false;
  private logMissingProviders: boolean = true;

  // Circular buffers for continuous recording
  private frameBuffer: CircularBuffer<DemoFrame>;
  private projectileEvents: ProjectileEvent[] = [];
  private targetEvents: TargetEvent[] = [];

  // Recording state
  private isRecording: boolean = false;
  private recordingStartTime: number = 0;
  private fixedDeltaTime: number = 0;
  private accumulator: number = 0;
  private frameCount: number = 0;
  private projectileIdCounter: number = 0;
  private targetIdCounter: number = 0;
  private eventsThisSecond: number = 0;
  private lastSecondTime: number = 0;

  // Data providers (minimal coupling via interfaces)
  private playerDataProvider: IPlayerDataProvider | null = null;
  private inputProvider: IInputProvider | null = null;

  // Events for external systems to hook into
  private onProjectileEventCallbacks: ((event: ProjectileEvent) => void)[] = [];
  private onTargetEventCallbacks: ((event: TargetEvent) => void)[] = [];
  private onCoolHitDetectedCallbacks: ((clip: DemoClip) => void)[] = [];

  public static readonly CURRENT_FORMAT_VERSION = 1;

  constructor() {
    // Calculate buffer size based on duration and tick rate
    const bufferCapacity = Math.ceil(this.bufferDuration * this.recordingTickRate);
    this.frameBuffer = new CircularBuffer<DemoFrame>(bufferCapacity);

    // Setup fixed timestep
    this.fixedDeltaTime = 1 / this.recordingTickRate;
  }

  /**
   * Initialize data providers.
   * Call this after the game systems are loaded.
   */
  initialize(
    playerDataProvider: IPlayerDataProvider | null,
    inputProvider: IInputProvider | null
  ): void {
    this.playerDataProvider = playerDataProvider;
    this.inputProvider = inputProvider;

    // Validate data providers
    if (this.requireDataProviders) {
      if (this.playerDataProvider === null) {
        const msg = '[DemoRecorder] IPlayerDataProvider not provided. Recording will use default values.';
        if (this.logMissingProviders) {
          console.warn(msg);
        } else {
          console.error(msg);
        }
      }

      if (this.inputProvider === null) {
        const msg = '[DemoRecorder] IInputProvider not provided. Recording will use default values.';
        if (this.logMissingProviders) {
          console.warn(msg);
        } else {
          console.error(msg);
        }
      }
    }

    if (this.autoRecord) {
      this.startRecording();
    }
  }

  /**
   * Update the recorder. Call this every frame.
   * @param deltaTime - Time since last frame in seconds
   */
  update(deltaTime: number): void {
    if (!this.isRecording) {
      return;
    }

    // Recording mode selection
    if (this.recordingMode === RecordingMode.FixedTimestep) {
      // Fixed timestep recording for deterministic playback
      this.accumulator += deltaTime;

      while (this.accumulator >= this.fixedDeltaTime) {
        this.recordFrame();
        this.accumulator -= this.fixedDeltaTime;
      }
    } else {
      // Variable framerate recording - record every frame
      this.recordFrame();
    }

    // Reset event counter every second
    const currentTime = performance.now() / 1000;
    if (currentTime - this.lastSecondTime >= 1) {
      this.eventsThisSecond = 0;
      this.lastSecondTime = currentTime;
    }
  }

  /**
   * Start recording gameplay.
   */
  startRecording(): void {
    if (this.isRecording) {
      return;
    }

    this.isRecording = true;
    this.recordingStartTime = performance.now() / 1000;
    this.frameCount = 0;
    this.projectileIdCounter = 0;
    this.targetIdCounter = 0;
    this.accumulator = 0;
    this.eventsThisSecond = 0;
    this.lastSecondTime = performance.now() / 1000;

    this.frameBuffer.clear();
    this.projectileEvents = [];
    this.targetEvents = [];

    console.log('[DemoRecorder] Recording started');
  }

  /**
   * Stop recording gameplay.
   */
  stopRecording(): void {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    console.log(
      `[DemoRecorder] Recording stopped. Frames: ${this.frameCount}, Projectile events: ${this.projectileEvents.length}, Target events: ${this.targetEvents.length}`
    );
  }

  /**
   * Record current frame data.
   */
  private recordFrame(): void {
    // Check for frame counter overflow
    if (this.frameCount >= 65535) {
      console.warn('[DemoRecorder] Frame counter approaching overflow, wrapping around');
      this.frameCount = 0;
    }

    const frame: DemoFrame = {
      frameNumber: this.frameCount,
      timestamp: performance.now() / 1000 - this.recordingStartTime,
      position: this.playerDataProvider?.position.clone() ?? new THREE.Vector3(),
      velocity: this.playerDataProvider?.velocity.clone() ?? new THREE.Vector3(),
      rotation: this.playerDataProvider?.rotation.clone() ?? new THREE.Quaternion(),
      inputFlags: this.recordInputs ? this.captureInputFlags() : 0,
      mouseDeltaX: this.recordInputs ? this.captureMouseDeltaX() : 0,
      mouseDeltaY: this.recordInputs ? this.captureMouseDeltaY() : 0,
      jetpackFlags: this.recordInputs ? this.captureJetpackFlags() : 0,
      jetpackFuel: this.recordInputs ? this.captureJetpackFuel() : 0,
    };

    this.frameBuffer.add(frame);
    this.frameCount++;
  }

  /**
   * Capture input flags as bitmask using IInputProvider interface.
   */
  private captureInputFlags(): number {
    try {
      return this.inputProvider?.inputFlags ?? 0;
    } catch (e) {
      console.warn(`[DemoRecorder] Error capturing input flags: ${e}`);
      return 0;
    }
  }

  /**
   * Capture jetpack flags using IInputProvider interface.
   */
  private captureJetpackFlags(): number {
    try {
      return this.inputProvider?.jetpackFlags ?? 0;
    } catch (e) {
      console.warn(`[DemoRecorder] Error capturing jetpack flags: ${e}`);
      return 0;
    }
  }

  /**
   * Capture jetpack fuel using IInputProvider interface.
   */
  private captureJetpackFuel(): number {
    try {
      return Math.max(0, Math.min(1, this.inputProvider?.jetpackFuel ?? 0));
    } catch (e) {
      console.warn(`[DemoRecorder] Error capturing jetpack fuel: ${e}`);
      return 0;
    }
  }

  /**
   * Capture mouse delta X using IInputProvider interface.
   */
  private captureMouseDeltaX(): number {
    try {
      return Math.max(-32767, Math.min(32767, this.inputProvider?.mouseDeltaX ?? 0));
    } catch (e) {
      console.warn(`[DemoRecorder] Error capturing mouse delta X: ${e}`);
      return 0;
    }
  }

  /**
   * Capture mouse delta Y using IInputProvider interface.
   */
  private captureMouseDeltaY(): number {
    try {
      return Math.max(-32767, Math.min(32767, this.inputProvider?.mouseDeltaY ?? 0));
    } catch (e) {
      console.warn(`[DemoRecorder] Error capturing mouse delta Y: ${e}`);
      return 0;
    }
  }

  /**
   * Record a projectile event (fire, bounce, hit).
   * Called by projectile system.
   */
  private recordProjectileEvent(
    eventType: ProjectileEventType,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    weaponType: number,
    surfaceNormal: THREE.Vector3 = new THREE.Vector3(),
    targetId: number = 0
  ): void {
    if (!this.isRecording) {
      return;
    }

    // Rate limiting
    if (!this.checkEventRateLimit()) {
      return;
    }

    // Total event limit
    if (this.projectileEvents.length + this.targetEvents.length >= this.maxTotalEvents) {
      console.warn('[DemoRecorder] Max total events reached, dropping projectile event');
      return;
    }

    const evt: ProjectileEvent = {
      eventType,
      timestamp: performance.now() / 1000 - this.recordingStartTime,
      position: position.clone(),
      velocity: velocity.clone(),
      projectileId: this.projectileIdCounter++,
      weaponType,
      surfaceNormal: surfaceNormal.clone(),
      targetId,
      hasPeakPosition: false,
      peakPosition: new THREE.Vector3(),
    };

    this.projectileEvents.push(evt);
    this.eventsThisSecond++;

    // Notify callbacks
    for (const callback of this.onProjectileEventCallbacks) {
      callback(evt);
    }

    // Check if this is a cool hit
    if (eventType === ProjectileEventType.Hit) {
      this.checkForCoolHit(evt);
    }
  }

  /**
   * Record projectile peak position (velocity.y sign change).
   * Optional enhancement for precision.
   */
  recordProjectilePeak(projectileId: number, peakPosition: THREE.Vector3): void {
    if (!this.isRecording || !this.recordPeakPositions) {
      return;
    }

    // Find the most recent event for this projectile and update it
    for (let i = this.projectileEvents.length - 1; i >= 0; i--) {
      if (this.projectileEvents[i].projectileId === projectileId) {
        const evt = this.projectileEvents[i];
        evt.hasPeakPosition = true;
        evt.peakPosition = peakPosition.clone();
        this.projectileEvents[i] = evt;
        break;
      }
    }
  }

  /**
   * Check event rate limit to prevent event spam.
   */
  private checkEventRateLimit(): boolean {
    if (this.eventsThisSecond >= this.maxEventsPerSecond) {
      if (Math.floor(performance.now() / 1000) % 60 === 0) {
        // Log once per second
        console.warn(`[DemoRecorder] Event rate limit reached (${this.maxEventsPerSecond}/s), dropping events`);
      }
      return false;
    }
    return true;
  }

  // IProjectileEventSource implementation
  recordProjectileFired(position: THREE.Vector3, velocity: THREE.Vector3, weaponType: number): void {
    this.recordProjectileEvent(ProjectileEventType.Fired, position, velocity, weaponType);
  }

  recordProjectileBounce(
    projectileId: number,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    surfaceNormal: THREE.Vector3
  ): void {
    this.recordProjectileEvent(ProjectileEventType.Bounce, position, velocity, 0, surfaceNormal);
  }

  recordProjectileHit(projectileId: number, position: THREE.Vector3, targetId: number): void {
    this.recordProjectileEvent(ProjectileEventType.Hit, position, new THREE.Vector3(), 0, new THREE.Vector3(), targetId);
  }

  recordProjectileDestroyed(projectileId: number, position: THREE.Vector3): void {
    this.recordProjectileEvent(ProjectileEventType.Destroyed, position, new THREE.Vector3(), 0);
  }

  /**
   * Record a target/ball event.
   * Called by target system.
   */
  private recordTargetEvent(
    eventType: TargetEventType,
    position: THREE.Vector3,
    velocity: THREE.Vector3
  ): void {
    if (!this.isRecording) {
      return;
    }

    // Rate limiting
    if (!this.checkEventRateLimit()) {
      return;
    }

    // Total event limit
    if (this.projectileEvents.length + this.targetEvents.length >= this.maxTotalEvents) {
      console.warn('[DemoRecorder] Max total events reached, dropping target event');
      return;
    }

    // Validate position/velocity (prevent NaN/Infinity)
    if (!this.isValidVector3(position) || !this.isValidVector3(velocity)) {
      console.warn('[DemoRecorder] Invalid position/velocity in target event, skipping');
      return;
    }

    const evt: TargetEvent = {
      eventType,
      timestamp: performance.now() / 1000 - this.recordingStartTime,
      position: position.clone(),
      velocity: velocity.clone(),
      targetId: this.targetIdCounter++,
      targetType: 0, // TODO: Get from target system
      health: 1.0, // TODO: Get from target system
      hasPeakPosition: false,
      peakPosition: new THREE.Vector3(),
    };

    this.targetEvents.push(evt);
    this.eventsThisSecond++;

    // Notify callbacks
    for (const callback of this.onTargetEventCallbacks) {
      callback(evt);
    }
  }

  /**
   * Record target peak position (velocity.y sign change).
   * Optional enhancement for precision.
   */
  recordTargetPeak(targetId: number, peakPosition: THREE.Vector3): void {
    if (!this.isRecording || !this.recordPeakPositions) {
      return;
    }

    // Find the most recent event for this target and update it
    for (let i = this.targetEvents.length - 1; i >= 0; i--) {
      if (this.targetEvents[i].targetId === targetId) {
        const evt = this.targetEvents[i];
        evt.hasPeakPosition = true;
        evt.peakPosition = peakPosition.clone();
        this.targetEvents[i] = evt;
        break;
      }
    }
  }

  /**
   * Validate Vector3 for NaN/Infinity.
   */
  private isValidVector3(v: THREE.Vector3): boolean {
    return (
      !isNaN(v.x) &&
      !isNaN(v.y) &&
      !isNaN(v.z) &&
      !isFinite(v.x) &&
      !isFinite(v.y) &&
      !isFinite(v.z)
    );
  }

  // ITargetEventSource implementation
  recordTargetSpawned(
    targetId: number,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    targetType: number
  ): void {
    this.recordTargetEvent(TargetEventType.Spawned, position, velocity);
  }

  recordTargetBounce(targetId: number, position: THREE.Vector3, velocity: THREE.Vector3): void {
    this.recordTargetEvent(TargetEventType.Bounce, position, velocity);
  }

  recordTargetHit(targetId: number, position: THREE.Vector3, health: number): void {
    this.recordTargetEvent(TargetEventType.Hit, position, new THREE.Vector3());
  }

  recordTargetDestroyed(targetId: number, position: THREE.Vector3): void {
    this.recordTargetEvent(TargetEventType.Destroyed, position, new THREE.Vector3());
  }

  recordTargetStateChanged(targetId: number, newState: number): void {
    this.recordTargetEvent(TargetEventType.StateChanged, new THREE.Vector3(), new THREE.Vector3());
  }

  /**
   * Check if a hit qualifies as a "cool shot" worthy of extraction.
   */
  private checkForCoolHit(hitEvent: ProjectileEvent): void {
    // TODO: Implement cool hit detection logic
    // Criteria could include:
    // - Long distance shot
    // - High velocity hit
    // - Prediction shot (leading target)
    // - Multiple bounces before hit
    // - Moving target hit

    // For MVP, extract all hits for now
    this.extractClipAroundEvent(hitEvent.timestamp, 2, 2, 'Hit');
  }

  /**
   * Extract a clip segment around a specific event.
   * @param eventTimestamp - Timestamp of the event
   * @param secondsBefore - Seconds before event to include
   * @param secondsAfter - Seconds after event to include
   * @param description - Clip description
   */
  extractClipAroundEvent(
    eventTimestamp: number,
    secondsBefore: number,
    secondsAfter: number,
    description: string
  ): void {
    const startTime = eventTimestamp - secondsBefore;
    const endTime = eventTimestamp + secondsAfter;

    // Find frame indices
    const startIndex = this.frameBuffer.findIndexAfterTimestamp(startTime, (f) => f.timestamp);
    const endIndex = this.frameBuffer.findIndexAfterTimestamp(endTime, (f) => f.timestamp);

    const clip: DemoClip = {
      startTime,
      endTime,
      startFrameIndex: startIndex === -1 ? 0 : startIndex,
      endFrameIndex: endIndex === -1 ? this.frameBuffer.getCount() - 1 : endIndex,
      description,
    };

    // Notify callbacks
    for (const callback of this.onCoolHitDetectedCallbacks) {
      callback(clip);
    }

    console.log(
      `[DemoRecorder] Extracted clip: ${description} (${endTime - startTime}s, ${clip.endFrameIndex - clip.startFrameIndex + 1} frames)`
    );
  }

  /**
   * Extract all recorded data as a DemoFile.
   */
  extractDemoFile(): DemoFile {
    const startPos = this.playerDataProvider?.position.clone() ?? new THREE.Vector3();
    const startRot = this.playerDataProvider?.rotation.clone() ?? new THREE.Quaternion();
    const startVel = this.playerDataProvider?.velocity.clone() ?? new THREE.Vector3();

    const demoFile: DemoFile = {
      header: {
        formatVersion: DemoRecorder.CURRENT_FORMAT_VERSION,
        gameVersion: '1.0.0', // TODO: Get from game config
        duration: performance.now() / 1000 - this.recordingStartTime,
        totalFrames: this.frameBuffer.getCount(),
        projectileEvents: this.projectileEvents.length,
        targetEvents: this.targetEvents.length,
        playerStartPosition: startPos,
        playerStartRotation: startRot,
        playerStartVelocity: startVel,
        description: 'Full session recording',
        checksum: 0, // TODO: Calculate checksum
        timestamp: Date.now(),
      },
      frames: this.frameBuffer.extractAll(),
      projectileEvents: [...this.projectileEvents],
      targetEvents: [...this.targetEvents],
      playerStartPosition: startPos,
      playerStartRotation: startRot,
      playerStartVelocity: startVel,
    };

    return demoFile;
  }

  /**
   * Extract a clip as a DemoFile.
   */
  extractClipAsDemoFile(clip: DemoClip): DemoFile {
    const demoFile: DemoFile = {
      header: {
        formatVersion: DemoRecorder.CURRENT_FORMAT_VERSION,
        gameVersion: '1.0.0',
        duration: clip.endTime - clip.startTime,
        totalFrames: clip.endFrameIndex - clip.startFrameIndex + 1,
        projectileEvents: 0, // TODO: Filter events within clip range
        targetEvents: 0,
        playerStartPosition: new THREE.Vector3(),
        playerStartRotation: new THREE.Quaternion(),
        playerStartVelocity: new THREE.Vector3(),
        description: clip.description,
        checksum: 0,
        timestamp: Date.now(),
      },
      frames: this.frameBuffer.extractRange(clip.startFrameIndex, clip.endFrameIndex - clip.startFrameIndex + 1),
      projectileEvents: [], // TODO: Filter events
      targetEvents: [],
      playerStartPosition: new THREE.Vector3(),
      playerStartRotation: new THREE.Quaternion(),
      playerStartVelocity: new THREE.Vector3(),
    };

    return demoFile;
  }

  // Getters
  getIsRecording(): boolean {
    return this.isRecording;
  }

  getRecordingTime(): number {
    return performance.now() / 1000 - this.recordingStartTime;
  }

  getFrameCount(): number {
    return this.frameCount;
  }

  getBufferFrameCount(): number {
    return this.frameBuffer.getCount();
  }

  // Event subscription
  onProjectileEvent(callback: (event: ProjectileEvent) => void): void {
    this.onProjectileEventCallbacks.push(callback);
  }

  onTargetEvent(callback: (event: TargetEvent) => void): void {
    this.onTargetEventCallbacks.push(callback);
  }

  onCoolHitDetected(callback: (clip: DemoClip) => void): void {
    this.onCoolHitDetectedCallbacks.push(callback);
  }

  // Configuration setters
  setBufferDuration(duration: number): void {
    this.bufferDuration = duration;
    const bufferCapacity = Math.ceil(duration * this.recordingTickRate);
    this.frameBuffer = new CircularBuffer<DemoFrame>(bufferCapacity);
  }

  setRecordingMode(mode: RecordingMode): void {
    this.recordingMode = mode;
  }

  setRecordInputs(record: boolean): void {
    this.recordInputs = record;
  }

  setAutoRecord(auto: boolean): void {
    this.autoRecord = auto;
  }

  setRecordingTickRate(rate: number): void {
    this.recordingTickRate = rate;
    this.fixedDeltaTime = 1 / rate;
    const bufferCapacity = Math.ceil(this.bufferDuration * rate);
    this.frameBuffer = new CircularBuffer<DemoFrame>(bufferCapacity);
  }

  setRecordPeakPositions(record: boolean): void {
    this.recordPeakPositions = record;
  }

  setMaxEventsPerSecond(max: number): void {
    this.maxEventsPerSecond = max;
  }

  setMaxTotalEvents(max: number): void {
    this.maxTotalEvents = max;
  }

  setShowDebugInfo(show: boolean): void {
    this.showDebugInfo = show;
  }

  setLogMissingProviders(log: boolean): void {
    this.logMissingProviders = log;
  }
}
