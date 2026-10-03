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
import { dopplerRate, worldInput, freeInput } from './audioRoute.js';

export interface LoopHandle {
  /** Push a 0..1 intensity; engine maps it to gain/filter params. */
  set(intensity: number): void;
  stop(): void;
}

/** A persistent loop routed through the positional channel — caller
 *  re-aims distance/pan per frame with setPos (moving remote players). */
export interface PositionalLoop extends LoopHandle {
  setPos(pos: THREE.Vector3, emitVel?: THREE.Vector3): void;
}

const MAX_VOICES = 24;          // cap concurrent one-shots — beyond this, drop
// Gunfire carries for hundreds of meters — ref 8m made a 100m shot
// −22dB, i.e. silent. 16m keeps close shots loud without killing far ones.
const WORLD_REF_DIST = 16;      // meters at which a positional sound is ~full
const WORLD_MAX_DIST = 260;     // beyond this, don't spawn the node at all
// Air absorption: high frequencies die exponentially with distance —
// real gunshots past ~80m are all low thump, no crack. Exponential
// (not the old linear 1/(1+d/60), which left 7.5kHz alive at 100m and
// made every shot sound adjacent). 30m→~8.5k, 100m→~1.9k, 200m→~500Hz.
const AIR_ABSORB_M = 45;
const airAbsorbHz = (d: number): number =>
  Math.max(400, Math.min(20000, 18000 * Math.exp(-d / AIR_ABSORB_M)));

export class AudioEngine {
  ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  world!: GainNode;
  private ui!: GainNode;
  /** Menu duck chain — sfx/world route through duckLp→duckGain→master;
   *  the ESC overlay dips gain + collapses the top end ("in the next
   *  room"), while ui/VGS bypass it so menu feedback stays crisp. */
  private duckLp!: BiquadFilterNode;
  private duckGain!: GainNode;
  /** Live one-shots, FMOD-channel style: on overflow the cap steals the
   *  oldest strictly-lower-priority voice instead of refusing the new
   *  sound — a firefight's world chatter must never silence a flag
   *  stinger or kill confirm. Prio tiers: 0 = world/positional,
   *  1 = self (own weapon, hurt, land), 2 = UI/stinger. */
  private voiceTab: { prio: number; at: number; node: AudioNode; chain?: GainNode }[] = [];
  private noiseBuf: AudioBuffer | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private samplesRequested = false;
  listenerPos = new THREE.Vector3();
  listenerRight = new THREE.Vector3(1, 0, 0);
  listenerVel = new THREE.Vector3();
  /** Scratch pitch bend set by worldInput for the voice about to be
   *  built — lets every recipe rate pick up Doppler without threading a
   *  param through each layer. Reset to 1 once the voice is built. */
  emitterPitch = 1;

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
    this.duckLp = ctx.createBiquadFilter();
    this.duckLp.type = 'lowpass'; this.duckLp.frequency.value = 20000;
    this.duckGain = ctx.createGain();
    this.duckLp.connect(this.duckGain).connect(this.master);
    this.sfx = ctx.createGain(); this.sfx.connect(this.duckLp);
    this.world = ctx.createGain(); this.world.connect(this.duckLp);
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

  /** ESC-menu duck: -10dB + a 900Hz blanket on game sounds. Fast attack,
   *  slower release so re-entering the game doesn't pop. */
  setDucked(on: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.duckGain.gain.setTargetAtTime(on ? 0.32 : 1, t, on ? 0.04 : 0.12);
    this.duckLp.frequency.setTargetAtTime(on ? 900 : 20000, t, on ? 0.04 : 0.12);
  }

  setVolume(v: number): void {
    settings.set('fps-volume', v);
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }
  getVolume(): number { return settings.get('fps-volume'); }

  /** Call each frame with camera pos + yaw basis for the listener. */
  updateListener(pos: THREE.Vector3, right: THREE.Vector3, vel?: THREE.Vector3): void {
    this.listenerPos.copy(pos);
    this.listenerRight.copy(right);
    if (vel) this.listenerVel.copy(vel);
    else this.listenerVel.set(0, 0, 0);
  }

  dopplerRate(pos: THREE.Vector3, emitVel?: THREE.Vector3): number {
    return dopplerRate(this, pos, emitVel);
  }
  worldInput(pos: THREE.Vector3, emitVel?: THREE.Vector3): GainNode | null {
    return worldInput(this, pos, emitVel);
  }
  freeInput(g: GainNode): void { freeInput(g); }

  /** Offline-dump hook: live code releases voices via timers, which would
   *  starve a batch of back-to-back renders — the dump resets instead. */
  resetVoices(): void { this.voiceTab = []; }

