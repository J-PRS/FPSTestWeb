# Hard-Surface Weapon Modeling in Blender — Flak Cannon Research

2026-10-05. Research + applied lessons from building the UT-style flak
cannon (`_tools/flak_cannon.blend`). Techniques here are deliberately the
ones that are NOT feasible in our TS primitive-merge pipeline
(`weaponsGeo*.ts`) — live modifier stacks, booleans, floaters, curves.

## Sources

- Howel Ganuchaud, "Advanced Weapon Creation" — gamesartist.co.uk
  (the mid-poly workflow + temperature areas reference)
- Blender Bros sci-fi cannon/hard-surface tutorials — blenderbros.com
- Gnomon "Sci-Fi Pistol for Games" (Sean Marino, Riot) — blockout theory
- 80.lv vintage gun breakdown — vertex-group-controlled bevels, Box Cutter
- UT4 flak cannon fan HD remakes (ArtStation/Sketchfab) — silhouette ref
- CGCookie "Modeling Weapons for FPS" — bevels, normal decals, hi/lo poly

## The pro loop (I did it backwards on pass 1)

1. **Blockout = 80% of the work.** Boxes only, no detail. Validate
   proportions and silhouette BEFORE any bevel/boolean. If the gun reads
   as a uniform rectangle here, no amount of greebles fixes it.
2. **FPS-camera check immediately after blockout.** The viewmodel angle
   (rear-left, low, looking down the bore) is the only angle that matters
   for a first-person weapon. Render it before detailing.
3. **Booleans for cavities** — ejection ports, vents, panel recesses.
   Keep cutters live/non-destructive; add a darker liner mesh inside the
   notch so it reads as a machined cavity, not a hole in a texture.
4. **Bevel modifier as support loops** — not just edge softening. Bevel
   generates the edge-density that subdivision/shading needs. Vary bevel
   width: big on silhouette edges, micro on detail edges.
5. **Floaters** — geometry hovering ~1mm above a surface that exists ONLY
   to shade/bake (overlay panels, rivet plates). Free detail, zero
   topology cost. This is the biggest "wait, that's allowed?" trick.
6. **Temperature areas** — detail density follows the player's eye:
   hot at receiver top / sight / grip zone, cold on barrel underside and
   stock. Uniform greeble scatter reads as noise.

## UT/Quake stylized gun DNA

- **Shape rhythm over realism**: the UT flak cannon is a fat breech →
  tapered finned jacket → FLARED muzzle collar. Three silhouette beats.
  Mine was initially a slab; the flare collar is the single highest-value
  fix.
- **Chunky**: oversized collars, thick sight blocks, exaggerated drum.
  Stylized = push every proportion ~15% past plausible.
- **Mechanical storytelling**: ejection port, charging handle, bolt
  rails, takedown pins — the gun explains how it works. Sealed boxes
  with decorative dents look like toys.
- **Restrained accents**: one warning-band color (amber/gold) at the
  muzzle collar + a sight post. Not rainbow greebles.

## Blender-specific techniques used on flak_cannon.blend

- `Bevel` modifiers on every hard part (width 0.006–0.02, segments 1–2)
- `Boolean` (EXACT solver) for the ejection port — cutter hidden, liner
  mesh inside
- Radial fin ring: 10 mesh plates rotated about the barrel axis, plates
  EMBEDDED into the jacket (r 0.155 vs barrel r 0.16) — intersection is
  fine; coplanar is the enemy
- `Curve` with `bevel_depth` + Bezier AUTO handles for the feed hose —
  routes around parts, zero modeling
- Torus + post ring sight; hex-cap bolt cylinders at receiver corners
- Floater overlay panels 1–4mm above receiver flanks
- Live-preview pseudo-camo: `Noise Texture → ColorRamp` into Principled
  base color (scale ~9, wide contrast) + Eevee at 480×360 — mimics the
  baked vertex-AO mottle. NOTE: node graphs don't survive glTF; bake to
  texture or vertex colors for export.

