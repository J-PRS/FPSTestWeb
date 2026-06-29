import * as THREE from 'three';
import { DemoFile } from '../types/DemoFile.js';
import { DemoFrame } from '../types/DemoFrame.js';
import { GhostManager } from './GhostManager.js';
import { Interpolator, InterpolationMode } from './Interpolator.js';

/**
 * Playback state.
 */
export enum PlaybackState {
  Stopped,
  Playing,
  Paused,
}

/**
 * Demo player for replaying recorded gameplay.
 * Handles playback controls, interpolation, and ghost object management.
 */
export class DemoPlayer {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private demoFile: DemoFile | null = null;
  private ghostManager: GhostManager;
  private playbackState: PlaybackState = PlaybackState.Stopped;
  private playbackTime: number = 0;
  private playbackSpeed: number = 1.0;
  private loopPlayback: boolean = false;
  private interpolationMode: InterpolationMode = InterpolationMode.Linear;
  private gravity: number = -20.0;

  // Ghost objects
  private playerGhostId: string = 'player';
  private freeCamera: THREE.PerspectiveCamera | null = null;
  private useFreeCamera: boolean = false;

  // Events
  private onPlaybackStartedCallbacks: (() => void)[] = [];
  private onPlaybackStoppedCallbacks: (() => void)[] = [];
  private onPlaybackPausedCallbacks: (() => void)[] = [];
  private onPlaybackResumedCallbacks: (() => void)[] = [];
  private onPlaybackTimeChangedCallbacks: ((time: number) => void)[] = [];

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
    this.ghostManager = new GhostManager(scene);
  }

  /**
   * Load a demo file for playback.
   */
  loadDemo(demo: DemoFile): void {
    this.stop();
    this.demoFile = demo;
    this.playbackTime = 0;
    console.log(`[DemoPlayer] Loaded demo: ${demo.header.description} (${demo.header.duration}s)`);
  }

  /**
   * Start playback.
   */
  play(): void {
    if (!this.demoFile) {
      console.warn('[DemoPlayer] No demo loaded');
      return;
    }

    if (this.playbackState === PlaybackState.Playing) {
      return;
    }

    this.playbackState = PlaybackState.Playing;

    // Setup replay scene
    this.setupReplayScene();

    // Notify callbacks
    for (const callback of this.onPlaybackStartedCallbacks) {
      callback();
    }

    console.log('[DemoPlayer] Playback started');
  }

  /**
   * Pause playback.
   */
  pause(): void {
    if (this.playbackState !== PlaybackState.Playing) {
      return;
    }

    this.playbackState = PlaybackState.Paused;

    // Notify callbacks
    for (const callback of this.onPlaybackPausedCallbacks) {
      callback();
    }

    console.log('[DemoPlayer] Playback paused');
  }

  /**
   * Resume playback.
   */
  resume(): void {
    if (this.playbackState !== PlaybackState.Paused) {
      return;
    }

    this.playbackState = PlaybackState.Playing;

    // Notify callbacks
    for (const callback of this.onPlaybackResumedCallbacks) {
      callback();
    }

    console.log('[DemoPlayer] Playback resumed');
  }

  /**
   * Stop playback.
   */
  stop(): void {
    if (this.playbackState === PlaybackState.Stopped) {
      return;
    }

    this.playbackState = PlaybackState.Stopped;
    this.playbackTime = 0;

    // Cleanup replay scene
    this.cleanupReplayScene();

    // Notify callbacks
    for (const callback of this.onPlaybackStoppedCallbacks) {
      callback();
    }

    console.log('[DemoPlayer] Playback stopped');
  }

  /**
   * Seek to a specific time.
   */
  seek(time: number): void {
    if (!this.demoFile) {
      return;
    }

    this.playbackTime = Math.max(0, Math.min(time, this.demoFile.header.duration));
    this.updatePlayback();

    // Notify callbacks
    for (const callback of this.onPlaybackTimeChangedCallbacks) {
      callback(this.playbackTime);
    }
  }

  /**
   * Update playback. Call this every frame.
   * @param deltaTime - Time since last frame in seconds
   */
  update(deltaTime: number): void {
    if (this.playbackState !== PlaybackState.Playing || !this.demoFile) {
      return;
    }

    // Advance playback time
    this.playbackTime += deltaTime * this.playbackSpeed;

    // Check for end of demo
    if (this.playbackTime >= this.demoFile.header.duration) {
      if (this.loopPlayback) {
        this.playbackTime = 0;
      } else {
        this.stop();
        return;
      }
    }

    this.updatePlayback();

    // Notify callbacks
    for (const callback of this.onPlaybackTimeChangedCallbacks) {
      callback(this.playbackTime);
    }
  }

  /**
   * Update playback state (apply frames to ghosts).
   */
  private updatePlayback(): void {
    if (!this.demoFile) {
      return;
    }

    // Find frame at current time
    const frame = this.findFrameAtTime(this.playbackTime);

    if (frame) {
      // Update player ghost
      this.ghostManager.updateGhostFromFrame(this.playerGhostId, frame);
    }
  }

  /**
   * Find the frame at a specific time using binary search.
   */
  private findFrameAtTime(time: number): DemoFrame | null {
    if (!this.demoFile || this.demoFile.frames.length === 0) {
      return null;
    }

    const frames = this.demoFile.frames;

    // Binary search
    let left = 0;
    let right = frames.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const frame = frames[mid];

      if (frame.timestamp === time) {
        return frame;
      } else if (frame.timestamp < time) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    // Return the closest frame
    if (left >= frames.length) {
      return frames[frames.length - 1];
    }
    if (right < 0) {
      return frames[0];
    }

    // Return the frame with the closest timestamp
    const leftFrame = frames[left];
    const rightFrame = frames[right];

    if (Math.abs(leftFrame.timestamp - time) < Math.abs(rightFrame.timestamp - time)) {
      return leftFrame;
    } else {
      return rightFrame;
    }
  }

  /**
   * Setup replay scene (create ghosts, free camera).
   */
  private setupReplayScene(): void {
    if (!this.demoFile) {
      return;
    }

    // Create player ghost
    this.ghostManager.createGhost(this.playerGhostId);

    // Set initial state
    const initialFrame = this.demoFile.frames[0];
    if (initialFrame) {
      this.ghostManager.updateGhostFromFrame(this.playerGhostId, initialFrame);
    }

    // Create free camera (optional)
    if (this.useFreeCamera) {
      this.freeCamera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
      );
      this.freeCamera.position.copy(this.demoFile.playerStartPosition);
      this.freeCamera.position.y += 2; // Offset for eye level
    }
  }

  /**
   * Cleanup replay scene (destroy ghosts, free camera).
   */
  private cleanupReplayScene(): void {
    this.ghostManager.removeAllGhosts();
    this.freeCamera = null;
  }

  /**
   * Get the current playback state.
   */
  getPlaybackState(): PlaybackState {
    return this.playbackState;
  }

  /**
   * Get the current playback time.
   */
  getPlaybackTime(): number {
    return this.playbackTime;
  }

  /**
   * Get the demo duration.
   */
  getDuration(): number {
    return this.demoFile?.header.duration ?? 0;
  }

  /**
   * Get the playback progress (0-1).
   */
  getProgress(): number {
    if (!this.demoFile || this.demoFile.header.duration === 0) {
      return 0;
    }
    return this.playbackTime / this.demoFile.header.duration;
  }

  /**
   * Get the ghost manager.
   */
  getGhostManager(): GhostManager {
    return this.ghostManager;
  }

  /**
   * Get the free camera (if enabled).
   */
  getFreeCamera(): THREE.PerspectiveCamera | null {
    return this.freeCamera;
  }

  // Configuration setters
  setPlaybackSpeed(speed: number): void {
    this.playbackSpeed = Math.max(0.1, Math.min(10, speed));
  }

  setLoopPlayback(loop: boolean): void {
    this.loopPlayback = loop;
  }

  setInterpolationMode(mode: InterpolationMode): void {
    this.interpolationMode = mode;
    this.ghostManager.setInterpolationMode(mode);
  }

  setGravity(gravity: number): void {
    this.gravity = gravity;
    this.ghostManager.setGravity(gravity);
  }

  setUseFreeCamera(use: boolean): void {
    this.useFreeCamera = use;
  }

  // Event subscription
  onPlaybackStarted(callback: () => void): void {
    this.onPlaybackStartedCallbacks.push(callback);
  }

  onPlaybackStopped(callback: () => void): void {
    this.onPlaybackStoppedCallbacks.push(callback);
  }

  onPlaybackPaused(callback: () => void): void {
    this.onPlaybackPausedCallbacks.push(callback);
  }

  onPlaybackResumed(callback: () => void): void {
    this.onPlaybackResumedCallbacks.push(callback);
  }

  onPlaybackTimeChanged(callback: (time: number) => void): void {
    this.onPlaybackTimeChangedCallbacks.push(callback);
  }
}
