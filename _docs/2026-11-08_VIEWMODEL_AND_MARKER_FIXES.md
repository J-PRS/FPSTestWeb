# 2026-11-08 — Viewmodel batch + IFF marker & corpse fixes

Companion to `2026-11-08_WEAPON_MODEL_REVIEW.md` (the ranking). This doc
records what actually changed this session and why.

## Weapon viewmodels

### FastDisc (`mkFastDisc`, `client/src/entities/viewmodel/weaponsGeoBallistic.ts`)

- **Grooves deepened 2×** (`DISC_HEX_R * 0.09` → `0.18`) and the black
  liners sunk so their mouths sit at the old `0.09R` depth — the visible
  open channel is the same depth as before liners existed.
- **Interior groove deleted at the source:** `hexHalf` clips the hex at
  `±DISC_SLIT_HALF` and the roof-edge filter tested `cur.y > 0`, which
  passed the clip baseline (`0.019`) and generated a groove+liner buried
  inside the body. Both `hexHalfGrooved` and `grooveLiners` now require
  `cur.y > DISC_SLIT_HALF`. (The ghost part the user picked:
  `child[5] › child[4]`, an interior ExtrudeGeometry.)
- **Grip + trigger guard removed** — the raked slab/guard read as a
  nonsense handle; most weapons carry none.
- **Forend block → 6-sided cylinder** (r=0.035, L=0.28) and raised
  `y=-0.13 → -0.11` so it tucks under the body — reads as a hex bar a
  hand could wrap, not a sharp slab.
- **Spindle deleted** — hidden 36mm cylinder, animation only drives the
  `discAmmo` group; same for the normal disc.
- **Rim color kept neutral** (`0xC8_F4_FF` white-cyan) after an
  aggressive `0x33_AA_FF` trail-matching test read worse. Note: the
  projectile trail is the regular disc's saturated blue ramp —
  intentional hotter-than-trail rim.

### Disc (`mkDisc`, same file)

- Grip + trigger guard removed, hidden spindle removed. Forend left as
  the original box (hex-bar swap deferred per user direction).

### Blaster (`mkBlaster`, `weaponsGeoSidearm.ts`) — reworked

Was bottom-of-kit (ranked 25/27). New: tapered octagonal emitter
housing, twin collar rings, glowing emitter face, top-mounted glowing
charge cell in a dark cradle (the energy-weapon tell), raked hex grip +
pommel. Emitter prongs were added then removed per user feedback (they
read as a beam weapon). Scale `1.17`, `z=-0.08` forward push so it
reads in FPS; octagonal receiver added behind the housing (`z=0.085`)
so the barrel doesn't float.

### Pistol (`mkPistol`, `weaponsGeoSidearm.ts`) — reworked, v1 archived

Was the worst model in the kit (27/27, stacked boxes). Old builder
moved verbatim to `weaponsGeoArchive.ts` as `mkPistol_v1` and registered
in `ARCHIVE_BUILDERS` (shows as `pistol_v1` in the gunlab archive rail).

New build is silhouette-first:

- **Slide**: trapezoid `ExtrudeGeometry` — chamfered top corners are
  the machined-autopistol read.
- **Frame**: single extruded side profile running dust cover → trigger
  bow → tang → raked handle → beavertail. The grip started as a
  separate extruded mesh (the revolver trick) but floated off the tail
  under every offset — so it was merged *into* the frame silhouette; a
  floater is now geometrically impossible. A `gripMat` band overlay
  paints the handle green.
- Rear serrations, rear notch + front blade sights, barrel ring + bore
  dot, trigger blade. `scale=1.2`, `z=-0.06`.
- Two floater fixes on sheet review: serrations + rear sight were
  anchored over the beavertail (`z>0`) while the slide ends at `-0.02`
  — moved onto the slide rear; grip band sat past the tail — moved
  onto the handle.

## Gunlab

- **Implodisc filtered** from the weapons rail + prev/next cycling
  (`gunlab.ts` `paintRail` + key cycle now iterate `MODEL_BUILDERS`
  keys + Chaingun). The runtime alias
  (`weapons.set(Implodisc, weapons.get(Disc))`) is untouched — belt
  viewmodel still works; it just doesn't get its own rail entry.
- **Sheet capture**: `shotSheet` composite is now **512×512** (cell
  256). Vision cost is per-pixel (`⌈w/28⌉×⌈h/28⌉` tokens), so sheets
  dropped ~1370 → ~360 tokens. External cells now fit the projected
  bounding *box* (8 corners pulled back to ~92% frame) instead of the
  bounding sphere — long guns (railgun) and wide ones (chaingun)
  actually fill their cells. FPS cell unchanged (real viewmodel).
- Known unfixed: `mkWeaponSel` uses `[...MODEL_BUILDERS.keys()]` on an
  **array** — `.keys()` yields indices, not weapon types (pre-existing
  bug, held-weapon picker likely broken).

## Runtime bugs

### IFF marker flicker (normal ↔ ~2m below, every frame)

Two writers per frame: `remotes.ts`'s local-bot lane writes
`position + renderLift`; `bots/index.ts` `headhuntBadges()` wrote the
same id at `position + 1.6`. The DOM chevron alternated anchors every
frame — offline/headhunt only. Fix: `held` + `setHeld` moved into the
remotes lane; `headhuntBadges()` reduced to `b.setHeld(b.heldTokens)`.
`client/src/game/remotes.ts`, `client/src/game/bots/index.ts`.

### Frozen corpses in offline bot play

`shared/botGoals.ts:254` read `process.env.BOTGOALS_DEBUG` — bare
`process` doesn't exist in the browser, so `BotBrain.think` threw
through `TeamBots.tickBot` mid-loop and every bot after the thrower
skipped its tick that frame — including corpse stepping. Threw every
frame once a bot hit the goal re-pick branch → bodies frozen mid-
tumble, never shrinking. Fix: `typeof process !== 'undefined'`
guard. `bun test` after: 1618 pass / 13 fail — failures not related
to this file (pre-existing).

## Verification

- `tsc --noEmit` clean after every batch (client).
- `gunsheet.ts` regenerated `client/shots/w*_sheet.png` for all 27
  weapon types at the new 512² size; pistol/blaster sheets verified
  per-iteration.
- `npx oxlint` on touched files: only pre-existing warnings.
- **Not run**: `bash _tools/check.sh` full gate; commits deferred per
  repo rules until the user calls a topic settled.
