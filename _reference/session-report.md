# Session Report: FPSWebTest Polish

**Date:** Oct 18, 2026  
**Project:** C:\TEMP\_WEB\FPSWebTest  
**Branch:** main (uncommitted changes)

---

## 1. Overview

This session covered four major work streams: (1) Quicksand bowl map rework, (2) Lagoon island map rework, (3) Weapon balance tuning + bot AI improvements, and (4) Map testing tooling. All changes remain uncommitted.

---

## 2. Quicksand Bowl Map

### Problem
Original quicksand used stamped square-mesa + annular-moat geometry from genfield. User wanted organic, not manmade. Central structure was underwhelming. Bowl was too small (spawns outside). Entry was a crater (fall in, not slide in).

### Solution
- Created `genquicksand.js` — domain-warped organic bowl with ridged texture + thermal erosion
- Bowl profile: shallow smoothstep concavity (0.10→0.22, ~15m drop) with rounded rim/bottom, rising outer ramp (0.22→0.47) for skiability
- 2× scaled (200m radius) with proportional vertical scaling
- Spawns moved inside bowl on outer edges (radius 150-190), facing inward via yaw=atan2(-x,-z)
- Central structure: replaced T2 DIF interior + box tower with native textured **katastand** kit piece at 4× scale
- Removed all leftover stamped cover boxes, walls, pillars, floating platforms

### Key Metrics
| Metric | Value |
|--------|-------|
| Relief | 125 m |
| Mean grade | 7-8° |
| Flat | 37-49% |
| Cruise | 40-48% |
| Steep | 1-3% |
| Hard | 1-2% |
| Cliff | 0-1% |
| Chatter | 1.0-1.3 m |
| Soak (moved) | 30-41% |
| Spawns | 12 (radius 150-190, inside bowl) |
| Structures | 1 (katastand 4×) |
| mapspec | 13/13 pass |

---

## 3. Lagoon Island Map

### Problem
Original lagoon was a 4-island archipelago with deep water between islands. User hated water as substrate — forced swimming to navigate.

### Solution
- Rewrote `genlagoon.js` — single medium island (~420m radius, ~136m peak) with ridged spine and organic coastline
- Water level dropped from 12m to 2m (island is the playable surface)
- Land: 24% of tile (was split across 4 small islands)
- Central peak raised as interest point (organic, domain-warped)
- Spawns redistributed on island (radius 240-320), all confirmed on land
- terrainPreset stays 6 (coast palette)

### Key Metrics
| Metric | Value |
|--------|-------|
| Relief | 135 m |
| Land % | 24.3% |
| Peak | ~136 m |
| Water level | 2 m |
| Spawns | 12 (all on land, heights 64-102m) |
| mapspec | 13/13 pass |

---

## 4. Weapon Balance

### Fire Rate Changes
| Weapon | Old | New | Rationale |
|--------|-----|-----|-----------|
| Flak | 1.1 s | 1.2 s | Slightly too strong |
| Cannon | 1.25 s | 0.7 s | Bounces = hard to use, faster cadence compensates |
| Bolt Launcher | 0.8 s | 1.0 s | Was faster than disc; now equal (differentiated by gravity) |

Both client (`config.ts`) and server (`shared/weapons.ts`) updated. Tests pass (weaponTable 18/18, weapons 18/18).

### Balance Assessment
The weapon roster is well-balanced for its design philosophy:

- **Fast/low-damage → slow/high-damage progression** is reasonable
- **Area denial weapons** (Rocket, Mortar, Sticky, Bombard) trade raw DPS for spatial control
- **Tracking-dependent weapons** (Chaingun, Lightning, PlasmaGun) have high theoretical DPS but require skill
- **Splash radii** constrain high-DPS weapons (PlasmaCannon: 161 DPS but only 5.5m splash)
- **Bolt vs Disc** differentiated by gravity (bolt arcs, disc flies flat) despite identical stats
- **Cannon** at 0.7 s is defensible — bounces make splash hard to land