  /** Admit a voice; on a full pool, evict the oldest strictly-lower-
   *  priority one (silenced, not just uncounted). A full pool of
   *  same-or-higher prio is the only refusal — the stinger tier
   *  effectively can't starve. */
  takeVoice(prio: number, node: AudioNode, chain?: GainNode): boolean {
    if (this.voiceTab.length >= MAX_VOICES) {
      let victim = -1;
      for (let i = 0; i < this.voiceTab.length; i++) {
        const v = this.voiceTab[i]!;
        if (v.prio < prio && (victim < 0 || v.at < this.voiceTab[victim]!.at)) victim = i;
      }
      if (victim < 0) return false;
      const [v] = this.voiceTab.splice(victim, 1);
      try { v!.node.disconnect(); } catch { /* already detached */ }
      if (v!.chain) this.freeInput(v!.chain);
    }
    this.voiceTab.push({ prio, at: Date.now(), node, chain });
    return true;
  }
  releaseVoice(node: AudioNode): void {
    const i = this.voiceTab.findIndex(v => v.node === node);
    if (i >= 0) this.voiceTab.splice(i, 1);
  }

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

  /** Positional loop: source → intensity gain → distance gain → lowpass →
   *  pan → world bus. `set` drives intensity, `setPos` re-aims the spatial
   *  chain per frame — same math as worldInput but updatable. */
  worldLoop(kind: 'noise' | 'osc' | 'sample', arg: BiquadFilterType | OscillatorType | string, opt?: number): PositionalLoop | null {
    if (!this.ctx) return null;
    const c = this.ctx;
    const inten = c.createGain(); inten.gain.value = 0;
    const dist = c.createGain(); dist.gain.value = 0;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000;
    const lp2 = c.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 20000;
    const pan = c.createStereoPanner();
    inten.connect(dist).connect(lp).connect(lp2).connect(pan).connect(this.world);
    let kill: () => void;
    let pitch: AudioParam | undefined;
    let pitchBase = 1;
    if (kind === 'sample') {
      const buf = this.buffers.get(arg as string);
      if (!buf) { inten.disconnect(); dist.disconnect(); lp.disconnect(); pan.disconnect(); return null; }
      const src = c.createBufferSource();
      src.buffer = buf; src.loop = true;
      if (opt) src.playbackRate.value = opt;
      src.connect(inten); src.start();
      kill = () => src.stop();
      pitch = src.playbackRate; pitchBase = opt ?? 1;
    } else if (kind === 'noise') {
      if (!this.noiseBuf) { inten.disconnect(); dist.disconnect(); lp.disconnect(); pan.disconnect(); return null; }
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const f = c.createBiquadFilter();
      f.type = arg as BiquadFilterType; f.frequency.value = opt ?? 1000;
      src.connect(f).connect(inten); src.start();
      kill = () => { src.stop(); f.disconnect(); };
      pitch = f.frequency; pitchBase = opt ?? 1000;
    } else {
      const o = c.createOscillator();
      o.type = arg as OscillatorType; o.frequency.value = opt ?? 90;
      o.connect(inten); o.start();
      kill = () => o.stop();
      pitch = o.frequency; pitchBase = opt ?? 90;
    }
    const setPos = (pos: THREE.Vector3, emitVel?: THREE.Vector3): void => {
      const dx = pos.x - this.listenerPos.x;
      const dy = pos.y - this.listenerPos.y;
      const dz = pos.z - this.listenerPos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      dist.gain.setTargetAtTime(d > WORLD_MAX_DIST ? 0 : 1 / (1 + d / WORLD_REF_DIST), c.currentTime, 0.08);
      const fc = airAbsorbHz(d);
      lp.frequency.setTargetAtTime(fc, c.currentTime, 0.08);
      lp2.frequency.setTargetAtTime(fc, c.currentTime, 0.08);
      pan.pan.setTargetAtTime(d > 1 ? Math.max(-1, Math.min(1,
        (dx * this.listenerRight.x + dz * this.listenerRight.z) / d)) : 0, c.currentTime, 0.08);
      const rate = this.dopplerRate(pos, emitVel);
      pitch?.setTargetAtTime(pitchBase * rate, c.currentTime, 0.08);
    };
    let alive = true;
    return {
      set: (v) => { if (alive) inten.gain.setTargetAtTime(v, c.currentTime, 0.08); },
      setPos,
      stop: () => { if (alive) { alive = false; kill(); inten.disconnect(); dist.disconnect(); lp.disconnect(); pan.disconnect(); } },
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
