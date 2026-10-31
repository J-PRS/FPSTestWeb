# OCI capacity investigation — where the 4-core box actually saturates

**Date:** 2026-10-31. **Status:** measured, production-verified.
**Builds deployed:** `78c360f0`, then `34cf59f5` (adds `rxCost` ingress
timing to `/metrics`).

## TL;DR

At ~340 seats/worker (~1k fleet-wide) the workers' main JS thread is
only **~50% busy**, GC is ~2%, heap ~45-76MB. The box saturates at
**4.1 cores of demand on a ~3.4-core box** — and the top process is
**Caddy at ~87.5% CPU** doing Go TLS termination for ~1k wss
connections. Kernel networking costs another ~1.4 cores (`sy` 33.3% +
`si` 17.4%), and the free-tier A1 loses **14.5% steal** to the
hypervisor. The event-loop delay that looked like a Bun problem is
socket events queueing behind an oversubscribed box — not tick work.

**Max CCU on this box today: ~1000** (the enforced fleet cap is the
correct number). The cheap lift: terminate TLS inside the Bun workers
(uWS native SSL) and drop the Caddy hop for game paths — plausibly
~1.3-1.5k.

## How we got there

### 1. Local dense-room work (dev box, 24 cores)

`_tools/profload.ts --bots 500 --rooms prof1` — one room, combat
density. Committed over the session:

| change | commit | measured effect at ~370-400 seats |
|---|---|---|
| Spatial index + staggered far emit + intro cap + cone scoring + DR-model suppression | `ac14d053` | fanout 31→29ms (~5%, within variance — cluster density means most records are relevant) |
| Lazy tier eval (off-tick candidates skip tier machinery) | `764e7a73` | flat at combat density; pays on tier-mixed rosters |
| Ordered cells + cutoff-bounded eval; `CONE_BOOST` 0.04→0.16 | `a1e7a33b` | ~8% scan cut (2.36M→2.17M scans/s) |
| wireId-keyed tierMem (numeric vs pid-string hash) | `2c44fdaa` | scan 16.2→13.9ms |
| drown-gate buffered sampling every 4th flush | `2c44fdaa` | below noise |
| admitPending.size hoist | `2c44fdaa` | below noise |

**Dense-room decomposition** (`/metrics` rollups, `scanNs`/`frameNs`
sub-timers): scan ~14ms + `ws.send` flush ~9.5ms + frame ~1.5ms +
prologue ~5ms ≈ ~30ms fanout at ~380 seats. Per-candidate eval is
~120ns and most candidates legitimately can win the 32-record cap —
the workload's own worst case.

### 2. Deploy + production herd (OCI, 4 cores)

`bash _tools/deploy_server.sh` (Git Bash; `FPS_DEPLOY_HOST`/`FPS_SSH_KEY`)
— `78c360f0` live on all 3 workers, `34cf59f5` after the rxCost commit.

`bun tools/netbot/wideSoak.ts --url wss://play.jprice.app/wN/ws
--rooms 12|16 --bots 28 --pace 250-800 --key <admin>` — multi-room
WAN workload (very different from the dense-room local test).

**Multi-room profile at ~340/worker** (`_scratch/_fleetrun.ts`
sampler — 5s polls of `/w*/metrics`):

