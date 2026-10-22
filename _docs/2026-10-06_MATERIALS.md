# Materials — how surface looks actually get made

Quick reference for the two cooperating halves of "worn procedural metal"
and which material classes exist where. Written 2026-10-05 while wiring
the `metalMat` recipe and the gunlab `▤ metal` toggle.

## The recipe (procMetal)

`client/src/entities/procMetal.ts` — the shared factory:

- `metalMat(color?, {roughness?, metalness?})` — machined gunmetal
  (0.45 / 0.75). The pickup-body defaults.
- `wornMetalMat(color?)` — tumbled variant (0.6 / 0.55) for parts that
  should read used, not machined.

The look needs **two halves working together**:

1. `MeshStandardMaterial` at moderate metalness — real specular
   response. Lambert physically can't show this.
2. The wear/grime vertex bake (below). On a Lambert body it just
   darkens; on metalness it modulates the specular, which is what makes
   it read as *worn metal* rather than a smudge.

## Material classes in use

| Class | Where | Reads as |
|---|---|---|
| `MeshLambertMaterial` | weapon bodies (`weaponKit.ts` bodyMat/darkMat, most `weaponsGeo*`) | matte — diffuse only, `emissive` fakes ambient |
| `MeshBasicMaterial` | accents, glows, bores, HUD-ish parts | unlit/emissive |
| `MeshStandardMaterial` | pickups (`Nugget` bodies), structures (`structKit`), GLB interiors, `procMetal` | PBR specular + metalness |

The Lambert `emissive` trick matters when converting: carry
`mat.emissive` into the Standard mat or the part loses its baked
fake-ambient lift (`metalFor` in gunlab.ts does this).

## The wear/grime bake (vertexAO.ts)

`client/src/effects/vertexAO.ts` writes per-vertex data onto geometry
and patches materials via `onBeforeCompile`:

- `bakeVertexAO(group, {grime, wearBoost})` — hemisphere raycast AO into
  vertex `color` attrs + wear (convexity × unoccluded) + grime + edge
  atlas (`geo.userData.__wearTex`) + material enhancement.
- `bakeWearOnly(group)` — wear/grime without the raycast AO (for
  already-textured GLBs).
- `enhanceWeaponMaterial(mat)` — the shader injection alone. Exported;
  call it on any NEW material you swap onto already-baked geometry or
  the wear/grunge is silently gone (`__grunge` userData flag gates
  re-injection — delete it before re-baking a cloned material).
- `attachEdgeWear(mesh)` — back-compat shim → `bakeWearTexture(geo)`.

Wear semantics: convexity AND unoccluded — crevices stay dark, only
exposed edges whiten. Flat-shaded blocks (most viewmodel parts) get edge
signal from coincident-position normal divergence, not per-vert.

## Where the bake runs

| Surface | Baked? |
|---|---|
| Weapon viewmodels (`vmBaked.ts`) | yes — AO or wear-only for textured GLBs; `GRIME_WEAPONS`/`WEAR_BOOST` per-weapon tables |
| Creature swarms (`swarms.ts`) | yes — grime + 0.7 wearBoost |
| Gunlab previews (`gunlab.ts` selectArchive) | yes — `bakeVertexAO(archiveGroup)` on everything |
| Pickups/nuggets in-game | **no** — bare `metalMat` + accent + halo (geometries are cached per kind, so baking once on the cached part is possible if wanted) |

## Gunlab `▤ metal` toggle

Swaps every `MeshLambertMaterial` in the active pick (weapon OR preview)
for a cached `metalMat` carrying the Lambert's color+emissive, then
re-injects `enhanceWeaponMaterial`. Stash/restore on toggle-off and
weapon/preview swap (`metaled` map). Lab-only — nothing ships until a
builder's materials actually change.

## Manifold output geometry (union/shell previews)

`maniToGeo` in gunlab.ts converts Manifold CSG results to render geometry.
Two decisions baked in that aren't obvious:

- **Keep the vertex pool indexed.** Manifold's `getMesh()` returns a
  shared `vertProperties` pool + `triVerts` indices — set them directly
  on the geometry. Going non-indexed first forces flat facet normals,
  which is what made `◨ shell`/`⛛ union` shade faceted.
- **`toCreasedNormals(geo, 60°)`** — smooth within surfaces, hard at real
  creases. Chosen because the weapon kits mix tubes (~20–36° segment
  facets, want smooth) with boxes (90° edges, want hard). A plain
  `computeVertexNormals` on indexed output would round box edges too.

Correctness notes that held up under audit:

- The carve happens in group space, then `applyMatrix4(m⁻¹·g)` moves the
  geo into the mesh's local frame — normals transform via the normal
  matrix, so don't generate normals after that call, generate before.
- The rebake (`bakeVertexAO(g)`) writes `color`/`wear`/`__wearTex` fresh
  on the carved geo — "shell looks different" is intended: smooth normals
  + wear concentrated on the new cut rims, not corrupted materials.
- `mergeGeometries(meshes)` inside vertexAO is a local position-only
  concat (not three's attr-strict util) — mixed attribute sets are safe.
- **ConeGeometry is indexed; IcosahedronGeometry isn't** — mixing them
  in `mergeGeometries` (three's util, e.g. PickupModel parts) returns
  null. Call `.toNonIndexed()` on cones before merging with polyhedra.

Pre-existing quirk, not shell's bug: kit mats (`bodyMat`/`darkMat`) are
singletons shared across weapons AND across sibling meshes in one weapon —
`mat.userData.__wearTex`/`__grimeTex` get repointed per mesh, last wins.
Sibling meshes sharing one geometry also get detached-and-rebaked on
repeat bakes (`baked` set in bakeVertexAO).

## Converting something to metal

1. Swap its `MeshLambertMaterial` for `metalMat(color)` —
   `mat.emissive.copy(lambert.emissive)` if the source relied on it.
2. Ensure `bakeVertexAO`/`enhanceWeaponMaterial` has run on the mesh —
   in-game entities that never hit the bake path need it explicitly.
3. Keep accents `MeshBasicMaterial` — glow parts shouldn't go PBR.
