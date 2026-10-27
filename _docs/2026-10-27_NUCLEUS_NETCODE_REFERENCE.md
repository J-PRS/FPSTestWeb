# Nucleus Networking — feature-set reference (and Fish-Net lineage)

Date: 2026-10-27.
Sources: nucleus-networking.com marketing pages + the public docs repo
`FirstGearGames/Nucleus-Networking-Docs` (`content/v1/**/*.md`, ~150 pages)
+ fish-networking.gitbook.io. Read for comparison against our own stack —
nothing in this doc changes behavior.

## 1. What it is

Nucleus is the next framework from FirstGearGames, the team behind
**Fish-Net** — the free Unity netcode stack a generation of Unity
multiplayer shipped on (Mirror's main successor: SyncTypes, observer/AOI
system, tick-based prediction, scene management, no CCU caps or paywalls).

Nucleus keeps the instincts but drops the engine: C#, `netstandard2.1`,
no Unity required — Unity/Godot/Flax/bare-server all run the same
`CoreManager`. Roslyn source generation instead of runtime reflection;
transports are pluggable (Synapse for UDP, Yak for offline tests, or
bring-your-own). Launch flags configure deployments.

Editions: **Free** and **Pro**. The split matters when evaluating the
feature list — several of the headline features are Pro-only:

| Feature | Edition |
|---|---|
| Controller-only member writes | Free |
| Multi-writer objects + arbitration | Pro |
| Spawn pacing | Pro |
| Interest level-of-detail (LOD bands) | Pro |
| Lag compensation (rewind) | Pro |
| PacketTransform (encryption/compression seam) | Pro |

## 2. The CoreManager model

One `CoreManager` per peer; sub-managers (transport, interest, state,
messages, violations, lag-comp, loop) wire themselves up. Roles:
**server**, **client**, **host** (server+client in one — the host's own
client skips all interest measurement and is never spawn-paced; a host
can also run with *no transport at all*).

