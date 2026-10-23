# Offline desktop demo→MP4 renderer — design reference

2026-10-23. Status: **concept, not built**. The in-browser stepped renderer
(`client/src/demo/renderClip.ts`, "Render MP4 (fast)") is shipped and verified;
this doc scopes the desktop version and records why each tier exists.

## Goal

A runnable tool (exe or script) that takes a `.demo` file on a desktop machine
and emits an MP4 — **no game server, no dev server, no interaction**. Uses:

- render/replay verification on machines without a browser session open
- CI artifact generation (render repro demos to video)
- the basis for "share clip by ID" — server-side or user-side clip rendering

## Why it is mostly built already

| Piece | Exists | Where |
|---|---|---|
| Stepped deterministic renderer | ✓ | `demo/renderClip.ts` — scrubTo @1/60 steps, real `gameLoop.renderFrame`, authored timestamps, WebCodecs→mp4-muxer, encoder backpressure, staged 1920×1080 letterbox |
| Export entry point | ✓ | `DemoManager.exportCoolShotMp4Rendered(id)` — playback paused + `offlineRender` gates every wall-dt path |
| Self-contained demo files | ✓ | embedded HMAP fallback + `srcHash` check — no asset install needed |
| Headless-Chrome harness | ✓ | `headless-test/render-mp4.js` — launches installed Chrome with real GPU, drives the export, parses+saves the MP4 (ffprobe-verified hevc 1920×1080) |
| Single-exe compiler | ✓ | `bun build --compile` — Bun + script → one ~50MB exe |
| GPU headless guidance | ✓ | `headless-game-testing` skill + `E2E_GPU=1` — real GPU without a window |

The remaining work is packaging + CLI, not architecture.

## Tiers

### Tier 1 — headless-Chrome CLI (the plan)

A Bun script that:

1. Spawns the user's installed Chrome headless (`channel:'chrome'`,
   GPU flags — the `render-mp4.js` boilerplate).
2. Serves the **built** client (`vite build` output) from an embedded static
   file server — offline mode, no game server. `?offline` boot path already
   exists (`setupOfflineMode`).
3. `page.addScriptTag`/`evaluate` to inject the `.demo` file (File or
   ArrayBuffer), mint a cool-shot entry, call
   `exportCoolShotMp4Rendered`, capture the exported blob (the
   `URL.createObjectURL`/exportClip hook already proven).
4. Writes `<clip>.mp4` to disk. Exit code = success.

CLI sketch:

```
kribes-render.exe match.demo [--start S] [--end E] [--fps 60] [--out clip.mp4]
```

- `--start/--end` default to full demo (cool-shot generation optional — a
  whole-demo render is just t0=0, t1=duration).
- Compiled via `bun build --compile` → `kribes-render.exe`.

Gotchas (from the headless harness runs):

- **Pointer-lock stub** required (headless can't lock) — skill documents it.
- The realtime `exportCoolShotMp4` lane refuses while the auto-mp4 ring is
  armed (`video.isRecording`) — harness must use the offline lane or suspend.
- Cold GLB/shader compile dominates first renders — warm one frame before
  timing (harness already does the equivalent via demo recording).
- Chrome dependency: probe standard install paths + `BROWSER` env; portable
  Chrome is the fallback (+150MB, probably not worth bundling).

### Tier 2 — ffmpeg pipe (quality/audio upgrade)

Browser produces frames; `ffmpeg` encodes. Options:

- pipe raw RGBA frames (`-f rawvideo -pix_fmt rgba -s 1920x1080 -r 60 -i -`)
  from the headless page to a spawned ffmpeg → `libx264`/`libx265` CRF.
- or keep in-browser WebCodecs and use ffmpeg only to **merge audio** —
  the Revideo pattern: render mute mp4 in-browser, mux a separately
  reconstructed audio track.

Audio path itself: playback SFX events exist in the demo; the honest
reconstruction is `OfflineAudioContext` rendering the same sfx graph → WAV →
ffmpeg mux. Untackled — the in-browser render is deliberately video-only.

### Tier 3 — Electron/Tauri shell (only if non-devs run it)

Same WebCodecs path inside a bundled browser. +150–250MB for guaranteed
Chrome + a preview window. Justified only if clip-making becomes a
user-facing product surface, not a dev/CI tool.

## Non-goals

- Not a native reimplementation (Three.js→wgpu/D3D port). Months of work for
  zero fidelity gain — the headless browser IS the renderer.
- Not realtime gameplay recording — the desktop tool renders *demos*; live
  capture stays in-browser (VideoRecorder).
- Not a replay editor — single-shot clip renders only; a takes UI is a
  separate roadmap item.

## Open questions

- Client build shipping: bundle `dist/` inside the exe (large) vs. expect a
  checked-out build vs. pin a released build artifact. Probably the first —
  the whole point is self-containment.
- Bitrate control: in-browser WebCodecs gives quantizer/VBR; if Tier 2
  lands, CRF presets move to the ffmpeg side.
- Long renders: for full-match renders, encoder-in-worker + FileSystem
  streaming target (mediabunny) avoids holding the whole mp4 in memory —
  deferred to whichever need shows up first.

## Pointers

- Renderer: `client/src/demo/renderClip.ts` · `DemoManager.exportCoolShotMp4Rendered`
- Realtime lane (kept for comparison): `client/src/demo/VideoRecorder.ts` · `exportCoolShotMp4`
- Harness to package: `C:\TEMP\_WEB\headless-test\render-mp4.js` (+ `render-ab.js` A/B)
- Headless prerequisites: `.agents/skills/headless-game-testing/SKILL.md`
- Prior art / lane rationale: `_docs/2026-10-22_DEMO_SOTA_COMPARISON.md` (demo→video section)
