# Class GLB clip-strip migration — post-strip wiring state

2026-11-07. The native animation packs were stripped out of every
`class_*.glb` to save bundle size (see
`2026-10-28_CLASS_ASSET_DUPLICATION.md` for the ~722KB duplication audit
that motivated it). This doc records where the clip supply actually
comes from post-strip, what was rewired, and the remaining gap.

## Where clips come from now

| Skeleton family | Rigs | Clip supply |
|---|---|---|
| M2M (`foot_l`/`ball_l`/`clavicle_l`) | scout, brawler, brute, juggernaut*, light_*, dreadnought | `class_scout.glb` — the shared 32-clip pack, loaded once via `classAnims()`/`_classAnimsP` (`PlayerModel.ts:101-105`). `PlayerModel.ts:425` falls back to it for **any** GLB that ships zero animations. |
| UE-style (`Hips`/`Spine`/`Chest`) | cybersoldier | `sources: ['kevdev','mannequin']` — kevdev covers locomotion, mannequin's native UAL set covers non-loco. The template for zero-native rigs. |
| Spine/Chest/Headgear | polyart | `sources: ['kevdev','ual2']` (wired post-strip — `POLYART_KEVDEV_BONE_MAP` + `POLYART_UAL2_BONE_MAP` existed already). Locomotion + UAL2 oneshots only — see gap below. |
| `Base_Human*` | vexa | `sources: ['kevdev']` — locomotion only since her non-loco natives were stripped (gap). |
| `Rig*` | scifisoldier | **No clip supply.** No bone map exists into any shared source — kevdev/UAL specs would bind nothing. Left `sources: []`; comment in `playerClips.ts` names the gap. Legacy variant superseded by `scout`. |

`RIG_MANIFEST[variant].sources` is the driver — `playerUal.ts` `SPECS`
maps each source id (`kevdev`, `ual1`, `ual2`, `mannequin`) to a GLB + a
default bone map + optional `mapByVariant` override. A source with no
matching map for the rig's bones produces zero bound tracks (silent
no-op), so wiring `sources` without a map is decoration, not coverage.

## What changed in the strip's wake

- `SCIFISOLDIER_ANIMS` + `POLYART_ANIMS` native anims tables deleted —
  they named pack clips that exist nowhere now (dead config the tests
  were right to flag).
- `clipRootMotion.test` — the anims-table check now validates entries
  against the **runtime union** (own GLB + `class_scout.glb` + declared
  SPECS sources), the same set `PlayerModel` actually loads.
- `animCoverage.test` — RIGS excludes `scifisoldier`/`vexa`/`polyart`:
  with natives stripped and no non-loco bone map they can't resolve a
  full state matrix. Re-add each when a non-loco map lands; the test's
  comment block says so.

## The gap (unclosed)

Three UAS variants still have **no non-locomotion clip supply**:

- `vexa` — idle/death/jump/hit/shoot all empty (was native, stripped).
- `polyart` — kevdev+ual2 covers loco + oneshots; idle/death/jump empty.
- `scifisoldier` — nothing at all (no maps, distinct `Rig*` skeleton).

Closing it needs new bone maps into a UAL/mannequin pack per skeleton —
cybersoldier's `kevdev + mannequin` pairing is the template — or
retiring the variants from `RIG_MANIFEST`. Deliberately not guessed:
binding a wrong-name map bakes zero tracks silently.

## Repro / verify

- Per-GLB clip inventory: parse the GLB JSON chunk
  (`json.animations`) — the strip is visible as `0 animations` on every
  `class_*` except `class_scout` (32).
- Visual bake check: `posedump.html?pmodel=<variant>&state=walk` — polls
  `window.__ready` (page doesn't set `__test`; see root AGENTS e2e
  notes). A rig with no clip path renders bind pose, not an error.
- Tests: `vitest run src/__tests__/clipRootMotion.test.ts
  src/__tests__/animCoverage.test.ts` — the two gates this migration
  touches.
