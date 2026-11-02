# Ammo pool pilot — PlasmaGun (2026-11-02)

First experiment in a per-weapon ammo economy. Goal: split a weapon's
power budget into **burst** (clip size) and **sustain** (regen rate)
instead of pricing everything by sustained DPS — so shots can hit hard
in a 2s window without the weapon being oppressive forever.

## Mechanic (final semantics)

PlasmaGun only. `shared/weaponRows.ts` row gains `ammoCap` +
`ammoRegenMult`; absent row = unlimited ammo, zero gate.

- **Clip**: 20 rounds, one per shot.
- **Regen**: 1 round per `fireInterval × ammoRegenMult` = 0.1 × 2 =
  **0.2s/round (5 rps)**.
- **Pause**: regen waits one fire interval (0.1s) after the last shot —
  the clip counts *down* during a burst, never jitters up mid-volley.
- **Dry exception**: below 1 round the pause stops applying, or the
  empty gun could never come back. This is what makes the sustain
  exactly half cadence.
- **Continuous lazy accrual** — no regen tick. Cells accrue on read
  (spend, preview, HUD), each keyed by the caller's own clock domain.

### The burst↔sustain math

| Phase | Behavior |
|---|---|
| Burst | 20 shots at 10 rps = **exactly 2s** full-rate (no accrual while trigger's hot) |
| Dry sustain | 1 round per 0.2s = **5 rps = half cadence**, forever, while holding trigger |
| Mid-pool stop | regen resumes 0.1s after last shot, refills to 20 (5 rounds/s) |
| Holstered | same accrual — a dry plasma swapped to disc comes back charged |

### Rejected alternatives (kept on record)

- **Regen while firing** (v1, shipped briefly): works, but pool drains at
  net 0.5/shot — burst stretches to ~4s and the counter visibly jitters
  up mid-volley. Replaced by pause-until-last-shot.
- **No dry exception + uniform pause** (`pause 0.1 + accrual 0.2`): still
  recovers — 0.3s/shot = one-third cadence. Loses the "half firerate"
  spec; dead-window tax paid on every trickle shot.
- **No exception + regen 0.1s** (`ammoRegenMult: 1`): dry cycle
  0.1 pause + 0.1 accrual = same 0.2s trickle, simpler rule — but couples
  idle-refill speed to the sustain rate (2× faster holstered recharge).
  A was chosen for **separate knobs**: `ammoRegenMult` is the sustain
  dial, a future second multiplier can slow holstered refill alone.

## Implementation map

Shared (`shared/`):

- `weaponTable.ts` — `WeaponStats.ammoCap?: number`, `ammoRegenMult?: number`
- `weaponRows.ts` — PlasmaGun row: `ammoCap: 20, ammoRegenMult: 2`
- `weapons.ts` — `AmmoPool` = `Map<weaponType, {ammo, t, shotAt}>`;
  `accrue()` (lazy, pause-aware), `ammoOf()` (peek), `spendAmmo()`
  (debit + stamps `shotAt`). Same payShotCost pattern: one formula all
  gates read. Absent cell = full pool, so `pool.clear()` IS the refill.

Server (`server_bun/src/`):

- `types.ts` — `PlayerState.ammoPool`, `ammoEchoAt`
- `PlayerManager.ts` — init on join, rides re-seat (`was.ammoPool`),
  `clear()` on respawn
- `CombatHandler.ts` — dry intent rejects `Shot: ammo dry` (verdict
  closes the shooter's predicted ledger; no ghost bolt)
- `botArsenal.ts` — both discharge branches spend after `rateOk` on the
  arsenal sim clock (bots' pools live on their player records)
- `tickRecords.ts` — `tickAmmoEcho`: every 500ms while a pool sits below
  cap, echoes `[weaponType, rounds]` to the owner. **Bots skipped** —
  their pools accrue on the sim clock; a wall-clock stamp would freeze
  regen (and they have no socket)
- `protocol.ts` + `ConnectionManager.ts` — `yourAmmo` message,
  `NO_JOURNAL_TYPES` (echoes aren't replayed on reclaim)

Client (`client/src/`):

- `entities/Player.ts` — `ammoPool` field, `resetLifeState` refill
- `entities/playerImpulse.ts` — `wantFireWeapon` dry-gate: no fireTimer
  burn, no shoot anim on dry ticks; trickle cadence emerges naturally.
  **wid is a loadout slot index — translate via `weaponDef(wid).weaponType`
  before touching the pool** (the bug that blanked the first readout)
- `game/combat/fire.ts` — `spendAmmo` in `fireWeapon` beside `payShotCost`
- `game/bots/botFire.ts` + `botBrain.ts` — offline bots spend
  `bot.ammoPool` in `canFire`; `respawn()` clears = refill
- `game/net/players.ts` — `onYourAmmo` stamps echoed cells with local
  accrual time
- `ui/hud*` — `#wammo-readout` under the crosshair (+62px, plasma cyan,
  blank for unlimited weapons), change-cached `setText` writes

## Clock domains — the sharp edge

Each pool accrues on *its owner's* clock: human intents use wall ms
(`now/1000`), server bots use the arsenal sim clock, the client uses
`performance.now()/1000`. A pool is only ever touched by one gate — but
`accrue` refuses a backwards stamp anyway (`nowS <= c.t` early-out), so
a mixed-epoch read can under-accrue but never over-regen or corrupt.

## Tests

`server_bun/tests/weaponAmmo.test.ts` — drain-then-trickle (exactly 20,
then ~5/s), pause-window accrual, uncapped pass-through + clear=refill,
and a wired intent test: 3 real `shotFired` claims debit the pool and
`TickFanout.buildRecords` emits `yourAmmo` with the server count.

Note: `harness.step()` ticks `room.sims` only — the echo lives in the
fanout loop, so tests drive `TickFanout.buildRecords` directly
(botEgress pattern).

## Tuning knobs

- `ammoCap` — burst budget (seconds of full-rate fire = cap × fireInterval)
- `ammoRegenMult` — sustained cadence (= 1/mult of fire rate when dry)
- Pause is fixed at 1× fireInterval (implicit, in `accrue`)
- Extending: adding the economy to another weapon = two numbers on its
  row. Chaingun stays infinite (it IS the sustain weapon); disc/mortar
  could take small caps + fast regen as alpha-strike tools.

## Known limits / follow-ups

- Client pool can read ~1 low vs server between echoes (rejected intents
  spend locally first) — self-converges on the 500ms echo.
- No dry-fire feedback (click / color shift) — the readout going still
  is the only tell today.
- No refill stations/packs — deliberately; evaluate the pilot first.
- No wire for remote players' ammo — only the owner needs it (HUD).

Verified: `bun test tests/weaponAmmo.test.ts` (4 pass), client + server
tsc clean, oxlint clean. `check.sh` failures at the time were other
agents' uncommitted dash violations + one wire-vitality flake, not ammo.