### Weapon Rankings (unpinned, rimrock, real DM gameplay)
| Rank | Weapon | K/D | Role |
|------|--------|-----|------|
| 1 | PlasmaCannon | 1.57 | Close-range splash |
| 2 | Shotgun | 1.54 | Close-range burst |
| 3 | Rocket Launcher | 1.34 | Area denial + knockback |
| 4 | Pistol | 1.29 | Fast sidearm |
| 5 | Sticky | 1.27 | Area denial (delayed) |
| 6 | MRV Launcher | 1.39 | Area denial (volley) |
| 7 | Disc | 1.23 | Mid-range (flat flight) |
| 8 | Bombard | 1.09 | Burst (crumbles on contact) |
| 9 | Flak | 1.11 | Spread burst |
| 10 | PlasmaGun | 0.75 | Precision sustained |
| 11 | Railgun | 0.78 | Precision (fastest projectile) |
| 12 | Lightning | 0.84 | Tracking beam |
| 13 | Mortar | 0.72 | Area denial (lobbed) |
| 14 | Cannon | 0.67 | Bounce precision |
| 15 | Bolt Launcher | 0.77 | Mid-range (gravity arc) |
| 16 | Revolver | 0.43 | Slow sidearm |

---

## 5. Bot AI Improvements

### Self-Splash Veto (botArsenal.ts)
- **Threshold:** Flat 30 HP → weapon's actual aoeDamage (scaled by perk selfDamage modifier)
- **HP gate:** Added in primary fire path — uses actual splash damage at target distance (including bands)
- **Heroic exception:** willKill bypasses veto (bot accepts self-damage for a kill)
- **Cumulative budget:** Per-bot budget (100 max) decrements on splash fire, regenerates at 5 HP/sim-s
- **Human imperfection:** 5% chance to skip HP gate, 10% chance to skip selfBlastBlocked (simulates "fuck it" moments)

### Critical Bug Fix: Self-Targeting in DM Mode
**Root cause of 70% "self-splash" deaths:** Squad spot reports in DM mode. In DM, all bots have `team = undefined`. Spot reports are stored with the reporter's team. `forTeam(me)` filters by `s.team === me`, which is `undefined === undefined` → `true for ALL spots`. So a bot could receive a spot report for **itself** (reported by another bot), and target itself.

**Fix:** `nearestSpot()` and `thiefBeacon()` now skip spots where `e.id === ctx.id`.

**Impact:** Eliminated 122 self-targeting deaths per 300 sim-seconds. Env deaths went from 235 → 0.

### Lesson Learned
The 70% "self-splash" deaths were **not** from bots firing splash weapons at close range. They were from bots **targeting themselves** via squad spot reports. The self-damage work (HP gate, budget, etc.) addressed a symptom, not the root cause. The actual fix was a one-line filter. The debug tracking (exact death cause logging) was what ultimately revealed the real root cause.

---

## 6. Map Testing Tooling

### _ffasoak.ts (Weapon-vs-Weapon Balance Matrix)
- 10-bot FFA deathmatch, each bot locked to one weapon
- Leaderboard = balance table (kills, deaths, K/D, sim-seconds-to-50)
- Shuffled weapon deals across seeds for coverage
- Expanded from 16 to 19 weapons (added Bombard, Pistol, Revolver)
- Added `FFASOAK_MAP` env var to load real heightfields (rimrock, quicksand, etc.)
- Added `FFASOAK_UNPINNED` mode for real DM gameplay (no ring pinning)
- Added exact death tracking: envDeaths, fallDeaths, selfSplashDeaths
- Added fall damage disable for clean weapon testing

### Key Finding: Flat vs Real Terrain
| Environment | Best K/D | Worst K/D | Spread |
|-------------|----------|-----------|--------|
| Flat arena (pinned) | 2.50 (Railgun) | 0.19 (Lightning) | 13.2× |
| Rimrock (pinned) | 1.29 (Lightning) | 0.14 (Mortar) | 9.2× |
| Rimrock (unpinned, real DM) | 1.57 (PlasmaCannon) | 0.43 (Revolver) | 3.7× |

