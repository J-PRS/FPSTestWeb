# Trap: wall-clock staleness sweeps mass-reap live objects after a global stall

Cost: `zombiePushes` climbing 37 → 15,277 in one session, `trail-jumpcut`
in the hundreds, doubled trails, corrupted shared slots — all downstream
of an alt-tab, not of any leak.

## The symptom that misleads

`zombiePushes` reads as "an owner outlived its handle" — the classic
dispose-without-death leak. The count exploding only after a `hidden`
resync is the tell: the owners were all alive; the *handles* were stolen.

## The mechanism

`RibbonTrail.sweepStale()` (runs every frame from `updateProjectiles`)
reaps ribbons whose `lastUpdateAt` is >2s old — **measured on
wall-clock**. A hidden tab freezes the frame loop, so on the first frame
back EVERY live ribbon reads as simultaneously stale:

1. `sweepStale` disposes every live ribbon → they enter the free pool.
2. `acquire()` re-issues them to newly spawned projectiles —
   `claimSlot` clears `inPool`, hands out a fresh slot.
3. The *old* owners (local predicted shells, swings, arm trails — the
   resync drop only kills remote replicas) still hold the same object:
   their drivers keep pushing → `zombiePushes`, or — worse — writes land
   in the new owner's slot → two writers interleave samples, the spatial
   jump guard cuts each frame → `trail-jumpcut` storm and drawn trails
   that belong to two shells at once.
4. The old owner's later `dispose()` re-pools an object the new owner
   is still using — double ownership with no marker left to catch it.

## The fix

Before reaping, take the **freshest** `lastUpdateAt` across `liveSet`.
If even the newest stamp is older than `staleMs`, the frame loop stalled
— not the owners — so re-baseline every stamp to `now` and reap nothing.
Genuine orphans keep their frozen pre-stall stamps and get reaped on the
next sweep once fresh stamps exist again; they lose only one `staleMs`
window of grace.

`RibbonTrail.ts` `sweepStale` — the guard is ~10 lines.

## Rule of thumb

Any wall-clock idleness detector that runs per-frame ("no update for N
ms = dead owner") is really measuring "no *frames* for N ms" after a
stall. Gate mass reap on *relative* staleness — is this object older
than its freshest sibling? — or stamp on a frame counter, not the wall
clock. Same class of bug as timestamp-expiry caches that fire every
entry at once when the process suspends.

Cross-ref: `_docs/2026-10-24_NETCODE_HEURISTIC_AUDIT.md` — every
heuristic needs a mechanism that un-bricks itself when it guessed wrong.
