# Netcode efficiency playbook — prior art → our plan

Researched 2026-10-31. Sources: Frohnmayer/Gift "The TRIBES Engine
Networking Model" (gamedevs.org PDF), Torque `onCameraScopeQuery` docs,
David Aldridge "I Shot You First: Networking the Gameplay of Halo:
Reach" (GDC), Epic Replication Graph docs + tech blog, Respawn's Apex
netcode deep-dive, PlanetSide 2 Higby/SOE interviews, Gaffer on Games
(snapshot compression / state sync / reading-writing packets).

Measured context is `_docs/2026-10-31_CAPACITY_KNEE.md` — every claim
here maps to that profile: ~370-seat knee, fanout 31ms of 40ms tick,
O(N²) interest loop, send 1/seat/tick at ~30µs, egress ~18.4MB/s at
368 seats with intro seats carrying ~300-record frames.

## Part 1 — what the old and new games actually do

### Tribes/Torque (1998-2001): the ancestor of everything here

Frohnmayer/Gift designed for 28.8kbps — a hard 2KB/s per-client budget
on dial-up, in a game where the client could see most of the map.

- **Ghost scoping**: each connection keeps a scope object answering
  "what's interesting to THIS client" (`onCameraScopeQuery`) — scene
  graph traversal from the camera, not a global list.
- **Priority within scope**: `getUpdatePriority` factors distance AND
  velocity perpendicular to the view vector (fast movers across your
  view update sooner — the same insight our spd>12 speed-tier uses).
- **Partial updates + ghost basis**: send only changed fields against
  a known basis; guaranteed-delivery for create/destroy edges,
  volatile for state. = eventual consistency: intermediate states may
  drop, convergence is guaranteed.
- **Move manager**: the control object is the ONE thing guaranteed
  latest-state + last-applied-move every packet; everything else is
  best-effort. Input reconciliation falls out of that pairing.
- **Multiple delivery classes**: 5 stream managers with different
  guarantees — events, ghosts, input, static data, strings. Different
  truth needs different lanes (our WIRE_BATCH vs reliable events vs
  UDP volatile is the same shape).

### Halo: Reach (2010, Aldridge GDC): priority-budgeted replication

Architecture: game → scrape → **prioritization** → replication → flow
control → transport.

- "There is always more data than will fit — so write high-priority
  data first." No hard entity cap: the packet is filled in priority
  order and the rest waits.
- Priority is per-object **per-client**: distance + direction +
  object size + speed, boosted by recent shooting/damage and special
  cases (thrown grenades).
- **Graceful degradation**: under bandwidth pressure, low-priority
  objects simply update slower; the sim never stalls. 2000+ synced
  entities in a 16-player match — the cap is a budget, not a count.
- The unreliable replication is on purpose: unreliability enables
  aggressive prioritization because nothing blocks on retransmit.

### Unreal Replication Graph (Fortnite, 2019+): precompute once, share

Built because 100 players × ~50,000 actors made per-actor×per-client
evaluation the bottleneck — **exactly our O(N²) problem**.

- **Nodes precompute and SHARE replication lists** across connections
  and across frames: a spatial-grid node buckets actors by cell; each
  connection gathers its lists from the same cached cell data instead
  of every actor testing every client every frame.
- **Dormancy**: actors that stop changing drop to flush/netdormant —
  they ship nothing until a channel event wakes them (our
  stopped-record zero-replication is the same idea at record level).
- **Net update frequency per class** — default 100Hz is "often much
  higher than needed"; tune down aggressively for ambient kinds.
- **Connection saturation cutoff**: when a connection's budget is
  spent, remaining actors just don't go (relevant >1s forces a look
  next frame — a liveness guarantee, not a send guarantee).

### Apex Legends (2019): the tickrate defense

- 20Hz is deliberate and defended in public: 60Hz saves ~2 client
  frames of latency for 3× the CPU AND bandwidth. Their math: tickrate
  ↑ multiplies BOTH sim and replication cost.
- Their real problem was never tickrate — it was **data volume per
  tick** (~1.1Mbit/s downstream, snapshot splitting into multiple
  packets). Lesson: send-rate and payload discipline beat tickrate.
- Snapshot model chosen for fidelity breadth — many global-relevance
  mechanics. We already pick the opposite (events + interest tiers).

