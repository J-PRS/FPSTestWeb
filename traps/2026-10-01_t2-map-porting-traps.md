# Traps hit while porting Tribes 2 maps (Escalade)

Every one of these cost real debugging time. Most looked like a rendering
bug but were actually a pipeline or environment lie.

## Environment traps (not code bugs at all)

### `localhost` resolves to `::1` in Chrome, `127.0.0.1` in Bun

A stale server process bound to `[::1]:8478` will happily serve Chrome's
`localhost` connections while IPv4 probes hit your fresh server. Symptom:
browser gets old/stub payloads, `curl`/ws probes get correct ones, and the
browser *never appears in the new server's log*. Fix everywhere: dial
`127.0.0.1` explicitly, never `localhost`, in E2E URLs and `?server=`.

### A live listener on the port doesn't mean your spawned process is bound

`waitHttp` passing ≠ your process owns the port. Orphaned vite/bun from
prior runs keep serving **old code**. `p.kill()` on the `npx` wrapper
doesn't kill the vite child. Guard: check `proc.exitCode` after the health
check passes, and kill leftovers on `down()`.

### `console.warn` goes to stderr

If your harness only drains `stdout`, every warn is invisible — including
the diagnostic you added to prove a codepath ran. Drain both.

## File format traps

### `.ter` grids and `.mis` coordinates disagree on centering

T2's 2048m terrain square is centered at origin, but our terrain UV maps
`u = fract(x / worldSize)` — a half-tile (750m) phase offset. Terrain and
albedo share the offset so they stay consistent, but `.mis` placements
(interiors, spawn spheres) land displaced and wrap. Fix: roll all exported
grids by half a tile (`half_shift`) at conversion time.

### `.ter` is v-major

Height byte order is `raw[v * GRID + u]` — meters = raw/32. Reading it
u-major mirrors the whole map; interiors then float or bury even though
the terrain "looks right."

### SpawnSpheres are volumes, not points

Escalade's `.mis` has five `SpawnSphere` entries per team (`Team1`/`Team2`
SimGroups) with `radius` 30–100m and `sphereWeight`. Flattening them to
centers makes everyone materialize on one dot — and the first entry is on
the flag stand. Keep `r`, `w`, and team attribution; scatter inside the
sphere at spawn time.

### Cubemap faces must share resolution in GL

T2 ships a 4×4 `dd2`/`*_bottom` placeholder for the never-seen down face.
Mixing 4×4 + 512² corrupts the cubemap upload and produces a huge dark
wedge in the sky. Decode and resize all faces to the max edge. Also note:
the wedge that *looks* like a corrupt face may just be authentic storm art
— verify with a labeled color test cube before flipping anything.

### Server route depth caps silently drop nested assets

`terrainTex` at 2 dirs worked while `t2/escalade/terrain.bin` (terrain) and
`t2/escalade/sky/px.png` (3 dirs) got dropped/404'd. Result: escalade
textures painted over the *boot* heightmap — "below terrain" spawns and a
map that looks right but simulates wrong. Check depth caps and extension
allowlists whenever assets nest.

## Verification techniques that paid off

- **Direct wire probe** (`new WebSocket`, print `gameState.map` keys) —
  separates server-side emission from client-side handling instantly.
- **Labeled cube faces** — colored faces with TOP/BOTTOM bands settle all
  face-mapping arguments in one screenshot. Do this *before* brute-forcing
  flips/rotations.
- **Edge continuity matching** — for genuinely ambiguous face orientation,
  compare edge rows/cols between candidate transforms.
- **Bisect screenshots** — hide the interior group / null the background,
  shoot again. One-axis changes isolate the culprit immediately.
- **Read the raw face averages** — a per-face top/mid/bottom luminance row
  flags a flipped face without rendering anything.
