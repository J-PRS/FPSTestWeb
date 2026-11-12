# 2026-11-13 — Bloom "spread then converge" artifact (and the mechanic it suggests)

## Symptom

Watching a chaingun stream on a live server: shells visibly fan out at the
muzzle, then curve back and converge onto the aim line ~30-80m downrange.
Reads almost like a homing volley — "spread that only matters at short
range."

## Cause

Not a mechanic — a seed desync made visible.

- Client predicts each bloom shell's cone jitter off its own counter
  (`fire.ts` `pl.bloomSeq++` — incremented per trigger pull).
- Server seeded the cone off `player.bloomSeq`, but only inside
  `bloomAim`, which ran AFTER every reject gate in `simmedShot`/
  `shotAdmit` (dead shooter, weapon lock, flood/cadence, ammo/energy/
  belt dry, needs ground).
- Every refused claim incremented the client counter but not the
  server's → the jitter streams diverged permanently. Each subsequent
  predicted shell flew at a *different cone angle* than the
  authoritative shell.
- When the `projectileCreated` echo arrived,
  `linkOwnProjectile`/`reanchorTo` (`client/src/game/net/projectiles.ts`)
  blended the shell back onto the server's true arc. The visual drag IS
  the convergence — the bigger the counter drift, the more dramatic
  the V-shape. Same desync produced the `parity-dmg-echo` misses with
  `aimOff` ≈ a full cone diameter.

## Fix (server_bun/src/CombatHandler.ts)

`bloomTick()` consumes one seed per unique shot claim at the top of
`handleShotFired` — decay → grow → stamp, mirroring the client's
per-pull rule — and stashes `{radius, seq}` in a `WeakMap` keyed on the
claim. `bloomAim` now only draws the jitter from the stash. Deduped
reclaim replays skip the counter (already paid on first arrival).

Residual: a claim lost outright (socket drop) still desyncs the counter
until reconnect — acceptable, reliable-lane loss implies a disconnect
anyway.

## The accidental mechanic

The artifact is a genuinely interesting weapon idea worth stealing
deliberately: a cone that starts wide and converges onto the aim line
at a fixed range — spread matters only at short range. Implementation
would be trivial (aim each shell at `muzzlePoint + aimDir * focusRange`
with muzzle offsets scattered, or lerp jitter→0 over flight time) —
parked here as a possible future weapon trait, not built.
