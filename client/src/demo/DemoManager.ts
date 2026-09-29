// Demo manager - orchestrates recording, playback, and file I/O.
// Single entry point for the game to interact with the demo system.

import { DemoRecorder, type DemoContext, type RemoteSample } from './DemoRecorder.js';
import { DemoSerializer } from './DemoSerializer.js';
import { DemoPlayer, type InterpolatedRemote } from './DemoPlayer.js';
import type { PlaybackState } from './DemoPlayer.js';
import { DemoUI } from './DemoUI.js';
import type { IPlayerDataProvider, IInputProvider, Vec3 } from './interfaces.js';
import { ProjectileEventType } from './types.js';
import type { ProjectileEvent, TargetEvent, DemoFile } from './types.js';
import { CoolShotManager } from './coolShots.js';
import type { CoolShotEntry } from './coolShots.js';
import { VideoRecorder } from './VideoRecorder.js';
import { ChildLogger } from '../core/Logger.js';
import { urlParams } from '../core/params.js';

export type { CoolShotEntry } from './coolShots.js';

const logger = new ChildLogger('Demo');

export class DemoManager {
  private recorder: DemoRecorder;
  private player: DemoPlayer;
  private ui: DemoUI;
  // Clip queue + server sync live in CoolShotManager; playback/mode stay here
  private coolShotMgr: CoolShotManager;

  private playerData: IPlayerDataProvider | null = null;
  private inputData: IInputProvider | null = null;

  private mode: 'idle' | 'recording' | 'playing' | 'paused' = 'idle';
  private uiVisible = false;
  private video: VideoRecorder = new VideoRecorder();

  // Callback when cool shots list changes
  onCoolShotsChanged?: (shots: CoolShotEntry[]) => void;

  // Interpolated remote-player poses + fresh remote frames each playback
  // frame — demoLifecycle turns them into RemotePlayer replicas.
  onRemotePlayback?: (states: InterpolatedRemote[], dt: number) => void;

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
    this.coolShotMgr = new CoolShotManager({
      recorder: () => this.recorder,
      isRecording: () => this.mode === 'recording',
      setStatus: (s) => this.ui.setStatus(s),
      playDemoData: (d) => this.playDemoData(d),
      downloadDemoFile: (d, f) => this.downloadDemoFile(d, f),
      timestampStr: () => this.timestampStr(),
    });
    this.coolShotMgr.onChanged = (shots) => this.onCoolShotsChanged?.(shots);

    // Stamped into every clip — wrong-map playback is the classic demo bug
    this.recorder.setContext({
      room: urlParams.room ?? 'default',
      mode: urlParams.mode ?? 'offline',
    });

