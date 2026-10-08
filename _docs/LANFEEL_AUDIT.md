# LAN-Feel Audit — network sweep against the manifesto

Date: 2026-10-01. Yardstick: `_docs/LANFEEL.md`.

## Verdicts per tenet

### 1. Own inputs instant — HELD, one scar
Local prediction is instant and journal-replay after corrections is
causally right (rewind → full snapshot → re-run inputs). Scar: **no
render-ease** — when a correction exceeds the visible floor, `player.pos`
teleports. The sim jump is honest; the camera reads it as a hit.
Fix: blend the rendered position ~80-120ms post-replay while the sim
stays converged (camera follows a `renderOffset` that decays to 0).

### 2. Never snap what nobody sees — HELD (today)
Speed-scaled snap budget: server suppresses < max(tol, speed×0.1s);
client ignores the same band. ~1.5m standing, ~5m at cruise. Banking
still counts at the honest tolerance.

### 3. Aim at now — MOSTLY HELD, two gaps
Dedicated server: broadcast led by transit EMA, corrections half-led,
rewind buffer stores led truth, harness measures led truth.
GAPS:
- **P2P host broadcasts raw `p.position`** (host.ts:303) — guests aim at
  transit-ago ghosts on hosted rooms. Small fix: lead by
  `moveShadows.transitOf(pid)` the same way TickLoop does.
- Downlink host latency is the guest→host→guest transit sum; the EMA
  only measures uplink, so the lead under-leads on hosted rooms.

### 4. Loss is scheduling — PARTIAL
- P2P 'game' lane: unordered + bounded retransmit — correct.
- Dedicated uplink (inputMove + position reports): rides WS **TCP** —
  one lost segment stalls every later input ~RTT. The WT/QUIC tier
  exists (opt-in env) but loopback showed ~47% datagram loss so binary
  downlink stayed reliable-lane by design. Inputs are tiny change-only
  packets — they're the best datagram candidates if the WT uplink is
  ever enabled. Until then: real loss spikes = input stall = the jank
  JP felt.
- Rate limits + seq-regression drops handle reorder correctly.

### 5. Client owns what it saw — HELD
Aim never corrected (server checks yaw-distance only), hit claims carry
the shooter's window, kills evaluate rewind buffers of led truth.

### 6. Bounded convergence — HELD (proven twice)
Multiplier-based suppression starved convergence (drift → 6.8m); the
landed form is bounded at max(tol, floor). soakChaos now measures
led-truth drift and holds ~4m at 150ms adverse.

### 7. Cheap server — HELD
20Hz tick (not 60), fixed-step shared sim, interest-tiered fanout,
change-only inputs, binary hot path, capped backlogs, quarantine on
tick faults, measured-elapsed sim steps on resync. Position reports
20Hz binary — ~50B/player/direction. Room for: nothing material.

### 8. Reconnects invisible — HELD
Epoch reset purges pre-disconnect verdicts, gap credit covers honest
reconnect drift, journal resends heal lost input edges, grace window
doesn't bank strikes.

### 9. Degrades, never breaks — MOSTLY HELD
Tolerances scale with measured RTT (transitTol, jitter credit, gap
credit). One hard edge: at >300ms transit the EMA caps — lead stays
honest but corrections get *more* teleporty, not less. Acceptable at
the 150ms bar; beyond it the game is wrong-but-playable.

### 10. Metrics measure feel — HELD
errSeries measures client-vs-led-truth (what observers render); adverse
corrections/min, post-snap residual, reconnect heal all pinned in the
net suite. 54/55 green; the one fail is the WIP-pinned soak boundary
(5.12 vs 5.0 cap).

## Ranked gaps

| # | Gap | Tenet | Cost | Payoff |
|---|-----|-------|------|--------|
| 1 | Authored-time input consumption (shadow trails by uplink transit) | 1,3 | TRIED + REVERTED | Full implementation regressed soak specs — replay infidelity exceeded the transit it removed; half-lead + authored-aligned compare already hide it |
| 2 | ~~Render-ease on post-replay position~~ | 1 | DONE (751445db) | renderPos + exp-decay snapEaseDelta |
| 3 | ~~P2P host broadcast lead + downlink EMA~~ | 3 | DONE (e0124b58) | transitOf(pid) lead in encodeTickPlayer |
| 4 | WT uplink for inputs (datagram lane) | 4 | Needs WT tier hardened; loopback loss unexplained | Only real answer to TCP HoL on bad links |
| 5 | >300ms degradation curve (lead cap) | 9 | Tuning only | Beyond the stated bar |

## Post-audit deltas

- **The "led broadcast" verdict was a lie the audit couldn't see.**
  `MessageHandler.moveReport` dropped rttMs on the way to reconcile —
  transitEma stayed 0 on dedicated AND P2P, so every lead mechanism
  evaluated at zero. The chain (telemetry.ping → binary frame →
  moveClaims → reconcile → EMA → encodeTickPlayer lead) only became
  live in `85aa27d4`. Audit lesson: a "held" verdict on a value path
  is only as good as the plumbing feeding it.
- **Correction cadence 100→80ms** (`8c357ec2`) — reconnect heal now
  lands inside the residual cap; the WIP-pinned soak spec is green.
  Full suite: only the Katabatic capper (movement-tuning WIP) fails.
- Guest correction parity on hosted rooms confirmed: P2P host reuses
  the real MessageHandler + RoomMoveSim, so reconcile→correction is
  the same code path as dedicated.

Bottom line: at 150ms the pipeline now matches the manifesto on every
tenet. TCP head-of-line is the standing risk on genuinely-lossy
links — mitigated by change-only inputs resending, not eliminated.
That and the >300ms curve are the only open items, both beyond the
stated bar.
