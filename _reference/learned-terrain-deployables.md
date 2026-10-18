# Learned: terrain, maps, deployables (session notes)

Append-only notes from the hills/mirage/maplab/deployable work. Covers
what the codebase actually does, the traps hit, and the knobs that matter.

## 1. Heightmap contract

- Square 8-bit heightmap, R channel 0-255 -> `h/255 * 125 * heightScale`
  meters over `HM_WORLD_SCALE` (1500 m). Both ends wrap (clipmap
  `RepeatWrapping`, CPU sampler does the same modulo).
- Bit-identical sampling is the hard constraint: server sim + client
  prediction replay against the same field, so terrain is BAKED, not
  procedural at runtime. Generation is offline and free to be heavy.
- GPU reads texel centers, CPU sampler compensates by -0.5. Generators
  must produce the field both paths see (the PNG->bin pipeline does).

## 2. Generators (in `_tools/mapbake/`)

- `genfield.js` — crudest: 3 fixed octaves of value noise + flats/craters,
  gain 0.38, NO normalize. Produces smooth low-relief plates. hills.bin
  was almost certainly from this (range 81/255, sd 9 m, 18 deg mean).
- `genmap.js` — fBm/ridged + domain warp + stamped features (bowls,
  plateaus, sea, tilt, flats). Normalizes to full range. Periodic.
- `genlagoon.js` — hand-authored archipelago (islands + shelf + deep).
- `genhills.js` — erosion-based (thermal talus + Beyer raindrop hydraulic),
  periodic BCs. Takes hills from 59 m relief / sd 9 to 187 m / sd 30.
- `genoasis.js` — sand dunes + scattered water pools (coast palette).
- `gen.py` / `mapgen/` — T2 CTF compound generator (structures on a
  heightmap), not terrain.

### The big trap (decisions.md)
A custom field must MATCH THE T2 RELIEF PROFILE (~125 m relief, sd 20-30 m,
mean slope 29-33 deg, energy 20-200 m). Two specifics:
  (a) NORMALIZE to the full byte range — `height` in every palette is
      byte/255, so a field filling only 0..0.56 leaves every palette stuck
      in its low band.
  (b) Features must be ADDITIVE and domain-warped — `mix(h, const, t)`
      turns a "mesa" into a PIT when the constant sits below the local
      fBm mean, and unwarped radial ops stamp literal circles.

## 3. Terrain palette presets (terrainShaders.ts / terrainPresets.ts)

- Preset 1 = desert (sand + dirt + rock; height-relative bands).
- Preset 2 = grassland (olive grass; height-relative).
- Preset 3 = snow (Whiteout).
- Preset 4 = volcanic (Caldera).
- Preset 5 = badlands (Hoodoo) — strata via `height * 12`.
- Preset 6 = coast (Lagoon) — ABSOLUTE height bands: water <0.010, wet sand
  0.045-0.072, dry sand 0.072-0.100, grass 0.100-0.170, rock 0.24-0.31.
  The lagoon correction: the sea sink is invisible because the field doesn't
  fill low enough (only 0.02% below waterline). Fix = widen/deepen the sink
  so 5-15% of the field is below byte ~2 while land keeps full 0..255 span.
  Do NOT rescale the field down to 0..0.30 (shrinks relief).

Presets 1-5 are height-relative (use the whole range). Preset 6 is the only
absolute one — the trap.

## 4. Terrain texture (hills fix)

Root cause: grassland preset (2) computed `grainG`/`triGrainG` and never
used them, and no micro-normal existed. Fix in terrainShaders.ts, preset 2
only: fragment micro-normal from `dFdx/dFdy` (bump-without-tangents,
det-normalized) feeding diffuse + grass sheen; `grainG`/`triGrainG` now
applied to albedo + bump-gradient crease darkening; un-band-limited micro
terms gated to close range (`nearFadeG` 20-70 m) and grazing-angle damped
(`bumpFadeG` 30-100 m) to kill moiré. WebGL2, no `extensions:` needed.
Tuning knobs: bump amplitude 0.10, nearFadeG 20-70m, bumpFadeG 30-100m,
grain multipliers 0.38/0.22.

## 5. Map spec composition (hills atmosphere fix)

hills was the only procedural map with NO `atmosphere` and NO `weather`
block, so it fell back to the engine default trio {dust:1, embers:1, ash:1}
— literally embers glowing and ash falling on a green meadow. Every
good-looking map carries both. The fix: add `atmosphere` + `weather` + tuned
`fog` (warm horizon band for aerial perspective). The user later rejected
the amber/yellow version ("green into grey into blue" is preferred) — so
the final hills keeps cool fog colors and no warm atmosphere, with neutral
ash motes instead of golden dust.

