// Realtime video capture of the render canvas for user-facing clip export.
// Preferred path: WebCodecs VideoEncoder with prefer-hardware → NVENC-class
// encode at ~0 fps cost, muxed to mp4 via mp4-muxer. Fallback: captureStream
// + MediaRecorder (CPU encode). Codec order prefers mp4 (shareable without
// transcoding) and falls back to webm.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

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
  private encFailed = false;
  // ShadowPlay-style rolling buffer: the last RING_MS of encoded chunks,
  // wall-clock keyed, so a clip window can be cut without re-encoding.
  // ~30MB at 12Mbps — stays RAM-only like Medal/ShadowPlay.
  private ring: { ts: number; c: EncodedVideoChunk; m?: EncodedVideoChunkMetadata }[] = [];
  private encWall = 0;
  private static RING_MS = 20_000;
  private videoW = 0;
  private videoH = 0;
  private fpsNow = 60;
  private lastFrameAt = 0;

  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
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
    // Bitrate follows encode area (~8Mbps at 1080p) instead of a flat
    // number — fast-motion game footage needs it at 1080p, but a small
    // buffer shouldn't pay a 1080p-sized stream.
    const bitrate = Math.round(src.width * src.height * 4);
    const config = {
      codec: 'avc1.640032', // H.264 High@5.0 — covers 1080p60
      width: src.width,
      height: src.height,
      bitrate: Math.min(Math.max(bitrate, 2_000_000), 12_000_000),
      framerate: fps,
      hardwarePreference: 'prefer-hardware',
      latencyMode: 'realtime',
    } as unknown as VideoEncoderConfig;
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (!supported) {return false;}
      this.mux = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: src.width, height: src.height, frameRate: fps },
        fastStart: 'in-memory',
      });
      this.encWall = performance.now();
      this.videoW = src.width;
      this.videoH = src.height;
      this.fpsNow = fps;
      this.enc = new VideoEncoder({
        output: (c, meta) => {
          // stop() detaches the muxer while the encoder still drains its
          // queue — late chunks belong to no file; drop them, don't throw.
          if (this.mux) {this.mux.addVideoChunk(c, meta);}
          const ts = this.encWall + c.timestamp / 1000;
          this.ring.push({ ts, c, m: meta });
          const cutoff = ts - VideoRecorder.RING_MS;
          while (this.ring.length > 0 && this.ring[0]!.ts < cutoff) {this.ring.shift();}
        },
        // A dead encoder must fail the clip, not silently record nothing.
        error: () => { this.encFailed = true; },
      });
      this.enc.configure(config);
      this.frameDur = 1e6 / fps;
      this.frames = 0;
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

  private startMediaRecorder(fps: number): boolean {
    const mime = MIME_PREFERENCES.find(m => MediaRecorder.isTypeSupported(m));
    if (!mime) {return false;}
    try {
      const stream = (this.staged ? this.stage! : this.canvas!).captureStream(fps);
      this.recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 12_000_000, // ~12 Mbps: crisp motion, sane file size
      });
    } catch {
      return false;
    }
    this.mime = mime;
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data.size > 0) {this.chunks.push(e.data);} };
    this.recorder.start(250); // periodic chunks so a crash keeps most of the clip
    return true;
  }

  async stop(): Promise<Blob | null> {
    if (this.enc) {
      const enc = this.enc, mux = this.mux!;
      this.enc = null;
      this.mux = null;
      this.ring = [];
      this.staged = false;
      try {
        await enc.flush();
        enc.close();
        mux.finalize();
        if (this.encFailed) {return null;}
        return new Blob([mux.target.buffer], { type: 'video/mp4' });
      } catch {
        return null;
      }
    }
    return new Promise((resolve) => {
      const r = this.recorder;
      if (!r) { resolve(null); return; }
      r.onstop = () => {
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
      // Backpressure: a stalled encoder drops frames rather than queueing
      // unbounded VideoFrames (each holds a full GPU readback).
      if (this.enc.encodeQueueSize > 30) {return;}
      // Frames arrive at the DISPLAY rate — a 144Hz render would squeeze
      // 144 stamps into 60fps timing (2.4x slow-mo clip). Gate on wall
      // clock so the mp4 runs true-speed at the configured fps on any
      // refresh rate.
      const now = performance.now();
      if (now - this.lastFrameAt < this.frameDur / 1000 * 0.9) {return;}
      this.lastFrameAt = now;
      const frame = new VideoFrame(this.staged ? this.stage! : src, { timestamp: Math.round(this.frames * this.frameDur) });
      this.enc.encode(frame, { keyFrame: this.frames % this.keyEvery === 0 });
      frame.close();
      this.frames++;
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
    for (let i = 0; i < this.ring.length; i++) {
      const r = this.ring[i]!;
      if (r.c.type === 'key' && r.ts <= startMs) {keyIdx = i;}
      if (r.ts <= endMs) {endIdx = i;} else {break;}
    }
    if (keyIdx < 0 || endIdx < keyIdx) {return null;}
    const mux = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: this.videoW, height: this.videoH, frameRate: this.fpsNow },
      fastStart: 'in-memory',
    });
    const base = this.ring[keyIdx]!.ts;
    for (let i = keyIdx; i <= endIdx; i++) {
      const r = this.ring[i]!;
      // Retimestamp relative to the leading keyframe so the clip starts at 0.
      mux.addVideoChunk(r.c, i === keyIdx ? r.m : undefined, Math.round((r.ts - base) * 1000));
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
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }
}
