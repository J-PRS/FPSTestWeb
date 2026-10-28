# Class model asset duplication (2026-10-28)

Status: reference note, no code changed for this item.

## What we found

Each live class GLB embeds its own copy of the same animation clips.

| File | Size (bytes) | Clips | Animation data (bytes) | Share of file |
|---|---|---|---|---|
| `client/public/assets/models/class_scout.glb` | 567,556 | 32 | 361,408 | 63.7% |
| `client/public/assets/models/class_brawler.glb` | 567,712 | 32 | 361,408 | 63.7% |
| `client/public/assets/models/class_brute.glb` | 567,012 | 32 | 361,408 | 63.7% |
| `client/public/assets/models/class_medium.glb` (vexa, not live) | 971,588 | 9 | 168,868 | 17.4% |

- The three live files hold the same clip names (first 8 checked) and the same animation byte count. Content is probably identical but not hashed.
- Two of the three copies are redundant: about 722 KB of duplicated animation data.
- `client/src/game/net/world.ts:338-343` warms all four live-class models at boot, so a joining player likely downloads all three.

## How it was measured

Node script run from `client/public/assets`. For each file: read the GLB JSON chunk, collect the `input` and `output` accessors of every animation sampler, and sum `count x componentSize x typeSize` per accessor. The first attempt summed bufferView lengths and overcounted, because accessors share bufferViews; the accessor-based sum above is the valid one.

Clip names came from the same JSON chunk (`animations[].name`).

## Context

- Live class selection: `CLASS_BODY_VARIANT` in `client/src/entities/playerClips.ts:414` maps light/medium/heavy to scout/brawler/brute.
- Retarget sources (`robot-anims*.glb`, `kevdev-anims.glb`) are used only by non-live rigs. Scout, brawler, and brute have `sources: []`.
- `anims/<variant>.glb` packs are loaded by `loadBakedUALClips` (`client/src/entities/playerUal.ts:448`). Scout, brawler, and brute have no pack, so each boot requests `/assets/anims/<variant>.glb` and gets a 404 before falling back to a runtime bake.
- The build prune list (`LIVE_UNUSED` in `client/vite.config.js`) drops the non-live packs and source GLBs from `dist/`. It keeps the three live class files.

## Options

1. **Shared clip pack.** Move the 32 clips into one animation GLB, for example `anims/live.glb`, and strip the clips from the three class GLBs. Keeps the per-variant mesh files. Reuses the existing `loadBakedUALClips` pattern. Saves about 722 KB per join.
2. **Keep embedded clips, dedupe at build.** Not practical without a glTF tool pass, and it doesn't remove the duplicate download.

## Prerequisites before option 1

- Confirm the three rigs share one skeleton: same bone names and hierarchy. The clips only apply cleanly if they do.
- Confirm the clip names are identical across all 32, not just the first 8.
- Check whether the mesh-only files still bind correctly without their own clips.
- Look at the 404 on `/assets/anims/scout.glb` (and brawler/brute) at the same time.

## Verification to run when implemented

- Byte sizes of the three class files before and after (node script above).
- Network panel during a boot: total GLB bytes requested.
- Playwright or chrome-devtools check that all three classes still animate in game and in gunlab.
