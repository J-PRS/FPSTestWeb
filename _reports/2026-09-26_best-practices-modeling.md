# Weapon/enemy modeling — best practices for agentic 3D in three.js

## Procedural code > asset files for this workflow
For AI-driven iteration, geometry built from primitives (cylinders/boxes/cones in a `THREE.Group` factory) beats loaded GLTF:
- **Diffable + versionable** — it's code; reviews, tweaks, and regressions are just text diffs.
- **No binary assets** the agent can't inspect or fix.
- **Instantly iterable** — change a number, screenshot, compare.
- Cheap: KRIBES's stylized low-poly look suits primitives natively (Krunker/Tribes are chunky, not photoreal).

## The agentic loop that works
1. Author a `THREE.Group` factory with **named parts and sensible pivots** (so animation can rotate barrels/drums/legs without knowing internals).
2. Render it headless (playwright screenshot or offscreen render), **judge the frame not the code**.
3. Iterate: silhouette first (does it read from across the map?), then silhouette against siblings, then material/emissive accents.
4. Keep the last good version before each pass.

## Weapon model review rules (applied)
- Each weapon must read as a distinct silhouette, not "generic tube": railgun = coil stack + capacitor drum, chaingun = tri-barrel + receiver, flak = boxy breech + top vents (the UT grill read), mortar = fat flared muzzle + breech, plasma = twin tubes + glowing emitter.
- Muzzle flash position is **per-weapon** (`MUZZLE_Z` map) — a shared offset floats ahead of stubby barrels.
- One `Map<WeaponType, Group>` — never positional arrays (enum-order collisions are a real bug class; this one showed the mortar for the chaingun and crashed on railgun).
- Color code materials per weapon where it helps identity (glow rings on railgun, green emitter on plasma) — Lambert gray + one emissive accent is enough.

## Enemy rendering
Same lesson scaled: instanced meshes per species-part (`swarm.ts`/`swarms.ts`) — one InstancedMesh per part per species, per-instance matrix + instanceColor for flash/telegraph. ~2000 draw calls at 300 enemies → ~30.
