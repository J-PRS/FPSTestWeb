# HMR vs build-and-reload — why we test the bundle

2026-10-25. Question: is `vite build` + `vite preview` a better loop
than the dev server + HMR for this project? Answer: yes, and the
community evidence says the same for WebGL games specifically.

## The measured facts (this project)

- rolldown-vite full build: **~0.6s** (`dist census` line in every
  build log, printed by the `dist-size` plugin in `vite.config.js`).
- Preview on :5500 serves the same bundle prod ships — test parity
  dev can't give (dev transform ≠ prod transform).
- The game can never benefit from HMR state preservation: sim state,
  GPU buffers/contexts, socket sessions, pointer lock, anim mixers —
  none survive a module swap. Every test reload is a hard boot anyway.
- The repo already evolved `noreload` mode + the stale-badge because
  live reload was actively in the way (half-applied module state,
  double listeners). The stale-badge (`staleFiles.ts`) is HMR
  replaced by an honesty mechanism: "N files changed (Ctrl+R)".
- The preview variant keeps the same badge via the `stale-probe`
  plugin — `configurePreviewServer` + `/dev/stale` mtime scan answers
  "which files are newer than this bundle" on localhost only.

## What the community says

- **Babylon engine dev (Sebavan, html5gamedevs):** "I just added full
  page reload to prevent state issues / shader recompilation being
  broken." Inside Babylon the only praised HMR path is texture/asset
  hot-swap — code still reloads.
- **Parcel #8514:** an OpenGL game author asked for reload-instead-of-
  HMR because HMR produced *inconsistent texture anomalies* he
  couldn't debug. Maintainer position: full reload should be the
  default, HMR opt-in via `module.hot.accept`.
- **Remix #2384 (Ryan Florence):** "HMR is more about hiding the
  slowness of front-end build tools than maintaining client state.
  ESBuild is fast, so it doesn't matter." Their full-reload path is
  fast enough that users think it IS HMR — the rolldown equivalent
  here (0.6s builds) makes the same point: HMR exists to amortize
  slow rebuilds; with fast builds it buys nothing.
- **General rule that emerged:** HMR pays when state is cheap to
  preserve or the change is view-layer (CSS, React components). For
  engine/sim code with GPU resources and wire sessions, engines
  default to full reload.

## Where HMR still wins here

- CSS/HUD-panel styling and copy edits — no boot cost to see.
- That's the whole list.

## Position

Build+preview is the honest loop for sim/render/net work: same
bundle as prod, 0.6s cost, no phantom half-state. Dev server stays
for styling and the stale-badge ergonomics. This matches mainstream
engine practice — not a quirk.

Sources: parcel-bundler/parcel#8514, html5gamedevs Babylon HMR
thread, remix-run/remix discussion #2384, vite preview
configurePreviewServer docs.