### PlanetSide 2 (2012+): thousands by zoning + culling

- ~1200/continent, 3600-4800/server — the thousands-bar IS achievable
  on one box, but via **zone partitioning**, not one giant room.
- Client-visible culling: ~200 on screen; dynamic relevance slicing
  decides which of the 300 players around you get sent. "Unless you're
  in the biggest fights you don't notice popping" — relevance culls
  are perceptually invisible until the extreme case.
- Confirms our architecture instinct: many bounded rooms/zones per
  box, each cheap, beats one monolithic world.

### Gaffer (2013-2016): the compression floor

- **Schema once, data relative**: declare types/ranges at connect;
  rapid traffic references them. = our worldModel/wire declarations.
- **Quantize to bounds+resolution**, smallest-three quaternions;
  position i16 is already the right shape for our maps.
- **Delta vs acked baseline**: 1 bit "unchanged" per field is the big
  win; requires the receiver to ack snapshot seqs so the sender knows
  the decode basis. Our V4 masked records + staggered fulls = the
  same mechanism (staggered fulls = reseat baseline on loss).
- **Quantize BOTH sides when the sim feeds it back** — only needed if
  quantized state re-enters simulation (our prediction replays from
  journal, not from wire values — so this doesn't apply).
- Prefer more+frequent+smaller updates over big sparse ones —
  resilience under loss.

## Part 2 — parity table: what we already have

| Prior art | Ours | Status |
|---|---|---|
| Ghost scoping (interest mgmt) | distance tiers 150/400/600m + stopped suppression | ✓ but O(N²) CPU |
| Priority within scope | spd-tier + K=32 nearest cap | partial — count cap, no score |
| Delta vs basis | V4 masked records + 15-tick staggered fulls + intro fulls | ✓ |
| Event vs stream lanes | WIRE_BATCH tick + reliable JSON events + UDP volatile | ✓ |
| Dormancy | stopped-record zero-replication (far+static) | partial — records only |
| Fill-budget degradation | drop-safe tick frames + shed/sparse keepalive + drown drain | ✓ at socket level, not per-frame budget |
| Move-manager guarantee | inputSeq ack rides every tick frame | ✓ |
| Shared replication lists | — | ✗ THE gap (O(N²)) |
| Per-class update freq | records tiered; events immediate | ✓ |
| Schema-once wire | worldModel/wire decls, V4 format | ✓ |
| Grace reclaim | offset-cursor journal + replay | ✓ |
| Join-burst handling | intro gate + paced admit (4/tick) | ✓ but intro seats bypass record cap |

## Part 3 — the plan (ranked by measured value, correctness invariants)

### P0 — Shared spatial index for the interest loop (the O(N²) kill)

**What:** bucket players into a coarse grid once per tick (one
position read each), then per recipient only distance-test records in
the cells covering its engagement radius — Replication Graph's core
move at our scale.

**Why:** fanoutRecords does `dSq` per seat×record = N²/tick. At 368
seats that's 135k tests/tick, 31ms. A grid reduces per-recipient work
to its visible set (≈cap+margin) → O(N + seats×K).

**How (concrete):**
- `shared/` or `server_bun` helper: `cellOf(x,z)` with ~200m cells
  (largest tier boundary 600m → cells queried = radius 600m → ~3×3
  cell box for far, 1×1 for near... simpler: query cells covering
  max tier radius once per recipient, then dSq-filter inside).
- Rebuild the bucket map once per tick BEFORE the recipient loop —
  insert all records into `Map<cellKey, records[]>`; each recipient
  walks only the cells its own radius covers. Far-tier hysteresis
  already bounds how often a record's cell membership changes.
- tierMem stays as the per-recipient×record cache — now consulted
  only inside the recipient's cell window.

**Correctness invariant:** a record is only ever *omitted* by the
spatial filter if its true dSq exceeds the outer tier boundary —
which already means 2.5Hz-sparse-or-stopped, i.e. the grid can only
skip records the tier logic was already allowed to delay/cull.
Forced (knockback) and intro records stay exempt — they'd bypass the
grid entirely, same as today. The pending-admit gate already keeps
un-admitted seats out of frames regardless of spatial truth.

**Payoff estimate:** at 500 seats ~250k→~40k distance tests/tick
(~6×); at 1000 ~1M→~80k (~12×). The fanout phase stops being the
dominant term; sim becomes the next wall (sim:proj 5ms is already
visible).

### P1 — Priority-scored fill, not just K-nearest

**What:** upgrade the cap from pure nearest-32 to a Halo-style score:
`score = f(dist) + f(1/spd?) + boosts(combatant, recentHit, flag)`.

**Why:** nearest-32 is right 95% of the time but blind to the 5% that
matters: a far player who just shot you, the flag carrier crossing
mid, a fast mover arcing into view. Halo's special-case boosts exist
precisely because pure distance loses important edges.

**How:** candidate records already carry `r.spd` + pos + we know
recent combat (hit-window `r.force`, flag carrier status). Score each
candidate cheaply (no sort needed until over-cap — same quickselect
on score instead of dSq). Exemptions unchanged.

**Correctness invariant:** same as today — culled records are
dead-reckonable ghosts; hit/kill/flag truth rides reliable events.
Priority reorders *which* ghosts a client gets, never *what truth*.

### P2 — Intro seats join the cap (join-storm fix)

**What:** intro recipients currently bypass `MAX_RECORDS` entirely
(introFull → every record, every tick, full variant). Under join
churn at 368 seats avg frame measured 2.16KB vs capped ~450B.

**Fix:** intro seats get the same K-nearest candidate pool — their
exemption was about the *cadence* (full rate) and the *variant*
(fulls for decode basis), not about needing all 300 records at once.
`introFull` keeps forcing full variants for the K admitted records;
it stops forcing "everything". The paced admit gate already controls
roster admission timing — this aligns record delivery to it.

**Correctness invariant:** an intro seat's decode basis is built from
the records it DOES receive; a record it never received is simply an
entity it doesn't see yet — same contract as any tier-culled record,
and the admit gate makes absence an explicit lifecycle state.

### P3 — Per-connection egress budget (Halo flow control)

**What:** measure `getBufferedAmount` growth per client and degrade
their *content* not just their cadence — a drowning client currently
gets the same frame as a healthy one until the shed cap. Halo's
answer: fill the packet by priority until budget spent, rest waits.

**How:** we already read buffered per-conn. Add a per-conn byte
budget per tick (e.g. 4KB): fill `others` by priority until budget —
records beyond it wait for next tick. Replaces nothing; sits on top
of the cap.

**Correctness invariant:** identical to the shed lane's contract —
drop-safe volatile frames degrade, reliable truth unaffected. The
intro gate's held-until-drained behavior already proves clients
tolerate record starvation without desync.

### P4 — Zone/room sharding at box level (Planetside pattern)

**What:** thousands-per-box = many bounded rooms on worker processes
(already built: matchmaker + fleet + /join routing). The spatial
index raises each process's room ceiling; the fleet multiplies it.

**Note:** this is the proven path — 24 cores, per-process ~350-500
after P0. "One room of thousands" is NOT the goal — no successful
game does it; even PlanetSide partitions by continent.

## What NOT to copy

- **Higher tickrate** — Apex's math applies: 20Hz→60Hz buys ~2 frames
  for 3× CPU+egress. Our tick is already ~2ms at load-out; spend the
  budget on seats, not Hz.
- **Smallest-three/cubemap normals** — positions are already i16-
  quantized; rotations fit u8. The next compression byte isn't worth
  the decode divergence risk.
- **Quantize-both-sides** — only matters when quantized values feed
  back into the sim (Gaffer's state-sync rule). Our prediction
  replays the move journal, not wire values. Skip.
- **Vision/FOV culling** — Halo/PS2 do it because they accept pop-in.
  Our rule is provably-safe skips; an unseen-but-shooting player is a
  correctness violation, not a cull candidate. Distance culling only.
- **Reliable-ordered everything** — the reason events+records split
  lanes. Keep volatile volatile.

## The one-line summary

Every successful large-player game does the same three things:
**precompute interest once and share it (Replication Graph)**, fill
packets by per-client priority until budget spent (Halo), and bound
the problem by zoning (PlanetSide/Fortnite). We already have the
delta encoding, the lanes, the suppressions, and the cap — what's
missing is exactly the middle piece of that triad at scale.
