# Demo recording & playback

Full-fidelity session recording — inputs, events, entities — for replay and
automatic "cool shot" clipping.

## Architecture

- **`DemoRecorder`** — samples player state + events per tick into a
  `CircularBuffer`; bounded memory, old footage ages out
- **`DemoSerializer`** — typed event stream (`InputFlags`, `JetpackFlags`,
  projectile fired/destroyed, target hit/died, AOE)
- **`DemoPlayer` + `playbackReconstruction`** — replays by stepping through
  recorded states; the camera is the player frozen (`inputFrozen`), sim
  entities spawned as playback clones (`playbackBallById`,
  `playbackProjectiles`)
- **`demoLifecycle`** — owns teardown: entering/exiting playback disposes
  live entities (balls, crawlers, turretters, rollers, seekers, projectiles,
  debris) and restores them when play resumes. Every new entity type must
  register here or it freezes mid-demo.

## Cool shots

Automatic clip extraction — a notable event (airshot kill, long-range disc)
marks the buffer; the clip saves the surrounding window. `CoolShotsPanel`
lists them. The interesting part is it's *retrospective*: the circular
buffer means you record everything and keep only what turned out cool.

## Live mp4 capture (`VideoRecorder`)

ShadowPlay-style rolling capture of the render canvas — a RAM ring keeps
the last ~20s of encoded chunks; a cool-shot event cuts the window to a
standalone mp4 (`cutWindow`), or F9 dumps the whole buffer.

- **Video path**: WebCodecs `VideoEncoder` (hardware-preference → NVENC)
  → `mp4-muxer`. Codec ladder per start: HEVC (hvc1/hev1) → H.264 High;
  bitrate mode ladder: `quantizer` (fixed QP22 ≈ visually lossless) →
  quality VBR → realtime CBR. `latencyMode:'quality'` is the single
  biggest artifact knob — realtime mode was the original blocking.
- **Staging**: live canvas blits into a fixed 1920×1080 stage inside the
  render loop (`pump()`), so clips are always 16:9 1080p regardless of
  the player's window shape. Must pump in the same rAF as the render —
  WebGL backbuffer is blank otherwise (no preserveDrawingBuffer).
- **Audio**: post-compressor mix (`audio.mixNode`) → AudioWorklet →
  `AudioEncoder` AAC (opus fallback) → same muxer. Chunk timestamps are
  sample-count-based so they align with wall-clock video ts. Clips cut
  audio from the ring too. MediaRecorder fallback path just gets an
  audio track on the captureStream — everything else stays video-only.
- **Ring semantics**: chunks stored `{ts, c, m}` wall-clock keyed.
  `cutWindow` starts on the previous keyframe (≤2s preroll, GOP
  granularity), ends frame-accurate, retimestamps relative to the cut.
  decoderConfig must be re-supplied at remux — ring metas often lack it,
  so the last-seen config is stashed (`decConf`/`aDecConf`).

## Capture research — what's worth it

Measured-vs-marketing summary of the WebCodecs tuning space (Oct 2026):

- `encode()` is already off-main-thread internally; worker-side encoding
  only moves the *callbacks* (chunk→muxer→ring, ~60–120/sec). Real
  residual main-thread cost is `VideoFrame(canvas)` construction +
  bookkeeping — sub-0.5ms/frame at our size. Not worth ~150 lines of
  worker plumbing unless profiling shows GC hiccups from QP-size chunk
  allocation.
- If it ever is: `canvas.captureStream()` → `MediaStreamTrackProcessor`
  → transfer the `ReadableStream` to a worker — frames arrive on the
  stream's own cadence, main thread does nothing per frame. `VideoFrame`
  and `AudioData` are both Transferable. `transferControlToOffscreen`
  moves rendering too but is a rewrite — skip.
- AV1 needs 40-series NVENC — on 30-series it's a software encode (fps
  loss). Skip. `contentHint:'text'` is for UI capture, not gameplay.
- HEVC caveat: Discord embeds + Firefox can't decode hvc1 clips —
  H.264 wins on shareability when that matters.
- Backpressure: drop frames when `encodeQueueSize` exceeds the cap —
  unbounded queues leak GPU memory and crash (each VideoFrame holds a
  full readback).
- Watch: `encodeQueueSize` growth + `pump()` timing are the two numbers
  that tell you the recorder is costing frames.

## The trap

Demo playback uses the same entity classes but different lifecycle —
playback balls are ID-keyed clones, projectiles replay from events, real
entities must not update. `gameLoop` gates every `entities.update*` call on
`demoPaused`, and `updateProjectiles`/`updateNuggets` gate on `isPlaying`.
New entity types need both gates or they'll double-sim under playback.