Tick loop is explicit and deterministic — `EarlyFixedUpdate` /
`LateFixedUpdate` on each `NetworkSystem`, driven at a fixed tick rate,
with `SimulationContext.Type` telling each step whether it's `Forward`,
`Replayed` (a reconcile replay) or `None` (peer doesn't simulate).
Deterministic step order is a marketed debugging property: "a bug
reproduces."

## 3. State replication (the "mark a field" layer)

`NetworkMember<T>` fields on `NetworkSystem`s — decorated/declared, not
hand-serialized. Key mechanics:

- **Delta compression**: bit-level packing; only changed members emit.
  Their headline claim: position+rotation in ~0.4–3 B/update vs ~28 B
  raw; ~85% less traffic than "today's frameworks".
- **Per-member send interval** — each member can be told to send less
  often than the rest (finer than per-object cadence).
- **Member roles**: `Predict` (client writes it as client state — the
  input), `Validate` (predicted result the server checks, carries an
  `accuracy` tolerance and `correctionSmoothingTicks`), `State` (plain
  replicated).
- New observers get a **full snapshot**; everyone else rides deltas.
- Collections (lists/sets/dicts/queues) replicate themselves.

## 4. Interest (their AOI)

**Broadcast-to-everyone is the default** — no condition registered means
every system replicates to every client every tick. Conditions *only
restrict*: `InterestOpinion` is `None`/`Met`/`Unmet`, folded with AND —
`Unmet` vetoes, nothing can grant beyond the default.

Two effects per `(system, connection)` pair:

- **Spawn** — the system exists for the conn at all (culled systems
  despawn on the receiver).
- **Stop** — replication freezes but the receiver keeps the object
  (cheap; re-entry costs nothing). `DespawnWhenStoppedEnabled` upgrades
  a stop to a despawn; in a `NetworkSystemGroup` it's a *vote* — the
  object is reclaimed only when every member is stopped-and-asking.

Resolution runs **inside the serialization pass** — a verdict change
takes effect on the same tick. `EvaluationCadenceTicks` default **5**,
staggered by system id; fresh auths and fresh spawns evaluate
immediately (not on their stagger slot). O(systems×connections),
cadenced — honest for demo/mid scale, they flag a real spatial
broadphase as future work.

Distance technique is a world-level setting: `Pairwise` (default,
direct measure) vs `SpatialGrid` (candidate narrowing first, identical
verdicts). Grid pays off only when the cutoff genuinely excludes most
pairs — 1.4–1.7× at 400m world/25m cutoff, **0.6× when everything's in
range** (the narrowing costs more than it saves). Axes can be
restricted (`Xyz`/`Xy`/`Xz`/`Yz`) for surface-world games.

**LOD ladder** (Pro): three bands `Near`/`Medium`/`Far`, hysteresis
release boundaries precomputed as `1-h` (default h=0.1). LOD is a
*measurement* only — the engine doesn't act on it; the game decides.
(Our tier system = LOD ladder + cadence built-in.)

## 5. Spawn pacing (Pro) — the idea we haven't built

Their framing: *"an unpaced world sends its biggest tick to the peer
least able to take it."* One MTU-segmented combined stream — losing any
segment costs the whole tick. A joiner building its connection gets
swamped by exactly the biggest ticks.

`MaximumSpawnsPerTick` (default 500, per-connection, per state-flush)
caps how many systems may *begin* replicating to one conn per tick;
overflow is admitted oldest-first on following ticks.

Correctness rules:
- A `NetworkSystemGroup` is admitted **whole** (never half an object).
- The conn's own controlled object **never waits**.
- Re-priming an existing observer is never deferred.
- Host/loopback conns are never paced.
- **Nothing on the wire says a spawn waited** — pacing is a sender-side
  policy only; a paced tick is an ordinary tick.

Our analog is the per-recipient intro window (full records for N
ticks) — same goal (don't drown the new peer) but a different
mechanism: they pace *admission* (which objects start existing), we
pace *records* (which state of already-known objects flows). Their
model would map to us as: stagger which entities enter a joiner's
roster per tick rather than shipping the full gameState+roster at once.

## 6. Control, prediction, reconciliation

The control model: the server *drives* a client's system by simulating
its **client state** (the Predict members — validated per packet; a
missing client-state tick is stepped with `TryGetLastState`). The
client predicts; the server compares and orders corrections.

Reconcile is a world-pass, once per inbound packet batch:

1. Detect during `LateStateUpdate` — record the earliest divergent tick;
   every predicted member captures its last server value as restore base.
2. Restore at the `Reconcile` step head — ONE start tick for the whole
   world (earliest any member recorded).
3. `ReconcileRequired` event.
4. **Replay** — ticks start+1 → live−1 re-run the same fixed updates as
   `SimulationType.Replayed`, system-Id order.
5. `ReplayReport.Corrections` — members whose post-replay present differs
   from pre-rewind; `OnMembersChanged(Correction)`.
6. Continue `Forward` from corrected state.

Notable: **observer prediction** — a client can predict *another*
client's system (`IsObserverPredictionEnabled`), not just its own.
And a **hold radius** — only systems near a replay get corrected, so a
distant mispredict doesn't drag the world into a rewind.

## 7. Lag compensation (Pro)

Shooter-side capture: `CaptureShot(origin, direction)` returns the ray
**plus a `LagCompensationView`** — which server-tick blend was on screen
(fraction quantized to a byte, 1/255 of a tick). The view travels with
the shot; 24 B for the ray + a few for the view. Plain Vector3 fields
would round to 0.001/component (~9 cm at 100 m) — enough to lose
headshots — so a dedicated serializer sends raw f32 bits.

Server side: rewound queries (`TryRaycast` etc.) judge against the
view's tick. `MaximumRewindMilliseconds` default **500** — sizes the
hitbox history. A view outside the window is **clamped, not refused**,
and raises `LagCompensationViewClampedViolation` per conn — a steady
stream of clamps is either a very slow link or a client fishing for the
oldest world. Default action `Ignore`. **Dead/despawned targets stay
hittable** until their last recorded tick leaves the window (in-flight
shots before a kill still count — the mirror of our `Shot: shooter
dead` legal race).

Also: `MaximumSpawnCompensationMilliseconds` (150, cap 500) — brings a
freshly spawned object up to the present; same problem family.

## 8. Channels and guarantees

Two values only: `Reliable` (ordered+reliable) and `Unreliable` — and
reliability is delegated *entirely* to the transport; no engine
retries, no redelivery machinery. Calls/messages are **fire-once and
never state**: no ack, no delta baseline, no eventual consistency — a
value that must be right for late joiners belongs in a replicated
member instead.

Batching: per-conn, once per frame, one outbound writer per channel;
each payload length-framed so a bad body can't misalign the batch.
**Large unreliable sends get fragmented by the engine** (≤255 pieces,
~300 KB cap) — whole-or-nothing delivery, 5 s reassembly timeout.

## 9. Link quality + the trust boundary

- RTT estimator = RFC 6298 §2.2/2.3 (SRTT: first sample seeds, later
  samples move 1/8); `RTTDeviation` carries jitter. Loss = probe-sequence
  gaps over the last **16** probes; late/reordered replies close their
  gap rather than counting as loss.
- **Trust-the-client model**: the server probes a client **once** at
  auth, then adopts the client's *self-reported* RTT/jitter/loss
  thereafter — a client that lies only mishandles its *own* recovery
  patience; nothing it reports affects other peers.
- `CanReceiveState` gates all state until the link is measured — every
  timing decision (ack patience, recovery) is denominated in RTT.
- Observation gates everything: an id naming a system the conn doesn't
  observe resolves to nothing — you can't reach objects by guessing.
  Sender resolution happens at transport level; a client-supplied
  sender field is ignored. Relayed calls carry the *original* sender id.
- `Connection.Id` is session-scoped and reused; persistent identity is
  `Connection.Identity` stamped by the authenticator.
- No built-in encryption — `PacketTransform` (Pro) is the seam.
- Multi-writer arbitration is explicitly **not a security boundary** —
  arbitrary but stable; connection-id farming can game it.

## 10. Fish-Net (the predecessor)

Unity-only, mature, free: SyncTypes (replicated vars, per-type interval,
reliable/unreliable, owner-only or broadcast), the **ObserverManager**
AOI system (scene/distance/custom conditions, stackable — Mirror allows
only one), tick-based prediction, lag compensation, scene management
(stacking, caching, persistence), transports pluggable, host mode,
no CCU caps. Nucleus is "the same instincts, nothing inherited we
wouldn't write again."

## 11. Feature map vs KRIBES

| Nucleus | Ours | Notes |
|---|---|---|
| Delta-compressed members, per-member intervals | v4 masked records (~8–15 B/player) + interest tiers | theirs is finer-grained (per-member cadence) |
| Interest conditions → Spawn/Stop | distance tiers + hysteresis + sparse far-field | we fuse restriction+cadence into tiers; their two-effect split (freeze vs despawn) is a cleaner model for distant retained objects |
| Spawn pacing (per-conn admission cap) | per-recipient intro window | different mechanism, same goal — see §5 |
| Reconcile + replay | journaled-input rewind + server corrections | theirs has observer-prediction + hold-radius; ours is controller-only |
| Lag-comp rewound queries | server-side rewind (entitlement bounded by observed transit) | theirs trusts the *client's view* within a clamp; ours measures the link — theirs is more shooter's-favor, ours harder to game |
| Reliable/Unreliable channels | ws (reliable) + wt/rtc/udp volatile lanes | they delegate reliability to transport; we do the same plus our QUIC datagrams |
| Client-reported RTT/jitter | worker-measured RTT + server-observed transit/jitter | we never trust client-reported timing for *entitlement* — their model accepts it for recovery-patience only, which is a reasonable split |
| `CanReceiveState` gate | intro window + drain floor | same idea: no state until the link is measured |
| Observation gates access | wireIds + session-scoped ids | same |
| Host mode, no transport | solo/offline mode | same concept |
| Multi-writer arbitration | n/a (authoritative) | correctly a Pro feature; we don't need it |

## 12. Ideas worth stealing (ranked)

1. **Spawn-pacing semantics for joins** — cap *how many entities enter a
   joiner's world per tick* (admission), not just how fast records flow.
   Cheaper than the playersJoined-batch idea and targets the real burst
   cost: the joiner's receive buffer + instantiation cost. Our
   gameState ships the full roster in one shot.
2. **Stop-vs-cull split** — our far tier keeps replicating sparsely;
   a `Stopped` state (frozen object, retained, zero replication) for
   far/static entities is a real egress lever we don't have. Their
   group-vote rule for reclaiming is the right shape.
3. **Hold radius on reconcile** — only systems near a replay get
   corrected. Ours restores the local player; if we ever predict remote
   entities, this limits the blast radius.
4. **Clamped-not-refused view clamp** — their rewind clamps an out-of-
   window view and *still judges* (raising a violation) rather than
   dropping the claim. Ours rejects past the window — functionally
   similar (the claim still doesn't hit), but their telemetry split
   (clamped vs refused) is nicer observability.
5. **Interest axes** (`Xz` for surface games) — cheap: our tier math
   could ignore Y if the map ever goes flat-ish. Low value today.
6. **Per-member send intervals** — `health`/`vitals` faster than `yaw`.
   Real if egress binds again; our record is a fixed-shape block today.

## 13. What's just good framing (no action)

- "Interest rules decide who hears about what — the lever that sets your
  ceiling" — correct, and already our doctrine.
- "Deterministic step order, so a bug reproduces" — we have it
  (simJournal); the marketing phrasing is a nice reminder it's a feature.
- "A paced batch is an ordinary state tick" — sender-side pacing should
  stay invisible on the wire; ours already is.
- The **Pro split** reads like a pricing model, but the boundary is
  honest: controller-only writes (Free) vs multi-writer+arbitration,
  paced spawns, LOD, lag-comp, packet transform (Pro). Everything we
  care about sits in the paid half — we built all of it.

## 14. What to skip

- The framework itself — C#/netstandard2.1 doesn't fit the Bun/TS stack
  and adopting a netcode layer would retire no bug class we have.
- Mirror-comparison marketing (they're selling to Unity devs).
- Their `SpatialGrid` caveat — at our scale (≤32/room) pairwise is
  already trivial; the grid only pays at 100+ systems per conn.
