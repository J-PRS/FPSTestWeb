// Demo manager - orchestrates recording, playback, and file I/O.
// Single entry point for the game to interact with the demo system.

import { DemoRecorder, type DemoContext, type RemoteSample, type TargetSnapshot } from './DemoRecorder.js';
import { DemoPlayer, type InterpolatedRemote,type PlaybackState } from './DemoPlayer.js';

import { DemoUI } from './DemoUI.js';
import type { IPlayerDataProvider, IInputProvider, Vec3 } from './interfaces.js';
import type { ProjectileEvent, TargetEvent, DemoFile } from './types.js';
import {CoolShotManager, type CoolShotEntry} from './coolShots.js';
import { VideoRecorder } from './VideoRecorder.js';
import * as clipSink from './clipSink.js';
import { ChildLogger } from '../core/Logger.js';
import { urlParams } from '../core/params.js';
import { feedMode } from '../feed/feedMode.js';
import * as demoIO from './demoIO.js';
import { getHeightfield } from '../world/heightmap.js';
import { buildDemoUI, wirePlayerCallbacks } from './demoWire.js';
import { renderClip } from './renderClip.js';

export type { CoolShotEntry } from './coolShots.js';

const logger = new ChildLogger('Demo');

// Visible armed indicator — the recorder rolls silently in the background
// (ShadowPlay-style), so without a chip there was no on-screen cue at all.
// Lives inside #hud-tr so it flows with the HUD's layout regions instead
// of floating over arbitrary UI.
let recEl: HTMLElement | null = null;
function recChip(on: boolean): void {
  if (on && !recEl) {
    recEl = document.createElement('span');
    recEl.textContent = '● REC';
    recEl.style.cssText = 'color:#f44;font-weight:700;animation:krec 1.2s infinite';
    const st = document.createElement('style');
    st.textContent = '@keyframes krec{0%,100%{opacity:1}50%{opacity:.35}}';
    recEl.append(st);
    (document.getElementById('hud-tr') ?? document.body).append(recEl);
  } else if (!on && recEl) {
    recEl.remove();
    recEl = null;
  }
}

export class DemoManager implements demoIO.DemoIOHost {
  recorder: DemoRecorder;
  player: DemoPlayer;
  ui: DemoUI;
  // Clip queue + server sync live in CoolShotManager; playback/mode stay here
  coolShotMgr: CoolShotManager;

  private playerData: IPlayerDataProvider | null = null;
  private inputData: IInputProvider | null = null;

  mode: 'idle' | 'recording' | 'playing' | 'paused' = 'idle';
  /** demoIO writes through this — the only external writer of mode. */
  setMode(m: 'idle' | 'recording' | 'playing' | 'paused'): void { this.mode = m; }
  uiVisible = false;
  video: VideoRecorder = new VideoRecorder();

  /** Cool-shot autorecord toggles (sidebar checkboxes, persisted). Demo
   *  was unconditional before this was a choice; mp4 arms the rolling
   *  canvas capture so a hit can cut a ShadowPlay-style replay. */
  private autoDemo = localStorage.getItem('kribes.autorecord.demo') !== '0';
  private autoMp4 = localStorage.getItem('kribes.autorecord.mp4') === '1';

  get coolShotDemo(): boolean { return this.autoDemo; }
  set coolShotDemo(on: boolean) {
    this.autoDemo = on;
    localStorage.setItem('kribes.autorecord.demo', on ? '1' : '0');
  }
  get coolShotMp4(): boolean { return this.autoMp4; }
  set coolShotMp4(on: boolean) {
    this.autoMp4 = on;
    localStorage.setItem('kribes.autorecord.mp4', on ? '1' : '0');
    // The mp4 lane has no buffer unless the canvas capture is rolling —
    // arming here means the toggle alone is enough, no F9 detour.
    if (on && !this.video.isRecording && VideoRecorder.isSupported()) {this.startVideoCapture();}
  }

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

  /** Off-rAF render hook (gameLoop.renderFrame) — the offline clip
   *  renderer calls it once per authored output frame. */
  renderNow?: (dt: number) => void;

  /** True while renderClip owns the demo clock — gates every wall-dt
   *  path that would otherwise double-advance playback state (replica
   *  ticks in update(), projectile/beam integration in the game loop). */
  offlineRender = false;
  /** Stepped playback-world tick (projectiles + beams) — demoLifecycle
   *  assigns updatePlaybackProjectiles so the render loop advances them
   *  at demo rate instead of wall rate. */
  onPlaybackTick?: (dt: number) => void;

