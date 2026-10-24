# CCU resource breakdown — single-process soak

Measured with `_tools/profload.ts` on one Bun server process (WS tier, no
WebTransport/RTC) on the dev box (24 logical cores). All runs 40 s
measurement after 45–60 s settle, `FPS_GLOBAL_MAX_PLAYERS` raised as needed.

## Ladder (single process)

| Players | Rooms | CPU % | Tick avg (ms) | Tick max (ms) | Dropped | Held | CCU/core |
|---|---|---|---|---|---|---|---|
| 32 | 2 | 25.1 | 0.78 | 5 | 0 | 0 | 127 |
| 64 | 2 | 32.8 | 1.32 | 5 | 0 | 0 | 195 |
| 128 | 4 | 48.1 | 2.39 | 10 | 0 | 0 | 266 |
| 256 | 8 | 49.1 | 1.78 | 7 | 0 | 0 | 260 |
| 512 | 16 | 77.0 | 2.01 | 14 | 0 | 0 | 332 |
| 1024 | 32 | 123.2 | 2.71 | 10 | 0 | 0 | 831 |

## Full resource breakdown — 1024 players

| Resource | Value |
|---|---|
| CPU | 123.2 % (~1.23 cores) |
| Tick time | 2.71 ms avg / 10 ms max |
| Memory (RSS) | 356 MB |
| Heap used / total | 175 MB / 162 MB |
| Ingress (client→server) | 54.7 MB / 40 s = 11.5 Mbps |
| Egress (server→client) | 1 978.5 MB / 40 s ≈ 415 Mbps |
| Messages in | 1 389 544 |
| Messages rejected | 0 |
| Dropped ticks | 0 |
| Held ticks | 0 |
| Event-loop delay (p50/p99/max) | 107.7 / 139.2 / 144.8 ms |
| Ticks dropped (lifetime) | 423 |

## Conclusions

- **Single-process ceiling ≈ 1024 CCU** on this box: CPU crosses one core
  and event-loop delay hits ~100 ms, even though sim tick time stays low.
- **Egress is the binding constraint**: ~415 Mbps for 1k players. A 1 Gbps
  VPS can run only ~2 such processes before saturating the NIC, regardless
  of the 24 cores available.
- **Memory is cheap**: 356 MB for 1k players → ~8.5 GB for 24 processes.
- The simulation itself is not the bottleneck; fanout/network is.

## Implications for "thousands on one VPS"

- ~2k CCU per 1 Gbps box (2 processes), not tens of thousands.
- To scale further: bigger pipe, edge distribution, or reduce per-client
  fanout (distance-tiered sends, delta compression, spectator culling).