// Demo manager - orchestrates recording, playback, and file I/O.
// Single entry point for the game to interact with the demo system.

import { DemoRecorder } from './DemoRecorder.js';
import type { DemoFileData } from './DemoRecorder.js';
import { DemoSerializer } from './DemoSerializer.js';
import { DemoPlayer } from './DemoPlayer.js';
import type { PlaybackState } from './DemoPlayer.js';
import { DemoUI } from './DemoUI.js';
import type { IPlayerDataProvider, IInputProvider, Vec3 } from './interfaces.js';
import { InputFlags, JetpackFlags } from './types.js';

export interface CoolShotEntry {
  id: string;
  filename?: string; // server-side filename
  projectileLifetime: number;
  timestamp: number;
  description: string;
  clipData?: DemoFileData; // only set for locally-generated clips
}

export class DemoManager {
  private recorder: DemoRecorder;
  private player: DemoPlayer;
  private ui: DemoUI;

  private playerData: IPlayerDataProvider | null = null;
  private inputData: IInputProvider | null = null;

  private mode: 'idle' | 'recording' | 'playing' = 'idle';
  private uiVisible = false;

  // Stored cool shots, sorted by lifetime descending
  private coolShots: CoolShotEntry[] = [];
  private static MAX_COOL_SHOTS = 10;

  // Server URL for demo upload/list/download
  private serverUrl: string = '';

  // Callback when cool shots list changes
  onCoolShotsChanged?: (shots: CoolShotEntry[]) => void;

  // Callbacks for the game to render replay state
  onPlaybackState?: (state: PlaybackState) => void;
  onPlaybackEvent?: (events: { projectiles: any[], targets: any[] }) => void;
  onPlaybackEnd?: () => void;
  onPlaybackSeek?: () => void;

  constructor() {
    this.recorder = new DemoRecorder();
    this.player = new DemoPlayer();
    this.ui = new DemoUI();

    this.setupUI();
    this.setupPlayerCallbacks();
  }

  private setupPlayerCallbacks(): void {
    this.player.setCallbacks({
      onFrameUpdate: (state, events) => {
        this.onPlaybackState?.(state);
        this.onPlaybackEvent?.(events);
      },
      onPlaybackEnd: () => {
        this.mode = 'idle';
        this.ui.setPlaying(false);
        this.onPlaybackEnd?.();
      },
      onTimeUpdate: (current, duration) => {
        this.ui.setTime(current, duration);
      },
      onSeek: () => {
        this.onPlaybackSeek?.();
      },
    });
  }

  private setupUI(): void {
    this.ui.setCallbacks({
      onPlayPause: () => {
        if (this.mode === 'playing') {
          this.player.pause();
          this.mode = 'idle';
          this.ui.setPlaying(false);
        } else if (this.player.isLoaded) {
          this.player.play();
          this.mode = 'playing';
          this.ui.setPlaying(true);
        }
      },
      onSeek: (time: number) => {
        this.player.seek(time);
      },
      onSpeedChange: (speed: number) => {
        this.player.setSpeed(speed);
      },
      onLoop: (loop: boolean) => {
        this.player.setLoop(loop);
        this.ui.setLoopActive(loop);
      },
      onStop: () => {
        this.player.stop();
        this.mode = 'idle';
        this.ui.setPlaying(false);
        this.onPlaybackEnd?.();
      },
      onSave: () => {
        this.saveDemo();
      },
      onLoad: (file: File) => {
        this.loadDemo(file);
      },
      onRecordToggle: () => {
        if (this.mode === 'recording') {
          this.stopRecording();
        } else {
          this.startRecording();
        }
      },
    });
  }

  // Set data providers for recording
  setDataProviders(playerData: IPlayerDataProvider, inputData: IInputProvider): void {
    this.playerData = playerData;
    this.inputData = inputData;
  }

  // Show/hide the demo UI
  showUI(): void {
    this.uiVisible = true;
    this.ui.show();
  }

  hideUI(): void {
    this.uiVisible = false;
    this.ui.hide();
  }

  get isUIVisible(): boolean { return this.uiVisible; }

  get isRecording(): boolean { return this.mode === 'recording'; }
  get isPlaying(): boolean { return this.mode === 'playing'; }
  get isLoadedForPlayback(): boolean { return this.mode !== 'recording' && this.player.isLoaded; }

  // Recording control
  startRecording(): void {
    if (!this.playerData || !this.inputData) {
      console.warn('[Demo] Cannot start recording: data providers not set');
      return;
    }
    if (this.mode === 'playing') {
      this.player.stop();
      this.mode = 'idle';
    }
    this.recorder.start(this.playerData, this.inputData);
    this.mode = 'recording';
    this.ui.setRecording(true);
    this.ui.setStatus('REC');
  }

  stopRecording(): void {
    this.recorder.stop();
    this.mode = 'idle';
    this.ui.setRecording(false);
    this.ui.setStatus('');
  }

  stopPlayback(): void {
    this.player.stop();
    this.mode = 'idle';
    this.ui.setPlaying(false);
    this.onPlaybackEnd?.();
  }