  constructor() {
    this.recorder = new DemoRecorder();
    this.player = new DemoPlayer();
    this.ui = new DemoUI();
    this.coolShotMgr = new CoolShotManager({
      recorder: (): DemoRecorder => this.recorder,
      isRecording: (): boolean => this.mode === 'recording',
      setStatus: (s): void => this.ui.setStatus(s),
      playDemoData: (d): void => this.playDemoData(d),
      downloadDemoFile: (d, f): void => demoIO.downloadDemoFile(d, f),
      timestampStr: (): string => demoIO.timestampStr(),
      videoClip: (s, e, l): string | null => this.videoAutoClip(s, e, l),
      demoEnabled: (): boolean => this.autoDemo,
    });
    this.coolShotMgr.onChanged = (shots): void | undefined => this.onCoolShotsChanged?.(shots);
    // IDB vault rehydrate — fire-and-forget; entries land via onChanged.
    this.coolShotMgr.loadVault();

    // Stamped into every clip — wrong-map playback is the classic demo bug
    this.recorder.setContext({
      room: urlParams.room ?? 'default',
      mode: urlParams.mode ?? 'offline',
    });

    // Render-tool entry point (tools/demorender drives seek+capture through
    // this handle — the DOM only exposes coarse ±2s keys otherwise).
    window.__demoManager = this;

    buildDemoUI(this);
    wirePlayerCallbacks(this);
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

  // Live target entities (balls, creatures) for the baseline sweep
  setTargetSnapshotSource(source: (() => Iterable<TargetSnapshot>) | null): void {
    this.recorder.setTargetSnapshotSource(source);
  }

  // Roster of the loaded demo — replica creation needs the names
  getRoster(): string[] {
    return this.player.roster.map((r): string => r.name);
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
      recChip(false);
      const ctx = this.player.isLoaded ? 'demo' : 'live';
      this.video.stop().then(async( blob): Promise<void> => {
        const ext = this.video.mimeType.includes('mp4') ? 'mp4' : 'webm';
        const name = `kribes_${ctx}_${demoIO.timestampStr()}.${ext}`;
        const ok = blob ? await clipSink.saveClip(name, blob) : false;
        if (ok && this.pendingExportShotId) {
          // Deliberate export — the vault row alone is invisible: link it
          // onto the shot (Download MP4 badge) and download the file too.
          const shot = this.coolShotMgr.list.find((s): boolean => s.id === this.pendingExportShotId);
          if (shot) {shot.mp4Name = name;}
          clipSink.exportClip(name);
        }
        this.pendingExportShotId = null;
        this.ui.setStatus(ok ? 'video saved' : 'video failed');
      return; }).catch((): void => undefined);
      return;
    }
    // First F9 on a Chromium build: pick the clips folder once and every
    // save after that is silent. Cancelled pickers keep the anchor path.
    if (!clipSink.hasClipsDir()) {clipSink.pickClipsDir();}
    this.startVideoCapture();
  }

  private startVideoCapture(): boolean {
    // main.ts hands us renderer.domElement up front; the largest-canvas
    // probe only survives for contexts that never wired one (clip feed).
    if (!this.video.hasCanvas) {
      const [canvas] = [...document.querySelectorAll('canvas')].toSorted((a, b): number => b.width * b.height - a.width * a.height);
      if (!canvas) { this.ui.setStatus('no canvas'); return false; }
      this.video.setCanvas(canvas);
    }
    this.video.start(60).then((ok): void => {
      if (!ok) { this.ui.setStatus('video unsupported'); return; }
      this.ui.setVideoRecording(true);
      recChip(true);
      this.ui.setStatus(this.video.usingHardware ? 'rec video (gpu)' : 'rec video');
    return; }).catch((): void => undefined);
    return true;
  }

  /** Cool-shot auto-mp4: the rolling video buffer already holds the clip
   *  window, so the mp4 materializes the moment the demo clip extracts —
   *  no replay pass needed. Clip bounds are demo-recorder seconds, mapped
   *  to the video's wall clock through the recorder's wallMarks anchors —
   *  elapsedTime drifts from real time under throttle, so a plain
   *  `now - duration` base slides the window forward by the drift. */
  private videoAutoClip(clipStart: number, clipEnd: number, lifetime: number): string | null {
    if (!this.video.isRecording) {return null;}
    const wallStart = this.recorder.wallForElapsed(clipStart);
    const wallEnd = this.recorder.wallForElapsed(clipEnd);
    if (wallStart === null || wallEnd === null) {return null;}
    const blob = this.video.cutWindow(wallStart, wallEnd);
    if (!blob) {return null;}
    const name = `kribes_coolshot_${demoIO.timestampStr()}_${lifetime.toFixed(1)}s.mp4`;
    clipSink.saveClip(name, blob).then((ok): void => {
      if (ok) {this.ui.setStatus('cool shot mp4 saved');}
    return; }).catch((): void => undefined);
    return name;
  }

