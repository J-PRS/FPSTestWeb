# Upheaval Audit — 2026-11-24

Full re-audit of the open architectural surface. Ranking is effort-free:
value = how much of the end-state it lands and how many bug *classes* die
with it, not how cheap it is.

## Where the ledger stands

| Candidate | State | Remaining |
|---|---|---|
| C5 — one world model (UPHEAVAL MAX) | Protocol spine landed (2026-10-08); ball pilot via `kindMake` (2026-11-02); all 5 fidelity lanes folded onto `runHashLane` (2026-11-24) | **The client mirror: replicas consume the declaration.** 5 of 6 kinds still hand-build |
| C4 — lane unification | Lane registry + spec table landed today | Server-side `emitReplicaLanes()` + `replicaHashes: Record<kind,{hash,fields}>` wire-slot unification (protocol bump) |
| C7 — claim-free spawn frame | Pilot landed (pos/vel derive); dir REVIEW-closed as declared claim field | Falsifier read from `shot.frameDerive/frameThin/frameVelBound` in prod metrics — needs a deploy, no code |
| C5-nav — route owns the runner | Pilot landed | Retire ~100 lines of orbit compensation in `botLines.plan` once `running` transits soak-verified |
| C6 — one position authority | Anchors + `packLodMin` ground bound landed | Entity ground truth: pickups/corpses/balls/deployables can still bury under drawn-vs-sim dips (hit live in ballroom twice today) |
| C2, C3 | REJECTED | — |

## Churn evidence (30 days, src only)

`Room.ts` 43 touches · `main.ts` 42 · `NetworkManager` 36 · `GameServer` 34 · `wireIn` 32 · `CombatHandler` 27 · `impact.ts` 28.

The hot seam is still **wire → replica construction → reconcile** — exactly
the surface the client mirror replaces.

## Ranked opportunities

### #1 — C5 client mirror / Room-as-replica (the pick)

**Why it's #1, no matter the cost:** it is the only open candidate whose
completion makes the architecture *singular* — one `Room`, run
authoritatively on the server, run as a predicted mirror on the client.
Everything else left on the board is a tail: C4's wire slot unification is
subsumed by it (the wire becomes generated per-kind), and the replica seam
is where churn concentrates today.

**What dies when done:** every hand-built replica constructor
(`new sp.Klass` in netCrawlers, `new RemotePlayer` in netHandlers, the
`new Ball` fallback, deploy/pickup construction), the per-kind spawn-edge
handlers' bespoke wiring, the remaining "Nth copy of reconcile" class C4
measured on lanes.

**What exists already:** `shared/worldModel.ts` declarations for all 7
kinds, `kindMake.ts` factory registry, `replicas.ts` roster-reconcile
lifecycle, the `runHashLane` spec table proving kinds declare as data,
the ball pilot proving `makeKind('ball')` works end-to-end.

**Falsifier:** a kind whose replica can't be expressed as
`kind.make()` + replayed-sim — e.g. species-class visual dispatch
(creature picks `Klass` per species) or RemotePlayer's prediction
entanglement. Resolution shape: the declaration names a customization
point (`kind.make` factory args), not a per-kind code path. If a kind
genuinely can't, it stays a declared exception and the table still wins.

**Next pilot (per pilot history):** extend `makeKind` to ONE more kind.
Recommend **creature**: it already runs a client-side sim
(`c.sim.state/targetId`), has 4 declared fields (species/state/uber/
targetId), and its only declaration-gap is `Klass`-per-species dispatch —
the exact customization-point question. Deploy is the fallback (simpler,
but proves less). Flag/pickup prove almost nothing (stateless rows).

**Honest costs:** determinism gate per kind (creature sim must be checked
for wall-clock/RNG before the mirror runs it); client CPU for replayed
sims (soak-proven for 16 bots, full lobby unmeasured); species dispatch
is the only real seam question.

### #2 — C6 residual: entity ground truth

Pickups/corpses/balls/deployables can still render under the drawn
clipmap surface in dips — JP hit this live twice today in ballroom.
High user-facing value, but it's render conformance, not architecture:
a `floorToGround`/clipmap-conformance fix per entity class, not a
subsystem deletion.

### #3 — C4 wire tail

`emitReplicaLanes()` + `Record<kind,{hash,fields}>` — now small because
the lane table landed today, but it's a protocol bump and honestly
waits on #1 (generated wire consumes the same declaration).

### #4 — C5-nav retirement

~100 lines of orbit compensation in `botLines.plan`. Low value density;
do it when `running` transits prove out, not as an audit pick.

### #5 — C7 falsifier read

No code — read `shot.frameDerive/frameThin/frameVelBound` on prod after
the next deploy.

## Recommendation

**Pilot next: creature via `makeKind`** — the first kind with real sim
fields and a genuine declaration question (species dispatch). It answers
"can the mirror consume a kind with constructor-owned visuals" before
deploy/player commit the harder entanglements.
