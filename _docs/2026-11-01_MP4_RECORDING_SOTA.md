# MP4 recording in-browser: where we are vs 2025/2026 SOTA

Audit of `client/src/demo/VideoRecorder.ts` against current browser-capture
state of the art. Sources: Chrome WebCodecs best-practices, MDN WebCodecs,
Mediabunny docs (mp4-muxer successor), 2025 worker+OffscreenCanvas capture
patterns, Lit.Build 4K recorder writeup. Measured numbers from
`_tools/e2e/_vidprof.ts` (E2E_HEADED=1 E2E_GPU=1, headed Chrome, 8-bot CTF
rimrock, 10s baseline / 20s recording A/B).

## Measured cost (this box, NVENC-capable)

```
WebCodecs hardware path (avc/hevc, prefer-hardware):
  baseline 10s:  avg=16.83ms p50=16.7 p95=17.0
  recording 20s: avg=16.76ms p50=16.7 p95=16.9
  delta: -0.07ms — unmeasurable against vsync-locked frames

MediaRecorder fallback (CPU encode, avc1.42E01E forced via hidden VideoEncoder):
  baseline 10s:  avg=16.78ms p95=17.1
  recording 20s: avg=16.68ms p95=18.4
  delta: -0.10ms — still unmeasurable on THIS box (p95 ticked up; tail cost)
```

Both paths are ~free on this machine at 60fps. The fallback's CPU encode
rides encoder threads, not the render thread — machine-true, not universal.

## SOTA scorecard

### Already SOTA (keep)

| Pattern | Status |
|---|---|
| `VideoEncoder` + `prefer-hardware` + `isConfigSupported` ladder | yes — HEVC→H.264, QP→VBR→realtime fallback chain is better than most impls |
| mp4-muxer + wall-keyed rolling ring (ShadowPlay architecture) | yes — `cutWindow` remux = frame-accurate trims without re-encode |
| Backpressure (`encodeQueueSize > 30` drop) | yes — #1 crash vector covered |
| `frame.close()` immediately after encode | yes — GPU-memory discipline correct |
| Wall-clock timestamps not counter×fps | yes — 144Hz→60fps slow-mo trap handled |
| AudioEncoder + AudioWorklet AAC lane | yes — most impls skip audio entirely |
| `latencyMode: 'quality'` + lookahead | yes — quality over latency is right for ring-buffer clips |
| Fixed-QP mode where supported | yes — ~visually lossless at QP22 |

### Gaps (ranked by value/effort)

1. **Worker offload** — TRIED, REVERTED (2026-11-01). Moved `VideoEncoder`
   into a worker via transferable `VideoFrame`s (`videoEncWorker.ts` +
   facade). Measured result: the worker-side encoder stalled at ~2fps —
   `encodeQueueSize` pegged at 31 while chunks trickled — almost certainly
   because `VideoFrame`s created from a main-thread canvas lose the GPU
   zero-copy path when transferred cross-thread, falling to software
   encode of 1080p60. The correct worker pattern is
   `MediaStreamTrackProcessor` → transfer frames **before** they're bound
   to a main-thread canvas — i.e. captureStream on the source, not
   post-blit VideoFrames. Not worth restructuring for: main-thread encode
   already measures ~0 frame-time on this box. Deleted.

2. **AV1 in the codec ladder** — one ladder entry (`av01.*`) ahead of
   HEVC. RTX40/RDNA3/Arc GPUs do AV1 HW encode: ~30% better quality/bit.
   `isConfigSupported` already gates it — falls through cleanly on older
   GPUs. Cheap win: ~4 lines.

3. **Mediabunny vs mp4-muxer** — TRIED, REVERTED (2026-11-01). Ported
   mux+ring+`cutWindow` to mediabunny@1.62.1: `stop()` muxed valid 15MB
   mp4s but `cutWindow` emitted stubs — the retimestamped-packet path
   needed `decoderConfig` on track metadata and `await`s we couldn't
   verify inside a sync API. Swapped back to mp4-muxer; mediabunny buys
   nothing for a 20s rolling ring. Dependency uninstalled.

4. **Streaming disk output** — mux target is `ArrayBufferTarget`
   (all-in-memory). For rolling 20s clips that's CORRECT — bounded by
   design. Only matters if we add full-session recording: then
   OPFS/FileSystemAccess stream (Mediabunny `StreamTarget`) bounds memory.

5. **`scalabilityMode` (L1T3)** — temporal layers let `cutWindow` trim at
   1/3-rate granularity instead of GOP (2s) boundaries. Reduces clip
   preroll padding. ~2 config lines; benefit is tighter clip starts.

6. **Pump split done** — `blitAvg` now logged separately from `pump` (the
   1080p staged drawImage). Verify on next live roll; if blitAvg >1ms the
   stage canvas is the tax, and a smaller stage or `captureStream`'d
   direct canvas is the fix.

## Non-gaps checked

- **`getDisplayMedia`** — not applicable; we capture our own canvas, not
  the screen. No permission prompt, no OS capture dialog.
- **OffscreenCanvas render** — can't move the WebGL scene to a worker
  without re-architecting the renderer; the blit stays main-thread by
  design, measured sub-ms anyway.
- **Timeslice on MediaRecorder** — already 250ms periodic chunks; a crash
  loses ≤250ms.

## Proposed order — updated after fill pass

| # | Item | Status |
|---|---|---|
| 1 | AV1 ladder entry | DONE — `av01.0.13M.08`/`av01.0.08M.08` ahead of HEVC, `isConfigSupported`-gated |
| 2 | Verify `blitAvg` on next live roll | DONE — `_vidprof` reads `video.stats`: blitAvg=0.05ms, pumpAvg=0.13ms (0.8% of a 60fps frame), qMax=31 (one transient gate trip, self-recovered) |
| 3 | Worker offload | DONE-REVERTED — worker-side encode stalls (~2fps); needs `MediaStreamTrackProcessor` architecture, not worth it |
| 4 | Mediabunny swap | DONE-REVERTED — `cutWindow` regressed, no gain |
| 5 | L1T3 scalabilityMode | DONE — VBR variants only (QP path preserved) |
| 6 | Session-record streaming | DEFERRED — 20s ring already bounds memory |
| 7 | `cutWindow` | VERIFIED WORKING — produces real clips (4.4MB, 248 chunks, 0 failures via `_vidprof` `lastCut`); earlier "stub" readings were a probe print bug (`size/1e6|0` labeled MB as KB) plus legitimate empty-window returns during the worker stall |

## Provenance

- Frame deltas: `_tools/e2e/_vidprof.ts [--fallback]` (rAF recorder
  injected, headed Chrome + real GPU, CTF 8-bot rimrock autopilot)
- Pump/blit/queue stats: `VideoRecorder` internal counters, logged every
  5s + on stop (`rec stats`, `rec done` console lines)
