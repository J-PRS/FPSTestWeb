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
