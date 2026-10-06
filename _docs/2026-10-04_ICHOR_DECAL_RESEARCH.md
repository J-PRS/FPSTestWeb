# Ichor decals: how games do droplet-to-stain cheaply

Deep-dive into how shipped games and engine samples implement "spray in
air, decal where it lands", and what that means for our ichor pipeline.
Findings are ordered by cost; we already do the cheap core, the report
ends with what we took and what we deliberately skipped.

## What everyone actually ships

**GoldSrc / Source model (CS, Half-Life, still the reference).**
Damage picks a tier; tier picks how many decals spray and the cone
width; a trace along the *shot direction* finds the surface behind the
victim; decals paint there. Blood lands BEHIND the target along the
bullet path, not at the hit point — directionality is what makes it
read physical. Modern Rust plugins reimplement this verbatim
("blood lands on the surface behind the target along the shot line").
H3VR's Blood System projects blood dots from the *exit wound* and
"dots scale with distance and stretch along the bullet path".

**Particles that paint on collision (the Skinner-Space-style ask).**
Unreal: fly droplets as particles/sprites, on world-static collision
spawn a decal at the hit point aligned to the hit normal
(`SpawnDecalAtLocation`, `(-Hit.Normal).Rotation()`). Unity tutorials do
the same via particle collision callbacks. Two lessons from everyone
who's done it: (1) a sprite frozen at the landing pose looks terrible —
you must swap particle → surface-aligned decal, not keep the billboard;
(2) parent/space decals on dynamic bodies or they float in air after
the corpse moves — or only paint static surfaces and skip the problem
entirely.

**Decal primitives, cheapest first:**
1. *Projected splat in the receiver's shader* — a uniform array of
   (pos, radius, intensity, tint); the terrain fragment blends stain
   color in. Zero draw calls, zero geometry, conforms to displaced
   terrain perfectly, no z-fighting. **This is what we already do**
   (`splatData[24]` in terrainShaders.ts). Owlchemy's Job Simulator
   "Ker-SPLAT" is the same idea baked into a render-target splatmap
   when you need persistence/area-counting (Splatoon-style); the RT
   ping-pong costs two passes per splat and is only worth it when the
   stain count or persistence needs explode.
2. *Instanced decal quads* — kMax quads lifted ~4mm off the surface,
   oriented to the hit normal, round-robin recycled. One instanced draw
   for all decals. threepp's fps_demo showed this beat geometry-churn
   decals by removing a ~33ms BLAS-refit hitch per stamp. Good when
   you need decals on arbitrary meshes, not just terrain.
3. *View-space projection decals* (DecalGeometry / deferred box
   projection) — draw a cuboid, reconstruct world pos from depth,
   discard outside the box. Per-pixel depth reconstruction over the
   whole cuboid; scales badly with decal count and requires depth
   sampling we don't have handy in the forward pass. Alyx uses it; we
   shouldn't.
4. *DBuffer/deferred decals* — requires deferred pipeline. Not us.

**Pooling rules everyone converges on:** fixed cap + FIFO eviction
(our 24 slots + `shift()` is the standard shape), decals recycled
round-robin, budgeted paints per burst so a shotgun pellet cloud
doesn't spam 20 decals (our `paintBudget: 4`).

**Juice details that are nearly free:**
- *Grow-in*: decals ease scale 0→1 over ~0.1–0.15s (the wet splash
  lands, it doesn't pop in).
- *Directional stretch*: elongate the mask along the landing velocity —
  streaks beat circles.
- *Satellite specks*: a real splash is a main blot + 2–4 off-axis
  droplets; can be faked in-shader with per-slot hash lobes, zero extra
  uniforms.
- *Dry-out*: fresh blood is bright and saturated; dried blood darkens
  toward brown/desaturated. We already fade intensity over 45s —
  darkening the tint as it dries sells the same arc harder.
- *Per-droplet brightness jitter* (H3VR uses noise 0.7–1.0) keeps a
  splat field from reading as one flat color.

## What we took

- Directional stains: `Splat` gains a unit dir + stretch; droplet
  landing velocity feeds it — smears point along travel.
- Grow-in: `SplatDecal` animates radius 0.35→1 over ~0.14s.
- Dry darkening: tint multiplier eases ~0.6 as the stain dries.
- Satellites: shader adds 2 hashed lobes per slot trailing the stain —
  splatter shape without extra uniforms.
- Brightness jitter per droplet: `onDropletLand` radius/intensity get
  a ±20% hash wobble.

## What we skipped and why

- **Stains on creatures/props**: decal-on-moving-mesh is the expensive
  hard part (wound RTs per character, bone-pinned decals re-transformed
  every frame). Our creatures are instanced anyway — no per-mesh UVs.
  Terrain-only stains, like our scorch system.
- **Wall stains**: interiors are sparse; revisit if a map makes wall
  hits common. The shader-splat trick doesn't generalize to arbitrary
  vertical meshes — that wants instanced quads.
- **Splatmap RT accumulation** (Ker-SPLAT/Splatoonity): needed for
  infinite persistent coverage or coverage accounting; 24 slots is a
  deliberate bound, not a limitation to fix.

Sources: s&box decal field guide, samdriver.xyz decal-render-intro,
Unity URP decal docs, tuket explosion-decals, Owlchemy Ker-SPLAT blog,
vfxmike Splatoonity, Tom Looman wound rendering, H3VR Blood System,
Tommygun Rust blood-splatter, threepp fps_demo decal-instancing commit,
UE/Unity blood-splat tutorials.
