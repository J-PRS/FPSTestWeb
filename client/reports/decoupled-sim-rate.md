# Decoupled Simulation Rate (Beyond Refresh Rate)

Status: idea, not implemented. Documented for later evaluation.

## Context

Competitive FPS players often report that running a game engine above the
display refresh rate "feels better." In a browser, the display rate itself is a
hard ceiling: `requestAnimationFrame` is vsync-locked, so on a 144Hz monitor the
game can never present more than 144 fps. What can be decoupled is the
**simulation tick rate** — physics and input sampling don't have to run at
display rate.

Current state: `main.ts` `loop()` runs `player.update(dt)` and rendering in the
same rAF callback. Sim and render are locked together at display rate, with
variable `dt` clamped by `MAX_DELTA_TIME`.

## What running sim above refresh actually buys

Uncapped-FPS benefits in native games come from the newest input state landing
in the next presented frame (reduced input-to-photon latency). Browser
equivalents:

1. **Fixed-timestep substepping (recommended, low risk)**
   - Accumulator inside the rAF loop; `player.update` runs at a fixed rate
     (e.g. `SIM_DT = 1/240`), zero or more substeps per frame.
   - Benefits: deterministic physics at any display rate, no tunneling at low
     fps, identical ski/jetpack behavior for all players, foundation for
     server-replay / client-prediction work later.
   - Does NOT reduce input latency by itself; it's the right architecture
     regardless.
   - Cost: ~15 lines around `player.update`/`terrain.update` in `main.ts`.
   - Needs an interpolation alpha (`acc / SIM_DT`) for camera/remote-player
     rendering to avoid visible stutter, or at minimum verify feel first.

2. **Timer-driven sim (aggressive)**
   - `player.update` + input send on `setInterval` at ~250Hz, render on rAF.
   - Displayed state is ~1–4ms fresher per frame vs. vsync-tied sim.
   - Requires render-side interpolation or movement stutters visually.
   - Marginal gain on 144Hz+ displays; significant complexity.

3. **`desynchronized` canvas context**
   - `new WebGLRenderer({ desynchronized: true })` asks Chrome to skip
     compositor buffering; can shave a few ms of display latency.
   - Platform-inconsistent, has historically broken fullscreen in some setups.
   - Cheap experiment — single flag, flip if weird.

## Recommendation

Do #1 first. It improves physics determinism independent of feel, and the
accumulator is the natural insertion point if prediction/replay work happens
later. #2 only worth revisiting if #1's substep interpolation already exists.
#3 is a one-line experiment that can be tried any time.

## Open questions

- Fixed sim rate value: 240Hz is standard for competitive feel; 128Hz is enough
  for correctness and halves per-frame work.
- Whether `player.update` substeps should also substep `terrain.update`
  (terrain paging is position-dependent; probably render-rate is fine).
- Input accumulation: `inputTracking` currently consumed once per frame —
  with substeps, mouse-look delta should apply once per frame (latest state),
  not once per substep, or look sensitivity multiplies.
