// Demo manager - orchestrates recording, playback, and file I/O.
// Single entry point for the game to interact with the demo system.

import { DemoRecorder } from './DemoRecorder.js';
import { DemoSerializer } from './DemoSerializer.js';
import { DemoPlayer } from './DemoPlayer.js';
import type { PlaybackState } from './DemoPlayer.js';
import { DemoUI } from './DemoUI.js';
import type { IPlayerDataProvider, IInputProvider, Vec3 } from './interfaces.js';
import { ProjectileEventType } from './types.js';
import type { ProjectileEvent, TargetEvent, DemoFile } from './types.js';

export interface CoolShotEntry {
  id: string;
  filename?: string; // server-side filename
  projectileLifetime: number;
  timestamp: number;
  description: string;
  clipData?: DemoFile; // only set for locally-generated clips
}

export class DemoManager {
  private recorder: DemoRecorder;
  private player: DemoPlayer;
  private ui: DemoUI;

  private playerData: IPlayerDataProvider | null = null;
  private inputData: IInputProvider | null = null;

  private mode: 'idle' | 'recording' | 'playing' | 'paused' = 'idle';
  private uiVisible = false;

  // Stored cool shots, sorted by lifetime descending
  private coolShots: CoolShotEntry[] = [];
  private static MAX_COOL_SHOTS = 20;

  // Server URL for demo upload/list/download
  private serverUrl: string = '';
  private uploadFailureCount = 0;
  private static MAX_UPLOAD_WARNINGS = 3;

  // Callback when cool shots list changes
  onCoolShotsChanged?: (shots: CoolShotEntry[]) => void;

