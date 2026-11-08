# maplab regen perf autopsy — 2026-11-07

Question: why does a maplab `refresh()` at 449² take ~1.9s, and is a WASM
port the fix? Answer from measurement: **the wait is CPU field gen, not
mesh or shader — and the fastest wins are algorithmic, not a library
swap.**

## Measurement pipeline

New instrumentation in `client/src/maplab.ts`: a 12-run ring buffer of
per-stage ms, dumped to console **and** clipboard on **Alt+Q** (same UX
as the base game's diag dump). Covers `refresh()` synth/erosion passes,
`loadMap()` fetch/parse, `paintField()` (mesh displace, computeNormals,
hillshade, stats), and a `compileWatch` flag that times the first
`renderer.render` after `mat.needsUpdate` — catching shader recompiles
that land async to the refresh call.

Reference dump (449², `Alt+Q` in maplab):

```
[synth seed 9541 449²] total 1906.2ms
     496.2ms  synthField
      34.6ms  smooth
     562.9ms  stream
       0.8ms  erode
     174.7ms  glacier
     304.3ms  talus
       3.7ms  flats
     265.3ms  verbs          (mostly h.set() replay of cached snapshots)
       6.4ms  mesh displace
       8.5ms  computeNormals
      22.7ms  hillshade
       0.9ms  stats
      23.8ms  render+compile
```

Read: ~1.8s of 1.9s is `gen.ts` math. Mesh, normals, hillshade, and the
suspected shader recompile are ~60ms combined. Clay mode
(`MeshNormalMaterial` toggle) never touched this path — it was always
field-gen time.

## Python sidecar bench

`_tools/bench/gen_bench.py` — faithful numba ports of the same passes on
the same 449² grid. Run:

```
uv venv _tools/bench/.venv --python 3.12
uv pip install --python _tools/bench/.venv/Scripts/python.exe numpy "numba<0.63" scipy
_tools/bench/.venv/Scripts/python.exe _tools/bench/gen_bench.py
```

(Numba needs numpy≤2.2-era compat — the venv exists because global
NumPy 2.5 breaks numba 0.62.)

| pass | JS (maplab) | numba 1-thread | numba `parallel=True` |
|---|---|---|---|
| synthField | 496ms | 112ms | **17ms** (29×) |
| smooth ×40 | 34.6ms | 32ms | 15.5ms |
| talus ×16 | 304ms | 38.6ms | — |
| stream ×3 | 563ms | 170ms | — |
| glacier | 175ms | 62.6ms | — |
| erode 50k | — | 194ms | — |

Also measured: scipy `minimum_filter` (separable pass) does glacier's
windowed-min core in **2.8ms**.

## What the research says about "faster Python libs"

- pyhpc-benchmarks (geophysical finite-diff suite): **Fortran ≈ numba ≈
  ~3× faster than numpy** — numba is already near-native CPU. Cython and
  Pythran sit in the same compiled tier (±20%, not 2×).
- Anything dramatically faster is a different device: numba.cuda showed
  ~200× on a 10k² stencil vs CPU (mrocklin gist); Taichi claims ~3× over
  numba-cuda on fluid ops; CuPy/JAX/PyTorch reach roofline on big grids.
- Conclusion: WASM ≈ numba ≈ Cython ≈ C — the browser WASM port buys the
  same 2–8× per pass and still blocks the tab. Not the fix.

## Bug found while porting: `priorityFlood` heap encoding

`gen.ts:priorityFlood` packs `f*1e7 + i` into one double and decodes
`top % 1e7`. When the fill raises a cell to `ih + 1e-6 ≥ 1.0`, the
encoded value crosses a `1e7` boundary and `i` decodes **wrong**. JS
silently reads `undefined` on the OOB Float32Array index and the flood
keeps going on a corrupt index — it mostly works by luck. The numba port
segfaulted on the same code, which is how it was found. Fix: two-array
`(height, idx)` heap (see `gen_bench.py:priority_flood`), or a wider
multiplier.

## Ranked recommendations

1. **Separable min-filter for `glacierPass`** — its per-cell `w≤9`
   window loop (175ms JS / 62.6ms numba) is what `playaPass` already
   does separably in O(N²). ~40× on the pass.
2. **Cache `drainage()` across `streamPower` iterations** — it reruns
   priority-flood + sort every iter (3× = 563ms); the receiver graph
   barely changes. Recut on stale `acc`/`rec`, refresh every k-th iter.
3. **Worker pool** — gen is pure `Float32Array` math; transferable
   buffers keep the main thread at 60fps with a "regenerating" state.
   The numba `prange` result (29× on synth) is the multicore ceiling.
4. **Draft-grid regen while scrubbing** — gen at `size/2` on slider
   input, full res on release: ~4× for free.
5. WASM/WebGPU compute: only if gen also needs to run offline/CI —
   smaller payoff than 1–4.

Skipped: WASM library eval (VistaWASM, soilwebgpu, fast-noise-lite) —
they'd replace the bespoke verb pipeline that is the lab's point.

## Verb-list bookkeeping (for future readers)

The rail's per-verb `cells% Δavg% ms` is `verbCache` replay bookkeeping —
`ms` is when the verb *first* computed; mid-log edits invalidate the
snapshot tail, which is why tweaking verb 6 re-runs 6→21.
