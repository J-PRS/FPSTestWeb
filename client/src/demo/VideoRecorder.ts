// Realtime video capture of the render canvas for user-facing clip export.
// Preferred path: WebCodecs VideoEncoder with prefer-hardware → NVENC-class
// encode at ~0 fps cost, muxed to mp4 via mp4-muxer. Fallback: captureStream
// + MediaRecorder (CPU encode). Codec order prefers mp4 (shareable without
// transcoding) and falls back to webm.

import { Output, Mp4OutputFormat, BufferTarget, EncodedPacket, EncodedVideoPacketSource, EncodedAudioPacketSource } from 'mediabunny';
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

// TS DOM lib predates MediaStreamTrackProcessor (Chrome 94+, Safari 17+).
interface TrackProcessor { readable: ReadableStream<VideoFrame> }
declare const MediaStreamTrackProcessor: { new (init: { track: MediaStreamTrack }): TrackProcessor } | undefined;

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
  private out: Output<Mp4OutputFormat, BufferTarget> | null = null;
  private vsrc: EncodedVideoPacketSource | null = null;
  private asrc: EncodedAudioPacketSource | null = null;
  private baseTsUs = -1; // first video chunk anchors the file at t=0
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
  private vmux: 'avc' | 'hevc' | 'av1' = 'avc';
  private qpMode = false;
  private qpKey: 'avc' | 'hevc' | 'av01' = 'avc';
  private lastFrameAt = 0;
  private static capSeq = 0;
  // Track-capture lane (ShadowPlay-tier): captureStream taps the canvas's
  // presented buffer at display cadence and MediaStreamTrackProcessor
  // hands ready-made GPU VideoFrames with true presentation timestamps —
  // the render thread is no longer in the capture path. Manual pump()
  // frames remain the fallback where TrackProcessor doesn't exist.
  private vReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private vTrack: MediaStreamTrack | null = null;
  private trackCap = false;
  // Track timestamps are µs on the same monotonic clock as
  // performance.now() in practice, but the epoch is opaque — measure the
  // shift once on the first frame and stamp pump()-path frames in the
  // same space so a mid-recording lane swap can't create DTS disorder.
  private tsShift: number | null = null;
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
  // PCM carry: worklet blocks are 128 samples, encode frames are 2048 —
  // a grow-once Float32Array + memmove instead of slice() churn ~375×/s.
  private aCarry = new Float32Array(0);
  private aCarryN = 0;
  private aInter = new Float32Array(0);
  // Recorder cost instrumentation — the two numbers that say whether
  // capture is hurting the main thread. Sampled per second, reported on
  // stop: queue growth = encoder can't keep up, pump ms = render-loop tax.
  private statQMax = 0;
  private statPumpMax = 0;
  private statPumpSum = 0;
  private statPumpN = 0;
  private statBlitSum = 0;
  private statBlitN = 0;
  private statLastAt = 0;
  // Last cutWindow() result - the probe can't see in-page console, so the
  // trim diagnostics land here instead.
  lastCut: Record<string, unknown> | null = null;
  /** Recorder cost snapshot - same numbers the `rec done` log line reports,
   *  readable from the test hook where console info-level is filtered out. */
  get stats(): { frames: number; qMax: number; pumpAvg: number; pumpMax: number; blitAvg: number } {
    return {
      frames: this.frames,
      qMax: this.statQMax,
      pumpAvg: this.statPumpSum / Math.max(1, this.statPumpN),
      pumpMax: this.statPumpMax,
      blitAvg: this.statBlitSum / Math.max(1, this.statBlitN),
    };
  }

  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  /** Audio tap provider — evaluated at start() so recording before the
   *  AudioContext unlock (first gesture) just records video-only. */
  setAudioSource(fn: () => { ctx: AudioContext; node: AudioNode } | null): void {
    this.audioSrc = fn;
  }

  /** Alt+Q row — everything needed to answer "did F9 do anything". */
  get diag(): Record<string, unknown> {
    return {
      on: this.isRecording,
      path: this.enc ? `webcodecs-${this.trackCap ? 'track' : 'pump'}-${this.vmux}` : this.recorder ? 'mediarec' : 'off',
      ...(this.enc ? { frames: this.frames, paints: this.statBlitN, ring: this.ring.length, qMax: this.statQMax } : {}),
      ...(this.aenc ? { audio: this.aCodec } : {}),
      ...(this.encFailed ? { encFailed: true } : {}),
      ...(this.lastCut ? { lastCut: this.lastCut } : {}),
      canvas: this.canvas !== null,
      supported: VideoRecorder.isSupported(),
    };
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
    // AV1 first: RTX40/RDNA3/Arc do HW encode at ~30% better quality/bit
    // than HEVC. isConfigSupported gates it - falls through on older GPUs.
    const ladders: { codec: string; muxCodec: 'hevc' | 'avc' | 'av1'; qKey: 'hevc' | 'avc' | 'av01' }[] = [
      { codec: 'av01.0.13M.08', muxCodec: 'av1', qKey: 'av01' },
      { codec: 'av01.0.08M.08', muxCodec: 'av1', qKey: 'av01' },
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
          // L1T3 temporal layers on VBR only: cutWindow can trim at
          // 1/3-rate granularity instead of GOP (2s) boundaries - tighter
          // clip starts. QP mode doesn't support layering; putting it on
          // the QP config would lose the preferred variant entirely.
          (Object.assign({}, base, {codec: cand.codec,bitrateMode: 'variable',scalabilityMode: 'L1T3'})) as VideoEncoderConfig,
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
      this.out = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: new BufferTarget(),
      });
      this.vsrc = new EncodedVideoPacketSource(chosen.muxCodec);
      this.out.addVideoTrack(this.vsrc);
      if (audioCfg) {
        this.asrc = new EncodedAudioPacketSource(audioCfg.muxCodec);
        this.out.addAudioTrack(this.asrc);
      }
      await this.out.start();
      this.baseTsUs = -1;
      this.encWall = performance.now();
      this.videoW = src.width;
      this.videoH = src.height;
      this.fpsNow = fps;
      this.enc = new VideoEncoder({
        output: (c, meta): void => {
          if (meta?.decoderConfig) {this.decConf = meta.decoderConfig;}
          // stop() keeps vsrc live through enc.flush() so the drained
          // tail lands — detach happens at finalize, not here.
          if (this.vsrc) {
            if (this.baseTsUs < 0) {this.baseTsUs = c.timestamp;}
            this.vsrc.add(this.chunkPacket(c, c.timestamp - this.baseTsUs), meta)
              .catch((): void => { this.encFailed = true; });
          }
          // c.timestamp lives in the tsShift epoch; subtracting lands it
          // back on performance.now() wall-ms, matching cutWindow's clock.
          const ts = (c.timestamp - (this.tsShift ?? 0)) / 1000;
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
      this.frameDur = 1e6 / fps;
      // Track capture first: frames arrive at presentation cadence with
      // real timestamps. If the platform lacks it, pump() keeps feeding
      // the encoder manually — the pipeline below doesn't care which.
      this.trackCap = this.startTrackCapture(src);
      if (audioCfg) {await this.startAudio(audioCfg);}
      this.frames = 0;
      this.statQMax = 0;
      this.statPumpMax = 0;
      this.statPumpSum = 0;
      this.statPumpN = 0;
      this.statBlitSum = 0;
      this.statBlitN = 0;
      this.statLastAt = performance.now();
      this.keyEvery = fps * 2; // IDR every 2s — the mp4 trim granularity
      this.encFailed = false;
      this.mime = 'video/mp4';
      return true;
    } catch {
      this.enc = null;
      this.out = null;
      this.vsrc = null;
      this.asrc = null;
      return false;
    }
  }

  /** Vsync-cadence capture: the browser emits a VideoFrame each time the
   *  canvas's presented buffer updates — dedup'd, GPU-resident, stamped
   *  at present time. Returns false where TrackProcessor is missing and
   *  the caller leaves pump() on the manual path. */
  private startTrackCapture(src: HTMLCanvasElement): boolean {
    if (typeof MediaStreamTrackProcessor === 'undefined') {return false;}
    try {
      // captureStream(0) = manual mode: nothing emits until pump() calls
      // requestFrame() after a real paint — emit is exactly 1:1 with
      // rendered frames, no browser-side pacing heuristic between us and
      // the presented buffer. statBlitN vs frames proves parity.
      const [track] = src.captureStream(0).getVideoTracks();
      if (!track) {return false;}
      const proc = new MediaStreamTrackProcessor({ track });
      const reader = proc.readable.getReader();
      this.vTrack = track;
      this.vReader = reader;
      this.tsShift = null;
      this.drainTrack(reader).catch((): void => undefined);
      return true;
    } catch {
      return false;
    }
  }

  private async drainTrack(reader: ReadableStreamDefaultReader<VideoFrame>): Promise<void> {
    try {
      for (;;) {
        const { value: f, done } = await reader.read();
        if (done || !f) {break;}
        const {enc} = this;
        // Encode backpressure mirrors pump()'s queue cap: a stalled
        // encoder drops the presented frame rather than queueing a
        // GPU readback apiece.
        if (enc && enc.state === 'configured' && enc.encodeQueueSize <= 30) {
          // Feed the track frame raw — no re-wrap. First frame pins the
          // opaque track epoch against performance.now() for tsShift.
          if (this.tsShift === null) {this.tsShift = f.timestamp - performance.now() * 1000;}
          const now = performance.now();
          const opts: VideoEncoderEncodeOptions & Record<string, unknown> = { keyFrame: now - this.lastKeyAt >= 2000 };
          if (this.qpMode) {opts[this.qpKey] = { quantizer: 22 };}
          enc.encode(f, opts);
          if (now - this.lastKeyAt >= 2000) {this.lastKeyAt = now;}
          this.frames += 1;
          const q = enc.encodeQueueSize;
          if (q > this.statQMax) {this.statQMax = q;}
        }
        f.close();
      }
    } catch { /* reader cancelled on stop, or the track ended */ }
    // Track died mid-recording → hand the lane back to manual pump()
    // rather than encoding silence for the rest of the clip.
    if (this.enc) {this.trackCap = false;}
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
        if (this.asrc) {
          this.asrc.add(this.chunkPacket(c, c.timestamp), meta)
            .catch((): void => { this.encFailed = true; });
        }
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
    // Inline worklet — a blob URL keeps it a single-file module. The
    // processor name must be unique per start: a second recording on the
    // same AudioContext re-registers and 'cap' collides, killing start().
    const capName = `cap${VideoRecorder.capSeq++}`;
    const wsrc = `class Cap extends AudioWorkletProcessor{process(i){const n=i[0];if(n&&n[0]){this.port.postMessage([n[0].slice(0),(n[1]||n[0]).slice(0)])}return true}}registerProcessor('${capName}',Cap)`;
    const url = URL.createObjectURL(new Blob([wsrc], { type: 'application/javascript' }));
    try {
      await a.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.aWorklet = new AudioWorkletNode(a.ctx, capName, { numberOfInputs: 1, numberOfOutputs: 0 });
    this.aWorklet.port.addEventListener('message', (e: MessageEvent<Float32Array[]>): void => this.onPcm(e.data[0]!, e.data[1]!));
    a.node.connect(this.aWorklet);
    this.aSamples = 0;
    this.aCarryN = 0;
    this.aring = [];
    this.aDecConf = null;
  }

  private onPcm(l: Float32Array, r: Float32Array): void {
    if (!this.aenc || this.aenc.state !== 'configured') {return;}
    const n = l.length;
    if (this.aCarry.length < (this.aCarryN + n) * 2) {
      const next = new Float32Array((this.aCarryN + n) * 4);
      next.set(this.aCarry.subarray(0, this.aCarryN), 0);
      next.set(this.aCarry.subarray(this.aCarry.length / 2, this.aCarry.length / 2 + this.aCarryN), next.length / 2);
      this.aCarry = next;
    }
    const half = this.aCarry.length / 2;
    this.aCarry.set(l, this.aCarryN);
    this.aCarry.set(r, half + this.aCarryN);
    this.aCarryN += n;
    const FRAME = 2048; // ~43ms at 48k — big enough to keep encode cheap
    if (this.aInter.length !== FRAME * 2) {this.aInter = new Float32Array(FRAME * 2);}
    while (this.aCarryN >= FRAME) {
      this.aInter.set(this.aCarry.subarray(0, FRAME), 0);
      this.aInter.set(this.aCarry.subarray(half, half + FRAME), FRAME);
      this.aCarry.copyWithin(0, FRAME, this.aCarryN);
      this.aCarry.copyWithin(half, half + FRAME, half + this.aCarryN);
      this.aCarryN -= FRAME;
      const ts = Math.round(this.aSamples / this.aSampleRate * 1e6);
      this.aSamples += FRAME;
      const data = new AudioData({
        format: 'f32-planar', sampleRate: this.aSampleRate,
        numberOfFrames: FRAME, numberOfChannels: 2, timestamp: ts, data: this.aInter,
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
      const {enc} = this, out = this.out!, {aenc} = this, reader = this.vReader, track = this.vTrack;
      this.enc = null;
      this.ring = [];
      this.staged = false;
      this.vReader = null;
      this.vTrack = null;
      this.trackCap = false;
      // Cancel the capture tap before flush so no frames queue behind the
      // drain — reader.cancel() makes drainTrack's read() resolve done.
      if (reader) {reader.cancel().catch((): void => undefined);}
      track?.stop();
      logger.info(`rec done ${this.frames}f qMax=${this.statQMax} pumpMax=${this.statPumpMax.toFixed(2)}ms pumpAvg=${(this.statPumpSum / Math.max(1, this.statPumpN)).toFixed(2)}ms blitAvg=${(this.statBlitSum / Math.max(1, this.statBlitN)).toFixed(2)}ms codec=${this.vmux}${this.qpMode ? '+qp' : ''}`);
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
        // vsrc stays live through the flush — quality-mode encoders hold
        // reordered tail frames (B-frame lookahead) that used to die here.
        await enc.flush();
        enc.close();
        this.vsrc?.close();
        this.asrc?.close();
        await out.finalize();
        this.vsrc = null;
        this.asrc = null;
        this.out = null;
        // A mid-flight encoder error used to void the whole clip; a
        // partial file (frames up to the failure) is strictly better.
        if (this.encFailed) {logger.warn(`encoder failed mid-recording — salvaging ${this.frames}f`);}
        return new Blob([out.target.buffer!], { type: 'video/mp4' });
      } catch {
        this.vsrc = null;
        this.asrc = null;
        this.out = null;
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
  // Held during offline clip render — stepped frames go to renderClip's
  // own encoder, not the realtime ring.
  suspended = false;

  get canvasEl(): HTMLCanvasElement | null { return this.canvas; }

  /** Fresh bytes per chunk — the muxer retains the array until
   *  finalize(), so a reused scratch buffer corrupts every prior chunk
   *  (the "Invalid OBU length" garbled-AV1 bug). A few KB per chunk at
   *  encode rate is nothing vs the corruption it caused. */
  private chunkPacket(c: EncodedVideoChunk | EncodedAudioChunk, tsUs: number): EncodedPacket {
    const data = new Uint8Array(c.byteLength);
    c.copyTo(data);
    const dur = Number.isFinite(c.duration) && c.duration! > 0 ? c.duration! : 0;
    return new EncodedPacket(data, c.type, tsUs / 1e6, dur / 1e6);
  }

  pump(): void {
    if (!this.canvas || this.suspended) {return;}
    const src = this.canvas;
    if (this.staged && this.stageCtx) {
      const b0 = performance.now();
      const scale = Math.min(STAGE_W / src.width, STAGE_H / src.height);
      const w = src.width * scale, h = src.height * scale;
      const dx = (STAGE_W - w) / 2, dy = (STAGE_H - h) / 2;
      this.stageCtx.fillStyle = '#000';
      this.stageCtx.fillRect(0, 0, STAGE_W, STAGE_H);
      this.stageCtx.drawImage(src, 0, 0, src.width, src.height, dx, dy, w, h);
      this.statBlitSum += performance.now() - b0;
      this.statBlitN += 1;
    }
    // Pull-mode capture: emit exactly one track frame per blit/paint.
    (this.vTrack as unknown as { requestFrame?: () => void } | null)?.requestFrame?.();
    if (this.enc && !this.trackCap) {
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
      const ts = Math.round(now * 1000 + (this.tsShift ?? 0)); // µs, same epoch as track frames
      const p0 = performance.now();
      const frame = new VideoFrame(this.staged ? this.stage! : src, { timestamp: ts, duration: Math.round(this.frameDur) });
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
        logger.info(`rec stats qMax=${this.statQMax} pump=${pumpMs.toFixed(2)}ms pumpAvg=${(this.statPumpSum / Math.max(1, this.statPumpN)).toFixed(2)}ms blitAvg=${(this.statBlitSum / Math.max(1, this.statBlitN)).toFixed(2)}ms`);
      }
    }
  }

  /** Cut [startMs, endMs] (performance.now() wall clock) out of the rolling
   *  buffer into a standalone mp4. Returns null when the window isn't in the
   *  ring (video wasn't rolling then) or on the MediaRecorder fallback path
   *  (opaque muxed chunks can't be re-spliced). Start lands on the previous
   *  keyframe — up to GOP (2s) of preroll; the end is frame-accurate. */
  async cutWindow(startMs: number, endMs: number): Promise<Blob | null> {
    if (!this.enc || this.ring.length === 0) {return null;}
    let keyIdx = -1, endIdx = -1;
    for (let i = 0; i < this.ring.length; i += 1) {
      const r = this.ring[i]!;
      if (r.c.type === 'key' && r.ts <= startMs) {keyIdx = i;}
      if (r.ts <= endMs) {endIdx = i;} else {break;}
    }
    if (keyIdx < 0 || endIdx < keyIdx) {
      this.lastCut = { keyIdx, endIdx, added: 0, failed: 0, bytes: 0, why: keyIdx < 0 ? 'no keyframe before start' : 'end before key' };
      return null;
    }
    const target = new BufferTarget();
    const out = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const vs = new EncodedVideoPacketSource(this.vmux);
    out.addVideoTrack(vs);
    let as: EncodedAudioPacketSource | null = null;
    if (this.aCodec) {
      as = new EncodedAudioPacketSource(this.aCodec);
      out.addAudioTrack(as);
    }
    await out.start();
    const base = this.ring[keyIdx]!.ts;
    let added = 0, failed = 0;
    for (let i = keyIdx; i <= endIdx; i += 1) {
      const r = this.ring[i]!;
      // Retimestamp relative to the leading keyframe so the clip starts at 0.
      // The muxer only learns decoderConfig from a meta that carries it —
      // the stored meta may lack one, so fall back to the last config seen.
      let meta;
      if (i === keyIdx) {
        meta = r.m;
        if (!meta?.decoderConfig && this.decConf) {meta = { decoderConfig: this.decConf };}
      }
      try { await vs.add(this.chunkPacket(r.c, Math.round((r.ts - base) * 1000)), meta); added += 1; }
      catch (error) { failed += 1; if (failed === 1) {logger.warn('cutWindow add:', error);} }
    }
    if (as) {
      let firstAudio = true;
      for (const r of this.aring) {
        if (r.ts < base || r.ts > this.ring[endIdx]!.ts) {continue;}
        let meta;
        if (firstAudio) {
          meta = r.m;
          if (!meta?.decoderConfig && this.aDecConf) {meta = { decoderConfig: this.aDecConf };}
        }
        await as.add(this.chunkPacket(r.c, Math.round((r.ts - base) * 1000)), meta);
        firstAudio = false;
      }
      as.close();
    }
    vs.close();
    await out.finalize();
    this.lastCut = { keyIdx, endIdx, added, failed, bytes: target.buffer?.byteLength ?? 0, why: failed > 0 ? 'add threw' : '' };
    return new Blob([target.buffer!], { type: 'video/mp4' });
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
