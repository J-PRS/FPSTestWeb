# Character construction techniques — deep reference (2026-10-24)

Round 2 research for the class-rig builders. Old-school era lessons that
still apply, plus the 2025 agentic-3D landscape. Companion doc:
`2026-10-24_MECH_SILHOUETTE_TECHNIQUES.md` (the design grammar).

## Old-school (PS1/N64/Quake era) — techniques worth stealing

- **Segmented action-figure skinning** — FFVII/RE1 limbs are separate
  meshes weighted 1:1 to bones (or just pivoted objects). Our plate rigs
  already do this — it was literally the PS1 technique for armor.
- **Vertex keyframe anim (Quake)** — models animated via skeletons in the
  DCC, then baked to per-frame vertex deltas; gives squash & stretch
  bones can't. Relevant if we ever want body deformation on death/hit
  beyond bone pose — bake a few frames of vertex morph.
- **Vertex color as lighting substitute** — Spyro/Crash paint shading
  INTO vertex colors (no textures). We already get this free from the
  AO bake — vColor is the same trick with a procedural source.
- **Big-medium-small on a budget of ~500-1000 tris** — Crash = 732 tris
  total. Our 2.5k jugg is generous; the budget should go to silhouette,
  not interior detail.
- **Detail via geometry silhouette breaks, not texture** — PS1 had no
  texture budget; detail was silhouette. Quake-look comes from jagged
  silhouette + painterly albedo, not high-frequency surface noise.
- **Fake roundness via alpha-card + low-seg cylinder hybrids** — tires,
  lamps: flat card doing the cylinder face. Could fake pauldron rims
  or jet fans with a single alpha quad if tris ever matter.
- **Weapons/props parented to bones** — bone-parented props (grenade
  belts, holstered pistol) follow anims for free; our pack/crest
  already do.

## Recent agentic / AI-3D pipelines (2025)

- **Meshy / Hunyuan3D / Tripo / Rodin** — prompt or multi-view images →
  GLB, optional auto-rig + clip library (Meshy v7 auto-rigs humanoids).
  Output is a blob mesh — the wrong topology family for plate armor, and
  no per-part material split without post work. Fine for prototyping
  silhouettes, not production on our pipeline.
- **SmartAvatar-style agent loop** — VLM renders a draft, critiques its
  own silhouette vs the prompt, iterates params. The interesting part
  isn't the generator — it's the render → critique → iterate loop. We
  effectively have that: build script → posedump/gunlab render → judge.
  Worth formalizing: a `shot → diff → adjust` cycle instead of eyeballing.
- **Hunyuan3D Studio** — end-to-end: concept → part-level generation →
  semantic UV → PBR. The *part-level* stage is the transferable idea:
  generate the shell pieces separately, assemble onto the skeleton —
  that's what our kitbash variant already does by hand.

## What applies to OUR builders specifically

| Technique | Already used | Worth adding |
|---|---|---|
| Rigid 1:1 plate-to-bone | ✅ every rig | — |
| Vertex-color shading | ✅ AO bake | — |
| Kitbash parts per slot | ✅ `kit` | parts shared across tiers (scout/brawler) |
| Silhouette-first blockout | partial | lock outline before plates land |
| Landmark features | partial (bld pack) | 1 signature per variant, not distributed detail |
| Vertex morph frames | no | hit/death squash if wanted later |
| Agent render→critique loop | informal | script a turntable + diff check per rebuild |

## Where the bodies actually stand

The .mjs rigs are coordinate lists; the .blend rig is the only one with
a sculptable source of truth. If we keep iterating on character quality,
the investment order is: (1) .blend as canonical for the shipped class,
(2) kit parts extracted into a shared `_tools/models/parts/` lib,
(3) silhouette-lock pass on the five rigs so they're each identifiable
from a 64px render.