    // Render-tool entry point (tools/demorender drives seek+capture through
    // this handle — the DOM only exposes coarse ±2s keys otherwise).
    (window as unknown as { __demoManager?: DemoManager }).__demoManager = this;

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
      onPlayPause: () => this.togglePlayPause(),
      onSeek: (time: number) => {
        this.player.seek(time);
        // Replicas snap to the interpolated pose at the seek target
        this.onRemotePlayback?.(this.player.getRemoteStates(), 0);
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
        // Stop exits replay — flush any in-flight video export so the clip
        // isn't abandoned silently.
        if (this.video.isRecording) this.toggleVideoRecord();
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
      onVideoToggle: () => {
        this.toggleVideoRecord();
      },
    });
  }

  // Set data providers for recording
  setDataProviders(playerData: IPlayerDataProvider, inputData: IInputProvider): void {
    this.playerData = playerData;
    this.inputData = inputData;
  }

  // Who we're playing as / which room — recorded into the file header
  setContext(ctx: Partial<DemoContext>): void {
    this.recorder.setContext(ctx);
  }

  // Live remote players for recording (world.remotePlayers etc.)
  setRemoteSource(source: (() => Iterable<RemoteSample>) | null): void {
    this.recorder.setRemoteSource(source);
  }

  // Roster of the loaded demo — replica creation needs the names
  getRoster(): string[] {
    return this.player.roster.map(r => r.name);
  }

  // Interpolated remote poses at the player's current time (seek recovery)
  getRemoteStates(): InterpolatedRemote[] {
    return this.player.getRemoteStates();
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

  // One-click video export: records the render canvas live (captureStream +
  // MediaRecorder), downloads mp4/webm when stopped. The render canvas is the
  // largest canvas in the DOM — found lazily so no main.ts wiring is needed.
  toggleVideoRecord(): void {
    if (!VideoRecorder.isSupported()) { this.ui.setStatus('no video capture'); return; }
    if (this.video.isRecording) {
      this.ui.setVideoRecording(false);
      const ctx = this.player.isLoaded ? 'demo' : 'live';
      void this.video.stopAndDownload(`kribes_${ctx}_${this.timestampStr()}`).then(ok => {
        this.ui.setStatus(ok ? 'video saved' : 'video failed');
      });
      return;
    }
    const canvas = [...document.querySelectorAll('canvas')].toSorted((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!canvas) { this.ui.setStatus('no canvas'); return; }
    this.video.setCanvas(canvas);
    if (this.video.start(60)) {
      this.ui.setVideoRecording(true);
      this.ui.setStatus('rec video');
    } else {
      this.ui.setStatus('video unsupported');
    }
  }

  get isRecording(): boolean { return this.mode === 'recording'; }
  get isPlaying(): boolean { return this.mode === 'playing' || this.mode === 'paused'; }
  get isPaused(): boolean { return this.mode === 'paused'; }
  get isLoadedForPlayback(): boolean { return this.mode !== 'recording' && this.player.isLoaded; }
  get currentTime(): number { return this.player.currentTimeValue; }

  // Recording control
  startRecording(): void {
    if (!this.playerData || !this.inputData) {
      logger.warn('Cannot start recording: data providers not set');
      return;
    }
    if (this.mode === 'playing' || this.mode === 'paused') {
      this.player.stop();
      this.mode = 'idle';
    }
    // Clear pending clips from previous recording (buffer is gone)
    this.coolShotMgr.clearPending();
    this.recorder.start(this.playerData, this.inputData);
    this.mode = 'recording';
    this.ui.setRecording(true);
    this.ui.setStatus('REC');
    logger.debug('Recording started — cool shots will be auto-clipped');
  }

  stopRecording(): void {
    // Extract any pending cool-shot clips before the buffer is abandoned
    this.coolShotMgr.flushPending();
    this.recorder.stop();
    this.mode = 'idle';
    this.ui.setRecording(false);
    this.ui.setStatus('');
  }

  stopPlayback(): void {
    this.player.stop();
    this.mode = 'idle';
    this.ui.setPlaying(false);
    // ESC-stop used to leave the control bar hanging over live play
    this.ui.hide();
    this.uiVisible = false;
    this.onPlaybackStop?.();
  }

  // Toggle play/pause — the UI button and the keyboard shortcut share this
  togglePlayPause(): void {
    if (this.mode === 'playing') {
      this.player.pause();
      this.mode = 'paused';
      this.ui.setPlaying(false);
    } else if (this.mode === 'paused' || this.player.isLoaded) {
      // A clip parked via finishLoad starts here, bypassing playDemoData —
      // without this the world never enters playbackMode and the live wire
      // fights the replay.
      if (this.mode === 'idle') this.onPlaybackStart?.();
      this.player.play();
      this.mode = 'playing';
      this.ui.setPlaying(true);
    }
  }

  // Seek by a relative offset (seconds)
  seekBy(delta: number): void {
    if (this.mode !== 'playing' && this.mode !== 'paused') return;
    this.player.seek(this.player.currentTimeValue + delta);
    // Arrow-key seek while paused must still snap the replicas
    this.onRemotePlayback?.(this.player.getRemoteStates(), 0);
  }

  // Restart demo from the beginning
  restart(): void {
    if (this.mode !== 'playing' && this.mode !== 'paused') return;
    this.player.seek(0);
    this.onRemotePlayback?.(this.player.getRemoteStates(), 0);
  }

  // Save current recording to file
  saveDemo(): void {
    if (this.recorder.frameCount === 0) {
      logger.warn('No frames to save');
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
  autoClipOnHit(projectileLifetime: number, minLifetime: number = 0.2, bufferBefore: number = 5.0, bufferAfter: number = 5.0, hitTime?: number): void {
    this.coolShotMgr.onHit(projectileLifetime, minLifetime, bufferBefore, bufferAfter, hitTime);
  }

  getCoolShots(): CoolShotEntry[] {
    return this.coolShotMgr.list;
  }

  // Play a cool shot clip by index
  playCoolShot(index: number): void {
    this.coolShotMgr.playAt(index);
  }

  // Play a cool shot clip by its entry ID
  playCoolShotById(id: string): void {
    this.coolShotMgr.playById(id);
  }

  // Download a cool shot clip by its entry ID
  async downloadCoolShotById(id: string): Promise<void> {
    return this.coolShotMgr.downloadById(id);
  }

  // Load a demo into the player and immediately start playback — the shared
  // tail of playCoolShot and playFromServer.
  private playDemoData(data: DemoFile): void {
    // Loading while recording used to orphan the recorder (mode flips to
    // 'idle' but recording kept running, its buffer silently frozen).
    if (this.recorder.isRecording) {
      this.coolShotMgr.flushPending();
      this.recorder.stop();
      this.ui.setRecording(false);
      this.ui.setStatus('');
    }
    this.player.load(data);
    this.mode = 'playing';
    this.player.play();
    this.ui.setPlaying(true);
    this.ui.show();
    this.uiVisible = true;
    this.ui.setTime(0, data.header.duration);
    this.updateHitMarkers(data);
    this.onPlaybackStart?.();
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
    this.coolShotMgr.setServerUrl(url);
  }

  // Fetch cool shots list from server and merge with local
  async fetchCoolShotsFromServer(): Promise<void> {
    return this.coolShotMgr.fetchFromServer();
  }

  // Load demo from file
  async loadDemo(file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      const data = DemoSerializer.deserialize(buffer);
      this.finishLoad(data);
      this.ui.setStatus(`Loaded: ${data.frames.length} frames, ${data.header.duration.toFixed(1)}s`);
    } catch (e) {
      logger.error('Failed to load demo:', e);
      this.ui.setStatus(`Load error: ${(e as Error).message}`);
    }
  }

  // Load demo from ArrayBuffer (for programmatic loading)
  loadDemoFromBuffer(buffer: ArrayBuffer): void {
    try {
      this.finishLoad(DemoSerializer.deserialize(buffer));
    } catch (e) {
      logger.error('Failed to load demo:', e);
      this.ui.setStatus(`Load error: ${(e as Error).message}`);
    }
  }

  // Shared post-load: parked at 0, not playing — differs from playDemoData
  // which starts playback immediately.
  private finishLoad(data: DemoFile): void {
    if (this.recorder.isRecording) {
      this.coolShotMgr.flushPending();
      this.recorder.stop();
      this.ui.setRecording(false);
      this.ui.setStatus('');
    }
    this.player.load(data);
    this.mode = 'idle';
    this.ui.setPlaying(false);
    this.ui.setTime(0, data.header.duration);
    this.updateHitMarkers(data);
  }

  private updateHitMarkers(data: DemoFile): void {
    // Collect all fired and hit timestamps, paired by projectileId.
    // Shows every shot/hit on the seekbar, not just the best one.
    const firedTimes = new Map<number, number>();
    for (const e of data.projectileEvents) {
      if (e.eventType === ProjectileEventType.Fired) {
        firedTimes.set(e.projectileId, e.timestamp);
      }
    }

    // "Hot" = the shot this clip exists for: fired→hit airtime matching the
    // header's recorded best lifetime (80% band catches float jitter and
    // near-equal combo partners). Full recordings (lifetime 0) show all hot.
    const best = data.header.projectileLifetime;
    const isHot = (lifetime: number) => best <= 0 || lifetime >= best * 0.8;

    const hitTimes: { t: number; hot: boolean }[] = [];
    const shotTimes: { t: number; hot: boolean }[] = [];
    for (const e of data.projectileEvents) {
      if (e.eventType !== ProjectileEventType.Hit) continue;
      const firedAt = firedTimes.get(e.projectileId);
      if (firedAt === undefined) continue;
      const hot = isHot(e.timestamp - firedAt);
      hitTimes.push({ t: e.timestamp, hot });
      shotTimes.push({ t: firedAt, hot });
    }

    this.ui.setMarkers(hitTimes, shotTimes, data.header.duration);
  }

  // Called every game frame
  update(dt: number): void {
    if (this.mode === 'recording') {
      this.recorder.update(dt);
      this.coolShotMgr.tick();
    } else if (this.mode === 'playing') {
      this.player.update(dt);
      this.onRemotePlayback?.(this.player.getRemoteStates(), dt);
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

  recordTargetBounce(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    this.recorder.recordTargetBounce(targetId, position, velocity, targetType);
  }

  recordTargetPeak(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    this.recorder.recordTargetPeak(targetId, position, velocity, targetType);
  }

  recordTargetHit(targetId: number, position: Vec3, velocity: Vec3, targetType: number, health: number): void {
    this.recorder.recordTargetHit(targetId, position, velocity, targetType, health);
  }

  recordTargetDestroyed(targetId: number, position: Vec3, targetType: number, health?: number): void {
    this.recorder.recordTargetDestroyed(targetId, position, targetType, health);
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
