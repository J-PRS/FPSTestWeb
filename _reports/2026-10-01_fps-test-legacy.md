# FPS_Test — Legacy Report

*Audit date: 2026-10-01 · Source: live project inspection (Unity MCP + read-only
filesystem + `__REVIEW/Weapons_and_Belt_Items_Report.md`) · Unity 6000.4.3f1,
FishNet networking · Author's first 3D game, second game ever — all hand-made,
pre-AI.*

## 1. What FPS_Test actually is

Not a prototype — a design laboratory. Over ~4 years it accumulated a working
FPS with skiing-adjacent movement, jetpacks, a 26-weapon arsenal, a 15-item
belt/deployable system, a persistent loadout system, a unified "nugget"
resource economy, networked multiplayer plumbing (FishNet), a demo-replay
camera, procedural texture generation, and procedurally-generated audio.

Its legacy is **design DNA**: most of what makes KRIBES feel like Tribes was
proven here first. The weaknesses are organizational (dead experiments, junk
layers, broken prefab chains), not creative.

## 2. Systems inventory

### Movement & packs (`jetpack_script.cs`, `RB_Controller`)
- Fuel-based jetpack with air-control tuning, separate from dash charges.
- **Dash charges** as a spendable resource (`AddDashCharges`, `UseNugCharge`)
  shared with belt items — one economy across mobility and offense.
- **Slam** (aerial attack), **Thrust** (velocity-aligned boost using
  split-vector math — preserves momentum instead of fighting it),
  **Blink** in three styles (camera-forward / input-axis / velocity-based —
  `GlobalModifiers.blinkStyle`), **ThrustBounce** on collision that converts
  impacts into speed below a threshold.
- Custom gravity controller — the ski/slide feel lives here.

### Weapons (26 prefabs in `_Weapons/`)
| Tier | Weapons |
|---|---|
| Hitscan | sniper rifle, railgun (remote_railgun, 2.0s — the anti-everything) |
| Arc family | bolt launcher (arc_fast), grenade launcher (arc_slow), mortar (arc_medium), mirv (arc_mirv) |
| Rockets | rocket fast / medium / slow / launcher |
| Automatics | chain (0.1), mg fast, nailgun, sprinkler, tracker, repeater, adaptive chain (chain_acc), intermittent chain (chain_uacc) |
| Specialty | disc (Tribes disc signature), flak (12-projectile shotgun), plasma, lance (proximity aim-assist), spike, mini missiles, turret |

- **Adaptive chain / tracker / intermittent chain** — homing and burst cadence
  experiments. `WeaponComponentHoming` is a 5-line velocity-redirect script
  attachable to *any* projectile — emergent composition, not per-weapon code.
- **WeaponComponentDistanceDamage** — an area-denial projectile that grows a
  damage radius over time, tracks whether it's receding from targets, and
  fires *predictively-aimed sub-projectiles* (IterativeInterceptor) at them.
  This is a whole weapon class in one component.
- **WeaponComponentHoming / fireAfterPassingTarget / shootOnlyClosestTarget /
  shootOnlyHighestTarget** — target-filter flags that turn one mechanism into
  several weapon personalities.
- **WC_* component suite**: WC_Lance (sphere-cast aim feedback → particle
  trigger), WC_ShellSpawner (±20% randomized ejection force), 
  WC_StartingLifetime (damage-over-time curves via lifetime offset).

### Belt items (15 prefabs in `_Projectiles/Belt Items/`)
Two-slot throwable system (`BeltItem.cs`) with fire delay (wind-up), cooldown,
muzzle FX, and per-item nugget cost (`PC_Cost`).

| Category | Items | Trade-off pattern |
|---|---|---|
| Explosives | grenade (500), sticky (500), mine (200), pop grenade (120vel/20dmg) | slow+lethal vs fast+weak |
| Turrets | turret, rTurret (rotating), anti-air, turret_mortar (500), turret_rocket (120vel) | deployable variety by role |
| Mobility | grapple (100dmg), **ugrapple (0 dmg, 80vel — pure utility)** | damage vs utility split |
| Impact | disc (100), impact (20) | belt disc reuses weapon feel |
| Resource | nugget, nugget_instant | the currency is itself a belt item |

**Velocity↔damage inversion as balance law**: pop grenade 120vel/20dmg vs
grenade 25vel/500dmg — speed taxes lethality system-wide.