  /** Armed by exportCoolShotMp4, consumed by playDemoData — the recorder
   *  starts only when the clip actually begins playing, so a server-
   *  fetched clip doesn't record its own loading gap. 0 = disarmed; the
   *  30s staleness window drops an arm whose fetch never resolves. */
  private videoExportArmedAt = 0;
  /** The cool-shot id an EXPORT MP4 is recording for — consumed when the
   *  capture stops: stamps mp4Name (the shot gains a Download MP4 entry)
   *  and anchor-downloads the file so a deliberate export lands visibly. */
  private pendingExportShotId: string | null = null;

  /** Cool-shot context-menu "EXPORT MP4": plays the clip with the canvas
   *  recorder armed; onPlaybackEnd stops+downloads. The recorder blits
   *  into a staged 1920×1080 canvas, so the export is fixed 16:9 at any
   *  window size — no forced fullscreen, the replay plays windowed. */
  exportCoolShotMp4(id: string): void {
    if (!VideoRecorder.isSupported()) { this.ui.setStatus('no video capture'); return; }
    if (this.video.isRecording) { this.ui.setStatus('video already rolling'); return; }
    this.player.setLoop(false); // looping suppresses onPlaybackEnd = the auto-stop
    this.videoExportArmedAt = Date.now();
    this.pendingExportShotId = id;
    this.coolShotMgr.playById(id);
  }

  /** Clip end is the export's stop signal — the armed recorder must
   *  stop+download here or it rolls forever and nothing lands. */
  finishExportIfArmed(): void {
    if (this.pendingExportShotId && this.video.isRecording) {this.toggleVideoRecord();}
  }

