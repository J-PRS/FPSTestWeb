// Offline stepped demo→mp4 render — the TF2-path twin of VideoRecorder's
// realtime capture. Seeks to t0, scrubs the player at fixed 1/fps steps,
// renders each frame synchronously and encodes VideoFrames with authored
// (step-index) timestamps. Output is frame-perfect at any machine speed
// and typically runs 2-5x faster than realtime; the wall-clock capture
// path in VideoRecorder.ts stays for live clips / comparison.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { DemoPlayer } from './DemoPlayer.js';

export interface RenderClipOpts {
  player: DemoPlayer;
  canvas: HTMLCanvasElement;
  /** One full render pass (gameLoop renderFrame — composer + viewmodel). */
  renderFrame: (dt: number) => void;
  /** Replica pose+anim per step — onRemotePlayback(getRemoteStates(), dt)
   *  so limbs/trails animate at demo rate, not wall rate. */
  snapRemotes?: (dt: number) => void;
  /** Playback-world tick per step (projectiles, rail beams) — without it
   *  they only get wall-dt from the live loop and fly at render speed. */
  tickFx?: (dt: number) => void;
  /** Arms seek-baseline reconstruction — needed when start > 0 so
   *  entities whose Spawned edges predate the window still appear. */
  armSeek?: () => void;
  /** Abort check (ESC/stop mid-render) — returns true → early null. */
  abort?: () => boolean;
  start: number;
  end: number;
  fps?: number;
}

// Encoder backpressure ceiling — unbounded VideoFrame queue holds full
// GPU readbacks; park the stepper until it drains.
const QUEUE_HI = 30;
const QUEUE_LO = 20;
// Same fixed output as the realtime path — the game canvas is rarely
// fullscreen, so renders letterbox-fit into staged 1920×1080.
const STAGE_W = 1920;
const STAGE_H = 1080;

const sleep = (ms: number): Promise<void> => new Promise<void>((r): void => { setTimeout(r, ms); });

/** Same codec ladder as VideoRecorder (HEVC then H.264-High, QP then VBR)
 *  minus the realtime fallback — offline render always wants quality mode. */
async function pickEncoderConfig(fps: number):
  Promise<{ config: VideoEncoderConfig; muxCodec: 'hevc' | 'avc'; qKey: 'hevc' | 'avc' } | null> {
  const base = {
    width: STAGE_W,
    height: STAGE_H,
    bitrate: Math.min(Math.max(Math.round(STAGE_W * STAGE_H * 6), 4_000_000), 25_000_000),
    framerate: fps,
    hardwarePreference: 'prefer-hardware',
    latencyMode: 'quality',
  } as unknown as VideoEncoderConfig;
  const ladders = [
    { codec: 'hvc1.1.6.L156.B0', muxCodec: 'hevc', qKey: 'hevc' },
    { codec: 'hev1.1.6.L156.B0', muxCodec: 'hevc', qKey: 'hevc' },
    { codec: 'avc1.640032', muxCodec: 'avc', qKey: 'avc' },
  ] as const;
  for (const cand of ladders) {
    for (const bitrateMode of ['quantizer', 'variable'] as const) {
      const variant = Object.assign({}, base, { codec: cand.codec, bitrateMode }) as VideoEncoderConfig;
      const { supported } = await VideoEncoder.isConfigSupported(variant);
      if (supported) {return { config: variant, muxCodec: cand.muxCodec, qKey: cand.qKey };}
    }
  }
  return null;
}

// VideoFrame snapshots the canvas at construction — must be created in
// the same task as renderFrame() while the GL drawing buffer is live
// (preserveDrawingBuffer is off).
function submitFrame(enc: VideoEncoder, src: HTMLCanvasElement, i: number, fps: number,
  picked: { config: VideoEncoderConfig; qKey: string }): void {
  const frame = new VideoFrame(src, { timestamp: Math.round(i * 1e6 / fps) });
  const opts: VideoEncoderEncodeOptions & Record<string, unknown> = { keyFrame: i % (fps * 2) === 0 };
  if (picked.config.bitrateMode === 'quantizer') {opts[picked.qKey] = { quantizer: 22 };}
  enc.encode(frame, opts);
  frame.close();
}

async function drainQueue(enc: VideoEncoder): Promise<void> {
  while (enc.encodeQueueSize > QUEUE_HI) {
    await sleep(2);
    if (enc.encodeQueueSize <= QUEUE_LO) {break;}
  }
}

export async function renderClip(o: RenderClipOpts): Promise<Blob | null> {
  if (typeof VideoEncoder === 'undefined' || !o.player.demoData) {return null;}
  const fps = o.fps ?? 60;
  const src = o.canvas;
  const picked = await pickEncoderConfig(fps);
  if (!picked) {return null;}

  // Same task constraint as VideoRecorder.pump: drawImage reads the GL
  // canvas only while its drawing buffer is live, so the blit happens
  // synchronously right after renderFrame each step.
  const stage = document.createElement('canvas');
  stage.width = STAGE_W;
  stage.height = STAGE_H;
  const stageCtx = stage.getContext('2d');
  if (!stageCtx) {return null;}
  const blit = (): void => {
    const scale = Math.min(STAGE_W / src.width, STAGE_H / src.height);
    const w = src.width * scale, h = src.height * scale;
    stageCtx.fillStyle = '#000';
    stageCtx.fillRect(0, 0, STAGE_W, STAGE_H);
    stageCtx.drawImage(src, 0, 0, src.width, src.height, (STAGE_W - w) / 2, (STAGE_H - h) / 2, w, h);
  };

  const mux = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: picked.muxCodec, width: STAGE_W, height: STAGE_H, frameRate: fps },
    firstTimestampBehavior: 'offset',
    fastStart: 'in-memory',
  });
  let failed = false;
  const enc = new VideoEncoder({
    output: (c, m): void => mux.addVideoChunk(c, m),
    error: (): void => { failed = true; },
  });
  enc.configure(picked.config);

  const dur = o.player.duration;
  const start = Math.max(0, Math.min(o.start, dur));
  const end = Math.max(start, Math.min(o.end ?? dur, dur));
  // armSeek before seek: the flag is consumed by the events seek() emits
  // synchronously inside reconstructToTime → onFrameUpdate.
  o.armSeek?.();
  o.player.seek(start);

  const frames = Math.max(0, Math.floor((end - start) * fps));
  const stepDt = 1 / fps;
  for (let i = 0; i <= frames; i += 1) {
    if (o.abort?.()) {enc.close(); return null;}
    o.player.scrubTo(start + i / fps);
    o.snapRemotes?.(stepDt);
    o.tickFx?.(stepDt);
    o.renderFrame(stepDt);
    blit();
    submitFrame(enc, stage, i, fps, picked);
    if (failed) {break;}
    await drainQueue(enc);
  }
  if (failed) {enc.close(); return null;}
  await enc.flush();
  enc.close();
  mux.finalize();
  return new Blob([mux.target.buffer], { type: 'video/mp4' });
}
