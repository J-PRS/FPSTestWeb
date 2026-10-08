# LAN-Feel Manifesto

The bar: at up to ~150ms of real Internet the game plays like it's on a
LAN — from the player's chair. Not "correctly synchronized" — *feels*
local. These tenets decide every netcode call, and every one trades
accuracy for feel **deliberately and bounded**, never accidentally.

## 1. Your own inputs are instant, always

Prediction is truth from your seat. The local sim applies an input the
frame it happens; the server's opinion arrives later as a *correction*,
and a correction is an implementation detail — the player should never
be able to tell one fired. If a correction is ever noticeable, the
netcode failed, not the player.

## 2. Never snap what nobody can see

A correction that moves the camera less than the player can perceive is
pure jank. Suppression bands scale with speed: ~1.5m at standstill,
~5m at cruise — a 5m offset at 50m/s is 0.1s of travel, invisible by
definition. Divergence still banks at the honest tolerance — anti-cheat
doesn't get the slack — but the *snap* only ships past the jank floor.

## 3. Aim at now, not at transit-ago

Every position the server shows the world is velocity-led by the
sender's uplink transit. Aiming at a raw sim position is aiming at a
ghost: hits don't register, corrections rubber-band. Observers,
hit-validation rewinds, and corrections all read the led truth, so the
world is where the player *is*, not where they were.

## 4. Loss is a scheduling problem, not a failure

Input is change-only + seq-stamped: a lost edge resends once and heals;
reordered packets drop silently; jitter sizes the comparison tolerance
instead of firing false strikes. Nothing in the pipeline assumes
in-order or on-time delivery — datagrams arrive when they arrive.

## 5. The client decides what it *saw*

The server owns outcomes; the client owns its own evidence. Aim is
client-authoritative (a correction never touches yaw/pitch), hit claims
carry the shooter's rewind window, and kills evaluate against the world
the shooter actually rendered. A lie can't produce impossible hits —
the window is bounded — but an honest shot is never lost to transit.

## 6. Convergence is bounded, always

Suppressed corrections, replayed journals, and led comparisons must all
be *bounded*: error can hide below the visible floor but can never grow
past it. Any mechanism that lets truth and prediction drift unbounded
for the sake of smoothness is a bug wearing the manifesto's clothes.

## 7. Cheap server is part of the feel

A tick that can't keep up is rubber-banding for everyone in the room.
Fixed-step integration (same trajectory on a 144Hz client and a 30Hz
tick), distance-tiered fanout, edge-only wire for non-players, bounded
journals/maps/buffers, and no per-tick allocation churn — the sim
budget is spent on players, not bookkeeping.

## 8. Reconnects are invisible

Dropping and rejoining mid-ski should cost the player nothing they can
notice: epoch resets purge pre-disconnect traffic from the verdict,
seq journals survive re-auth, and corrections during the reconnect
grace don't bank as strikes. The wire's job is continuity, not ceremony.

## 9. Bad-network behavior degrades, never breaks

At 300ms the game should feel worse — not wrong. Degradation means
bigger allowed offsets and longer windows; it never means teleports,
stuck inputs, or correction storms. Every tolerance in the pipeline
scales with measured transit so a worse link gets a wider lane, not a
harder crash.

## 10. Metrics measure what the player feels

The honest error is client-vs-led-truth — what observers render and
what snaps measure against. Correction cadence, post-snap residual, and
reconnect heal time are the metrics that matter; raw sim-vs-report
distance is a debugging view, not a verdict. A green suite that
measures transit-age is green-washing.

---

# State-of-the-Art Techniques

The published playbook for LAN-feel on unpredictable networks, and where
each technique lives in this codebase. Sources: Valve's Source engine
netcode papers (Bernier), the Overwatch/Valorant netcode talks, GGPO and
the rollback literature, Unreal's replication docs, and the Halo/GDC
reach-out-and-shoot-someone lineage.

## Prediction & reconciliation

**Client-side prediction with replay** — the local sim applies input
immediately and replays the input journal over the last authoritative
state when a correction lands. Ours: predicted sim runs the same fixed
step as the server; corrections trigger a journal replay in `MoveSim`,
and a render-ease blends the visible mesh while the sim snaps. Tenet 1.

**Correction damping / error budgets** — Unreal ships
`positionSnapThreshold`; below it the proxy blends, above it the proxy
snaps. We do it by *speed*, not a constant: `max(tol, speed × 0.1s)` —
1.5m standing, ~5m at cruise (tenet 2). The "smooth correction" trap:
lerping an own-player correction reads as rubber-banding — snap the
sim, ease only the camera (tenet 1).

