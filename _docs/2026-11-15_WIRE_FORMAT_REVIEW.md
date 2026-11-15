# Wire-format review — JSON vs binary, and whether protobuf is worth it

**Status:** analysis only — no wire change is committed or planned.
**Question asked:** how much of our traffic is JSON vs binary, and what
would switching the JSON lane to protobuf buy us?

## TL;DR

- Steady-state in a populated room: **~85–95% of bytes are already
  binary** (estimate — see measurement caveat below). JSON carries
  control + edge messages only.
- Protobuf compresses a JSON message **~3–5×**, but that lane is
  5–30% of traffic → **~5–15% total bandwidth saved**, concentrated in
  the join burst, not steady state.
- Pro games do **not** use protobuf on the gameplay lane. They use
  hand-rolled bit-packed binary + delta snapshots — which is what we
  already do. Protobuf lives in their *services* layer (matchmaking,
  inventory, chat).
- **Recommendation: don't.** If the join `gameState` burst ever hurts,
  gzip it — ~5–10× compression for ~10 lines, no schema pipeline.
  Cheapest structured-binary alternative if we ever want one:
  MessagePack (drop-in, ~30% smaller, no codegen).

## Current wire structure

Sources: `client/src/networking/wireIn.ts` (`msgSeen` tallies),
`netWorker.ts`, `server_bun/src/UdpLane.ts`, Alt+Q dumps from live
`igunffa-1` sessions (2026-11-14).

**Binary lane (continuous, per-tick):**

- Player positions / movement rows
- Projectile positions
- `inputSync`
- Sent at the 20 Hz tick cadence; small per frame, never stops.

**JSON/text lane (edges + control):**

- `gameState` — the big one: full map spec (terrain path, spawns, fog,
  preset, mode) + roster. Tens of KB once per join/reseat.
- `intel`, `mapUpdate`, `ballRoster`, `crawlRoster`, `weaponUpdate`,
  `gunRung`, `wireIds`, `playerKill`, `matchNotice`, `playerRespawn`,
  `playerStale`, `playerHit`, `stateHash`, `ping`, `srvPing`.

**Sample — 19 s solo session on `igunffa-1` (Alt+Q `msgSeen`):**

```
ping:37  srvPing:37  stateHash:9  intel:48
gameState:2  mapUpdate:3  ballRoster:3  crawlRoster:3  weaponUpdate:3
gunRung:3  wireIds:1  playerKill:2  matchNotice:2  playerRespawn:2
playerStale:2  playerHit:2  inputSync:1
```

Counts are frequent-but-tiny; the two `gameState` frames outweigh
everything else on the JSON side combined.

## Measurement status — why this is an estimate

Three measurement attempts failed for structural reasons:

1. **CDP `Network` domain** — the game socket doesn't appear. Traffic
   lives in a Web Worker (`netWorker.ts`); page-target CDP only sees
   main-thread sockets.
2. **Main-thread `WebSocket` monkey-patch** — captured only the
   lobby/control socket (3 frames, all JSON). Same reason.
3. Worker-attached CDP wasn't completed; WebTransport datagrams aren't
   exposed to JS-level sniffing at all.

**To get real numbers** (~15 lines): add per-frame byte counters inside
`netWorker.ts` keyed on `typeof data === 'string'` (ws) plus the WT
reader path, flushed into the Alt+Q dump as `net: json X KB / bin Y KB`.
Server-side equivalent: per-lane counters in the WS/WT send paths.

## Byte-share estimate

| Room state | Binary share | Why |
|---|---|---|
| Empty/near-empty room | **~50–70%** | Binary lane shrinks to near-idle; JSON control traffic (pings, intel, stateHash) is constant. `gameState` re-joins tip it further. |
| Active FFA (8–16 players) | **~85–95%** | Player+projectile rows dominate; JSON edges are sparse by comparison. |
| Whole session incl. join | intermediate | Join burst is JSON-heavy; it amortizes away over minutes. |

These are estimates from message inventory + wire design, not wire
measurements — flag accordingly if cited.

## What protobuf would buy

Applied to the JSON lane only (the binary lane is already smaller than
protobuf would make it — hand-rolled with known field widths):

- **Encoding density**: field tags + varints vs repeated key strings +
  text digits → typically 3–5× on our message shapes.
- **Total impact**: 3–5× on 5–30% of traffic ≈ **5–15% total bytes**,
  weighted toward connect-time (the `gameState` burst is the single
  largest JSON expense).
- **CPU**: roughly a wash to slightly worse — JSON.parse in browsers is
  extremely optimized; protobuf adds a decode step either way.
- **Costs**: `.proto` schema + codegen in both builds, client/server
  versioned in lockstep, wire debugging goes opaque (Alt+Q's `msgSeen`
  tally and devtools frame reads are free *because* it's text).

## What pro games actually do (researched)

- **Quake III / Source / Overwatch lineage**: hand-rolled bit-packed
  binary, per-field quantization, **delta snapshots** — send only what
  changed since the client's last ack'd state. This is the design our
  binary lane already follows (fabiansanglard.net Quake3 review;
  Gaffer on Games "Reading and Writing Packets").
- **Turbine (Liquid Labs)**: 128-player sims in production on a custom
  binary codec — **38 B/player/frame**, changed-rows only, keyframes +
  freshness markers. No text serialization anywhere in the hot path.
- **Protobuf's actual home**: services layer — matchmaking, parties,
  inventory, chat, telemetry. Colyseus/Nakama-class frameworks expose
  protobuf/JSON for *room management*, not per-tick state.
- **FlatBuffers/MessagePack**: the pragmatic middle — MessagePack is a
  drop-in JSON replacement (~30% smaller, faster to parse, no schema);
  FlatBuffers is zero-copy but brings codegen like protobuf.

## Recommendation — ranked by value per effort

1. **Do nothing.** At 32-player scale the bandwidth is already trivial;
   correctness and latency are the constraints, not bytes.
2. **If join-time `gameState` ever hurts** (slow connect, mobile):
   gzip/brotli the JSON — ~5–10× for ~10 lines, no schema.
3. **If we want structured binary without hand-rolling** new message
   types: MessagePack — drop-in, keeps dynamic shapes, no codegen.
4. **Full protobuf**: only if we scale to hundreds of players or want
   typed contracts across a growing cross-service API. The schema
   rigor is the real feature; the byte savings here are noise.

## Related

- `_docs/2026-10-26_TRANSPORT_TIERS.md` — WS→WT transport decision
- Alt+Q `msgSeen` + `net:` lines — the existing free observability
