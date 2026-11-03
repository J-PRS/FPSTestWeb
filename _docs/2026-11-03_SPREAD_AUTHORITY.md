# Server-authoritative spread — bloom + cones (2026-11-03)

How the chaingun bloom cone and sprinkler base cone work, why the seed
is a server-side counter and not the client's `shotId`, and how the
implementation scores against published best practice.

Companion doc: `_docs/2026-11-02_AMMO_POOL_PILOT.md` (the plasma/sprinkler
ammo economy this shares plumbing with).

## The mechanic

| Weapon | Cone model | Feel |
|---|---|---|
| Chaingun | **Bloom**: `bloom += 0.001`, `bloom *= 1.25` per shot, `decay 0.6/s` after one `fireInterval` idle, cap `0.1` | tight taps (~5 shots ≈ 0.008), cone blows open by ~15 slugs (1.4s of spray) |
| Sprinkler | **`spreadBase: 0.05`**: fixed hose cone, no growth | constant scatter, same seeded draw |

Both travel the same code path: `radius = spreadBase + bloom`, one
shared helper set. Bloom params live on the shared weapon row
(`shared/weaponTable.ts`: `bloomRate/bloomExp/bloomDecay/bloomMax`,
`spreadBase`) so client prediction and server authority read one source
of truth.

## The anti-cheat shape — and the hole we closed

**Wire model:** client claims its RAW aim `dir` (+ `shotId` for dedupe/
echo). The server computes the cone itself and applies it to the claim
before spawning. A forged dead-center `dir` still gets the full cone —
a "perfect aim" cheat gains nothing because the scatter is decided
after the claim, not before.

**The seed problem:** the cone draw must be deterministic so the
client's predicted shell lands inside the same scatter — but the seed
must NOT come from the client.

- **v1 (rejected): `idSeed(shotId)`** — this is CSGO's `usercmd.random_seed`
  design. The famous **nospread exploit**: a hacked client brute-forces
  seeds until the draw lands near cone center, claims only the lucky
  `shotId`s, and gets ~zero-spread shots that look legit server-side.
  Seed-from-claim = seed-from-cheater.

- **v2 (shipped): sequential per-player counter** — server draws
  `jitter01(idSeed(playerId) ^ bloomSeq++)`. The client mirrors the
  counter for its own predicted pulls. Cheat angle removed: the seed
  is server state, full stop. This is the pattern every reference
  converges on (JVM Gaming spread thread, Roblox devforum, CSGO
  postmortems).

**Residual predictability (accepted):** a modified client *knows* the
sequence and can predict the next cone — but only its own view lies.
Its shots scatter identically for everyone else. That asymmetry is the
whole point of server-seeded spread.

## Implementation map

Shared (`shared/`):

- `weaponTable.ts` — `bloomRate/bloomExp/bloomDecay/bloomMax` + `spreadBase` fields
- `weaponRows.ts` — Chaingun bloom row (`0.001 / 1.25 / 0.6 / 0.1`)
- `weaponRowsB.ts` — Sprinkler `spreadBase: 0.05` + ammo row
- `weapons.ts` — `jitter01(seed)` (integer-mix u32→[0,1) pair, no
  `Math.random`), `coneDir(dir, angle, radius)` (orthonormal basis
  jitter, same math the client fan used), `bloomRadius(bloom, bloomAt,
  wt, nowS)` (lazy gap-decay → radius = `spreadBase` + decayed bloom),
  `bloomGrow` (+rate then ×exp, clamped)
- `weaponTable.ts` — `idSeed(id)` FNV-1a, reused as the per-player
  seed base

Server (`server_bun/src/`):

- `types.ts` — `PlayerState.bloom`, `bloomAt` (lazy-decay stamp),
  `bloomSeq` (per-shooter draw counter)
- `PlayerManager.ts` — init on join, ride re-seat, reset `bloom` on
  respawn (the counter keeps running — reseeding would weaken it)
- `CombatHandler.ts` — after the cadence/ammo gates, `bloomRadius` →
  `jitter01(idSeed(playerId) ^ bloomSeq++)` → `coneDir` on the claimed
  dir → `bloomGrow`. Radius is the decayed bloom BEFORE this shot.
- `botArsenal.ts` — `bloomCone(me, dir, wt)` at both discharge sites;
  bots get the identical law via a per-arsenal counter seed

Client (`client/src/`):

- `weapons.ts` — `WeaponDef.bloom = {base, rate, exp, decay, max}`
  derived from the shared row (stats-sourced, no config constants)
- `entities/Player.ts` — `bloom` (HUD + predicted radius), `bloomSeq`
  (predicted counter); decay in `tickTimers` gated on `!mouseHeld`
  (continuous decay would swallow the +rate add at cadence)
- `game/combat/fire.ts` — bloom branch: claim RAW `e.dir`, mint
  `shotId`, predicted shell jitters via `jitter01(idSeed(localId) ^
  pl.bloomSeq)` with radius `base + pl.bloom`, then `pl.bloom` grows
- `game/combat.ts` — `FireArgs.bloomRadius`/`bloomSeq` fields
- `ui/hud*` — `#bloom-arms`: four expanding ticks, `sqrt(alpha)` fade
  with a 5% deadband, whole-pixel-snapped origin (odd-viewport blur fix),
  resting 4px gap on bloom weapons only

## Audit vs published best practice

| Practice | Status |
|---|---|
| Server owns aim error before the ray/spawn, not a client visual | ✓ `coneDir` server-side pre-`fireProjectile` |
| Per-player sequential server seed, never client-supplied | ✓ counter, `shotId` does dedupe only |
| One shared formula/table both ends import | ✓ `shared/weapons.ts` + shared rows |
| Client predicts same draw for feel; cheat = own view only | ✓ `pl.bloomSeq` mirror |
| RNG stream advances at identical rate both ends | ~ drifts on **rejected intents** (client counted a shot the server refused) — self-corrects on echo bind |
| One-shot edges validated server-side | ✓ cadence gate + `spendAmmo` + class gate all run before the draw |
| Desync reconciles, never a correctness loss | ✓ `linkOwnProjectile` reanchor |

## Known gaps / follow-ups

1. **Rejected-intent drift** — the documented failure mode of sequence
   counters: a refused pull shifts every later predicted cone one slot.
   Harmless today (one wrong arc, echo fixes it); the proper fix is a
   `bloomSeq` echo on rejects or inside `yourAmmo` (~20 lines).
2. **Bot counter is per-arsenal, not per-bot** — deterministic but
   shared; cosmetic parity only.
3. **Sprinkler arms never show** — constant cone keeps `bloom = 0` →
   `sqrt` alpha stays at deadband. The resting 4px gap still marks the
   drawn weapon as a hose; showing the fixed radius is a UI choice,
   not implemented.
4. **Client `bloomSeq` isn't reset on reseat** — a full reconnect
   starts counting from 0 while the server kept its counter; first
   spray after a hard reconnect jitters wrong until one shot lands.
   Harmless, self-heals.

Verified: both typechecks clean, `weaponAmmo.test.ts` 4/4 green,
dash watch clean on all touched files. The subpixel arm fix is in
`_docs/2026-11-02_AMMO_POOL_PILOT.md`'s sibling — whole-pixel snap +
even tick thickness (Chromium bug 426333 class).
