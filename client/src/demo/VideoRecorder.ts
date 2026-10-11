// Realtime video capture of the render canvas for user-facing clip export.
// Preferred path: WebCodecs VideoEncoder with prefer-hardware → NVENC-class
// encode at ~0 fps cost, muxed to mp4 via mp4-muxer. Fallback: captureStream
// + MediaRecorder (CPU encode). Codec order prefers mp4 (shareable without
// transcoding) and falls back to webm.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('VideoRec');

const MIME_PREFERENCES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

// Staged export: the live canvas is whatever size the window happens to
// be, so the recorder blits it into a fixed 1920×1080 staging canvas —
// guaranteed aspect + resolution out of every clip. Drawing from a WebGL
// canvas reads a blank buffer unless preserveDrawingBuffer is on, unless
// the blit happens inside the same rAF the scene just rendered — the
// caller drives pump() from the render loop for that exact reason.
const STAGE_W = 1920;
const STAGE_H = 1080;

export class VideoRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private stage: HTMLCanvasElement | null = null;
  private stageCtx: CanvasRenderingContext2D | null = null;
  private staged = false;
  private mime = '';
  // WebCodecs hardware path
  private enc: VideoEncoder | null = null;
  private mux: Muxer<ArrayBufferTarget> | null = null;
  private frameDur = 0;
  private frames = 0;
  private keyEvery = 0;
  private lastKeyAt = 0;
  private encFailed = false;
  // ShadowPlay-style rolling buffer: the last RING_MS of encoded chunks,
  // wall-clock keyed, so a clip window can be cut without re-encoding.
  // ~30MB at 12Mbps — stays RAM-only like Medal/ShadowPlay.
  private ring: { ts: number; c: EncodedVideoChunk; m?: EncodedVideoChunkMetadata }[] = [];
  private encWall = 0;
  // Last decoderConfig the encoder emitted — cutWindow remuxes from ring
  // chunks whose stored meta may not carry one, and the muxer crashes on
  // finalize without a decoderConfig.
  private decConf: EncodedVideoChunkMetadata['decoderConfig'] | null = null;
  private static RING_MS = 20_000;
  private videoW = 0;
  private videoH = 0;
  private fpsNow = 60;
  private vmux: 'avc' | 'hevc' = 'avc';
  private qpMode = false;
  private qpKey: 'avc' | 'hevc' = 'avc';
  private lastFrameAt = 0;
  // Game audio lane: the AudioEngine's post-compressor mix feeds an
  // AudioWorklet that hands PCM to an AudioEncoder (AAC→muxer audio track,
  // opus fallback, none when unsupported — clips stay video-only then).
  private audioSrc: (() => { ctx: AudioContext; node: AudioNode } | null) | null = null;
  private aenc: AudioEncoder | null = null;
  private aWorklet: AudioWorkletNode | null = null;
  private aDecConf: EncodedAudioChunkMetadata['decoderConfig'] | null = null;
  private aring: { ts: number; c: EncodedAudioChunk; m?: EncodedAudioChunkMetadata }[] = [];
  private aSamples = 0;
  private aSampleRate = 0;
  private aCodec: 'aac' | 'opus' | null = null;
  private aPendL: number[] = [];
  private aPendR: number[] = [];
  // Recorder cost instrumentation — the two numbers that say whether
  // capture is hurting the main thread. Sampled per second, reported on
  // stop: queue growth = encoder can't keep up, pump ms = render-loop tax.
  private statQMax = 0;
  private statPumpMax = 0;
  private statPumpSum = 0;
  private statPumpN = 0;
  private statLastAt = 0;

  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  /** Audio tap provider — evaluated at start() so recording before the
   *  AudioContext unlock (first gesture) just records video-only. */
  setAudioSource(fn: () => { ctx: AudioContext; node: AudioNode } | null): void {
    this.audioSrc = fn;
  }

  get hasCanvas(): boolean { return this.canvas !== null; }

  get isRecording(): boolean { return this.recorder !== null || this.enc !== null; }
  get mimeType(): string { return this.mime; }
  get usingHardware(): boolean { return this.enc !== null; }

  static isSupported(): boolean {
    return typeof VideoEncoder !== 'undefined'
      || (typeof MediaRecorder !== 'undefined' && Boolean(HTMLCanvasElement.prototype.captureStream));
  }

  async start(fps = 60, staged = true): Promise<boolean> {
    if (this.isRecording || !this.canvas) {return false;}
    this.staged = staged;
    if (staged && !this.stage) {
      this.stage = document.createElement('canvas');
      this.stage.width = STAGE_W;
      this.stage.height = STAGE_H;
      this.stageCtx = this.stage.getContext('2d');
    }
    if (staged) {this.pump();}
    if (await this.tryWebCodecs(fps)) {return true;}
    return this.startMediaRecorder(fps);
  }

  /** WebCodecs → mp4-muxer. prefer-hardware maps to NVENC/QSV/AMF — the
   *  ShadowPlay-class path: encode cost lives on the GPU, ~0 fps impact. */
  private async tryWebCodecs(fps: number): Promise<boolean> {
    if (typeof VideoEncoder === 'undefined') {return false;}
    const src = (this.staged ? this.stage : this.canvas)!;
    // hardwarePreference predates TS's DOM lib — it selects NVENC/QSV/AMF
    // when the platform exposes a hardware encoder.
    // Bitrate follows encode area: fast-motion footage is the worst case
    // for block artifacts, so the multiplier is generous (~12Mbps at
    // 1080p, capped at 25) — VBR only spends it on hard frames.
    const bitrate = Math.round(src.width * src.height * 6);
    const base = {
      width: src.width,
      height: src.height,
      bitrate: Math.min(Math.max(bitrate, 4_000_000), 25_000_000),
      framerate: fps,
      hardwarePreference: 'prefer-hardware',
      // Quality over realtime: lookahead + B-frames are the difference
      // between visible block artifacts and clean footage — the tiny
      // encode latency doesn't matter for a ring buffer.
      latencyMode: 'quality',
    } as unknown as VideoEncoderConfig;
    // Codec ladder: HEVC first (NVENC does it — ~25% better quality per
    // bit), then H.264 High. Quantizer mode (fixed QP ≈ visually
    // lossless) beats VBR where the encoder supports it.
    const ladders: { codec: string; muxCodec: 'hevc' | 'avc'; qKey: 'hevc' | 'avc' }[] = [
      { codec: 'hvc1.1.6.L156.B0', muxCodec: 'hevc', qKey: 'hevc' },
      { codec: 'hev1.1.6.L156.B0', muxCodec: 'hevc', qKey: 'hevc' },
      { codec: 'avc1.640032', muxCodec: 'avc', qKey: 'avc' },
    ];
    let chosen: (typeof ladders)[number] | null = null;
    let config: VideoEncoderConfig | null = null;
    let qpMode = false;
    try {
      outer:
      for (const cand of ladders) {
        for (const variant of [
          (Object.assign({}, base, {codec: cand.codec,bitrateMode: 'quantizer'})) as VideoEncoderConfig,
          (Object.assign({}, base, {codec: cand.codec,bitrateMode: 'variable'})) as VideoEncoderConfig,
          (Object.assign({}, base, {codec: cand.codec,latencyMode: 'realtime'})) as VideoEncoderConfig,
        ]) {
          const { supported } = await VideoEncoder.isConfigSupported(variant);
          if (supported) {
            chosen = cand;
            config = variant;
            qpMode = variant.bitrateMode === 'quantizer';
            break outer;
          }
        }
      }
      if (!config || !chosen) {return false;}
      const audioCfg = await this.probeAudio();
      this.mux = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: chosen.muxCodec, width: src.width, height: src.height, frameRate: fps },
        audio: audioCfg
          ? { codec: audioCfg.muxCodec, sampleRate: audioCfg.ctx.sampleRate, numberOfChannels: 2 }
          : undefined,
        // Wall-clock frame stamps make the first chunk land at wherever
        // the first pumped frame happened — offset rebases it to 0
        // instead of throwing on non-zero DTS.
        firstTimestampBehavior: 'offset',
        fastStart: 'in-memory',
      });
      this.encWall = performance.now();
      this.videoW = src.width;
      this.videoH = src.height;
      this.fpsNow = fps;
      this.enc = new VideoEncoder({
        output: (c, meta): void => {
          if (meta?.decoderConfig) {this.decConf = meta.decoderConfig;}
          // stop() detaches the muxer while the encoder still drains its
          // queue — late chunks belong to no file; drop them, don't throw.
          if (this.mux) {this.mux.addVideoChunk(c, meta);}
          const ts = this.encWall + c.timestamp / 1000;
          this.ring.push({ ts, c, m: meta });
          const cutoff = ts - VideoRecorder.RING_MS;
          while (this.ring.length > 0 && this.ring[0]!.ts < cutoff) {this.ring.shift();}
        },
        // A dead encoder must fail the clip, not silently record nothing.
        error: (): void => { this.encFailed = true; },
      });
      this.enc.configure(config);
      this.vmux = chosen.muxCodec;
      this.qpMode = qpMode;
      this.qpKey = chosen.qKey;
      if (audioCfg) {await this.startAudio(audioCfg);}
      this.frameDur = 1e6 / fps;
      this.frames = 0;
      this.statQMax = 0;
      this.statPumpMax = 0;
      this.statPumpSum = 0;
      this.statPumpN = 0;
      this.statLastAt = performance.now();
      this.keyEvery = fps * 2; // IDR every 2s — the mp4 trim granularity
      this.encFailed = false;
      this.mime = 'video/mp4';
      return true;
    } catch {
      this.enc = null;
      this.mux = null;
      return false;
    }
  }

  /** Probe the audio tap + encoder support. AAC first (mp4-native), opus
   *  fallback — mp4-muxer takes both. Null = record video-only. */
  private async probeAudio(): Promise<{ ctx: AudioContext; node: AudioNode; codec: string; muxCodec: 'aac' | 'opus' } | null> {
    const src = this.audioSrc?.();
    if (!src || typeof AudioEncoder === 'undefined') {return null;}
    for (const cand of [{ codec: 'mp4a.40.2', muxCodec: 'aac' as const }, { codec: 'opus', muxCodec: 'opus' as const }]) {
      const cfg: AudioEncoderConfig = {
        codec: cand.codec, sampleRate: src.ctx.sampleRate, numberOfChannels: 2, bitrate: 128_000,
      };
      try {
        const { supported } = await AudioEncoder.isConfigSupported(cfg);
        if (supported) {return Object.assign({}, src, cand);}
      } catch { /* next candidate */ }
    }
    return null;
  }

  /** AudioWorklet → PCM → AudioData → encoder. The worklet posts each
   *  128-sample render block; we pack them into ~1024-sample frames,
   *  timestamped by sample count so they stay glued to the wall base. */
  private async startAudio(a: { ctx: AudioContext; node: AudioNode; codec: string; muxCodec: 'aac' | 'opus' }): Promise<void> {
    this.aenc = new AudioEncoder({
      output: (c, meta): void => {
        if (meta?.decoderConfig) {this.aDecConf = meta.decoderConfig;}
        if (this.mux) {this.mux.addAudioChunk(c, meta);}
        const ts = this.encWall + c.timestamp / 1000;
        this.aring.push({ ts, c, m: meta });
        const cutoff = ts - VideoRecorder.RING_MS;
        while (this.aring.length > 0 && this.aring[0]!.ts < cutoff) {this.aring.shift();}
      },
      error: (): void => { this.encFailed = true; },
    });
    this.aenc.configure({ codec: a.codec, sampleRate: a.ctx.sampleRate, numberOfChannels: 2, bitrate: 128_000 });
    this.aSampleRate = a.ctx.sampleRate;
    this.aCodec = a.muxCodec;
    // Inline worklet — a blob URL keeps it a single-file module.
    const wsrc = `class Cap extends AudioWorkletProcessor{process(i){const n=i[0];if(n&&n[0]){this.port.postMessage([n[0].slice(0),(n[1]||n[0]).slice(0)])}return true}}registerProcessor('cap',Cap)`;
    const url = URL.createObjectURL(new Blob([wsrc], { type: 'application/javascript' }));
    try {
      await a.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.aWorklet = new AudioWorkletNode(a.ctx, 'cap', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.aWorklet.port.onmessage = (e: MessageEvent<Float32Array[]>): void => this.onPcm(e.data[0]!, e.data[1]!);
    a.node.connect(this.aWorklet);
    this.aSamples = 0;
    this.aPendL = [];
    this.aPendR = [];
    this.aring = [];
    this.aDecConf = null;
  }

  private onPcm(l: Float32Array, r: Float32Array): void {
    if (!this.aenc || this.aenc.state !== 'configured') {return;}
    this.aPendL.push(...l); this.aPendR.push(...r);
    const FRAME = 2048; // ~43ms at 48k — big enough to keep encode cheap
    while (this.aPendL.length >= FRAME) {
      const inter = new Float32Array(FRAME * 2);
      inter.set(this.aPendL.slice(0, FRAME), 0);
      inter.set(this.aPendR.slice(0, FRAME), FRAME);
      this.aPendL = this.aPendL.slice(FRAME);
      this.aPendR = this.aPendR.slice(FRAME);
      const ts = Math.round(this.aSamples / this.aSampleRate * 1e6);
      this.aSamples += FRAME;
      const data = new AudioData({
        format: 'f32-planar', sampleRate: this.aSampleRate,
        numberOfFrames: FRAME, numberOfChannels: 2, timestamp: ts, data: inter,
      });
      this.aenc.encode(data);
      data.close();
    }
  }

  private startMediaRecorder(fps: number): boolean {
    const mime = MIME_PREFERENCES.find((m): boolean => MediaRecorder.isTypeSupported(m));
    if (!mime) {return false;}
    try {
      const stream = (this.staged ? this.stage! : this.canvas!).captureStream(fps);
      // Fallback path gets sound for free — MediaRecorder mixes tracks.
      const src = this.audioSrc?.();
      if (src) {
        const dest = src.ctx.createMediaStreamDestination();
        src.node.connect(dest);
        stream.addTrack(dest.stream.getAudioTracks()[0]!);
      }
      this.recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 25_000_000, // fast-motion needs headroom; browsers clamp what they can't do
      });
    } catch {
      return false;
    }
    this.mime = mime;
    this.chunks = [];
    this.recorder.ondataavailable = (e): void => { if (e.data.size > 0) {this.chunks.push(e.data);} };
    this.recorder.start(250); // periodic chunks so a crash keeps most of the clip
    return true;
  }

  async stop(): Promise<Blob | null> {
    if (this.enc) {
      const {enc} = this, mux = this.mux!, {aenc} = this;
      this.enc = null;
      this.mux = null;
      this.ring = [];
      this.staged = false;
      logger.info(`rec done ${this.frames}f qMax=${this.statQMax} pumpMax=${this.statPumpMax.toFixed(2)}ms pumpAvg=${(this.statPumpSum / Math.max(1, this.statPumpN)).toFixed(2)}ms codec=${this.vmux}${this.qpMode ? '+qp' : ''}`);
      try {
        if (aenc) {
          // Disconnect the tap first so no more PCM lands on a closing codec.
          this.aWorklet?.disconnect();
          this.aWorklet = null;
          if (aenc.state === 'configured') {
            await aenc.flush();
            aenc.close();
          }
        }
        this.aenc = null;
        await enc.flush();
        enc.close();
        mux.finalize();
        if (this.encFailed) {return null;}
        return new Blob([mux.target.buffer], { type: 'video/mp4' });
      } catch {
        return null;
      }
    }
    return new Promise((resolve): void => {
      const r = this.recorder;
      if (!r) { resolve(null); return; }
      r.onstop = (): void => {
        const type = this.mime.split(';')[0] || 'video/webm';
        resolve(this.chunks.length > 0 ? new Blob(this.chunks, { type }) : null);
        this.chunks = [];
        this.recorder = null;
      };
      r.stop();
      this.staged = false;
    });
  }

  /** Blit the live canvas into the staging canvas — call once per rendered
   *  frame while recording staged (from the render loop, so the WebGL
   *  buffer is still live). contain-fit + black bars, same letterbox math
   *  a player expects from a 16:9 export of a non-16:9 window. */
  pump(): void {
    if (!this.canvas) {return;}
    const src = this.canvas;
    if (this.staged && this.stageCtx) {
      const scale = Math.min(STAGE_W / src.width, STAGE_H / src.height);
      const w = src.width * scale, h = src.height * scale;
      const dx = (STAGE_W - w) / 2, dy = (STAGE_H - h) / 2;
      this.stageCtx.fillStyle = '#000';
      this.stageCtx.fillRect(0, 0, STAGE_W, STAGE_H);
      this.stageCtx.drawImage(src, 0, 0, src.width, src.height, dx, dy, w, h);
    }
    if (this.enc) {
      // The error callback closes the codec but keeps this.enc set —
      // encode on a closed codec throws InvalidStateError.
      if (this.enc.state !== 'configured') {return;}
      // Backpressure: a stalled encoder drops frames rather than queueing
      // unbounded VideoFrames (each holds a full GPU readback).
      if (this.enc.encodeQueueSize > 30) {return;}
      // Frames arrive at the DISPLAY rate and must stamp at wall time,
      // not counter*fps: 144Hz squeezes into 60fps timing (slow-mo clip),
      // sub-60 stretches it (fast-forward). Wall stamps keep the mp4
      // true-speed at any render rate; the cap just bounds encode work.
      const now = performance.now();
      if (now - this.lastFrameAt < this.frameDur / 1000 * 0.9) {return;}
      this.lastFrameAt = now;
      const ts = Math.round((now - this.encWall) * 1000); // µs
      const p0 = performance.now();
      const frame = new VideoFrame(this.staged ? this.stage! : src, { timestamp: ts });
      const opts: VideoEncoderEncodeOptions & Record<string, unknown> = { keyFrame: now - this.lastKeyAt >= 2000 };
      // Fixed-QP ≈ visually lossless: bitrate config is ignored, QP 22 is
      // the game-footage sweet spot (20 for near-transparent).
      if (this.qpMode) {opts[this.qpKey] = { quantizer: 22 };}
      this.enc.encode(frame, opts);
      if (now - this.lastKeyAt >= 2000) {this.lastKeyAt = now;}
      frame.close();
this.frames += 1;
      const pumpMs = performance.now() - p0;
      const q = this.enc.encodeQueueSize;
      if (q > this.statQMax) {this.statQMax = q;}
      if (pumpMs > this.statPumpMax) {this.statPumpMax = pumpMs;}
      this.statPumpSum += pumpMs;this.statPumpN += 1;
      if (now - this.statLastAt >= 5000) {
        this.statLastAt = now;
        logger.info(`rec stats qMax=${this.statQMax} pump=${pumpMs.toFixed(2)}ms pumpAvg=${(this.statPumpSum / Math.max(1, this.statPumpN)).toFixed(2)}ms`);
      }
    }
  }

  /** Cut [startMs, endMs] (performance.now() wall clock) out of the rolling
   *  buffer into a standalone mp4. Returns null when the window isn't in the
   *  ring (video wasn't rolling then) or on the MediaRecorder fallback path
   *  (opaque muxed chunks can't be re-spliced). Start lands on the previous
   *  keyframe — up to GOP (2s) of preroll; the end is frame-accurate. */
  cutWindow(startMs: number, endMs: number): Blob | null {
    if (!this.enc || this.ring.length === 0) {return null;}
    let keyIdx = -1, endIdx = -1;
    for (let i = 0; i < this.ring.length; i += 1) {
      const r = this.ring[i]!;
      if (r.c.type === 'key' && r.ts <= startMs) {keyIdx = i;}
      if (r.ts <= endMs) {endIdx = i;} else {break;}
    }
    if (keyIdx < 0 || endIdx < keyIdx) {return null;}
    const mux = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: this.vmux, width: this.videoW, height: this.videoH, frameRate: this.fpsNow },
      audio: this.aCodec ? { codec: this.aCodec, sampleRate: this.aSampleRate, numberOfChannels: 2 } : undefined,
      fastStart: 'in-memory',
    });
    const base = this.ring[keyIdx]!.ts;
    for (let i = keyIdx; i <= endIdx; i += 1) {
      const r = this.ring[i]!;
      // Retimestamp relative to the leading keyframe so the clip starts at 0.
      // The muxer only learns decoderConfig from a meta that carries it —
      // the stored meta may lack one, so fall back to the last config seen.
      const meta = i === keyIdx
        ? (r.m?.decoderConfig ? r.m : this.decConf ? { decoderConfig: this.decConf } : r.m)
        : undefined;
      mux.addVideoChunk(r.c, meta, Math.round((r.ts - base) * 1000));
    }
    if (this.aCodec) {
      let firstAudio = true;
      for (const r of this.aring) {
        if (r.ts < base || r.ts > this.ring[endIdx]!.ts) {continue;}
        const meta = firstAudio
          ? (r.m?.decoderConfig ? r.m : this.aDecConf ? { decoderConfig: this.aDecConf } : r.m)
          : undefined;
        mux.addAudioChunk(r.c, meta, Math.round((r.ts - base) * 1000));
        firstAudio = false;
      }
    }
    mux.finalize();
    return new Blob([mux.target.buffer], { type: 'video/mp4' });
  }

  async stopAndDownload(filename = 'kribes_clip'): Promise<boolean> {
    const blob = await this.stop();
    if (!blob) {return false;}
    const ext = this.mime.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.${ext}`;
    a.click();
    setTimeout((): void => URL.revokeObjectURL(url), 10_000);
    return true;
  }
}