**Input journaling** — every input edge is seq-stamped and journaled
(128 entries client-side) so the server can ask for exactly the edges it
missed and the client can replay them for reconciliation. Watermark
goes both ways: `inputSeq` rides the binary position frame down, the
server's `inputSync` resend-request rides the reliable lane up.

**In-packet redundancy** — GGPO's core trick (`dup_send_range`):
every uplink packet carries a copy of the previous edge, so a single
lost packet costs zero instead of a watchdog round-trip. Cheap because
change-only streams are already sparse. Ours: `inputMove.prev`.

## Interpolation & remote rendering

**Adaptive interpolation delay** — Source's `cl_interp` idea: the
render buffer sizes itself to observed jitter, not a constant. Our
buffer adapts 200→800ms under jitter and reports its own delay to the
server (`clientStats.renderLagMs`) so lag-comp rewinds to the ghost the
shooter actually saw — not a nominal one.

**Bounded extrapolation** — when the buffer starves, extrapolate
velocity past the newest snapshot, capped. Valve's guidance is ~0.25s;
stretching further draws ghosts that were never real. Ours caps at
`max(0.25s, 0.6 × arrival interval)`, 0.6s ceiling.

**Hermite / spline interpolation** — interpolating position AND
velocity between snapshots (Hermite tangents) smooths the corners a
linear interp chops. Ours lives in `remoteSnapshots.ts`.

**Teleport threshold** — an undeclared delta beyond plausible travel
(respawn carried over, stale post-reconnect frame) must hard-jump the
buffer: lerping it draws a speed-ghost sliding across the map and
poisons the velocity estimate used for extrapolation. Ours: deltas past
physically-possible travel wipe the buffer and the DR state.

## Hit registration

**Rewind lag compensation** — the server keeps a position history per
target and validates hits against where the shooter *saw* the target,
not where it is now. The discipline is the rewind amount: full-RTT
rewinds validate ~RTT/2 behind the rendered ghost. The honest amount is
`shooterTransit + renderLag − targetTransit` — one-way hops only, with
the target's own uplink transit subtracted because the rewind buffer
already rides it.

**Shooter advantage, bounded** — Valorant's rule: the shooter's
evidence wins within a bounded window; a lie can buy a tighter window,
not impossible hits. Ours: aim is client-authoritative, rewind depth is
clamped, and the kill feed evaluates against the shooter's rendered
ghost — `hitVerdict` pre-flight gates the predicted hitmarker so what
you see is what the server will validate.

**Server-side RTT probing** — trusting the client's self-reported ping
makes the whole lag-comp window forgeable. The server issues stamped
pings and owns the transit estimate once its probe is live; the client
report only covers the join grace. Unprompted pongs are dropped.

## Loss & transport

**Seq gates over ordering assumptions** — change-only streams plus
unordered transports means every receiver needs an idempotent apply:
stale seqs drop, gaps are explicit. Never let "in order" be a protocol
assumption — WS TCP guarantees it, datagrams don't, and the same code
path serves both.

**Watchdog vs redundancy** — a gap-counter resend heals in ~RTT+;
in-packet redundancy heals single losses instantly. Use both:
redundancy for the common case, the watchdog for runs of losses.

**Reliable vs unreliable lanes** — events that must land (kills,
flags, pickups, corrections) ride the reliable lane; high-rate
position/input state tolerates loss by design (next frame supersedes).
TCP's head-of-line blocking is the residual cost of running the input
stream on the reliable lane — the datagram tier (WT/SCTP) is the
answer when loss is real.

**Bounded everything** — journals, buffers, maps, queues all carry
caps with eviction accounting (`wireChaos` proves journal eviction is
*counted*, and drowned sockets get marked-skipped-closed rather than
silently stalled). Unbounded state on a bad link is a memory leak that
also feels bad.

## Convergence & degradation

**Speed-scaled error tolerance** — the perceivable threshold isn't a
distance, it's a fraction of a second of travel. Scale suppression
bands by speed; a fixed threshold is wrong at both ends (too visible
standing still, too lenient at ski speed).

**Degrade the window, not the world** — at 300ms the right answer is
a wider interpolation buffer and a bigger allowed offset, not
teleports or correction storms. Tenet 9; `tickDegradation` and the
`harshWan` netbot soak are the regression tests.

**Reconnect as first-class state** — epoch resets purge pre-disconnect
evidence, journals survive re-auth, and the reconnect grace window
suppresses banking. The player's experience of a drop should be a
hiccup, not a respawn.

## The residual gap

TCP head-of-line blocking on the input uplink is the last structural
item the bar doesn't already cover: loss stalls the whole stream ~RTT
while the redundancy fix only covers edges once they've been *sent*.
The WebTransport/SCTP datagram lane exists but needs its own debugging
pass — that's the final piece for true LAN-feel under real loss.
