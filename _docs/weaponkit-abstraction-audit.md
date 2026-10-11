# Weapon Kit Abstraction Audit (2026-10-10)

Audit of `client/src/entities/viewmodel/weaponsGeo{Ballistic,Energy,Sidearm}.ts` for repeated
hand-rolled Three.js patterns that should live in `weaponKit.ts`. Ranked by line savings.

## Recommended additions (priority order)

### 1. `mkBox(w, h, d, x, y, z, mat, rotX = 0)` — biggest win, ~45 sites

The dominant pattern across all three builder files: `new Mesh(new BoxGeometry) +
position.set`, ~3 lines each. Sidearm is ~15 sites (receivers, slides, rails, guards,
sights, triggers), ballistic ~20 (receivers, stocks, grips, risers, vents, ports),
energy ~10. The `rotX` param covers the ~10 raked-grip sites (`rotation.x = 0.25–0.35`).

### 2. `mkTube` gains `ox`/`oy` offsets — kills ~15 hand-rolled cylinders

`new CylinderGeometry + rotation.x = π/2 + position.set(x, y, z)` reimplements mkTube
whenever a tube lives off the bore axis: plasma bell/throat/glows/cell, revolver
cylinder/bore, repair front/rear housings/face/tip, sprinkler dial/podGlow/centerHole.
Cheaper than a new `mkCyl` — just extend mkTube's signature.

### 3. `radialRepeat` gains a `spin` option — "face outward" ring parts

Current signature: `radialRepeat(n, r, z, mk(a), a0 = π/8)` places but doesn't orient.
Most ring usages also rotate the part to face out: plasma fins (`rotation.z = a`),
revolver flutes (`-a`), MRV shroud ribs (`a + π/2`), bolt fletching, sticky bombs,
GL/bow-drum chamber mouths. ~7 sites. Add `spin?: (a: number) => number` applied to
`rotation.z` (or rotation.y for drum-face rings — worth a flag for axis choice).

### 4. `mirrorX(mk)` — the `for (const side of [-1, 1])` loops

Bolt risers/cheeks/arms, MRV stock struts + brake ports, sprinkler pods, repair
cables (side × yOff nested). ~8 sites. `for (const m of mirrorX(s => mkBox(...))) g.add(m)`
where `s` is ±1 passed to the factory.

### 5. `segStack` — running-z turned-barrel builder

Cannon `cnSeg`/`cnHoop` and Bombard `bbSeg`/`bbHoop` are identical duplicated closures
(build a segment at running z, advance; crowned hoop = two tapered rings). Revolver's
`bseg` is a third variant. Hoist: `const st = mkStack(group); st.seg(...); st.hoop(r)`.

## Sizing (as of 2026-10-10)

- 1,522 lines of builders: ballistic 844 + energy 394 + sidearm 284. Kit itself 447.
- Realistic savings: mkBox ~90 · mkTube offsets ~30 · radialRepeat spin ~15 ·
  mirrorX ~15 · segStack ~15 → **~165 lines out of the builders (~11%)**, minus
  ~40 lines of kit additions → ~10% net.
- Ceiling is real: after this pass, what's left is mostly genuine per-weapon
  silhouette logic, not boilerplate.

## Deliberately left alone

- Extrude/shape grips (pistol, revolver plowhandle) — one-off profiles, the curve IS the design.
- `hexHalf` / Sutherland–Hodgman slit machinery in disc.
- `tubePath` bow-string legs, tickBow dynamic string.
- Plasma-gun notched-ring prong lofts — unique machining detail.
- Lightning's numerically-solved fork lean (RB/RT/TILT math).
- Chaingun barrel loft cluster + recoil userData.
- `mkSoftBox` — exists in kit already, used by sidearm only.

## Known kit seams (worth fixing opportunistically)

- `mkRevolve`'s `smooth` weld is broken: ring verts get `u=0` on one seam side and
  `u=1` on the other, so `mergeVertices` never merges — stays faceted triangle soup.
  Fix: make seam-side u consistent (`j/seg`), or drop the option and document
  "turned parts → stacked mkTube".
- `mkLoft` emits non-indexed triangles → flat per-face normals + sparse verts → the
  vertex-AO bake resolves as big blotches/facets. OK for hard-surface blocky parts
  (profOct); never use for round turned surfaces.
- `mkTube` hardcodes 8 radial segs — fine for bore walls; `mkRod` covers detail rods.

## AO bake lessons (why these rules exist)

- `bakeVertexAO` raycasts the merged weapon in a 63° cone, ~6cm reach, 16 rays/vertex.
  Texture = `vColor` variance (shader: `diffuse *= 0.6 + 0.4*smoothstep(0.2,0.75,vColor.g)`).
- Blobby organic texture needs *local* occlusion contrast — stacked parts/rings that
  shadow each other over short distances (flak is the reference).
- Single long smooth walls bake flat ~1.0 → uniform grey (one occluded vertex paints a
  huge stretched triangle — the "glitch" artifacts on early mortar iterations).
- Parts embedded inside a wall (receiver box poking into the tube) paint giant real
  shadows — seat them kissing the surface, or under-sized.
- Capped cylinders are fine. Dark wedges came from lofts/embeds, not caps.

## Conventions

- Barrel axis = local Z, muzzle at −Z. `mkTube`/`mkRod` pre-rotate cylinders onto Z.
- Cross-axis drums (revolver cylinder, GL drum) hand-roll `rotation.z = π/2` today —
  no mk func; if a sixth pattern is needed, `mkDrum(r, len, x, y, z, mat)` covers
  GL/sticky/bow drum+hub pairs (~5 sites).
- `radialRepeat` default `a0 = π/8` puts parts at facet centers of the 8-seg tubes.
- Name important parts (`m.name = 'mortar.brake'`) — gunlab click-pick reports the name.
