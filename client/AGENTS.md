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
- `world/` — terrain/sky/scene; `effects/` — particles.
- Prediction: local player replays the same `shared/movement.ts` sim;
  corrections rewind + replay journaled inputs.

## Rules

- Wire is law: render what the server sent; prediction is for feel only.
- Species render instanced (SpeciesRenderer) — no per-creature meshes.
- Keep per-frame allocation ~zero in hot paths; reuse scratch vectors.
- UI-side interactivity that must be shared goes on the wire — local
  state is decor or debug.
