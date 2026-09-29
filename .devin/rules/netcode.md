---
trigger: glob
globs:
  - shared/**
  - server_bun/src/**
  - client/src/net/**
---

# Netcode rules

- The server owns every interactive outcome. Clients send claims and
  intents; anything a client computes is prediction until the server
  answers. Interactive-but-client-only is decor (`ambient`) or a bug.
- Non-player objects never stream positions. Broadcast state EDGES
  (spawn/retarget/land/bite/die) + a committed snapshot; both ends run the
  same shared sim to fill the gaps. New entity kinds extend this pattern,
  never bypass it.
- Committed snapshots are authoritative for sims: they steer at `tp`, not
  the live position. Anything the client can't predict must become a
  committed event — a target pick, flee, special attack — not a stream.
- Distance-tiered sends and staggered AI buckets are established patterns:
  near players get every edge, far players get periodic resync beats; AI
  decisions spread across BRAIN_BUCKETS phases so no single frame spikes.
- Bandwidth lives in the event shape: discrete state changes only, a few
  bytes each, only when they happen. Flag positions while carried are not
  streamed — clients pin them to the carrier's rendered position.
