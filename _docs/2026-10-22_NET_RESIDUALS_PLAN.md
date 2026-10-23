# Net residuals — research + plan (2026-10-22)

Sources read: Colyseus netcode docs (`predict.spawns`, lag-compensation rewind
modes), Gunsmith projectile replication modes, Sam Reitich's UE projectile
prediction series (parts 1-4), Photon Fusion reliability exceptions, Mirror
NetworkServer out-of-order handling, Unity Netcode deferred despawn +
NetworkRigidbody, MSDN networked-physics correction deltas.

## What production stacks do vs what we do

### 1. Predicted-spawn correlation (the `bind:-1` / `traj-epoch` class)

Every mature stack binds a predicted spawn to its authoritative entity with a
**client-minted id** (we have `shotId`) AND an **exact spawn timestamp/age**
(the piece we're missing on create). Colyseus `predict.spawns` takes a
`spawnTime` field so the replica is placed at the server's epoch, not at
arrival + guessed lead. Gunsmith's "Simulated Predicted" mode does the same:
the replicated projectile is stepped forward by its true age before render.

We already send `age` on `projectileDestroyed` (the gone echo) but NOT on
`projectileCreated` — remote replicas fast-forward by `lead = ping/2`
(estimated, capped 150ms) and own shells re-anchor by `age - transit` (ping
estimate). Two residuals live there:

- `traj-epoch` on remote shells — create echo arrival lag is invisible; the
  replica's age ≠ server age.
- `sa < age` epochs — a create that queued >4s spawns a replica for a shell
  that already died; with `age` we can skip spawning dead-on-arrival replicas.

**P1: put `age` on `projectileCreated`** (spawnFields + broadcast), then:
  - remote replicas `advanceBy(srvAge)` — exact, not capped guess
  - own-shell re-anchor uses `srvAge` verbatim instead of `age − ping/2`
  - replicas with `srvAge ≥ ttl` skip spawn entirely (dead-on-arrival —
    prevents ghost shells for killed-before-seen projectiles)
  - `traj-epoch` becomes measurable at the source: |srvAge| > fuse = echo
    loss, classify as `echo-late` not arc divergence

### 2. Non-player entity replicas (`trail-jumpcut tag:"ball"`, StateHash bot drift)

Reference pattern (Unity BallStateSync + Gambetta dead-reckoning): pos+vel
packets on a jitter buffer, extrapolate between updates, **snap threshold** —
small drift lerps, large drift teleports (and the trail needs an explicit
cut, which our RibbonTrail already does).

Our ball/creature replicas replay server edges + bounce mirror. The 216-283m
jump-cuts mean a replica sat ~1 map-radius stale and snapped — likely a
ball that was idle/server-parked then got punted: our replica extrapolates
nothing (edge-driven), so the wire pos jump IS the artifact. If the replays
are faithful, jumpcuts are just "the ball really teleported server-side
(knock/respawn)" — need to check whether the wire carries the full state
each edge or if we infer.

**P2: audit `netBalls`/`ballGhostPos` path** — confirm replicas get pos+vel
per update and DR between them; if edges are positional-delta only, the
replica freezes between events and the jumpcut is just faithful replay of
a real server teleport (in which case it's cosmetic, already cut by the
trail guard).

### 3. `dmg-echo` divergent blast centers (`offM:33`, `offM:162`)

Same unbound/epoch class as #1 — a predicted blast stamp pairs by shotId but
the server's detonation point diverges when the shell's true arc differs.
P1's exact age + dead-on-arrival skips remove the worst ones. Residual rim
rejections (aimOff>0 legit) stay named.

### 4. `kb-echo` — DONE in this round (RTT-scaled horizon).

### 5. `ping:null`/`srvPing` — DONE (probe.rttMs fallback + srvPing verified
   arriving through the funnel: banner read 306/567ms).

### 6. Boot flake — DONE (serial wanduel launch).

## Work order

| # | Task | Residual killed |
|---|------|-----------------|
| P1 | `age` on `projectileCreated` + exact-epoch remote replicas + dead-on-arrival skip | `traj-epoch` (remote), `self:0` outliers, ghost-shell replicas, worst `dmg-echo` |
| P2 | audit ball/creature replica path for faithful-edge vs freeze artifact | `trail-jumpcut tag:ball`, ball rubber-bands |
| P3 | re-run Tailscale duel, compare before/after | measure |
  
## Follow-up (tsDuel13-15, Tailscale funnel)  
  
- ghostPosition was min()-clamped - ghost==wire always (wg~0), envelope math ran one interp-delay ahead (the aimOff 6-9m dmg-echo/kb-echo class). Now unclamped AND reads `SnapshotBuffer.sampleAt(viewEpochT)` - the shooter's literal view epoch from real snapshot history (LiteEntitySystem snapshot-pair+blend, client-side). rg p50 now 0.04-0.10m (was ~6m).  
- BALL lane persistent desync + 700m rubberbands = ONE bug: a room re-mint rewound ballSim.simTime ~17s, inside isStaleSeg's 30s 'rewind=new epoch' window - every new-epoch segment dropped stale forever  frozen replica + stale regime fields. Window now 2s (isStaleSeg + noteStamp); estSimNow rate floor 0.50.9. tsDuel15: zero ball warns.  
- projectileCreated carries `t` (server wall-ms at broadcast): remote replicas read exact age = srvAge + (serverNow - srvT); dead-on-arrival skip on the exact epoch (counted in dumps).  
- Remaining floor (physical, classified): fate-late verdicts through multi-second stalls; dmg/kb-echo with offM:0 = honest rim rejects; traj-epoch sa>age = gone-edge queue delay bounded by fuse.  
