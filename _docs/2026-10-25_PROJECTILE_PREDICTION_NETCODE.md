# Projectile Prediction Netcode — Research + Our Implementation

Goal: own shots must feel and look identical to offline — fire, the shell
leaves instantly, and no visible correction ever reaches the eye.

## Sources consulted (2026-10-25)

- Broadside devlog — "Projectile Networking in a High Speed Shooter"
  (broadside.gg/devlog): three views of one shot (shooter / server /
  target); local prediction + server resimulation of the missed window +
  rewind against historical positions. Server spawns at the *real* shot
  epoch and resimulates forward.
- Sam Reitich, "Projectile Prediction" parts 1-4 (sreitich.github.io):
  Unreal/GAS fake-vs-authoritative model. Fake lerps toward the real shell
  at ~0.05% of initial speed per tick; MaxPredictionPing bounds the
  fast-forward; the authoritative replica is hidden from the owner.
- Riot, "Peeking into VALORANT's Netcode" + "State of Hit Registration":
  server rewinds input timestamp ("what is currently rendered on your
  screen"), resimulates; the goal is preventing disagreement under
  reasonable conditions, not correcting well.
- 4AM Games, "Smooth Server Reconciliation": split true position from
  render position; corrections ignore collision (a lerping body must not
  snag); float determinism never perfect — residual epsilon corrections
  are absorbed by design.
- Colyseus netcode recipes: `predict.spawns` — stable-id handoff between
  predicted and authoritative entities; `smoothMs` display spring because
  the eye punishes velocity discontinuity harder than offset error.
- SnapNet, "Netcode Architectures Part 4: Tribes": original Tribes model —
  projectiles were server-owned ghosts + local smoothing; control object
  move-replay; eventual consistency.
- CS2 "exact grenades" (cstrike.gg wiki): demos store exact spawn pos+vel;
  replaying those values reproduces landings within 0.03u and identical
  bounce counts — proof that identical spawn state → identical flight.

## The canonical model ("fake + real")

1. Client spawns a predicted shell instantly at trigger — full physics,
   full visual. It owns the whole visual lifetime unless contradicted.
2. The fire intent carries the COMPLETE spawn state: origin, direction,
   **inherited velocity**, and a timestamp (fireAt). Not a request for the
   server to compute a spawn — a claim of what was drawn.
3. Server validates plausibility (cadence, ammo/belt, origin within reach
   of a rewound body sample, velocity within an honesty window), then
   adopts the claimed state verbatim when honest.
4. Server back-dates shell age by measured uplink so fuse/arc epochs
   match the replica's clock; echoes pos/vel/age back with the claim's
   nonce (shotId/pellet) for exact binding.
5. If the echo differs (clamped claim, stale shadow, dropped fields), the
   predicted shell converges onto the wire arc via a RENDER-ONLY offset —
   never touching the simmed position.

## Our implementation (post 2026-10-25 fixes)

Intent: `shotFired { weaponType, dir, pos, vel, shotId, fireAt }`.

- `claimOrigin` (CombatHandler.ts:237): adopts claim `pos` verbatim if
  within 3m of a rewound body sample (window = uplink + 150ms), else uses
  `rewindPos(player, uplinkMs)`. No transit estimate — claim truth,
  measured window.
- Velocity adopt (CombatHandler.ts:~560): `vel` claim adopted verbatim if
  within 20m/s of shadow `player.velocity` (the whole honest divergence
  space: accel × uplink), else clamped to shadow. Inherit is 0.5-weighted
  so worst forged nudge is 10m/s on a ~250m/s shell.
- `lagS = uplinkMs/1000` seeds the authoritative shell's age — fuse epochs
  align with the replica clock.
- `edgeSpawn` echoes pos/vel/age (+shotId/pellet nonce) on the reliable
  binary lane; `linkOwnProjectile` binds it to the predicted shell by
  nonce — no FIFO/position inference.
- `reanchorTo` (Projectile.ts): adopts wire pos+vel, projects forward by
  the echo's own `srvAge` (falls back to ping-estimated age on old peers),
  folds the positional splice into `renderOffset`.
- `renderOffset` decay: `tau = |offset| / max(|vel|·0.1, 1)` — lateral
  correction is bounded to 10% of flight speed (~6° max path deflection),
  self-scaling: tiny splices snap in a frame, big ones stretch to a
  smooth curve. Same speed-relative insight as Reitich's per-tick lerp.

### The bug this fixed

`dir·speed + playerVel·0.5` ran on both ends — but the server substituted
its shadow `player.velocity` for `playerVel`. Tribes inheritance makes
that term huge: skiing at 200km/h, a stale shadow shifts the disc's spawn
velocity ~28m/s → every echo arrived on a visibly different arc and
`reanchorTo` jinked the shell mid-flight. Claiming `vel` made the echo
≈bit-identical for honest claims; corrections now exist only for the
bounded-clamp / stale-echo / dropped-field edges.

## Remote-shell pop-in — the three shipped strategies

A remote replica's truth is always ~1 transit downrange on arrival; the
shell can't be at the muzzle AND at truth. Every shipped game picks which
lie looks better:

- **Battlefield (EA/DICE)**: spawn at the original transform, never
  advance — the shell permanently trails truth ~1 transit, the explosion
  edge owns the death visual. Consistent with remote players rendering
  ~100ms in the past anyway.
- **Accelerate-to-catch-up** (gamedev.stackexchange accepted): the server
  speeds its shell up over a few frames until it reaches the lag delta —
  on-time arrival AND muzzle spawn, but the server sim departs from the
  shared deterministic sim during catch-up (replica parity cost).
- **Render-side catch-up (ours)**: sim advances by the exact wire age
  (impact alignment stays true), `renderOffset` walks the visual back to
  the shooter's rendered muzzle and blends forward at ≤10% of flight
  speed — same outcome as accelerate-to-catch-up without touching the
  sim; identical to Unity Netcode's prescribed "separate the visual,
  sync over time."

Residual artifact is architectural, not a bug: during the blend the
visual trails truth briefly near the muzzle (masked by flash/smoke);
the detonation edge owns the kill visual either way.

## Lineage + the two named failure cases

**Quake 3 / Unlagged `cg_projectileNudge`** (ra.is/unlagged): the original
remote-projectile compensation — set to your ping, remote shells render
advanced by that amount so what you dodge IS your real action window.
Documented cost, verbatim: shells "seem faster, stick into walls before
they explode" — accepted because the advance reflects the true window of
useful action. Our `advanceBy(lead)` is the same mechanism with the ping
cvar replaced by the echo's exact `srvAge+transit`, plus the
muzzle-walkback that Q3 never had. `cl_timeNudge` is the sibling knob
(interp delay vs prediction error) — ours derives from measured
`viewLagMs` rather than a manual value.

**Premature detonation** (Reitich part 4): the fake leads the real shell
by uplink — a target in the fake's path may have moved out of the real
one's, so the fake detonates where the authority flies on. GAS's
`SwitchToAuthTimer`: after the fake pops, wait ~1 ping; if the wire
shell hasn't detonated, the pop was premature → destroy the fake, unhide
the authoritative replica, keep flying server truth. Reitich's standing
advice: `bPredictFX` OFF — the fake vanishes silently and the wire blast
paints the real position rather than playing a false explosion.
We predict the blast FX+force locally (the risk he names); our shell
can't unhide-and-continue because server shells aren't position-
replicated — the wire 'gone' edge still owns the real detonation spot,
so the cost is a possible false local blast, not a wrong outcome.

## What proper practice says remains

1. **Prediction ping cap**: our uplink bound is `min(ms, 5000)`. Industry
   standard is ~400-500ms (Unreal MaxPredictionPing). A 4s-stale claim
   materializes a shell deep into its arc — the born-late pop. Tightening
   to ~500ms bounds worst-case; the claim is bounded, never rejected.
2. **Overshoot**: Reitich deliberately *under*-forwards the authoritative
   shell so a fully-synced fake can't collide ahead of what observers
   see. Our `lagS` fully forwards — fine while prediction is exact, but
   watch for "my shell hit but the server's popped early/late" reports.
3. **Bounce determinism**: remote shells and predicted shells both step
   on the server's 50ms cell grid (`cellAcc`) so bounce/contact phases
   match the tick grid — this was the trajDiv fix and is the equivalent
   of CS2's exact-grenades requirement. Float noise remains a source of
   epsilon corrections by design (4AM): absorbed, not eliminated.
4. **Correction ignores collision**: renderOffset is render-only, so a
   blending shell may briefly draw through geometry near a wall —
   correct per 4AM (collision during correction double-explodes); keep
   splices small and it never shows.
5. **Fire-rate honesty**: cadence law (rolling-second per
   `playerId:weaponType`, 0.85× interval slack) + belt-economy charge are
   the claim's only hard gates; everything else is adopt-and-broadcast.

## Verification anchors

- `client/src/__tests__/hookWhiff.test.ts` — hook whiff never pulls.
- `spawnDrift()` (fire.ts) — claimed-vs-flown velocity drift must read ~0.
- Alt+Q `parity`/`trajDiv` diagnostics — own-shell reanchor deltas should
  read ≈0 after the vel-claim change; persistent nonzero = shadow-vel
  divergence still leaking through some path.
- `server_bun/tests/nuggetDeploy.test.ts` — claim-vel adoption proven for
  the thrown-pod deploy path through real GameServer dispatch.