**Terrain compresses the gap.** The flat arena exaggerates differences (Railgun 2.50 K/D). Real terrain makes balance more even. The unpinned rimrock test is the best balance validation tool.

---

## 7. Key Lessons Learned

1. **Debug before tuning.** Exact death-cause logging revealed the real root cause (self-targeting via squad spots) in minutes, after hours of threshold tuning failed.
2. **"No rigid rules" is a design philosophy.** The bot should make intelligent decisions (courage-scaled, heroic exceptions) not follow flat thresholds. Humans are imperfect; bots should be too.
3. **Flat arena ≠ real gameplay.** The flat arena is a stress test (worst case). Real maps compress the gap. Both are needed.
4. **Bot AI gaps ≠ weapon balance issues.** Self-splash deaths from terrain proximity are an AI issue. Don't tune weapons to fix AI limitations.
5. **Environment deaths confound K/D on hilly maps.** Use kills as the primary metric. K/D is only clean on flat ground.
6. **Squad spot reports in DM mode are dangerous.** Team-based filtering breaks when everyone is teamless. Always filter by entity ID.
7. **Weapon balance is map-dependent.** This is good game design — different maps favor different loadouts.
8. **The "heroic shot" exception is valuable.** A bot at low HP should be able to fire a splash weapon if it will kill the target. This creates dramatic moments.

---

## 8. Files Modified

| File | Changes |
|------|---------|
| `_tools/mapbake/genquicksand.js` | Rewrote: organic bowl, 2× scaled, shallow profile, smooth entry |
| `maps/quicksand.json` | Spawns inside bowl, katastand 4×, removed stamped structures, no interiors |
| `maps/quicksand.bin` | Regenerated |
| `_tools/mapbake/genlagoon.js` | Rewrote: single medium island, taller peak, low water |
| `maps/lagoon.json` | Water level 2, spawns on island |
| `maps/lagoon.bin` | Regenerated |
| `client/src/core/config.ts` | FLAK_RATE 1.1→1.2, CANNON_RATE 1.25→0.7, BOLT_FIRE_RATE 0.8→1.0 |
| `shared/weapons.ts` | WEAPON_FIRE_INTERVAL_S: Flak 1.1→1.2, Cannon 1.25→0.7, Bolt 0.8→1.0 |
| `server_bun/src/botArsenal.ts` | Self-splash veto: flat 30→weapon aoeDamage; HP gate; heroic exception; cumulative budget; human imperfection skips |
| `shared/botHunt.ts` | Fixed self-targeting: nearestSpot and thiefBeacon skip self-id |
| `server_bun/tests/scenarios/_ffasoak.ts` | Added FFASOAK_MAP, FFASOAK_UNPINNED, death tracking, fall damage disable |
| `server_bun/tests/scenarios/botMatchups.test.ts` | Updated flanker assertion ≤3→≤4 (Flak nerf) |

---

## 9. Takeaways

- **Debug before tuning.** Exact death-cause logging revealed the real root cause (self-targeting via squad spots) in minutes, after hours of threshold tuning failed.
- **"No rigid rules" is a design philosophy.** The bot should make intelligent decisions (courage-scaled, heroic exceptions) not follow flat thresholds. Humans are imperfect; bots should be too.
- **Flat arena ≠ real gameplay.** The flat arena is a stress test (worst case). Real maps compress the gap. Both are needed.
- **Bot AI gaps ≠ weapon balance issues.** Self-splash deaths from terrain proximity are an AI issue. Don't tune weapons to fix AI limitations.
- **Environment deaths confound K/D on hilly maps.** Use kills as the primary metric. K/D is only clean on flat ground.
- **Squad spot reports in DM mode are dangerous.** Team-based filtering breaks when everyone is teamless. Always filter by entity ID.
- **Weapon balance is map-dependent.** This is good game design — different maps favor different loadouts.
- **The "heroic shot" exception is valuable.** A bot at low HP should be able to fire a splash weapon if it will kill the target. This creates dramatic moments.