### Loadout (`LoadoutManager.cs`, `WeaponSwitching.cs`)
- 3 weapon slots + 2 belt slots, PlayerPrefs persistence by ID name
  (`WeaponSlotOne`…`BeltSlotTwo`), dedupe, auto-select on pickup.
- Switch coroutine with equip/unequip animations, randomized audio pitch
  (0.8–1.2), `WaitForSecondsRealtime` so it survives timescale pauses,
  fire-timer reset on switch (no instant-fire exploit).

### Two-tier inheritance — the genuinely brilliant part
`GlobalModifiers` carries *separate* velocity-inheritance values for weapons
vs belt items vs nuggets (`forwardInheritance` / `nonForwardInheritance` /
`forwardInheritanceBelt` / `nonForwardInheritanceBelt` /
`nuggetInheritance`). Thrown items can inherit player momentum differently
than fired projectiles — Tribes-level nuance most commercial FPSes skip.
KRIBES' own `shared/damage.ts` inheritance split descends from this.

### Nugget economy
One currency does triple duty: belt-item cost (PC_Cost), jetpack dash charges,
and score (nugget banking → team score). Insufficient-charge HUD feedback.
This single-resource-economy idea shipped into KRIBES as Nugget Wars.

### Art & audio
- Procedural texture pipeline (the bolt launcher/flak/plasma bakes — Bevel
  node edge-masks + AO + grunge + base tint, all shader-generated, no painted
  textures). Recreated headlessly this month in `_tools/bake_full_albedo.py`.
- `_Audiogen/` — batch-generated weapon/jetpack sounds.
- `DEMO_REPLAY/` — camera-rewind replay camera (uncommon foresight for a
  first project).

### Multiplayer
FishNet throughout (rooms, relay transports), analytics handler, end-of-match
stats table. KRIBES deliberately re-founded this on Bun + custom protocol
with server authority — the Unity version's netcode was the learning run,
not the production one.

## 3. Ideas worth carrying into KRIBES (ranked)

1. **Two-tier projectile inheritance** — already inherited; keep it.
2. **Nugget-as-everything economy** — already the backbone (Nugget Wars).
3. **WeaponComponentDistanceDamage-style area-denial + sub-projectiles** —
   a modular MIRV/denial weapon class; cheap to add via shared projectile sim.
4. **Blink styles as a pack choice** — three traversal verbs on one key is
   exactly the pack-slot design KRIBES has.
5. **Velocity↔damage inversion** — apply as the balance rule for fast belt
   items (pop grenade pattern).
6. **Procedural texture pipeline** — now recreated headless; usable for all
   baked weapon albedos.
7. **Predictive sub-projectile interception (IterativeInterceptor)** —
   port to `shared/` for homing/mirv weapons.
8. **Deployable turret family by role** (AA/mortar/rocket) — maps onto the
   deployables system; roles, not just variants.
9. **Randomized-pitch equip/unequip audio + switch cooldown** — free polish,
   prevents switch-spam exploits.
10. **Demo-rewind camera** — spectator/kill-cam groundwork; a real
    differentiator for a browser FPS.

## 4. What should NOT be inherited

- **The entropy**: `__BIN__`, `__BIN_ZZZ__`, `__MYBIN__`, `zzz/` — three
  generations of dead experiments in the live tree. Asset→prefab chains that
  mislead (the `bolt launcher.prefab` pointing at a different mesh than
  `launcher.blend` — the whole baking detour). KRIBES keeps the ideas and
  drops the archeology requirement.
- **Monolithic controllers**: RB_Controller/jetpack_script statics
  (`instance`, `playerRB`) — fine solo, wrong under server authority.
- **PlayerPrefs as authority** — persistence yes, server-owned state no.

## 5. Verdict

FPS_Test's legacy is that it already contains — in embryonic, experimental
form — nearly every pillar of the game KRIBES is becoming: inheritance-split
projectiles, a unified resource economy, belt-vs-weapon asymmetry, modular
weapon behaviors, deployables by role, traversal packs, procedural art. It
proved the design vocabulary works. What it lacked (deterministic shared
sims, server authority, instanced rendering, perf discipline, repo hygiene)
is exactly what KRIBES adds. The Unity project remains a read-only reference
mine — and it still has more ore (206 non-weapon prefabs unexploited).
