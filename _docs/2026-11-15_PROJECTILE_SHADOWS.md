# Projectile shadows — why the javelin's looks wrong, and the options

Report only — no code changed. Trigger: javelin shadow on terrain reads
low-quality and "not connected" to the shell.

## What the javelin's shadow actually is

A real shadow-map caster. `buildProjectileMeshes` puts every shell body
into an InstancedMesh pool with `castShadow = true`
(`effects/projectileVisuals.ts:284` → `instPoolFor(..., shadows=true)`).
The sun map is a 2048² PCFShadowMap over a ±130m ortho box that follows
the camera, snapped in light space (`world/scene.ts:92-105`,
`core/config.ts:439-442`).

Three properties of that map each work against a fast thin caster:

| Property | Where | Effect on a javelin |
|---|---|---|
| ~0.127m/texel | 260m ortho / 2048 (`scene.ts:143`) | a dart is ~2-4 texels across → blocky, stair-stepped silhouette, worse under PCF smear |
| Half-rate update | `renderer.ts:714-736` — `needsUpdate` every other frame | 30Hz raster vs 60Hz render: at 60-90 m/s the shadow sits **1-1.5m behind** the shell — the "not connected" feel |
| Camera-follow ±130m box | `scene.ts:133+` | shells outside/near the box edge lose or clip their shadow |

Separately: a sun at moderate elevation puts the *correct* shadow point
meters to the side of the ground point for an airborne shell — so even a
perfect shadow map looks "detached" to an eye expecting a blob pinned
underneath. Part of the complaint is real lag; part is that real
projection geometry is less intuitive than the fake players are used to.

## What everything else uses

Players and species do NOT cast into the sun map for their contact
shadow — they ride `InstancedBlobShadows` (`entities/swarm.ts:261`): one
instanced draw for all owners, terrain-conforming discs (GPU heightfield
drape — `world/terrain.ts:164`), repositioned **every frame**, faded
with altitude and inside fog. Remotes join the same pool
(`entities/RemotePlayer.ts:270`). This is why bodies read "grounded"
and the javelin doesn't — different mechanism entirely.

Current API: `set(owner, pos, radius, alpha)` — uniform discs only.

## Options

### A. Oriented-sliver blob (recommended)

Keep the blob pipeline; extend it for elongated casters:

- **Shape:** instanced thin capsule/ellipse quad (per-instance rotation +
  non-uniform scale), ~1.5× the shell's horizontal footprint.
- **Placement:** project along the sun vector, not straight down —
  `foot = pos + sunDir * (heightAboveTerrain / -sunDir.y)`. This puts the
  shadow where the sun actually casts it, which resolves the "detached"
  read correctly rather than by pinning it under the shell.
- **Dynamics:** altitude fade (existing curve), terrain conform (existing
  GPU drape), per-frame position → zero lag.
- **Cost:** removes projectile pools from the shadow raster (small win —
  they were a few instanced draws of the ~46%-of-frame pass) and adds
  zero draws if they join the existing blob batch. Net: cheaper AND
  better, but the win is quality (60Hz placement, soft edge, no texel
  blockiness), not a big FPS delta.
- **Honest limits:** faked silhouette (no fins/spin), lands on terrain
  only — a shell over a base roof shadows the ground beneath, not the
  roof. At projectile speeds nobody resolves silhouette anyway; the eye
  catches placement and lag.

External check (search results): blob/quad shadows pinned under the
caster are the standard cheap trick (Unity mobile guidance, FFX Runner);
the elongated/elongating projector is the known answer for
non-spherical casters. Nothing novel required.

### B. Tune the sun map

Raise `SHADOW_MAP_SIZE` (2048→4096 = 0.06m/texel) and/or update it every
frame. Fixes blockiness and lag *for all casters*, but the pass is
already the heaviest per-frame cost ("~46% of the frame measured" —
`renderer.ts:712`) and doubling resolution or raster rate multiplies it
exactly when weak GPUs opt for `?shadows=off`. Wrong direction.

### C. Drop projectile shadows entirely

`castShadow = false` on the body pools. Cleanest perf, but shells lose
their only ground-contact cue — reads worse than either option above,
especially lobbed/arcing shots where the shadow is the depth read.

## Recommendation

Option A. It matches the codebase's own precedent (characters already
faked their ground shadow and it looks right), it fixes placement at the
correct point rather than hiding the geometry, and it removes work from
the pass that the settings menu already treats as the expensive knob.

Requires: a sibling instanced pool (or per-instance
rotation/stretch on `InstancedBlobShadows`) taking `{foot, dirYaw,
length, width, alpha}`; projectile update loop sets it each frame;
`castShadow = false` on the body pools. Terrain-height query per shell
or reuse of the existing conform mechanism.