  // Callbacks for the game to render replay state
  onPlaybackState?: (state: PlaybackState) => void;
  onPlaybackEvent?: (events: { projectiles: ProjectileEvent[], targets: TargetEvent[] }) => void;
  onPlaybackEnd?: () => void;
  onPlaybackStop?: () => void;
  onPlaybackSeek?: () => void;
  onPlaybackStart?: () => void;

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
        this.mode = 'paused';
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
          this.mode = 'paused';
          this.ui.setPlaying(false);
        } else if (this.mode === 'paused' || this.player.isLoaded) {
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
        this.ui.hide();
        this.uiVisible = false;
        this.onPlaybackStop?.();
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
  get isPlaying(): boolean { return this.mode === 'playing' || this.mode === 'paused'; }
  get isPaused(): boolean { return this.mode === 'paused'; }
  get isLoadedForPlayback(): boolean { return this.mode !== 'recording' && this.player.isLoaded; }
  get currentTime(): number { return this.player.currentTimeValue; }

  // Recording control
  startRecording(): void {
    if (!this.playerData || !this.inputData) {
      console.warn('[Demo] Cannot start recording: data providers not set');
      return;
    }
    if (this.mode === 'playing' || this.mode === 'paused') {
      this.player.stop();
      this.mode = 'idle';
    }
    // Clear pending clips from previous recording (buffer is gone)
    if (this.pendingClips.length > 0) {
      console.log(`[Demo] Clearing ${this.pendingClips.length} pending clip(s) from previous recording`);
      this.pendingClips = [];
    }
    this.recorder.start(this.playerData, this.inputData);
    this.mode = 'recording';
    this.ui.setRecording(true);
    this.ui.setStatus('REC');
    console.log('[Demo] Recording started — cool shots will be auto-clipped');
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
    this.onPlaybackStop?.();
  }

  // Toggle play/pause (used by keyboard shortcut)
  togglePlayPause(): void {
    if (this.mode === 'playing') {
      this.player.pause();
      this.mode = 'paused';
      this.ui.setPlaying(false);
    } else if (this.mode === 'paused' || this.player.isLoaded) {
      this.player.play();
      this.mode = 'playing';
      this.ui.setPlaying(true);
    }
  }

  // Seek by a relative offset (seconds)
  seekBy(delta: number): void {
    if (this.mode !== 'playing' && this.mode !== 'paused') return;
    this.player.seek(this.player.currentTimeValue + delta);
  }

  // Restart demo from the beginning
  restart(): void {
    if (this.mode !== 'playing' && this.mode !== 'paused') return;
    this.player.seek(0);
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
  // If a new cool shot happens during an existing pending clip's wait period,
  // the clips are merged into one longer clip (chain combo).
  // minLifetime is 0.2s during testing phase so clips are easy to trigger. Raise to ~2.0s for production.
  autoClipOnHit(projectileLifetime: number, minLifetime: number = 0.2, bufferBefore: number = 5.0, bufferAfter: number = 5.0): void {
    if (this.mode !== 'recording') return;
    if (projectileLifetime < minLifetime) return;

    const hitTime = this.recorder.duration;
    const shotTime = hitTime - projectileLifetime;

    // Check if there's a pending clip whose wait period hasn't elapsed yet — merge into it
    for (const pending of this.pendingClips) {
      if (hitTime < pending.extractAt) {
        // Extend the clip end and push extraction time back
        pending.clipEnd = hitTime + bufferAfter;
        pending.extractAt = hitTime + bufferAfter;
        pending.chainCount = (pending.chainCount ?? 1) + 1;
        pending.bestLifetime = Math.max(pending.bestLifetime ?? pending.projectileLifetime, projectileLifetime);
        const totalDur = pending.clipEnd - pending.clipStart;
        pending.description = `Combo x${pending.chainCount} (best ${pending.bestLifetime.toFixed(2)}s air, ${totalDur.toFixed(1)}s clip)`;
        console.log(`[CoolShot] Chain x${pending.chainCount}! Extending clip to ${totalDur.toFixed(1)}s — extracting in ${bufferAfter}s...`);
        return;
      }
    }

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
      chainCount: 1,
      bestLifetime: projectileLifetime,
    });
    console.log(`[CoolShot] Clip scheduled: ${desc} — extracting in ${bufferAfter}s...`);
  }

  private pendingClips: { extractAt: number; clipStart: number; clipEnd: number; projectileLifetime: number; description: string; chainCount: number; bestLifetime: number }[] = [];

  private processPendingClips(): void {
    if (this.pendingClips.length === 0) return;
    const now = this.recorder.duration;
    for (let i = this.pendingClips.length - 1; i >= 0; i--) {
      const pending = this.pendingClips[i];
      if (now < pending.extractAt) continue;

      // Time to extract
      this.pendingClips.splice(i, 1);
      const clipData = this.recorder.extractClip(pending.clipStart, pending.clipEnd, pending.description, pending.projectileLifetime);
      if (!clipData) {
        console.warn('[Demo] Auto-clip: not enough buffer for this clip');
        continue;
      }

      const filename = `clip_${this.timestampStr()}_${pending.bestLifetime.toFixed(1)}s.demo`;
      this.uploadClipToServer(clipData, pending.bestLifetime);

      const entry: CoolShotEntry = {
        id: `clip_${Date.now()}_${pending.bestLifetime.toFixed(1)}`,
        filename,
        projectileLifetime: pending.bestLifetime,
        timestamp: Date.now(),
        description: pending.description,
        clipData,
      };
      this.coolShots.push(entry);
      this.coolShots.sort((a, b) => b.projectileLifetime - a.projectileLifetime);
      // Keep top 10 by lifetime + recent 10 by timestamp (may overlap)
      const topIds = new Set(this.coolShots.slice(0, 10).map(s => s.id));
      const recentIds = new Set([...this.coolShots].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10).map(s => s.id));
      this.coolShots = this.coolShots.filter(s => topIds.has(s.id) || recentIds.has(s.id));
      this.onCoolShotsChanged?.(this.coolShots);

      console.log(`[Demo] Auto-saved clip: ${filename} (best lifetime ${pending.bestLifetime.toFixed(2)}s, chain x${pending.chainCount})`);
      this.ui.setStatus(`Clip saved! ${pending.bestLifetime.toFixed(1)}s air${pending.chainCount > 1 ? ` x${pending.chainCount}` : ''}`);
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
      this.updateHitMarkers(entry.clipData);
      this.onPlaybackStart?.();
      console.log(`[Demo] Playing cool shot: ${entry.description}`);
    } else if (entry.filename) {
      // Download from server then play
      this.playFromServer(entry.filename);
    }
  }

  // Play a cool shot clip by its entry ID
  playCoolShotById(id: string): void {
    const index = this.coolShots.findIndex(s => s.id === id);
    if (index >= 0) this.playCoolShot(index);
  }

  private downloadDemoFile(data: DemoFile, filename: string): void {
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
  private async uploadClipToServer(clipData: DemoFile, projectileLifetime: number): Promise<void> {
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
      this.uploadFailureCount = 0;
      if (result.rejected) {
        console.log(`[Demo] Clip rejected by server: ${result.reason}`);
      } else {
        console.log(`[Demo] Clip uploaded to server: ${result.filename}`);
      }
    } catch (e) {
      this.uploadFailureCount++;
      if (this.uploadFailureCount <= DemoManager.MAX_UPLOAD_WARNINGS) {
        console.warn(`[Demo] Failed to upload clip (${this.uploadFailureCount}):`, e);
        if (this.uploadFailureCount === DemoManager.MAX_UPLOAD_WARNINGS) {
          console.warn('[Demo] Suppressing further upload failure warnings. Check server CORS/network.');
        }
      }
    }
  }

  // Fetch cool shots list from server and merge with local
  async fetchCoolShotsFromServer(): Promise<void> {
    if (!this.serverUrl) return;
    try {
      const resp = await fetch(`${this.serverUrl}/demos`);
      if (!resp.ok) {
        console.warn(`[Demo] Failed to fetch cool shots: HTTP ${resp.status}`);
        return;
      }
      const data = await resp.json();
      const serverDemos: CoolShotEntry[] = (data.demos || []).map((d: any) => ({
        id: d.filename,
        filename: d.filename,
        projectileLifetime: d.projectileLifetime,
        timestamp: d.timestamp,
        description: d.description,
      }));
      console.log(`[Demo] Fetched ${serverDemos.length} demos from server`);

      // Merge: server demos that aren't already in local list (by filename)
      const localFilenames = new Set(this.coolShots.map(s => s.filename));
      for (const sd of serverDemos) {
        if (!localFilenames.has(sd.filename)) {
          this.coolShots.push(sd);
        }
      }
      this.coolShots.sort((a, b) => b.projectileLifetime - a.projectileLifetime);
      // Keep top 10 by lifetime + recent 10 by timestamp (may overlap)
      const topIds = new Set(this.coolShots.slice(0, 10).map(s => s.id));
      const recentIds = new Set([...this.coolShots].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10).map(s => s.id));
      this.coolShots = this.coolShots.filter(s => topIds.has(s.id) || recentIds.has(s.id));
      this.onCoolShotsChanged?.(this.coolShots);

      console.log(`[CoolShots] ${this.coolShots.length} entries (top: ${this.coolShots[0]?.projectileLifetime.toFixed(2) ?? 'none'}s)`);
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
      this.updateHitMarkers(data);
      this.ui.setStatus('');
      this.onPlaybackStart?.();
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
      this.updateHitMarkers(data);
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
    this.updateHitMarkers(data);
  }

  private updateHitMarkers(data: DemoFile): void {
    // Find the hit with the longest airtime (Hit timestamp - Fired timestamp for same projectileId)
    const firedTimes = new Map<number, number>();
    for (const e of data.projectileEvents) {
      if (e.eventType === ProjectileEventType.Fired) {
        firedTimes.set(e.projectileId, e.timestamp);
      }
    }

    let bestHitTime: number | null = null;
    let bestAirtime = -1;
    for (const e of data.projectileEvents) {
      if (e.eventType !== ProjectileEventType.Hit) continue;
      const firedAt = firedTimes.get(e.projectileId);
      if (firedAt === undefined) continue;
      const airtime = e.timestamp - firedAt;
      if (airtime > bestAirtime) {
        bestAirtime = airtime;
        bestHitTime = e.timestamp;
      }
    }

    this.ui.setHitMarkers(bestHitTime !== null ? [bestHitTime] : [], data.header.duration);
  }

  // Called every game frame
  update(dt: number): void {
    if (this.mode === 'recording') {
      this.recorder.update(dt);
      this.processPendingClips();
    } else if (this.mode === 'playing') {
      this.player.update(dt);
      // onTimeUpdate callback handles ui.setTime during playback
    } else if (this.mode === 'paused') {
      // Keep UI in sync (e.g. after seek while paused)
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

  recordTargetBounce(targetId: number, position: Vec3, velocity: Vec3): void {
    this.recorder.recordTargetBounce(targetId, position, velocity);
  }

  recordTargetPeak(targetId: number, position: Vec3, velocity: Vec3): void {
    this.recorder.recordTargetPeak(targetId, position, velocity);
  }

  recordTargetHit(targetId: number, position: Vec3, velocity: Vec3, health: number): void {
    this.recorder.recordTargetHit(targetId, position, velocity, health);
  }

  recordTargetDestroyed(targetId: number, position: Vec3): void {
    this.recorder.recordTargetDestroyed(targetId, position);
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
    this.ui.destroy();
  }
}
