# Traps hit chasing "line trails render on the first shot only"

Symptom: ball/projectile ribbon trails drew once — literally the first
shot fired after load — then never again. Alt+Q reported everything
healthy: slots lit, `count` saturated, heads tracking positions, meshes
visible and in-scene, drawRange covering the high-water mark, no orphan
slots. CPU state was perfect the whole time. The bug was NOT in the
data — it was in *which parts of the data ever reached the GPU*.

## The actual mechanism

`TrailBatch.flush()` ran **per ribbon** inside `RibbonTrail.update()`.
Each flush did:

    attr.clearUpdateRanges();
    attr.addUpdateRange(dirtyLo, dirtyHi);
    attr.needsUpdate = true;

`needsUpdate` doesn't upload — it just bumps `attribute.version`; the
upload happens at the next render, when `WebGLAttributes.updateBuffer`
drains `updateRanges` and then calls `clearUpdateRanges()` itself
(three r184 source, `src/renderers/webgl/WebGLAttributes.js`).

So per frame: ribbon A queues its span → ribbon B's flush **clears A's
pending range** and queues only B's → at render, only the *last*
flushed span uploads. ~150 live ribbons meant ~150 clears per frame.

Why the first shot survived: a buffer's FIRST `needsUpdate` always does
a full `bufferData` upload — `updateRanges` only apply once the buffer
exists. That one upload froze shot #1's trail into GPU memory. Every
write after that went through the range path and was erased before it
ever uploaded.

Fix: flush now keeps a pending-span union (`qLo/qHi`) per batch; each
call *extends* it (`addUpdateRange` of the union, array length stays 1),
and the union resets when the renderer has drained the list
(`updateRanges.length === 0`). Same fix in `DotBatch` (ball dots had
the identical bug). `?fxfull` URL param kept — full-upload bypass as an
A/B escape hatch.

Every other `addUpdateRange` caller in the codebase already accumulated
without clearing — only these two files cleared mid-frame.

## Dead ends that each looked right

- **"Diagnostics are broken"** — they weren't. The dump truthfully
  showed correct CPU arrays. Lesson: verify the upload boundary
  (CPU → GPU) separately from buffer contents. `lit:true` means
  "nonzero floats in the JS array", nothing more.
- **drawRange/high-water cutoff** — checked: `hw * IDX` math was right,
  index buffer is static slot-ordered, covers all slots.
- **Pool reuse dropping state** — diffed `reinit` vs constructor field
  by field; every field that matters is reset.
- **Material/blend/layer/composer** — opaque-red material swap in a
  live page still drew nothing; bloom layers were a red herring since
  `layers.enable(7)` is additive, not exclusive.
- **Frustum culling** — `frustumCulled=false`, boundingSphere pinned
  huge at construction.
- **End-on foreshortening** — burned THREE probe runs firing bolts
  toward/away from the camera before parking the player perpendicular
  to the flight line. A billboard ribbon aimed at the camera is a
  legitimate-looking dot — don't read absence as proof.

## What finally worked — the bisection ladder

Headless probes (`_tools/e2e/trailprobe*.ts`, launched by
`bun _tools/e2e/trailprobeN.ts`) interrogating the *live* page:

1. `trailprobe2` — swap batch material to opaque `MeshBasicMaterial`
   red. Still invisible → rules out color/blend/fade math.
2. `trailprobe3` — dump vertex pairs per slot: non-degenerate, colors
   nonzero → rules out zero-width/degenerate geometry.
3. `trailprobe4` — patch `RibbonTrail.stop` to capture stacks → proves
   live ribbons aren't being stopped early.
4. `trailprobe5/6` — teleport player perpendicular to flight line +
   `mesh.visible` toggle shows the draw call runs (27→25 calls) +
   `?fxfull` → **red streak appears**. Partial upload convicted.
5. Repro without `?fxfull` after the fix → streak renders.

The red-material swap + draw-call-delta pair is the reusable pattern:
it separates "not drawing" from "drawing invisible" and proves the
draw call executes, in two `page.evaluate` calls.

## Tooling left in place

- `?fxfull` — full-attribute upload A/B in `trailBatch.ts` /
  `ballTrails.ts` flush paths. If trails vanish again and `&fxfull`
  fixes it, the partial-upload path regressed.
- `trailprobe.ts` — baseline fire-and-dump (quarks + ribbon slots).
- `trailprobe2.ts` — material-swap + mesh census screenshots.
- `trailprobe6.ts` — perpendicular tracking cam, NDC projection of live
  slot verts, draw-call A/B, optional `&fxfull` in the URL.
- Alt+Q ribbon census (`ribbons:`/`litAudit:`/`ballDots:`/`balls:`) —
  already there; still the right first read for "is the CPU side sane".

## Rules of thumb for next time

- **`clearUpdateRanges()` is a frame boundary, not a flush detail.** It
  must only run when you're replacing the queue with a strict superset —
  or not at all. If a flush helper runs per-object, never clear.
- A full `bufferData` first upload will happily mask a broken partial
  path — "works on the first frame only" is its signature.
- `needsUpdate` is not "upload now". Nothing reaches the GPU between
  mark and render; anything that resets upload bookkeeping in between
  silently discards work.
- When every diagnostic says healthy, the boundary you haven't probed
  is the one that's broken.
