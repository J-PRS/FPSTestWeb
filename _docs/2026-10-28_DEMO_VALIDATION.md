# Demo Validation — the desync oracle end-to-end

Date: 2026-10-28 · Status: live, e2e-integrated (`dualcheck.ts` in `all.ts`)

The system that answers "did the client see exactly what the server sent?"
— event-for-event, not count-for-count. Damage delivery is the hard gate:
a missing `playerHit` on an established stream fails the run.

## Pieces

| File | Role |
|---|---|
| `server_bun/src/roomDemo.ts` | Server-side demo recorder. Taps `connections.broadcast` (JSON lane) AND `broadcastBinaryReliable` (binary lane, decodes `WIRE_HIT`/`WIRE_KILL` via literal magic `0x54` — `MAGIC` is not exported). Arms via `FPS_DEMO=<dir>` env; flush live via `POST /admin/demodump?room=<name>` (Bearer token) or on room teardown. |
| `client/src/demo/*` | Client recorder: remote frames (render pos @ receipt `elapsedTime`), target/projectile events, `recordPlayerHit` — every credited damage edge on the KILL lane (`recordKill` writes `StateChanged`, `recordPlayerHit` writes `Hit`, same lane `TARGETTYPE_KILL`=224). |
| `client/src/networking/wireIn.ts` | `pendingWidEvents` — binary hits/kills/projSpawns that arrive before their wireIds mint queue up to **1.5s** (below the wireId reissue quiet window; a longer cap lets a stale frame resolve against a recycled id). Drains on `wireIds`/`gameState`, warns + drops orphans, cleared on room epoch. |
| `_tools/demodiff.ts` | The oracle. Clock fit → posΔ per seat → event pairing → gated exit. `--bytime` buckets posΔ over capture time. `DD_DEBUG=<key>` dumps a key's pairing pools. |
| `_tools/e2e/dualcheck.ts` | Automated dual capture: upStack (FPS_DEMO armed) → headless client → client demo + `/admin/demodump` → demodiff → exit code. `--secs=45 --room=<name>`. Registered in `all.ts` SPECS. |
| `_tools/e2e/demodiffSelftest.ts` | Synthetic gate: match→0, missing→1, fabricated→1, in-tolerance→0. |

## demodiff pipeline

1. **Clock fit** — the client's `elapsedTime` is wall-clamped (drifts vs
   server sim; observed 0.24–0.65x headless). Piecewise 4s windows, offset
   sweep both directions, scored by *consensus across all moving seats*
   (per-seat sweeps alias on periodic patrols). Output: `offAt(t)` linear
   interpolation + drift rate print.
2. **Position diff** — per remote frame vs nearest server sample at fitted
   time. `>1m`/`>5m` counts per seat + `--bytime` buckets. Under headless
   throttle this is capture-environment noise (render-state at a crawling
   clock), NOT gated — real interp truth needs a non-throttled capture.
3. **Event pairing** — normalized key per event:
   `targetType:targetId:eventType` (+`:w<damage>s<shooter>` on KILL lane,
   roster indices translated via player names; client `StateChanged` kills
   normalize to server `Destroyed`). Nearest-timestamp match within
   tolerance, two passes: strict `EV_TOL=0.75` then drift pass `tol=3`
   (piecewise fit residual grows ~0.1s/s off anchor).
4. **Verdicts** — `[missed]` = server sent, client never recorded (a drop);
   `[fabricated]` = client claims an event the server never sent.
   **Exit 1 iff `gated misses + kill-lane fabrications > 0`.**

## Gating semantics (what "counts")

A miss is gated only when ALL of these hold:
- `t >= cliStart` — the socket's registration instant sits in
  [connect, first frame]; earlier misses can't be proven undelivered.
- `t <= cliEnd + 1` — past the client's last stamped edge the capture had
  stopped; can't be a drop.
- `key` on `TARGETTYPE_KILL` (224) — pickup/deploy/flag edges carry
  legitimate asymmetries (rest-spot rebroadcasts, own-shot exclusion,
  baseline emissions) that are tape noise. Damage is the oracle.

Fabricated: only KILL-lane counts (hits/kills the client claims the
server never sent). Proj-lane and other client-only records are printed
but informational.

## Known asymmetries (not bugs)

- **Own-shot projectiles** — `projectileCreated` excludes the shooter, so
  the recording client's own shells are server-only by design → proj-lane
  is `gating=false`.
- **Heartbeat spawns** — client snapshot lanes re-emit `Spawned` as
  "still alive". Deduped by key+aux within a **3s window** — repeats
  past 3s are real edges (rest-spot resyncs, respawns) and must pair.
- **Flag baseline `Spawned`** — client emits one at join; server only
  emits state changes. Excluded from pairing.
- **Rest-spot resyncs** — a settled pickup rebroadcasts `pickupSpawn`
  (RoomPickups:182) — a position-update edge on the spawn lane; real
  edges, dedupe window must NOT eat them.
- **Hit pos divergence** — KILL-lane pos check is exempted: server
  credits at the rewound-ghost position (the `gd` mechanism), client
  records its interpolated view; >25m is legitimate.
- **Replay grace** — client events in the first `REPLAY_S=8s` of a
  capture pair by key regardless of Δt/pos (join backpressure stamps
  journaled events at dispatch time under starvation).

## Real bugs this system caught

1. `roomDemo` tapped only `broadcast` — `WIRE_HIT`/`WIRE_KILL` ride the
   binary lane → server demos missing ~95% of damage edges.
2. Client silently dropped binary hits/kills/projSpawns on unminted wids
   (join/gameState race) — the missing-damage class → `pendingWidEvents`.
3. `pickupGone`/`deployGone` wrote `pos(0,0,0)` — now reuses stored
   spawn pos (`posById`).
4. Unbounded heartbeat dedupe collapsed rest-spot resyncs — kept copy on
   each tape was a *different logical edge* → false missed+fabricated.
5. `srvWin` upper bound cut server twins that land past `tMax+off` →
   real pair read as missed+fabricated.
6. Pre/post-capture edges gating — boundary events can't be proven
   deliverable; now gated only inside `[cliStart, cliEnd+1]` on 224.

## Running it

```bat
bun _tools/e2e/demodiffSelftest.ts            :: synthetic gate (always green)
set E2E_GPU=1 && bun _tools/e2e/dualcheck.ts --secs=45   :: live wire test
bun _tools/demodiff.ts <cli.demo> <srv.demo> --bytime    :: manual pair diff
```

Success: `event truth: missed=N (gated=0) fabricated=M (kill-lane fabricated=0)`
— nonzero missed/fabricated counts are fine if ungated; `gated` and
`kill-lane fabricated` are the only numbers that must be zero.

## Limits / next levers

- posΔ is capture-environment-limited headless (elapsedTime crawl); for
  a hard posΔ gate need a headed/undistorted capture or server-time
  stamps on remote frames (format change).
- WireId reissue: queued-event misresolve window now 1.5s < quiet window;
  full fix would carry a roster epoch in binary frames.
- `demorender`/`sxs`/`vidcmp` remain the visual-parity gate (SSIM);
  demodiff is the state-truth gate — complementary oracles.