  // Toggle play/pause (used by keyboard shortcut)
  togglePlayPause(): void {
    if (this.mode === 'playing') {
      this.player.pause();
      this.mode = 'idle';
      this.ui.setPlaying(false);
    } else if (this.player.isLoaded) {
      this.player.play();
      this.mode = 'playing';
      this.ui.setPlaying(true);
    }
  }

  // Save current recording to file
  saveDemo(): void {
    if (this.recorder.frameCount === 0) {
      console.warn('[Demo] No frames to save');
      return;
    }
    const data = this.recorder.buildDemoFile();
    this.downloadDemoFile(data, `demo_${this.timestampStr()}.demo`);
  }

  // Auto-clip: called when a projectile hits something.
  // If projectileLifetime > minLifetime, schedules a clip extraction
  // bufferAfter seconds after the hit so post-hit footage is captured.
  autoClipOnHit(projectileLifetime: number, minLifetime: number = 0.1, bufferBefore: number = 5.0, bufferAfter: number = 5.0): void {
    if (this.mode !== 'recording') return;
    if (projectileLifetime < minLifetime) return;

    const hitTime = this.recorder.duration;
    const shotTime = hitTime - projectileLifetime;
    const clipStart = shotTime - bufferBefore;
    const clipEnd = hitTime + bufferAfter;

    const totalClipDuration = projectileLifetime + bufferBefore + bufferAfter;
    const desc = `Cool shot (${projectileLifetime.toFixed(2)}s air, ${totalClipDuration.toFixed(1)}s clip)`;

    // Defer extraction until bufferAfter seconds have elapsed so post-hit footage is in the buffer
    this.pendingClips.push({
      extractAt: hitTime + bufferAfter,
      clipStart,
      clipEnd,
      projectileLifetime,
      description: desc,
    });
  }

  private pendingClips: { extractAt: number; clipStart: number; clipEnd: number; projectileLifetime: number; description: string }[] = [];

  private processPendingClips(): void {
    if (this.pendingClips.length === 0) return;
    const now = this.recorder.duration;
    for (let i = this.pendingClips.length - 1; i >= 0; i--) {
      const pending = this.pendingClips[i];
      if (now < pending.extractAt) continue;

      // Time to extract
      this.pendingClips.splice(i, 1);
      const clipData = this.recorder.extractClip(pending.clipStart, pending.clipEnd, pending.description);
      if (!clipData) {
        console.warn('[Demo] Auto-clip: not enough buffer for this clip');
        continue;
      }

      const filename = `clip_${this.timestampStr()}_${pending.projectileLifetime.toFixed(1)}s.demo`;
      this.uploadClipToServer(clipData, pending.projectileLifetime);

      const entry: CoolShotEntry = {
        id: `clip_${Date.now()}_${pending.projectileLifetime.toFixed(1)}`,
        filename,
        projectileLifetime: pending.projectileLifetime,
        timestamp: Date.now(),
        description: pending.description,
        clipData,
      };
      this.coolShots.push(entry);
      this.coolShots.sort((a, b) => b.projectileLifetime - a.projectileLifetime);
      if (this.coolShots.length > DemoManager.MAX_COOL_SHOTS) {
        this.coolShots = this.coolShots.slice(0, DemoManager.MAX_COOL_SHOTS);
      }
      this.onCoolShotsChanged?.(this.coolShots);

      console.log(`[Demo] Auto-saved cool hit clip: ${filename} (proj lifetime ${pending.projectileLifetime.toFixed(2)}s)`);
      this.ui.setStatus(`Clip saved! ${pending.projectileLifetime.toFixed(1)}s air`);
    }
  }

  getCoolShots(): CoolShotEntry[] {
    return this.coolShots;
  }

  // Play a cool shot clip by index
  playCoolShot(index: number): void {
    if (index < 0 || index >= this.coolShots.length) return;
    const entry = this.coolShots[index];

    if (entry.clipData) {
      // Play from local memory
      this.player.load(entry.clipData);
      this.mode = 'playing';
      this.player.play();
      this.ui.setPlaying(true);
      this.ui.show();
      this.uiVisible = true;
      this.ui.setTime(0, entry.clipData.header.duration);
      console.log(`[Demo] Playing cool shot: ${entry.description}`);
    } else if (entry.filename) {
      // Download from server then play
      this.playFromServer(entry.filename);
    }
  }

