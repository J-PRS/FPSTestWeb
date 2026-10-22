# Remote render truth — three bodies per remote, and only one is law

Every networked remote has THREE positions, and bugs live in the gaps:

| Body | What it is | Who uses it |
|---|---|---|
| **Wire** | Latest server record, projected by wireAge | Lag comp (server + client envelopes) |
| **Rendered** | Interp buffer / dead-reckoned ghost | Your eyes, your crosshair |
| **Judged** | The epoch the server rewinds to | Hit validation |

If you shoot what you see, the hit must count — that's the contract.
Everything below exists to keep the three bodies honest about each other.

## Rules of the road

- **Wire is law for remotes.** Client prediction is for the LOCAL player
  only. Predicted remote motion (e.g. estimated blast knockback) draws
  the body where the wire never put it — when the truth lands it reads
  as sling-then-warp. A real-wire run confirmed wire shoves arrive in
  ~4 ticks; prediction saved <100ms and cost the entire trust model.
- **The judged epoch is the shooter's literal view.** `interp.viewLagMs`
  reports actual sample staleness (extrapolation-aware), the server
  rewinds to exactly that — no 0.7 "shooter advantage" haircut, no
  estimate. Aim-land far off the wire pos is then *expected*, not a bug.
- **Never teleport to enforce an invariant.** `clampWireGap` once snapped
  bodies inside the leash instantly — the enforcement WAS the warp.
  Leashes pull at bounded, reachable speed (≤ REACH_CAP·dt) so the
  monitor can scream while the screen stays calm.
- **Silence is earned budget.** DR during packet gaps legitimately
  diverges; `silencePeakMs` keeps that allowance for the first frame
  after reconnect instead of clamping against a shrunken cap.
- **Respawn/teleport is a different class than motion.** A 200m jump is
  fine if the wire teleported; only undeclared jumps get flagged. Any
  monitor that can't tell them apart cries wolf.

## The debugging pattern: draw all three

The multi-wireframe gizmos (cyan wire ghost, yellow projected ghost,
skinned body) turned a week of log archaeology into one visible frame:
"the render was somewhere the wire never put it." Anywhere you keep
predicted vs authoritative vs judged state — remotes, projectiles, own
rewind — drawing all three costs ~20 lines and finds the divergence
class immediately.

## Validation as a resident, not a test

`liveMonitor.ts` runs invariants (wire-gap, render-drift,
impossible-motion, dup-hit, parity echoes) while you play — `?monitor=1`,
`__monitor.dump()`. Synthetic tests can't produce real silence gaps,
burst loss, or teleport-seeded velocities; the 616 m/s converge event
only showed up on a real socket. The monitor never changes gameplay —
it just refuses to let drift hide.
