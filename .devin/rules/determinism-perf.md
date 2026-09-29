---
trigger: glob
globs:
  - shared/**
  - server_bun/src/sim/**
  - client/src/game/**
---

# Determinism & perf rules

- `shared/` is a contract: identical inputs must yield identical outputs on
  client and server. No `Date.now()`, no IO, no unseeded `Math.random` in
  sim code — wall-clock never decides gameplay.
- Both ends integrate the same sim between committed events. If behavior
  diverges, fix the sim or the event — never patch one side only.
- Perf optimizations are safe only when provably outcome-neutral:
  parabola-skip terrain probes, early-exit sweeps bounded by capsule reach,
  re-anchoring on the skip window's own math. Unfair misses are
  unacceptable — a skip that changes the result is a bug, not a speedup.
- Cheap paths that already exist stay the default: instanced meshes for
  species, pooled projectiles, AI buckets, distance-tiered fanout. Profile
  before budgeting new work — phase EMAs in the client profiler, tick lag
  on the server.
- New AI behavior belongs in shared sims driven by edges; heavy but
  per-second decisions can be bucket-staggered across ticks with a stable
  creature-id→bucket hash. Keep tick() allocation-free where it already is.
