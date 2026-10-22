# Spectator relay / OBS-server pattern — reference

Researched 2026-10-22. Sources: HLTV/GOTV architecture (Valve),
"Broadcasting Virtual Games in the Internet" (Slipgate/HLTV design paper),
deadlock-api/hltv-relay (Source 2 HTTP-push variant),
MSR "Supporting Spectators in Online Multiplayer Games" (HotNets '04),
Source engine hltvserver.cpp (dispatch logic).

## The pattern

A game server cannot fan out a live match to thousands of spectators —
every spectator seat costs an outbound stream. The relay pattern inserts
a *privileged observer process* between the server and the watchers:

```
game server ── 1 privileged seat ──> OBS master proxy ──> N spectators
                                        │
                                        └──> relay proxies ──> N×128 more
```

- **Master proxy / GOTV master**: one client connection that receives the
  *full* world state — no visibility culling (HLTV's exception to PVS).
  The game server's cost is literally one player slot; the HLTV design
  goal was "server virtually unaffected".
- **Relay proxies**: connect to master (or each other) and re-broadcast —
  a tree. Each Source node serves ~128-255 clients; chaining gives
  effectively unbounded capacity (~24s added latency per tier).
- **Dispatch**: new spectators connect to the master; it redirects to the
  least-loaded relay by clients/slots ratio (`DISPATCH_MODE_AUTO` keeps
  ~25% bonus on the direct seat).
- **Source 2 modernized it**: the game server *pushes* broadcast fragments
  over HTTP POST (`tv_broadcast_url`) to a relay service that caches and
  serves any number of consumers — fully decouples producer from consumers,
  no spectator load reaches the server at all.

## Design elements that matter

1. **Signon vs game stream.** A late joiner needs a full-state snapshot
   before deltas decode. HLTV's multicast design ran two groups: signon
   state resent every few seconds until the client syncs, then it joins
   the game-data group. Same split applies unicast: snapshot + edges.
2. **Delay buffer.** `tv_delay 30-90s` — the master buffers the stream
   before rebroadcasting. Purpose is *anti-cheat*: a spectator can't
   ghost-call live positions. Side effects: the buffer IS the demo
   recorder (`tv_autorecord` writes it to disk), and a second shorter
   channel (`tv_delay1`) serves interactive casters a ~3s feed while the
   public feed stays deep.
3. **Delta compression.** Game state is stored/sent as diffs against the
   last mutually-known state — HLTV got ~2MB/min per match. Unreliable
   transport needs periodic keyframes (or FEC) or a lost packet wedges
   the decoder.
4. **Entity-level reliability split.** Spectators aren't A/V: entity
   create/destroy must be reliable (persistent world), but position
   updates can be lossy — client extrapolation masks drops. Per-entity
   priority beats per-layer codec tricks.
5. **Camera at the client, not the stream.** The broadcast carries world
   state; each viewer's POV/follow choice is rendered locally. Per-viewer
   "POV streams" would multiply bandwidth for nothing — you get every
   camera angle for free.

## Mapping to KRIBES

- The `?watch` direct seat is the small-scale version — each spectator
  costs one broadcast fanout on the room server. Fine at ~tens of viewers
  per room.
- Our wire shape is already relay-shaped: **edges + committed snapshots,
  both ends replay the same sim**. A relay needs almost no protocol
  knowledge — buffer the room's edge stream and replay it; late joiners
  get last committed snapshot + buffered edges since. No per-entity
  parsing required.
- Snapshot resync already exists for the reconnect path — same mechanism
  serves "joined 40s late".
- `DemoRecorder`/`.rec` playback is the same object as the delay buffer:
  record the stream, replay it N seconds late. Broadcast delay falls out
  of the existing machinery.
- Placement options: (a) in-process observer in `server_bun` — one fake
  client per room receiving unculled state then fanning out; cheap to
  build, adds fanout cost to the match process. (b) out-of-process Bun
  relay the game server *pushes* to (Source 2 style) — a `room_push` URL
  config; server load stays at one connection regardless of watcher count.
  (b) is the HLTV "server unaffected" property and the one that scales.
- Delay: casual rooms can run ~5-10s (stops ghost calls, keeps it feel-
  live); ranked events want 30s+ — make it a room/push option.
- Mobile/watch UI consumes the same stream — the relay answers
  `?watch=<room>` with snapshot+edges exactly like a normal client, plus
  a spectator flag so no player slot is consumed.

## Gotchas

- Lossy broadcast on a stateful world: entity create/destroy edges need
  reliable delivery (our WS is reliable; over WT datagram lanes it isn't —
  spectator feeds should ride the reliable lane or add seq-gap → resnapshot).
- A relay that replays packets must respect any per-client fields — room
  broadcast is recipient-agnostic here, but anything personalized
  (yourHealth, claims) must be filtered or spectators see private state.
- Tree depth costs latency: ~24s/tier in Source. Keep it 2 tiers max for
  a "live" feel; delay budget = relay latency + configured delay.