- tick avg ~2-4ms — tick work is trivial at 28-seat rooms
- sends ~5.4k/s at ~30µs/call (ARM send cost ≈ x64 dev box's)
- ingress ~7.6k msgs/s at **~13µs/call** (new `rxCost` meter)
- ELD p50 **~30-40ms**, p99 ~100-140ms
- fill: ~335/336 seated (the earlier ~25% join loss did NOT repeat
  on these runs)

### 3. Thread-level attribution (`threadCpu` deltas on `/metrics`)

At ~340/worker steady state:

| thread | busy |
|---|---|
| `bun` main (JS+syscall) | ~45-57% |
| `JITWorker` | ~2-8% |
| `HeapHelper` | ~2% |
| `mi-scavenger` | ~1% |
| `Bun Pool` | ~0% |

Main thread half-idle while ELD p50 is 30-40ms → waiting, not
computing. Not GC (2%), not JS.

### 4. Box-level attribution (`top` via SSH)

```
%Cpu(s): 31.9 us, 33.3 sy, 1.4 id, 17.4 si, 14.5 st
load average: 10.73
caddy 87.5% · bun 75/56/44%
```

| slice | cores | what |
|---|---|---|
| `us` 31.9% | ~1.3 | 3 workers' JS (matches ~50% threadCpu) |
| `sy` 33.3% | ~1.3 | kernel: send syscalls + TLS copies + routing |
| `si` 17.4% | ~0.7 | softirq — packet processing, 1k sockets of small frames |
| `st` 14.5% | ~0.6 | hypervisor steal — free-tier tax, ~85% of nominal CPU |
| `caddy` | ~0.9 | **Go TLS termination for ~1k wss conns — top process** |

Demand ≈ 4.1 cores vs ~3.4 usable → saturated → ELD delay.

## The ELD mystery, resolved

The 30-40ms loop delay is **event-dispatch queueing on a saturated
box**, not any single hot path:

- socket IO events queue behind each ~10-20ms JS iteration
- kernel+softirq+steal eat another ~1.3 cores outside all JS
- Caddy alone burns ~0.9 core proxying/terminating every game frame

Every measured JS slice is lean at this load: tick ~3ms, ingress
~13µs/call, send ~32µs/call, GC ~2%.

## What this means for capacity

**Today: ~1000 CCU** on the A1 — the 1000 fleet cap is the correct
shipping number. Mechanical headroom past it exists only if the
non-JS costs shrink:

1. **TLS inside Bun workers** (`Bun.serve({tls})`, uWS native SSL —
   much cheaper per byte than Go TLS, and kills the proxy hop +
   its syscalls). Frees ~0.9 Caddy core + kernel copy/hop → est.
   ~1.3-1.5k. The single biggest honest lever found this session.
2. **Bigger/fewer frames** — softirq tracks packet count, not bytes;
   larger writes amortize it (already 1 send/seat/tick — the frame
   itself is the lever now).
3. **Steal 14.5%** — fixed cost of the free tier; can't fix on this box.

Things ruled out: more JS-side netcode micro-opts (the tick is already
under 10% of box CPU), GC tuning (2%), sharding differently (workers
are already spread; the shared kernel/steal budget is the bound).

## Provenance

- Local: `bun _tools/profload.ts --bots 500 --rooms prof1 --secs 40`
  (`FPS_MAX_PLAYERS=500 FPS_GLOBAL_MAX_PLAYERS=2000`)
- Production herd: `bun tools/netbot/wideSoak.ts --url
  wss://play.jprice.app/wN/ws --rooms 12 --bots 28 --pace 250-800
  --key <FPS_ADMIN_TOKEN>`
- Sampler: `_scratch/_fleetrun.ts` (spawns herds + polls `/w*/metrics`
  every 5s: ELD, threadCpu deltas, heap, rx/send costs)
- Box: `ssh opc@92.5.61.55 'top -b -n 2 -d 2'` — key
  `~/.ssh/oci_anabatic`
- Deploy: `bash _tools/deploy_server.sh` via Git Bash with
  `FPS_DEPLOY_HOST=opc@92.5.61.55` (Windows cmd mangles inline bash
  quotes — drive it from `.sh`+`.bat` files in `_scratch/`)

## Open threads

- ~25% join-loss on local profload runs (did not reproduce on prod
  this session — may be a local-socket artifact, worth one clean
  local repro before calling it fixed)
- `aoe-refuse` flood (~67k refused claims/50s in dense runs — bot
  driver fires at 300-1200m targets; claim-path CPU + log spam)
- drain-deploys (research doc only — deploys still hard-restart)
- Bun-TLS experiment for the ~1.3-1.5k box
