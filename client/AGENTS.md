# client — Agent Guide

Render + prediction + input. Never an authority on interactive state —
a client-side "fix" that the server can't observe is a bug, not a fix.

## Commands

```bash
./node_modules/.bin/tsc --noEmit   # gate before commit
./node_modules/.bin/vitest run     # client tests
npx -y oxlint src                  # lint
npm run dev                        # vite dev server
```

## Map

- `game/net/` — wire decode → netHandlers → local state. Handle edges
  here, not in render code.
- `entities/` — RemotePlayer, species visuals (instanced), balls.
- `game/` — bots.ts (offline brains), deployables, lobby, remotes.
- `world/` — terrain/sky/scene; `effects/` — ALL transient VFX.
- Prediction: local player replays the same `shared/movement.ts` sim;
  corrections rewind + replay journaled inputs.

## Rules

- Wire is law: render what the server sent; prediction is for feel only.
- Species render instanced (SpeciesRenderer) — no per-creature meshes.
- Keep per-frame allocation ~zero in hot paths; reuse scratch vectors.
- UI-side interactivity that must be shared goes on the wire — local
  state is decor or debug.

## VFX lives in `effects/` — one spot, one contract

All transient visual effects (particles, ribbons, beams, blasts, decals,
shake) live under `effects/`; entities/projectiles own *gameplay* and may
hold VFX handles, but never own pooling, batching, or buffer logic.

- Pooling/batching/diagnostics: `vfxRuntime.ts`, `trailBatch.ts`,
  `fxDiag.ts` — new FX must ride an existing pool or justify a new one.
- Ownership: an FX handle (`RibbonTrail`, `QuarksTrail`) is single-owner.
  Owner calls `stop()` on death, keeps calling `update()` until `done`,
  then `dispose()` — never dispose a handle another object still ticks.
- Position jumps: explicit `teleport()`/`clear()` at the call site;
  `push()` additionally refuses chords beyond ~0.25s of travel — if the
  guard fires on legit motion, fix the threshold, don't bypass it.
- A `slot=-1` ribbon or `zombiePushes>0` in Alt+Q means an owner outlived
  its handle — find the dispose-without-death path, don't paper over it.