Weather kinds: dust (golden motes), embers (orange sparks), ash (grey
flecks), snow (white flakes). Absent weather = default trio. Dust's colors
are hard-coded golden (85% warm, 15% pale blue) — a "dirty yellow" source.

## 6. Terrainrate.js (the "ball soak" report card)

Multi-axis report: RELIEF, GRADE (slope bands), SCALE (coarse/fine ratio),
SHAPE (convex/concave, chatter), LINE (fall-line drop/length), PADS
(walkable/flat), and a BALL SOAK (drop N balls, ski 10 s, report speed
percentiles: dead-ball pass + jetted pass). Uses T2 ports as reference
population with `--ref` (percentiles, not absolute verdicts). Hoodoo is
the "good ski map" reference: sd 16.9, mean 27.4°, steep 12%, soak p50 9 /
p90 20 / moved 75%.

A good ski map: mean 20-30°, flat <10%, steep 15-25%, hard <15%, cliff <10%,
chatter <4 m, coarse/fine ~0.7. Sand dunes (narrow sand band 0.072-0.10)
are inherently less skiable than strata.

## 7. Deployable turrets

- DeployTurret (sentry): instanced pool (7 parts, cap 192). Was a toy
  (tiny dims, no wear, cyan glow). Fixed: scale up ~1.6x, wear+emissive,
  amber optic, updated MUZZLE/sync offsets. oxlint/tsc clean.
- DeployMortar, DeployCg (minigun): real meshes. Same treatment (wear,
  emissive, thicker geometry, warm optic). MUZZLE constants updated.
- Gunlab: deployables previewed under "items" (sentry, shield, station,
  beacon, drone). Sentry uses instanced pool → needs `creatureLayer` added
  to its proxy (otherwise invisible). `bakeWearOnly` on proxy for visibility.
  Added mortar + minigun entries to ITEMS list.

Friendly fire: deployables should NOT take friendly (teammate) damage.
- Server `RoomDeployables.applyBlast`: skip if deployTeam === shooterTeam
  and shooterId !== d.owner (self-splash stays legal, matching player rule).
  Base assets resolve team from `base:<team>` owner id.
- Client `Deployables.blastRemotes`: skip if `i.team === localTeam && i.owner !== undefined`.
- Players/bots: same rule via `CombatHandler.friendly()` — self-splash
  legal, teammate blocked unless `FPS_FRIENDLY_FIRE=1`.

## 8. Maplab tooling

- `copy spec`: minimal 3-field snippet (terrain/heightScale/terrainPreset)
  to paste into a real map JSON.
- `copy params`: full knob set (Object.assign({}, state)) for reproducibility.
- Terrain picker: ◀/▶ buttons for quick map cycling; T2 maps prefixed
  `[T2]`, custom maps `[C]`, sorted custom-first then T2.
- T2 maps identified by `_t2` marker in the map spec.

## 9. Map archetypes (missing)

Night, forest, swamp, canyon, urban ruins, toxic wasteland, glacier/cave,
tundra, floating islands. The missing ones are about constraint (canyon,
cave, ruins) or atmosphere (night, swamp, toxic). Oasis (mirage) added
as a native sandy-with-water map.

## 10. Practical pitfalls

- **Literal `\n` in edits**: the edit/write tools sometimes write `\n`
  literally instead of a newline. Use PowerShell heredocs or line-based
  edits instead. Always verify with `Select-String`/`Get-Content`.
- **Bun crashes**: `hillshade.cjs` crashes bun (illegal instruction);
  use `node` instead. Bun OOM on tsc deserialization; use node with
  `--stack-size`.
- **Image read broken**: the `read` tool intermittently can't read PNGs
  ("does not support image input"). Use file.open or visual verification
  via in-game captures.
- **oxlint `no-rest-spread-properties`**: use `Object.assign()` not `{...x}`.
- **oxlint `no-zero-fractions`**: `1.0` → `1`.
- **check.sh on Windows**: use Git's bash, not WSL bash (CRLF issue).
- **mapspec test**: use `bun test` in server_bun, not `bun test` in client
  (window is undefined). Client tests use `bunx vitest run`.
- **Double-spaced file**: `client/src/game/combat/impact.ts` has a blank
  line between every source line.
- **Foreign uncommitted changes**: the checkout has ~89 foreign changes;
  avoid `check.sh --fix` (touches unrelated files). Scope manually.