## Gotchas hit live

- **`transform_apply(scale=True)` resets location on primitives added
  with `location=`** — produced ten stacked coplanar fins = z-fighting.
  Verify transforms after apply, or build meshes via `from_pydata`.
- **Coplanar faces z-fight; intersecting is fine.** Flush-mounted
  greebles must be sunk a few mm INTO the surface they decorate.
- **`Applied modifier was not first` warning** — applying a lower-stack
  modifier bakes with upper modifiers unevaluated. Apply top-down or
  audit the stack before exporting.
- Engine enum in 5.2 is `BLENDER_EEVEE` (the `EEVEE_NEXT` rename was
  reverted).
- Barrel axis: built along +Y (forward in this scene); glTF exports -Z
  forward → rotate on import or in engine.

## Polycount sanity (weapon art, not ours)

- Mid-poly (bevels+decals, no hi/lo split): Cyberpunk guns hit 60–70k.
- Classic hi→lo: big modern gun ~20–30k low-poly, bake the rest.
- Our flak cannon is <<5k — viewmodel-safe, could triple detail free.

## The Doom doctrine — chunky stylized guns (round 2 research)

How iconic Doom/Quake/UT guns were actually designed, from the artists:

- **"Singular, continuous form — fully encased, low-frequency detail,
  sparse cut-lines."** — Jon Lane, id, on the Doom Combat Shotgun. The
  gun is ONE mass with cuts carved into it, not parts glued together.
  Our tube+receiver still meet at a seam; the ideal is one shroud
  flowing breech→bell.
- **"Chunky and heavy design language... the challenge was third-read
  detail WITHOUT MAKING IT LOOK DELICATE."** — Timothee Yeramian, id.
  Small greebles actively hurt chunky guns — they're a realism habit,
  not a stylization tool. Subtraction > decoration.
- **Mechanics before geometry** — Bryan Flynn "figured out most of the
  mechanics early"; Doom guns are designed around what MOVES (Gauss
  unfolds on zoom, front-ends expand on alt-fire). A gun's personality
  is its animation, not its trim. Flak claws should articulate on
  equip/fire — designed-in, not bolted-on.
- **"Give them mass"** — UT3 art direction. Personalty + battle-worn
  real-world feel; moving parts; 3.5k→10k tri budget grew during dev.
- **Epic's process**: proto mesh fast ("focus on creating geometry vs
  perfect geometry"), get it in-game ASAP, iterate design IN the engine,
  hi-poly only after the design is proven. UT4 flak was literally a
  community concept (KazeoHin) refined through this loop.

### Big-Medium-Small (the rule my gun violated)

- ONE dominant shape, ≤4 medium shapes, details strictly subordinate.
  First draft had ~12 equal-weight mediums (drum, ribs, claws, rail,
  sight, hose, floaters, bolts, fins) competing — reads as "stacked
  junk," not a gun.
- The subtraction pass (delete floaters, grooves, all 8 bolts, rib spam,
  wedge, charge knob) improved the read more than all additions combined.
- **Asymmetry reads natural.** Cardinal claw placement put a plate
  hanging below the silhouette like a loose tab; rotating to the bell's
  diagonal corners made them read as expanding petals.
- Feed systems carry outsized readability (Sarah Clarity Studios):
  thickness/curvature/visible-rounds telegraph ammo class in <1s. The
  drum earns its size; decorative ribs on it don't.

### Revised rule of thumb

When a chunky stylized gun looks "mid," the bug is almost never missing
detail — it's missing MASS HIERARCHY. Merge before you decorate.

## Still-missing vs UT reference (next pass)

- Receiver→tube should be ONE encased shroud (Doom doctrine), not two
  objects meeting at a seam
- Shell chamber / drum feed window visibility
- Claws should be jointed for equip/fire articulation
- Normal-map baked details if this goes to GLB (vents as floaters only)
