# 2026-11-05 — Bot Weapon-Use Audit

Full sweep of the kill-gated cycle tables: every suspicious-low weapon
row was investigated for AI misuse vs. design limits, benched pinned
where needed, and either fixed or explained.

## Method

`_tools/sweeps/teamSoak.ts`:

- `--cycle` — kill-gated progression: a bot dealt a weapon stays on it
  until it scores (the "prove or stay" trap). `s` = held-seconds,
  `ts` = trigger-seconds; `k/10s` is survival-adjusted value,
  `k/10ts` is on-trigger efficiency.
- `--alpha/--bravo` pinned benches — all-16-bots one-weapon fights on
  rimrock dm, answers "can bots extract kills when the kit and every
  opponent's approach is in-range".
- `--force` — fires the dealt weapon at ANY range; measures the raw
  range curve (per-band shots/hits/dmg/kills), not what the AI picks.
- `--mix` — half of EACH side carries each weapon; mirrored A/B.
- Ledgers append to `_tools/sweeps/out/weapon_results.jsonl`; BT
  ladder via `weaponRank.ts` (kill counts as Bernoulli trials).

Key distinction: cycle kills ≠ weapon weakness. Low kills + low s =
exposure-limited; low kills + huge s = the trap (can't score, never
advances); kills-per-shot by band = the honest efficiency read.

## Fixes committed (in order)

| Commit | Fix | Evidence |
|---|---|---|
| (earlier) | GL/Mortar arm-gate standoff + bounce-serve | — |
| `937e630d` | MRV ground-pop lane: under-band volleys pop the carrier on terrain ~10m short, raining point-blank | MRV pinned 33→498 kills |
| `e1240a67` | MRV bomblet aoeRadius 16→20 (cluster.radius already 5m) | 498→686 kills |
| `c712331c` | ClusterBomb `fuseOnly` — was contact-popping like a grenade | 460 kills pinned |
| `4da2cce4` | fuseOnly carriers BOUNCE off bodies (dedupe per body) instead of phasing | MRV 686→746 kills |
| `47fbf521` | arm-window rules key on `bodyArmTime ?? armTime` — GL's armTime is only its dirt-skip window (bodyArmTime 0 = bodies pop at any age); was wrongly parked at 42m orbit | GL forced curve apex 25-60, reach 120 |
| `7a2746ef` | GL earns `far` draws (wildcard pool + standoff kits) — measured conversion peaks 60-120 (7.1%/shot) | — |
| `87edc86d` | GL-as-far orbits 60m, not generic 30m | — |
| `d0013f5d` | BoltLauncher knife-range draw: measured 10.2%/shot at <10m (shotgun-equal) — a carrier doesn't holster a 50dmg slug for a pistol | Bolt cycle 127→264+ |
| `7905b2b0` | Sidearm draws situational: skilled path scores `fit×0.5` (only beats penalized primaries); `!skill` path draws side at <8m only when near can't pay (no near gun / arm-gated) | Revolver 118→85, Pistol ~stable |
| `3d9c3d2c` | Pool hoses (PlasmaGun/Sprinkler) orbit 20m — undodgeable-bolt band; 12m paid approach deaths, 30m wasted the dodge-tax | PG pinned 3,784 kills |
| `162e32c6` | Shotgun pellets 7→5 (70→50 point-blank) — sidearm-stamped gun was out-damaging primaries | 367→268 kills |
| `1aa1036c` | Flak feet-serve CONDITIONAL: lat-speed >8m/s + grounded only — ground-skips beat the lead, not the lob | unconditional falsified (-11%); conditional neutral |
| `b3f16eb1` | Splash-serve for direct-fire aoe guns (PC/Missile/Disc et al): vs lat>8 movers at 20-80m aim dirt under led point — whiffs become guaranteed splash tags | bench-neutral |
| `518ef23b` | Disc-as-far orbits 80m — airtimeScale pays x(1+flight), cap x4 at 2s; 30m orbit earned 1.4x | Disc pinned 2,399 kills |
| `2561027d` | orbit keys on `airtimeScale` flag — covers BoltLauncher too | Bolt pinned 2,296 kills |

## Pinned-bench board (all-16-bot dm, rimrock, 60 sim-min)

| Weapon | Kills | Notes |
|---|---|---|
| PlasmaGun | 3,784 | apex 10-25m, medLife 20s — knife-range cost is honest |
| Sprinkler | 2,691 | respectable duelist, not just area-denial |
| Disc | 2,399 | airtime payoff: 283 kills past 60m |
| PlasmaCannon | 2,332 | splash pops on whiffs — low dodge-tax |
| BoltLauncher | 2,296 | airtime-scaled + works point-blank (10.2%/shot) |
| Flak | 2,032 | best burst-near gun; volume < hoses |
| GrenadeLauncher | 1,866 | apex 25-60, reach to 120 |
| MissileLauncher | 1,543 | rocket niche, 10-60m |
| MRVLauncher | 746 | 15× baseline after ground-pop + bounce + aoe20 |
| Mortar | 638 | still competitive — precision vs MRV's area |
| ClusterBomb | 460 | fuse-pop rains now, was contact-popping |

## Cycle verdicts (mixed-field, non-force)

- **Melee** still #1 (~450-490) — brawl tax + real threat.
- **Shotgun** 268 post-nerf — still strong for `sidearm: true`.
- **BoltLauncher** 217-273 — knife-draw + airtime orbit both pay.
- **MRV** ~50-60 kills, conn ~51% — fixed; its k/10s (~0.08) is the
  kill-gate trap + chip-not-finish role, NOT misuse.
- **Javelin/Blaster/BeltSticky/ProxyGrenade** — design-limited
  (narrow proxy, whiff geometry, positional tools).
- **Repair/ArmorGrenade/EMP/Concussion** — utility bookkeeping rows,
  correctly excluded from the normal pool.

## Techniques modeled for bots

- Bounce-serve (arm-gated ordnance): lob dirt ~10m ahead, shell skids
  armed, pops where the runner's headed.
- MRV ground-pop: under-band volleys pop the carrier on terrain point
  short — the human 3-kills/min lane.
- fuseOnly body-bounce: carrier shells thunk off bodies and keep
  cooking (one reflect per body).
- Flak feet-serve: conditional vs fast lateral movers only.
- Splash-serve: aoe guns aim dirt under led point vs fast movers —
  whiff = guaranteed splash tag.
- Sidearm: situational only (penalized primaries / finishers / splash
  escape), not range-gated.

## Remaining balance questions (NOT usage bugs)

- Shotgun still punching above sidearm tier post-nerf — cut to
  4/pellet (40 max) or accept as the universal floor.
- Plasma family owns bench 1-4 — if unintended, it's a tuning call.
- Melee #1 — fight density, not a weapon problem.
- `--force` caveats: respects self-splash/self-damage gates (only
  overrides weapon pick); can still drain ammo pools on hopeless
  shots and telegraph position — forced band kills/shot is the
  honest read, not volume.

## Ledger artifact

Primary-vs-sidearm attribution splits some weapons into two rows in
the weapon table — merge by name when reading; worth deduping in the
tool later.
