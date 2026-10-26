# Trap: wrapper objects defeat identity-keyed caches — silent per-call rebuild

Cost: `balls` phase at 23–118ms/frame with 8–14 balls (~9.3ms per
`ball.update()`), 20–30fps on a scene that should idle at vsync. Measured
by `_tools/e2e/_ballprof.ts` (`?ballprof` diag split), fixed in `6bde1f3f`
→ 0.015ms/ball, balls phase 0.26–0.45ms/frame.

## The symptom that misleads

The profiler blamed `stepBall` — the physics integrator — at ~9ms/call.
`stepBall` is ~40 flops + one heightfield chord; a bun microbenchmark of
the identical function ran 200k calls at 60ns each. Reading the sim
line-by-line finds nothing, because the cost isn't in the function —
it's in the *cache lookup its input triggers*.

## The mechanism

`shared/heightfield.ts` `chordTaps` is a `WeakMap<Heightfield, tapCache>` —
keyed on the **field object**. `client/world/heightmap.ts`
`getHeightfield()` minted a fresh `{ size, data, stride, ... }` wrapper
on every call. `Ball.tickLocal` calls it per ball per frame:

1. New wrapper → WeakMap miss → `chordCache()` rebuilds the whole
   `span²` (~168k-sample) `Float64Array` tap cache.
2. That rebuild happens *inside* `stepBall`, so the lap timer bills it
   to `net`/sim — the innocent code.
3. The fresh wrapper is garbage next call; the new cache is unreachable
   and rebuilt again. The cache worked exactly as designed — the key
   never survived long enough to hit.

## The fix

`getHeightfield()` returns a cached wrapper (`_fieldObj`), invalidated
at every module-state mutation (`setHeightScale`, `setWorldScale`,
`loadHeightfieldBin`, `restoreHeightmap`, `injectHeightmapBytes`). One
wrapper per field lifetime → one tap build per map.

## Rule of thumb

Any cache keyed on object identity (`WeakMap`, `Map`, `===`) is only as
stable as the objects handed to it. A getter that *wraps* state instead
of *returning* state turns every lookup into a miss-and-rebuild — and
the cost lands inside whatever innocent function queries it first.
Audit: for every `WeakMap`/`Map` in the codebase, ask "who mints the
key, and how often?" Per-frame getters must return stable objects or
the cache is a rebuild machine.

Tell: a profiler blaming a function that a microbenchmark proves is
nanoseconds-fast — the missing ms are being paid inside a cache/key
path the call site can't see.
