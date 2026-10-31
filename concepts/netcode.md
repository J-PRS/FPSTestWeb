# Netcode model — server-authoritative, claim-driven, 20 Hz

> Master reference. For transport ladder details see
> `_docs/2026-10-26_TRANSPORT_TIERS.md`; for lag-comp depth see
> `_docs/2026-10-28_LAG_COMP_WYSIWYG.md`; for prior-art parity see
> `_docs/2026-10-31_NETCODE_EFFICIENCY_PLAYBOOK.md`.

Cost constraint drives everything: one cheap Bun process, 20 Hz room
tick, thin binary messages, events over streams. The client predicts,
the server adjudicates — and the server *sims* almost everything now.

## The pipeline (one tick, `server_bun/src/TickLoop.ts`)

Deadline-compensated `setTimeout` at `FPS_TICK_HZ` (20 → 50 ms
`TICK_DT`), not `setInterval` — a fixed wall-clock deadline avoids
phase-error accumulation and Windows 15.6 ms timer quantization, both
of which used to land in every client's arrival-jitter EMA.

Per room, per tick:

1. **Drain commands** (`Room.drainCommands`) — inbound messages queue
   on arrival, never apply mid-tick. Before handling, stamped claims
   sort by `fireAt` (the shooter's own server-clock stamp of the
   trigger instant), clamped to `arrival − 2×measured-uplink − margin`:
   two shooters inside one tick resolve by who actually clicked first,
   not whose packet won the wire race. Forged stamps degrade to arrival
   order. This is the CS2 "sub-tick" answer, already implemented.
2. **Drain input edges → step shadow sims** (`RoomMoveSim.tick`) —
   every player has a shadow `shared/movement.ts` sim. `inputMove`
   edges (change-only, seq-gated, FIFO `pending` queue, prev-edge
   redundancy) replay across the tick window at their stamped times:
   each `inputMove` edge carries `ageMs` (ms-before-send, u16, clamped
   to `2×transit + 4×jitter + 50`), so edge i governs `[est_i, est_{i+1})`
   of the window and the pre-edge state covers the head — a press+release
   inside one tick holds for its real fraction. Unstamped/legacy edges
   keep the old uniform slicing. Resting shadows skip the integrator.
3. **Step world sims** — projectiles, creatures, ball, deployables;
   all deterministic (`shared/`), no wall-clock decisions.
3.5 **Arrival-time cosmetic relays** — pure-presence edges don't wait
   for the drain: jump/jetpack fast-path at dispatch like position
   frames, and stamped cosmetic-path shotFired intents (melee/beam/
   non-simmed — not shell weapons, which get projectileCreated) emit
   `playerShot` on arrival via `Room.earlyShotRelay`. shotId dedupe
   stops the drain's re-emit (`earlyRelayed`); damage/ordering still
   adjudicates in fireAt order at phase 0.
4. **Build records** (`tickRecords.ts` / `TickFanout`) — per-player
   per-tick: distance tiers + aim-cone boost + suppression
   (`recordSuppressed` skips unchanged far records) + idle reap +
   per-recipient cap + spatial index. Delta-masked v4 binary records;
   periodic fulls bound loss.
5. **Fanout** — batched per-connection binary frames. Volatile kinds
   ride datagram lanes where the session has one; reliable kinds
   journal for replay on reclaim (~3 s volatile TTL, durable events
   like kills journal too).

## Who owns what (current truth)

| Thing | Owner | Mechanism |
|---|---|---|
| Your movement | server shadow sim (or judged claim) | `inputMove` edges + held-input on position frames; `moveAuthority()` picks sim-owns-position vs judge-mode (divergence = anti-cheat signal, `correction` msgs on divergence) |
| Your view of yourself | client prediction | replays same `shared/movement.ts`; corrections rewind to echoed `inputSeq` and replay the `InputStream` journal (`inputsAfter`) |
| Remote players | position records | 20 Hz claimed/simmed positions, client interp buffer (~200 ms base render lag, adaptive to ~800 under jitter) |
| Damage/hits | server | intents + `fireAt`-ordered drain; validated against the rewind buffer |
| Projectiles | shared sim | claim-carried spawn state (pos/dir/vel/`fireAt`); both ends replay deterministically — `_docs/2026-10-25_PROJECTILE_PREDICTION_NETCODE.md` |
| Non-player objects | shared sim | **never stream positions**: broadcast state edges + committed snapshot, both ends replay. The strongest cheapness guarantee in the stack |
| Kills/respawns/teams | server | binary event edges (0x14–0x19 family: jump/jet/landed/shot/knock/kill) + durable journal |

