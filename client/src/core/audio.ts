// AudioEngine — the whole sound system, zero assets: every SFX is
// synthesized Web Audio (no downloads, instant start, fits the retro look).
//
// Architecture: master gain -> compressor -> destination; three buses
// (ui / sfx / world) for independent mixing; positional sounds are cheap
// StereoPanner + distance gain + lowpass-with-distance (good enough for a
// fast shooter, way cheaper than PannerNode HRTF convolutions).
//
// Loops (ski scrape, jetpack, wind) are persistent nodes the game loop
// drives with setTargetAtTime — smoother than re-triggering.
import * as THREE from 'three';
import { settings } from './settings.js';

export interface LoopHandle {
  /** Push a 0..1 intensity; engine maps it to gain/filter params. */
  set(intensity: number): void;
  stop(): void;
}

const MAX_VOICES = 24;          // cap concurrent one-shots — beyond this, drop
const WORLD_REF_DIST = 8;       // meters at which a positional sound is ~full
const WORLD_MAX_DIST = 220;     // beyond this, don't spawn the node at all

export class AudioEngine {
  private ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private world!: GainNode;
  private ui!: GainNode;
  private voices = 0;
  private noiseBuf: AudioBuffer | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private samplesRequested = false;
  private listenerPos = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);

  /** Must be called from a user gesture (pointer lock click qualifies). */
  unlock(): void {
    if (this.ctx) { void (this.ctx as AudioContext).resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.wire(new AC());
    void this.loadSamples();
  }

  /** Decoded sample lookup — null until loadSamples resolves it. */
  sample(name: string): AudioBuffer | null { return this.buffers.get(name) ?? null; }

  /** Fetch + decode the /sfx/*.ogg bank once. Failures stay silent —
   *  the synth fallbacks in sfx.ts cover every slot a sample misses. */
  private async loadSamples(): Promise<void> {
    if (this.samplesRequested || !this.ctx) return;
    this.samplesRequested = true;
    const names = [
      'explosion1', 'explosion2', 'explosion_small',
      'shot_chaingun', 'shot_plasma', 'shot_cannon', 'shot_energy',
      'shot_laser', 'shot_rocket', 'shot_shotgun',
      'hit_marker', 'impact', 'jump', 'land', 'hurt', 'pickup',
      'powerup', 'jet_loop', 'teleport',
      'alien_die1', 'alien_die2', 'alien_die3', 'snow_amb',
      'dash', 'dash2', 'slam_thud', 'bounce', 'punch', 'missile',
      'monster1', 'monster2', 'monster3', 'sparks', 'zap_loop',
      'robot_die', 'equip', 'reload', 'ski_scrape', 'thud_big', 'cryst_bang',
      'ricochet1', 'ricochet2', 'ricochet3', 'whistle',
      'hg_throw', 'hg_clang', 'hg_tick',
    ];
    await Promise.all(names.map(async n => {
      try {
        const res = await fetch(`/sfx/${n}.ogg`);
        if (!res.ok) return;
        const buf = await this.ctx!.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(n, buf);
      } catch { /* synth fallback covers it */ }
    }));
  }

  /** Offline-rendering hook for the WAV dump pipeline — attaches a
   *  pre-made OfflineAudioContext instead of creating a live one.
   *  Resolves once the sample bank is decoded so renders use real clips. */
  async attachOffline(ctx: BaseAudioContext): Promise<void> {
    this.wire(ctx);
    await this.loadSamples();
  }

  private wire(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 20; comp.ratio.value = 8;
    this.master.connect(comp).connect(ctx.destination);
    this.master.gain.value = settings.get('fps-volume');
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.world = ctx.createGain(); this.world.connect(this.master);
    this.ui = ctx.createGain(); this.ui.connect(this.master);
    // 2s of white noise — the raw material for most SFX.
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  get ready(): boolean { return this.ctx !== null && (this.ctx.state === 'running' || 'startRendering' in this.ctx); }
  get context(): BaseAudioContext | null { return this.ctx; }
  get sfxBus(): GainNode | null { return this.ctx ? this.sfx : null; }
  get uiBus(): GainNode | null { return this.ctx ? this.ui : null; }

  setVolume(v: number): void {
    settings.set('fps-volume', v);
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }
  getVolume(): number { return settings.get('fps-volume'); }

  /** Call each frame with camera pos + yaw basis for the listener. */
  updateListener(pos: THREE.Vector3, right: THREE.Vector3): void {
    this.listenerPos.copy(pos);
    this.listenerRight.copy(right);
  }

  /**
   * Route a source node to the world bus through distance gain + stereo pan.
   * Returns the input node for the caller to connect into, or null if the
   * sound is out of earshot (caller should skip building the voice).
   */
  worldInput(pos: THREE.Vector3): GainNode | null {
    if (!this.ctx) return null;
    const dx = pos.x - this.listenerPos.x;
    const dy = pos.y - this.listenerPos.y;
    const dz = pos.z - this.listenerPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > WORLD_MAX_DIST) return null;
    const distGain = 1 / (1 + dist / WORLD_REF_DIST);
    // Cheap directional cue: pan by projection of the offset onto the
    // listener's right axis. Not HRTF but your ears read it instantly.
    const pan = dist > 1 ? Math.max(-1, Math.min(1,
      (dx * this.listenerRight.x + dz * this.listenerRight.z) / dist)) : 0;
    const g = this.ctx.createGain();
    g.gain.value = distGain;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // Air absorbs highs with distance — sells scale better than gain alone.
    lp.frequency.value = Math.max(800, 20000 / (1 + dist / 60));
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(lp).connect(p).connect(this.world);
    return g;
  }

  /** Offline-dump hook: live code releases voices via timers, which would
   *  starve a batch of back-to-back renders — the dump resets instead. */
  resetVoices(): void { this.voices = 0; }

  /** Voice accounting for one-shots; returns false when the cap is hit. */
  takeVoice(): boolean {
    if (this.voices >= MAX_VOICES) return false;
    this.voices++;
    return true;
  }
  releaseVoice(): void { this.voices = Math.max(0, this.voices - 1); }

  /** Shared white-noise buffer for SFX synth. */
  get noise(): AudioBuffer | null { return this.noiseBuf; }

  /**
   * Continuous noise loop with a filter — the raw material for ski, jetpack,
   * wind. intensity 0 silences it; the node stays alive (cheap to idle).
   */
  noiseLoop(type: BiquadFilterType, freq: number): LoopHandle | null {
    if (!this.ctx || !this.noiseBuf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type; filt.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(filt).connect(g).connect(this.sfx);
    src.start();
    let alive = true;
    return {
      set: (v) => { if (alive) g.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.08); },
      stop: () => { if (alive) { alive = false; src.stop(); src.disconnect(); filt.disconnect(); g.disconnect(); } },
    };
  }

  /** Sample buffer loop (real jetpack/ski recordings) — same handle shape. */
  sampleLoop(name: string, rate = 1): LoopHandle | null {
    const buf = this.buffers.get(name);
    if (!this.ctx || !buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.sfx);
    src.start();
    let alive = true;
    return {
      set: (v) => { if (alive) g.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.08); },
      stop: () => { if (alive) { alive = false; src.stop(); src.disconnect(); g.disconnect(); } },
    };
  }

  /** Oscillator loop (jetpack hum etc.) — set() drives gain + pitch bend. */
  oscLoop(type: OscillatorType, freq: number): LoopHandle | null {
    if (!this.ctx) return null;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(this.sfx);
    o.start();
    let alive = true;
    return {
      set: (v) => {
        if (!alive) return;
        g.gain.setTargetAtTime(v * 0.3, this.ctx!.currentTime, 0.06);
        o.frequency.setTargetAtTime(freq * (1 + v * 0.8), this.ctx!.currentTime, 0.06);
      },
      stop: () => { if (alive) { alive = false; o.stop(); o.disconnect(); g.disconnect(); } },
    };
  }
}

export const audio = new AudioEngine();
