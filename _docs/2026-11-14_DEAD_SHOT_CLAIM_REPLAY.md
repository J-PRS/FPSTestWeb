# Dead-Shooter Reject on Replayed Fire Claim (2026-11-14)

Report on a live `igunffa-1` session: the client predicted a direct Disc
hit, painted damage, and 9s later the server rejected the claim with
`Shot: shooter dead` — no damage credited.

## Observed timeline (client diagnostics dump)

```
19:56:00.390  [CoolShot] Disc Launcher hit player_sclkibunq air=0.343s dist=24.9 direct=true
19:56:00.392  [Hit] ... score=85                       <- local sweep marked the hit
19:56:08.694  Local player killed by player_sclkibunq  <- server death lands client-side
19:56:09.309  shot rejected - predicted damage never applied: Shot: shooter dead (pingMs=2)
```

Session context: `tier: ws`, `loss: 11%` (datagram-lane measurement —
irrelevant here, see below), repeated `[Resync] hidden Ns` → `gameState` →
"Reconnect restore replayed" cycles throughout the match (16.7s, 12.2s,
8.0s, 15.0s, 12.2s hidden windows).

## The claim's full journey

1. **Fire** — `sendShotFired` (`NetworkManager.ts:1197`) stamps `fireAt`
   in server-epoch ms, sends immediately, and journals the msg into
   `claimIntents` (cap 16, 10s `FIRE_REPLAY_MS` window).
2. **Send path** — `shotFired` is in `FAST_LANE` (line 694) → `sendFast`
   → native binary shot frame → `sendBinary` → the connected lane. On
   the ws tier this is TCP — a frame sent successfully cannot be lost
   mid-flight. If the lane is dead, `send()`/`sendFast` calls `noteDrop`
   and the claim hits the floor (it is deliberately NOT in `QUEUEABLE`).
3. **First recovery** — `sweepLedgers` (line 807) resends each journaled
   `shotFired` once at ~2×RTT (150–450ms, `e.resent` flag). Only runs
   `if (this.isConnected())` — a dead lane skips it entirely.
4. **Last recovery** — `replayFireIntents` (line 1226) fires on every
   `gameState` re-seat (`wireIn.ts:587`): reconnect, or the visibility
   resync that requests world-state replay. Anything younger than 10s is
   re-sent verbatim; the server dedupes by `shotId`.

## Why it arrived 9 seconds late

The reject landed `pingMs=2` after the claim was adjudicated — i.e. the
claim reached the server at ~19:56:09, nine seconds after the shot fired.
No "send dropped - no live lane" warning appears in the log, which means
`ws.connected()` still returned true at send time: the claim was most
likely buffered into a socket that was already dying (the tab had just
come out of a hidden window / lane teardown). Outbound bytes buffered on
a CLOSING socket die with it — the send looks clean, the bytes never
ship. The only remaining recovery is the `gameState` reclaim replay,
which fired ~9s later on the reconnect and re-sent the intent verbatim.

Server-side adjudication is strictly arrival-time (`CombatHandler.ts:482`):
`!player.isDead` is the first gate, before `fireAt`/`uplinkMsOf` and
before the `shotId` dedupe (`shotDup`, line 493). At 19:56:09 the shooter
was dead → reject → client rolls back the predicted paint.

So the rollback is the system working as designed: **the wire never saw
the shot while the shooter was alive.**

## Latent issues surfaced by this event

**A. Dead-check runs before dup-check** (`CombatHandler.ts:482` vs `493`).
If a claim IS credited while alive and the same `shotId` later replays
post-death (the normal reconnect-replay path), the dead-check emits a
reject for a shot that was already applied — a bogus "predicted damage
never applied" log + rollback attempt on confirmed damage. `shotDup`
should run first; a dup to a dead player should silent-drop, exactly
like an alive one (`// Dropping silently ... is correct` comment at 490).

**B. Replaying fire intents when the client knows it's dead.** The
`gameState` that triggers `replayFireIntents` carries the roster —
including our own `isDead`. A replayed shot from a dead shooter can never
be credited; sending it only manufactures a reject + rollback noise.
Skipping own-shot replay while dead removes this whole failure class.

**C. No death timestamp exists server-side.** `fireAt` is already
server-epoch and `uplinkMsOf` bounds claim staleness by measured transit
(~400ms floor + transit EMA), but `PlayerState` has no `deadAt`
(3 `isDead = true` write sites: `PlayerManager.ts:209`, `:379`). A
"last shot counts" tolerance (accept claims with `fireAt` inside the
uplink window *before* death) needs that stamp plus a bound — and even a
generous ~1s window cannot save a 9s tab-hidden replay, only the common
sub-RTT "died mid-claim" race.

**D. `fireAt` survives the replay verbatim.** The journal stores the
original msg including its `fireAt` stamp, so a replayed claim keeps its
original fire time — good for origin rewind (`claimOrigin` rewinds by
bounded uplinkMs, not raw age) and exactly what a deadAt tolerance would
need. No forgery window opened: cheaters can already stamp any fireAt;
the uplink bound is measured, not stamped (comment at :255–263).

## Options

1. **Do nothing** — arrival semantics are defensible; the cost is rare
   paint-rollbacks on reconnect-over-death edges. Cheapest.
2. **Reorder dead-check after `shotDup`** (A) — one-line move; kills
   bogus rejects on credited shots. Should be done regardless.
3. **Skip own-shot replay while dead** (B) — gate `replayFireIntents`
   entries on the `isDead` from the same `gameState`; removes the noise
   path entirely. Small, safe: a dead shooter's replay can never credit.
4. **deadAt tolerance** (C) — real "died mid-claim" coverage, but adds a
   stamp + an adjudication branch and can't help multi-second replays.

Recommended: 2 + 3 now; revisit 4 only if live telemetry shows legit
pre-death claims dying in ordinary latency (it's a ~1-ping window —
the 400ms uplink floor already covers honest cases).