  private downloadDemoFile(data: DemoFileData, filename: string): void {
    const blob = DemoSerializer.toBlob(data);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private timestampStr(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  }

  // Set the server base URL for demo upload/list/download
  setServerUrl(url: string): void {
    this.serverUrl = url.replace(/\/$/, '');
  }

  // Upload clip binary to server
  private async uploadClipToServer(clipData: DemoFileData, projectileLifetime: number): Promise<void> {
    if (!this.serverUrl) {
      console.warn('[Demo] No server URL set, skipping upload');
      return;
    }
    try {
      const buffer = DemoSerializer.serialize(clipData);
      const resp = await fetch(`${this.serverUrl}/demos/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });
      if (!resp.ok) {
        console.warn('[Demo] Server upload failed:', resp.status);
        return;
      }
      const result = await resp.json();
      console.log(`[Demo] Clip uploaded to server: ${result.filename}`);
    } catch (e) {
      console.warn('[Demo] Failed to upload clip:', e);
    }
  }

  // Fetch cool shots list from server and merge with local
  async fetchCoolShotsFromServer(): Promise<void> {
    if (!this.serverUrl) return;
    try {
      const resp = await fetch(`${this.serverUrl}/demos`);
      if (!resp.ok) return;
      const data = await resp.json();
      const serverDemos: CoolShotEntry[] = (data.demos || []).map((d: any) => ({
        id: d.filename,
        filename: d.filename,
        projectileLifetime: d.projectileLifetime,
        timestamp: d.timestamp,
        description: d.description,
      }));

      // Merge: server demos that aren't already in local list (by filename)
      const localFilenames = new Set(this.coolShots.map(s => s.filename));
      for (const sd of serverDemos) {
        if (!localFilenames.has(sd.filename)) {
          this.coolShots.push(sd);
        }
      }
      this.coolShots.sort((a, b) => b.projectileLifetime - a.projectileLifetime);
      this.coolShots = this.coolShots.slice(0, DemoManager.MAX_COOL_SHOTS);
      this.onCoolShotsChanged?.(this.coolShots);
    } catch (e) {
      console.warn('[Demo] Failed to fetch cool shots from server:', e);
    }
  }

  // Download a demo from server and play it
  private async playFromServer(filename: string): Promise<void> {
    if (!this.serverUrl) {
      console.warn('[Demo] No server URL set');
      return;
    }
    try {
      this.ui.setStatus('Loading clip...');
      const resp = await fetch(`${this.serverUrl}/demos/${filename}`);
      if (!resp.ok) {
        console.warn('[Demo] Failed to download clip:', resp.status);
        this.ui.setStatus('Load failed');
        return;
      }
      const buffer = await resp.arrayBuffer();
      const data = DemoSerializer.deserialize(buffer);
      this.player.load(data);
      this.mode = 'playing';
      this.player.play();
      this.ui.setPlaying(true);
      this.ui.show();
      this.uiVisible = true;
      this.ui.setTime(0, data.header.duration);
      this.ui.setStatus('');
      console.log(`[Demo] Playing cool shot from server: ${filename}`);
    } catch (e) {
      console.warn('[Demo] Failed to play from server:', e);
      this.ui.setStatus('Playback failed');
    }
  }

  // Load demo from file
  async loadDemo(file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      const data = DemoSerializer.deserialize(buffer);
      this.player.load(data);
      this.mode = 'idle';
      this.ui.setPlaying(false);
      this.ui.setTime(0, data.header.duration);
      this.ui.setStatus(`Loaded: ${data.frames.length} frames, ${data.header.duration.toFixed(1)}s`);
    } catch (e) {
      console.error('[Demo] Failed to load demo:', e);
      this.ui.setStatus(`Load error: ${(e as Error).message}`);
    }
  }

  // Load demo from ArrayBuffer (for programmatic loading)
  loadDemoFromBuffer(buffer: ArrayBuffer): void {
    const data = DemoSerializer.deserialize(buffer);
    this.player.load(data);
    this.mode = 'idle';
    this.ui.setPlaying(false);
    this.ui.setTime(0, data.header.duration);
  }

  // Called every game frame
  update(dt: number): void {
    if (this.mode === 'recording') {
      this.recorder.update(dt);
      this.processPendingClips();
    } else if (this.mode === 'playing') {
      this.player.update(dt);
      this.player.postUpdate();
      this.ui.setTime(this.player.currentTimeValue, this.player.duration);
    }
  }

  // Recording event hooks - called by game systems
  recordProjectileFired(position: Vec3, velocity: Vec3, weaponType: number): number {
    return this.recorder.recordFired(position, velocity, weaponType);
  }

  recordProjectileBounce(projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void {
    this.recorder.recordBounce(projectileId, position, velocity, surfaceNormal);
  }

  recordProjectileHit(projectileId: number, position: Vec3, targetId: number): void {
    this.recorder.recordHit(projectileId, position, targetId);
  }

  recordProjectileDestroyed(projectileId: number, position: Vec3): void {
    this.recorder.recordDestroyed(projectileId, position);
  }

  recordTargetSpawned(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    this.recorder.recordTargetSpawned(targetId, position, velocity, targetType);
  }

  recordTargetHit(targetId: number, position: Vec3, health: number): void {
    this.recorder.recordTargetHit(targetId, position, health);
  }

  recordTargetDestroyed(targetId: number, position: Vec3): void {
    this.recorder.recordTargetDestroyed(targetId, position);
  }

  // Mouse delta accumulation for recording
  recordMouseDelta(dx: number, dy: number): void {
    // The recorder accumulates this internally if recording
    // We expose it via the input provider pattern instead
  }

  // Toggle UI with keyboard shortcut
  toggleUI(): void {
    if (this.uiVisible) this.hideUI();
    else this.showUI();
  }

  // Cleanup
  dispose(): void {
    this.player.unload();
    this.hideUI();
  }
}