## Upstream (client → server)

- **Position reports** — 20 Hz binary volatile frames; carry pos/vel/yaw,
  held input, `inputSeq`, `ping`. Superseding stream: a lost frame costs
  nothing, stale frames drop on the seq gate.
- **`inputMove` edges** — change-only seq'd stream on the same binary
  lane; prev-edge redundancy heals single loss instantly.
- **Combat intents** — `shotFired` carries muzzle pos/dir + `fireAt`
  (client's server-clock estimate). `arrival − fireAt` measures per-claim
  uplink transit (`uplinkNote`).

## Lag compensation (`server_bun/src/rewind.ts`)

**The contract: WYSIWYG.** A shot is judged against the shooter's
rendered model — visually on the model = hit, visually off = miss, both
directions. The rewind target is what the shooter *saw* (their ghost at
their render lag), never server truth. `gd` ghost-delta telemetry is the
KPI for violations. Residual error: during starves the shooter's client
extrapolates a ghost that exists nowhere in server history — bounded by
keeping extrapolation short, not by tightening bounds.

- 1700 ms rewind buffer, ~25 Hz position samples, freelist-pooled.
- Rewind target = ping + **per-victim** `renderLagOfTarget` (the
  shooter's ghost lag for *this* victim — a single max-across-remotes
  rewound fast victims ~500 ms behind the real ghost).
- Claimed render lag is a hint, not evidence: `renderLagBoundOf` caps it
  at base 200 + 2×transit + 3×jitter, floor 350, ceiling 1200. The bound
  exists to stop *fraudulent* rewind (claimed lag the link never had),
  NOT to protect victims — the model is unabashedly favor-the-shooter:
  WYSIWYG hit-reg and LAN feel outrank "died behind cover" complaints,
  and honest deep rewinds are the intended behavior.
- Ghost delta (`gd` on `playerHit`) reports how far the credited ghost
  sat off live truth when >1.5 m.

## Transports (`client/src/networking/tiers.ts`)

Ladder: **WebTransport datagrams** → WebRTC datachannel → WebSocket.
Volatile binary (position frames, claims, tick frames) prefers the
datagram lane; `WIRE_JSON` never rides it — reliable traffic in binary
clothing gets dropped there. Native shell adds a **raw-UDP lane**
(`FPS_UDP_PORT`, token-bound) for ticks down / claims up. P2P rooms
split `game` (unordered, maxRetransmits:2) vs `ctrl` (reliable) channels.
Port map lives in root AGENTS.md.

## Trust model

- Server owns every interactive outcome; client-only interaction is
  decor or a bug.
- All claimed time values are hints bounded by measured link physics:
  `fireAt` clamps to 2×uplink, renderLag clamps to transit+jitter,
  `ping` is credited but bounded (`clampPing ~400`).
- Combat *claims* are refused on dedicated (`claimsAccepted=false`) —
  clients send intents; `claimLedger` survives for P2P hosts + ambient.
- Reconnect grace + seat-token HMAC; journaled events replay on reclaim
  so a drown doesn't lose kills/chat.

## Cost doctrine ("cheap is a feature")

- Events over streams: state edges + committed snapshot, never position
  streams for server-owned things.
- Distance-tiered sends, aim-cone boost, suppression, idle reap, caps.
- Staggered AI buckets; resting shadows skip physics.
- Only provably-safe skips (no unfair misses): intro windows force
  fulls, hits/knockback exempt from caps.
- Per-frame/per-tick allocation ~zero in hot paths — freelists, scratch
  arenas, pooled samples.

## Known seams (ranked by earlier analysis)

- Remote viewers still interpolate 20 Hz positions — the shadow-sim +
  `inputMove` infrastructure could relay edges to near-tier clients for
  full-framerate remote replay (determinism already exists; records
  become reconciliation checkpoints).
- `fireAt` clamp margin is now jitter-scaled (4×jitter + 50ms floor).
- `fireAt` clamp margin is now jitter-scaled (4×jitter + 50ms floor).
- `fireAt` clamp margin (+100 ms flat) could tighten by measured jitter.
- `fireAt` clamp margin is now jitter-scaled (4×jitter + 50ms floor).

## Don't regress these

- Commands apply at drain, never on arrival — arrival-time mutation
  interleaved with sim ticks was a real bug class.
- `WIRE_JSON` off the datagram lane; volatile TTL on journals.
- Deterministic sims: no `Date.now()` in `shared/`; tests drive
  `step(dt)`.
- The rewind window the position path and bot feeder share — they must
  agree or they rewind different pasts.
