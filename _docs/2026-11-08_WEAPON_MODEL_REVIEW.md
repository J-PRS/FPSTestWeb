# Weapon viewmodel review — all 27 models ranked

2026-11-08. Judged on: silhouette readability at viewmodel distance,
instant "what weapon is this" identification, and absence of floating /
noise / interior parts. Bench-view judgment — in-hand motion (chaingun
spin, disc feed anim) could shift a few mid-tier picks.

## Method / provenance

- Fresh 4-up sheets (`side / top / front-¾ / fps` cells) for every weapon
  via `bun _tools/e2e/gunsheet.ts <wt> http://localhost:5400` →
  `client/shots/w<N>_sheet.png` (SwiftShader headless, live vite :5400).
- `_tools/e2e/gallery.ts` was tried first (`E2E_GPU=1`): its per-pick
  screenshots in `screenshots/gallerydiff/` all captured the same first
  model (rail pick clicks didn't take in that env — 29 weapon shots,
  4 unique md5s). gunsheet's sheet-button path is the reliable one.
- Builders read alongside: `client/src/entities/viewmodel/
  weaponsGeoBallistic.ts`, `weaponsGeoEnergy.ts`, `weaponsGeoSidearm.ts`.

## Ranking (best → worst)

### Top tier — instant read, strong silhouette

1. **17 Revolver** — stepped barrel, dinner-plate cylinder with flutes,
   hammer spur, extruded plowhandle grip. Most authored model in the kit.
2. **9 Railgun** — three grooved hex prongs + brass throat tips;
   unmistakable from every angle.
3. **3 Chaingun** — fat barrel cluster on a bearing collar; the gun IS
   its function.
4. **12 Lightning** — tesla coil stack + three splayed electrodes +
   bloom-layer emitter node/corona. Unique silhouette.
5. **7 PlasmaCannon** — flared emitter bell, glow slats, slung capacitor
   bottle. Bulky T2 energy read.
6. **44 RocketLauncher** — one fat machined tube: crowned hoops for edge
   wear, muzzle brake, venturi tail with converging throat. Cleanest
   "one shape, done right".
7. **13 Shotgun** — barrel-over-magtube + red side-saddle shells +
   ribbed pump. Reads shotgun instantly.

### Good — clear identity, minor muddiness

8. **0 Bolt** — skeletal crossbow silhouette; distinctive.
9. **23 PlasmaGun** — six-prong emitter cage around a recessed hot core.
10. **5 GrenadeLauncher** — drum + ringed chamber bores; MGL read.
11. **28 MRV** — perforated shroud + rotary drum + glowing shell noses;
    busy but readable.
12. **26 Repair** — split octagonal housings bridged by ribbed orange
    cabling; reads tool-not-gun.
13. **38 Shocklance** — hafted spear + electrodes; unique, a bit sparse.
14. **14 Cannon** — crowned hoops + cascabel ball; clean, plain.
15. **43 Basilisk** — warm brass mass distinguishes it, but it shares
    the cannon's hoop-tube idiom.

### Mid — readable but generic or cluttered

16. **45 Howitzer** — big tube, does the job, forgettable.
17. **15 MissileLauncher (RPG)** — protruding warhead sells it; the rest
    is a plain pipe.
18. **6 Flak** — ribbed barrel + hex receiver; could be any fat gun.
19. **25 Sprinkler** — pressurized goo can + perforated face; reads
    garden equipment before weapon (by design).
20. **35 Bombard** — stubby bell + cascabel; silhouette works, zero
    surface interest.
21. **18 Sticky** — drum + spike + bomb row is muddled; the ordnance
    doesn't read.
22. **42 Gonne** — plain hoop pipe; smallest cannon, smallest effort.
23. **41 Blaster** — toylike; the green emitter face carries the whole
    identity.

### Bottom — weak silhouette / bare

24. **46 FastDiscLauncher** — improved by today's groove rework (see
    below), still two boxy slabs.
25. **1 Disc** — two featureless slabs; the slit and chambered disc
    don't survive the bake.
26. **4 Mortar** — a tube and a collar; saved only by scale.
27. **16 Pistol** — stacked boxes; crude even for a hold-out sidearm.

## Fixes landed during this review (mkFastDisc / mkDisc / gunlab)

- **FastDisc groove depth doubled** (`DISC_HEX_R * 0.09` → `0.18`) and
  the black shadow liners sunk to the bottom half — the other agent's
  liners sat flush at the mouth and filled the channels entirely; now
  the visible channel depth matches the pre-liner groove
  (`weaponsGeoBallistic.ts` `hexHalfGrooved` / `grooveLiners`).
- **Interior baseline groove removed** — the notch filter `cur.y > 0`
  let the slit clip baseline (`y = DISC_SLIT_HALF`) through, cutting a
  groove + liner into the slit's floor INSIDE the body. Filter is now
  `cur.y > DISC_SLIT_HALF` in both the cutter and the liner.
- **Grip + trigger-guard deleted** from both disc launchers (stacked
  slabs read as noise; most of the arsenal has no handles). FastDisc
  forend is now a 6-sided cylinder raised into the body's underside.
- **Hidden spindle cylinders deleted** from both disc launchers —
  interior geometry, never animated (the disc feed animates `discAmmo`
  only).
- **gunlab rail filter** — `11 Implodisc` dropped from the weapons rail
  and prev/next cycling (it's a `weapons`-map alias of the Disc group
  for its pull-muzzle node, not a real model). `gunlab.ts` now lists
  `MODEL_BUILDERS` keys + Chaingun.

## Known issues / follow-ups

- `gunlab.ts` `mkWeaponSel` (~line 841) uses `[...MODEL_BUILDERS.keys(),
  WeaponType.Chaingun]` — `.keys()` on an array yields indices 0-26, not
  weapon types. Pre-existing bug, held-weapon picker probably broken.
  NOT fixed here.
- `gallery.ts` rail-pick clicking didn't switch models in this
  environment (all picks captured model 0). Not root-caused; gunsheet
  is unaffected.
- FastDisc rim glow (`0xC8_F4_FF` white-cyan) vs trail ramp
  (`rgb(0,128,255)` blue, inherited from `discConfig`) — same hue
  family, deliberately hotter. A `0x33_AA_FF` blue rim was tried and
  reverted; judged worse.
- Bottom-tier candidates for rework: **Pistol** (needs a real slide/
  frame profile, not boxes), **both Discs** (the slabs could take
  chamfered loft profiles like PlasmaGun's receiver), **Mortar**
  (could borrow the cannon's hoop idiom for free).

## Caveats

- Sheets are orthographic bench views; no in-game motion check
  (chaingun barrel spin, disc feed envelope, shocklance pull-out cycle
  could move ±2 ranks).
- `MeshBasicMaterial` glow pads read flat-fullbright in sheets; in-game
  bloom (BLOOM_LAYER on lightning emitter only) changes some reads.