  /** Cool-shot context-menu "RENDER MP4": offline stepped render — scrubs
   *  the demo at fixed 1/60 steps and encodes authored-timestamp frames,
   *  so the mp4 is frame-perfect at any machine speed and usually done
   *  faster than the clip's wall duration. The realtime capture path
   *  (EXPORT MP4) stays for comparison. shortcut: video-only — playback
   *  SFX still fires live during the render but doesn't land in the
   *  file; upgrade path is an OfflineAudioContext pass. */
  async exportCoolShotMp4Rendered(id: string): Promise<void> {
    if (!this.renderNow) { this.ui.setStatus('render unavailable'); return; }
    if (this.offlineRender) { this.ui.setStatus('render already running'); return; }
    const shot = this.coolShotMgr.list.find((s): boolean => s.id === id);
    if (!shot) { this.ui.setStatus('clip missing'); return; }
    if (!this.video.hasCanvas) {
      const [canvas] = [...document.querySelectorAll('canvas')].toSorted((a, b): number => b.width * b.height - a.width * a.height);
      if (canvas) {this.video.setCanvas(canvas);}
    }
    const canvas = this.video.canvasEl;
    if (!canvas) { this.ui.setStatus('no canvas'); return; }
    const data = await this.coolShotMgr.resolveClipData(shot);
    if (!data) { this.ui.setStatus('clip missing'); return; }

    // Parked playback: mode 'playing' arms playbackMode/onPlaybackState so
    // scrubs drive the scene, but player stays paused so the live loop's
    // player.update() doesn't double-advance the clock.
    if (this.mode === 'recording') {this.stopRecording();}
    this.player.setLoop(false);
    this.player.load(data);
    this.mode = 'playing';
    this.ui.setPlaying(true);
    this.onPlaybackStart?.();
    this.player.pause();

    this.ui.setStatus('rendering mp4…');
    this.video.suspended = true;
    this.offlineRender = true;
    const renderFrame = this.renderNow;
    const blob = await renderClip({
      player: this.player,
      canvas,
      renderFrame,
      snapRemotes: (dt): void => { this.onRemotePlayback?.(this.player.getRemoteStates(), dt); },
      tickFx: (dt): void => { this.onPlaybackTick?.(dt); },
      armSeek: (): void => { this.onPlaybackSeek?.(); },
      // ESC/stopPlayback flips mode to 'idle' — bail rather than write
      // an mp4 of an empty scene.
      abort: (): boolean => this.mode !== 'playing',
      start: 0,
      end: data.header.duration,
      fps: 60,
    }).finally((): void => { this.video.suspended = false; this.offlineRender = false; });

    // Park at the end like a finished realtime playback — ESC/stop from
    // here walks the normal cleanup path. If the user already stopped,
    // mode is 'idle' — leave it.
    if (this.mode === 'playing') {this.mode = 'paused';}
    this.ui.setPlaying(false);
    if (!blob) { this.ui.setStatus('render failed'); return; }
    const name = `kribes_render_${demoIO.timestampStr()}.mp4`;
    const ok = await clipSink.saveClip(name, blob);
    if (ok) {
      shot.mp4Name = name;
      clipSink.exportClip(name);
    }
    this.ui.setStatus(ok ? 'mp4 rendered' : 'video failed');
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
    // MP4 autorecord persisted on: arm the rolling capture now that the
    // canvas exists (construction runs before main wires the renderer).
    if (this.autoMp4 && !this.video.isRecording && VideoRecorder.isSupported()) {this.startVideoCapture();}
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
    this.videoExportArmedAt = 0;
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
      if (this.mode === 'idle') {this.onPlaybackStart?.();}
      this.player.play();
      this.mode = 'playing';
      this.ui.setPlaying(true);
    }
  }

  // Seek by a relative offset (seconds)
  seekBy(delta: number): void {
    if (this.mode !== 'playing' && this.mode !== 'paused') {return;}
    this.player.seek(this.player.currentTimeValue + delta);
    // Arrow-key seek while paused must still snap the replicas
    this.onRemotePlayback?.(this.player.getRemoteStates(), 0);
  }

  // Restart demo from the beginning
  restart(): void {
    if (this.mode !== 'playing' && this.mode !== 'paused') {return;}
    this.player.seek(0);
    this.onRemotePlayback?.(this.player.getRemoteStates(), 0);
  }

  // Save current recording to file
  saveDemo(): void { demoIO.saveDemo(this); }

  // Auto-clip: called when a projectile hits something.
  // If projectileLifetime > minLifetime, schedules a clip extraction
  // bufferAfter seconds after the hit so post-hit footage is captured.
  // If a new cool shot happens during an existing pending clip's wait period,
  // the clips are merged into one longer clip (chain combo).
  // minLifetime is 0.2s during testing phase so clips are easy to trigger. Raise to ~2.0s for production.
  autoClipOnHit(projectileLifetime: number, minLifetime = 0.2, bufferBefore = 5, bufferAfter = 5, hitTime?: number, meta?: { weapon?: string; distance?: number }): void {
    this.coolShotMgr.onHit(projectileLifetime, minLifetime, bufferBefore, bufferAfter, hitTime, meta);
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
    // The feed supplies its own chrome — the transport bar would double it.
    if (!feedMode.on) {
      this.ui.show();
      this.uiVisible = true;
    }
    this.ui.setTime(0, data.header.duration);
    demoIO.updateHitMarkers(this, data);
    if (this.videoExportArmedAt) {
      const fresh = Date.now() - this.videoExportArmedAt < 30_000;
      this.videoExportArmedAt = 0;
      if (fresh) {this.startVideoCapture();}
    }
    this.onPlaybackStart?.();
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
  async loadDemo(file: File): Promise<void> { return demoIO.loadDemo(this, file); }

  // Load demo from ArrayBuffer (for programmatic loading)
  loadDemoFromBuffer(buffer: ArrayBuffer): void { demoIO.loadDemoFromBuffer(this, buffer); }

  // Called every game frame
  update(dt: number): void {
    if (this.mode === 'recording') {
      // v5 HMAP trailer — capture the live field lazily once it exists:
      // recording starts at boot before the room's map finishes loading.
      if (!this.recorder.heightmap) {this.recorder.setHeightmap(getHeightfield());}
      this.recorder.update(dt);
      this.coolShotMgr.tick();
    } else if (this.mode === 'playing') {
      this.player.update(dt);
      // Offline render drives replica pose+anim from the stepper —
      // a wall-dt feed here would run anims at render speed, not demo rate.
      if (!this.offlineRender) {this.onRemotePlayback?.(this.player.getRemoteStates(), dt);}
      // onTimeUpdate callback handles ui.setTime during playback
    } else if (this.mode === 'paused') {
      // Keep UI in sync (e.g. after seek while paused)
      this.ui.setTime(this.player.currentTimeValue, this.player.duration);
    }
  }

  // Recording event hooks - called by game systems
  recordProjectileFired(position: Vec3, velocity: Vec3, weaponType: number, shooterId?: string): number {
    return this.recorder.recordFired(position, velocity, weaponType, shooterId);
  }

  recordProjectileBounce(projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void {
    this.recorder.recordBounce(projectileId, position, velocity, surfaceNormal);
  }

  recordProjectileHit(projectileId: number, position: Vec3, targetId: number, weaponType: number, targetType: number): void {
    this.recorder.recordHit(projectileId, position, targetId, weaponType, targetType);
  }

  recordProjectileDestroyed(projectileId: number, position: Vec3): void {
    this.recorder.recordDestroyed(projectileId, position);
  }

  /** Other players' shells — recorded so MP demos aren't an empty
   *  firefight. serverId is the wire projectile id (string). */
  recordRemoteProjectileFired(serverId: string, position: Vec3, velocity: Vec3, weaponType: number, ownerId?: string): void {
    this.recorder.recordRemoteFired(serverId, position, velocity, weaponType, ownerId);
  }

  recordRemoteProjectileDestroyed(serverId: string, position: Vec3): void {
    this.recorder.recordRemoteDestroyed(serverId, position);
  }

  /** Creature lifecycle — netId is the server creature id; the demo
   *  target space namespaces it so it can't alias a ball's id. */
  recordCreatureSpawned(netId: number, species: string, position: Vec3): void {
    this.recorder.recordCreatureSpawned(netId, species, position);
  }

  recordCreatureEdge(netId: number, position: Vec3, velocity: Vec3): void {
    this.recorder.recordCreatureEdge(netId, position, velocity);
  }

  recordCreatureRoster(netId: number, species: string, position: Vec3, velocity: Vec3): void {
    this.recorder.recordCreatureRoster(netId, species, position, velocity);
  }

  recordCreatureDie(netId: number, position: Vec3): void {
    this.recorder.recordCreatureDie(netId, position);
  }

  /** Deployable lifecycle — turrets/mines/stations/drones/shields/beacons
   *  and base assets ride the deploy lane of targetEvents. */
  recordDeploySpawned(netId: number, kind: string, position: Vec3): void {
    this.recorder.recordDeploySpawned(netId, kind, position);
  }

  recordDeployGone(netId: number): void {
    this.recorder.recordDeployGone(netId);
  }

  recordDeployHp(netId: number, hp: number): void {
    this.recorder.recordDeployHp(netId, hp);
  }

  recordDeployShot(netId: number, target: Vec3): void {
    this.recorder.recordDeployShot(netId, target);
  }

  recordDeployBoom(netId: number, position: Vec3): void {
    this.recorder.recordDeployBoom(netId, position);
  }

  /** Game-state edges — kill markers, flag state, pickup lifecycle. */
  recordKill(shooterId: string | null, targetId: string, weapon: number, position: Vec3): void {
    this.recorder.recordKill(shooterId, targetId, weapon, position);
  }

  recordFlagUpdate(team: string, state: string, position: Vec3, carrier: string | null): void {
    this.recorder.recordFlagUpdate(team, state, position, carrier);
  }

  /** Map look spec — captured when the map applies; serialized as the
   *  SECTION_ATMO trailer so playback replays the recorded sky/haze. */
  recordAtmo(atmo: { fog?: unknown; weather?: unknown; atmosphere?: unknown; terrain?: unknown; terrainTex?: unknown; terrainPreset?: unknown; heightScale?: unknown; tileSize?: unknown; sky?: unknown }): void {
    this.recorder.atmo = atmo;
  }

  recordNodeUpdate(r: { id: number; pos: Vec3; owner: string; core: boolean; hp: number; buildBy: string | null; show: boolean; hot: boolean; gx: number; gz: number }): void {
    this.recorder.recordNodeUpdate(r);
  }

  recordMatchMeta(alpha: number, bravo: number, remainingMs: number): void {
    this.recorder.recordMatchMeta(alpha, bravo, remainingMs);
  }

  recordPickupSpawned(netId: number, kind: string, position: Vec3): void {
    this.recorder.recordPickupSpawned(netId, kind, position);
  }

  recordPickupGone(netId: number): void {
    this.recorder.recordPickupGone(netId);
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
    if (this.uiVisible) {this.hideUI();}
    else {this.showUI();}
  }

  // Cleanup
  dispose(): void {
    this.player.unload();
    this.hideUI();
    this.ui.destroy();
  }
}
