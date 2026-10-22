# Tribes 1/2 Networking Model vs KRIBES — 2026-10-01

Source: Frohnmayer & Gift, "The TRIBES Engine Networking Model" (GDC 2000),
plus Torque/T2-era notes (OpenTNL history, NetConnection docs).

## What Tribes actually did (the core)

1. **Four delivery classes** — data is classified by requirement:
   non-guaranteed (never resent), guaranteed-ordered (resent, in order),
   most-recent-state (volatile, only latest matters), guaranteed-quickest
   (out of band, fastest path).
2. **Notify protocol** — the connection layer ACKs every packet but
   *never retransmits*. The ACK only tells the stream manager "delivered"
   or "dropped" so the app layer decides what to resend (and usually
   resends only what is still relevant — a dropped position update is
   superseded by the next one anyway).
3. **Sliding window + client-declared bandwidth** — each client tells the
   server its rate + packet size budget (a 28.8k modem asked for
   10 pps x 200 B). Server caps per-client bandwidth on its own quality.
4. **Bitstream packing** — every field written at bit granularity
   (bools 1 bit, bounded ints, normalized floats, Huffman strings).
   3 bytes/packet of protocol overhead total.
5. **Move manager** — client input moves are the unreliable stream;
   the server replays them. T2 added *periodic control-object state
   updates* (server drifts the client's authoritative state in alongside
   inputs) and checksums on client state to catch divergence.
6. **Ghost manager** — object scoping (only ghost what the client can
   see), partial state updates, most-recent-state semantics for volatile
   fields.

## How KRIBES maps (as of b00cd49)

| Tribes mechanism | Ours | Verdict |
|---|---|---|
| Non-guaranteed movement state | binary `tickFrame`/`ballSegment` on the WS/WT/RTC lane | matches |
| Guaranteed-ordered events | JSON lane (chat, joins, flags, kills) | matches |
| Most-recent-state volatile | binary lane supersedes itself; probes confirmed | matches |
| Input moves unreliable, server replays | `inputMove` seq journal + MoveSim shadow per player | matches — we even fixed stale-seq replay anchoring |
| Periodic authoritative state during prediction | corrections + `correctionGraceUntil` drain window | matches T2's control-object updates |
| Client state checksum | shared FNV-1a `stateHash` both ends (post-fix) | matches T2's checksum pass |
| Per-client bandwidth declaration | **not present** — we send full-rate ticks to everyone | gap (modem-era concern; still useful for cheap hosting) |
| Bit-level packing | partial — binary frames are byte-aligned structs, not bit-packed | gap (ours is fine for broadband; bit-packing is a ~3x win if hosting matters) |
| Notify/no-retransmit discipline | TCP JSON lane can't avoid retransmit/head-of-line; datagram tiers (WT/RTC) exist | mostly fine — the hot lane is already on unreliable transports |
| Ghost scoping / interest management | full roster broadcast, no spatial culling | gap — cheap win when player count grows |

## Verdict

**Core is sound.** The three load-bearing ideas — unreliable state vs
guaranteed events, input-stream + shadow-sim convergence, and
most-recent-state semantics — are all implemented and soak-verified.
We did them the hard way (per-seq journal, resync epochs, anchored
replay) which is *more* sophisticated than T1 had, not less.

## What we'd change if bandwidth/scale becomes the priority

1. **Per-client tick budget** — the only Tribes feature with real modern
   value: let slow clients declare a rate and gate their tick payload.
   Currently every connection gets full-rate frames; a spectator on a
   phone pays the same as a desktop player.
2. **Spatial scoping** (ghost manager lite): skip per-tick position sends
   for players >300m away when the roster is large. Biggest single
   bandwidth lever; trivial on our side since ticks are already per-entity.
3. **Bit packing** — only if self-hosting cost starts to matter. Our
   binary structs are byte-aligned; bit-packing yaw/pitch/positions is
   mechanical but buys ~3x.
4. **NOT worth adopting**: sliding-window ACK machinery (TCP already does
   this), polymorphic persist managers (our protocol is a tagged union),
   Huffman strings (chat volume is trivial).

Conclusion: nothing ineffective or overly complex found. The divergent
places are scale-oriented (bandwidth, culling) — the same direction
Tribes went in T2, and the same order we'd want to invest in.
