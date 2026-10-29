# Join latency autopsy — 2026-10-29

**Question:** why did production herds show connect→first-gameState p95
of 13–17s (max ~60s) and ~1.1 seats/s admission?

**Answer: not compute.** Phase-level instrumentation on the live fleet
splits first-gameState into `wait` (ws-upgrade → join handshake
dispatched), `work` (seat + roster + gameState serialize + send), and
`drain` (register → outbox under the 32 KB intro floor + tick frames
flowing). Every measured sample says the server side is trivial and the
tail is WAN delivery, amplified by the herd's single-link concentration.

## Instrumentation (commit `45202213`)

- `/metrics.joinMs`: `waitAvg/Max`, `workAvg/Max`, `n`
  (`SessionManager.handle` stamps wait from `ws.data.connectedAt` at
  upgrade; `SessionManager.seat` times `messages.handleHandshake`)
- Per-room `health.introDrain{Sum,N,Max}` (`ConnectionManager.onIntroDrained`
  fires when `tickDrained` opens — wired in `Room.ts`, rolled up as
  `introDrainAvg` in `rooms[].health`)
- Probe scripts: `_tools/_joinlat.ts` (local loaded-join diff),
  `_tools/_joinsamp.ts` (2s per-worker fleet scrape → `_joinsamp.jsonl`),
  `_tools/_wirerate.ts` (egress rate via /wire diff),
  `_tools/_roomhealth.ts`, `_tools/_netdiag.sh` (box NIC/CPU snapshot),
  `tools/netbot/wideSoak.ts` for all herd shapes.

## Measurements

### Loopback, saturated-ish (own box, `_joinlat.ts`)

| Seats | join wait (delta) | work | introDrain |
|---|---|---|---|
| 424 | ~1ms | 0.1ms | 22–41ms avg, ≤60ms max |
| ~590 (past the ~546 ccu/core ceiling) | ~38ms | 0.1ms | 24–43ms avg, ≤62ms max |

Server-side join cost stays ~1ms even past the nominal core ceiling.

### Production, 3 workers × ~600 bots (`_ph0/1/2.log`, `_joinsamp.jsonl`)

Bot-side (wideSoak): 595/600, 596/600, 592/600 seated; join phase
~800–865s; first-gameState **p50 265–315ms, p95 4.0–5.3s, max 22–62s**.

Server-side at the same window:

- `work` **0.4–0.5ms** (avg), 4ms max — seat cost trivial on N1 too.
- `wait` avg ~365–393ms (mostly the handshake's own WAN RTT + inbound
  queue), max 8.5–13.3s during the burst.
- `drain` steady-state ~30–50ms; during the congestion window **avg
  ~800ms, max 244,932ms** on w0.
- **ELD p99 ~20–70ms** — the loop was healthy the entire run
  (post `714a4458` volatile-batch + 10Hz pickup pass).
- Box-side (`_netdiag.sh`): NIC tx ~5MB/s aggregate, three `bun` procs
  ~34–37% CPU each, Caddy ~1.2% — nothing saturated.
- Egress `_wirerate.ts`: 1.0–1.6MB/s per worker at ~410 conns.
- Player count fell 961→~500 mid-run then stabilized ~180–215/worker.

### Mechanism

~1800 bot sockets all terminate at one laptop. The shared link cannot
deliver per-socket bursts at the rate 1200+ concurrent TCPs need —
per-socket throughput starves (classic many-flows fairness), outboxes
sit above the 32KB intro floor for minutes, sockets near the 4MB/5s
drown cap or the 15s `joinTimeoutMs` pre-seat bound die, and their
reconnects re-fire join bursts — a delivery-bound feedback spiral. The
older 13–17s p95 (2-vCPU era) was the same wall behind a CPU-saturated
lens; with compute fixed, the delivery wall is what remains.

### What the herd can and cannot say

The herd **overstates** real-user join latency: real clients each own
their pipe, so per-user join ≈ RTT + ~1ms work + small burst flush —
sub-second while aggregate egress has headroom (~5MB/s used, NIC is
Gbps). What the herd does prove: admission is healthy at ~600/worker on
4 OCPUs, and the seat work itself will never be the limit.

## Close attribution — RESOLVED (832f8906 + 73b4ce6c live)

Second herd (~400/worker, `_qh0/1/2.log`, `_closecodes.ts`):
~250-267 × **close code 1005** per worker — deaths with *no close
frame*, i.e. TCP-level kill. Zero `1011` drowns, `closesUnseated` 0,
drains ~38ms, ELD ~50ms. Bot-side: `closed=19-27/34` concentrated in
the earliest-joined rooms — a point-in-time mass kill; post-event
joins survived. Same rooms show hundreds of `fire rate flood` rejects
(the post-stall queued-input burst). **The ~460-seat drop was a
transient outage on the client-side WAN path** — every herd socket
shares one laptop link, so a stall kills them all at once and backs up
every outbox server-side. The server never blinked (work ~0.4ms).
Local-path flakiness was observed directly throughout the run (fetch
timeouts, crashed fleet launches).
2. **Herd methodology:** single-link fleets cannot measure per-user join
   latency past ~300 seats/worker, and cannot measure server resilience
   to WAN death — a local stall mass-kills ~40% of sockets identically
   (1005). Split-source (two client sites) or per-bot link shaping is
   required for both questions.
3. **Fleet cap enforcement** is matchmaker-only; direct `/wN/ws` joins
   bypass `FPS_FLEET_MAX_PLAYERS`. Per-worker `globalMaxPlayers` is the
   only backstop.
4. `maxPlayers` fixed 73b4ce6c: worker reports `globalMaxPlayers`,
   fleet reports the enforced `FPS_FLEET_MAX_PLAYERS` (1000 live).
5. `joinTimeoutMs` (15s) is the correct bound — it is also what capped
   seating at ~595/600 during the storm; do not raise it, it caught the
   spiral.
