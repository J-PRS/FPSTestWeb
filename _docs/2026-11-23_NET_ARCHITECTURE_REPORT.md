# 2026-11-23 — Networking architecture report: robust by design

Triggered by the shot-divergence incident: painted hits refused 16-41m out
on prod because a per-field gate (`ownerVel` 20 m/s shadow-diff) silently
swapped the claim's velocity for a stale one (fixed `edea3619`, deployed
2026-11-23 ~21:15 UTC). JP's directive: robust and correct *by design*,
not monkeypatching. This report audits the whole net stack, classifies
every trust boundary as structural vs heuristic, and ranks the five
big-picture directions. Companion ledger entry: C7 in
`_docs/UPHEAVAL/CANDIDATES.md`.

## 1. How the stack is shaped today

```
client                                   server (Bun, fleet :8000 + workers :8001-3)
──────                                   ────────────────────────────────────────────
inputs + claims  ──WS/WT ladder────────►  MessageHandler (validate → route)
fireAt/pos/dir/vel                       ─ shotAdmit → simmedShot → RoomProjectiles
position reports                       ─ RoomMoveSim shadow + moveJudge
aimGhost drawn spots                   ─ moveClaims.ghostSweep
claim ledger (predicted fates)  ◄──────  tickUpdate/edges/hit echoes (20Hz, tiered)
```

**Wire**: binary codec for hot paths (position 28B, tickUpdate ~39B/player),
JSON for rare/reliable events. `PROTOCOL_VERSION` force-reloads stale
clients. Transports: WebTransport → WebRTC → WebSocket ladder (v2
netcode), UDP volatile lane parked (FPS_UDP_PORT=9898 exists, ~3KB stub),
RTC/P2P lanes dev-gated off (FPS_RTC).

**Authority model**: server owns every interactive outcome. Clients send
claims/intents; combat *outcome* claims are already refused at the gate
(`claimsAccepted=false`). Non-player objects stream state *edges* +
committed snapshot; both ends replay the same deterministic sim.

**Lag compensation**: rewind buffer per player (~1.7 s);
`ghostBack = shooterTransit + renderLag − targetTransit` rewinds victims
to the shooter's rendered epoch; `aimGhosts` drawn-spot override bounds
drift slack; `ghostLateSweep` retro-tests late reports.

## 2. The trust-boundary inventory (the real audit)

Every place a client number crosses into server truth, classified:

| Boundary | Mechanism | Type |
|---|---|---|
| Movement pos/vel reports | `RoomMoveSim` shadow re-simulates; `moveJudge` resyncs client; N teleport gaps → cheat hook | **structural** — server never runs client numbers |
| Remote replicas | tick/interp replay, replica hashes from `kind.fields` | structural |
| Shot `pos` | claim accepted if ≤3 m of rewound body sample, else rewound pos | heuristic clamp |
| Shot `dir` | sanitize + deterministic bloom re-jitter | heuristic |
| Shot `vel` | was: ≤20 m/s of shadow else silent shadow swap → now: claimed, magnitude cap 140 | heuristic (cap is physics, not truth) |
| Shot `fireAt` | drain ordering + deep-past clamp | structural (queue can't be jumped) |
| `aimGhosts` drawn spot | <300 ms freshness + drift slack vs rewind/live | heuristic window |
| Victim pos at contact | rewind to `shooterTransit + renderLag − targetTransit`, bounded | structural (server owns history) |
| Blast victims | envelope at server shell's detonation vs rewound ghost | structural *if* arc correct |
| Combat outcome claims | refused on dedicated | structural |
| Tick fanout | distance tiers, backlog shed, interest hysteresis | structural |

**Pattern**: everything the server *derives* is structurally correct.
Everything it *arbitrates* (clamps/sanitizes a client-supplied value) is
a hand-tuned heuristic — and each heuristic is a failure mode waiting
for the honest edge case that trips it. Today's incident: the vel gate's
edge case was "predicted-vs-shadow divergence >20 m/s during knockback,"
which is exactly the moment a painted hit needs the true velocity.

## 3. Root cause, restated as an architecture lesson

The `body refuse` forensics on prod: drawn spots landed inside rewind
slack (dR 1.4-6.2m), but the server shell's arc passed 16-41m from the
ghost. Origin matched, dir matched → the only unmeasured arc input was
`ownerVel`. The gate was *silently* correct-by-its-own-lights: divergence
>20 m/s → use shadow → spawn valid → arc bent. No warning class named
"the claim was right and the gate was wrong" existed until now.

**Lesson**: arbitration gates can't distinguish forged velocity from
predicted-but-fresher velocity. The information to decide correctly
already existed server-side (the rewind buffer of the shooter's own
shadow) — the gate just didn't use it. *Derive from server history, or
accept the claim within physics bounds; a gate that arbitrates between
two numbers is the monkeypatch shape.*

## 4. The five big-picture directions

### D1 (C7) — Claim-free spawn frame: derive, don't arbitrate
`shotFired` becomes pure intent (`fireAt`, `weaponType`, `shotId`).
Server rewinds the shooter's *own* shadow to `fireAt` and derives
origin/dir/ownerVel — the "inputs up, truth down" model movement
already uses. Kills every per-field gate (`claimOrigin`, ownerVel
arbitration, spawnWarp forensics, the 3m clamp). Client prediction
unchanged: its live values equal the rewound values within interp error.
Fallback: claim fields stay sent-but-ignored until the shadow history is
thin (reconnect, tab-resume) — that fallback is today's clamped path.
Falsifier: rewind-thin shooters get worse spawn frames than clamped
claims. **Smallest diff of the five; direct descendant of today's fix;
already spec'd as C7.**

### D2 — Client mirror: Room-as-replica (C5's unfinished half)
The client runs the same `Room` as a predicted mirror — local entities
predicted, remote entities replayed from edges, one codepath for all
presentation. `kindMake` factory registry exists (ball pilot landed
2026-11-02); 5 kinds still hand-build (deploy/flag/pickup/creature/
player). What dies: 5 hand-written replica lanes (~200 lines × seams),
5 parallel hash bodies in stateHash, 5 compare blocks in stateDebug,
5 computations in TickLoop — the exact class that shipped eight
lane-drift fixes in one week. What stays: server authority; per-kind
*content* declared once in worldModel. Cost: every kind must satisfy
shared/ determinism; client CPU grows by a full mirror. **The structural
endgame — every other item except D4 lands cheaper once this exists.**

### D3 — Journaled replay instead of snap-resync
JP's dump: 3 hidden-tab suspends → 3 full resyncs, each dropping live
shells and ghost history. A resume shouldn't be a correctness cliff.
Server keeps a ring buffer of tick frames per seat (it already
generates them — the journal exists for demodump); on resume the client
reports its last watermarked tickSeq and the server replays at 4-8×
cadence until caught up. Cheaper than resync, invisible, preserves
ledger continuity (hitSeq/fate bookkeeping survives the gap).
Falsifier: a seat whose ring is shallower than its gap still
snap-resyncs — the fallback exists already.

### D4 — Refuse forensics as first-class metrics
Today the parity-miss signal lives in `journalctl` grep
(`body refuse`, `aoe-refuse`, `spawnWarp`) plus client-side census
(`rejectCensus`, `dropCensus`, `kb-unpredicted`). After today we know
these catches *are* the product — a parity regression should page, not
wait for a dump paste. Promote: `shot.velGap`, `shot.velClamp`,
`bodyRefuse`, `aoeRefuse.*`, `spawnWarp`, `resync` to `/metrics` and
the ops counters the fleet already exposes; per-room refuse-rate alarm
threshold. ~cheap, pure observability, ships alone.

### D5 — Shared sim-clock
Every claim epoch (`fireAt`, ghost-report `at`) is client-stamped and
server-*clamped* — the bounds (300 ms ghost freshness, drain ordering,
deep-past clamp) are all heuristic because the server can't verify
client time. A shared clock — server broadcasts its sim epoch in each
tick; client maintains offset+drift — turns every freshness window into
a provable interval: ghost freshness becomes `report.epoch − fireAt ≤
shell TTL` instead of "arrival within 300 ms." Feeds D1 (fireAt provable
→ derived spawn provable), feeds D3 (replay cursors become epochs).
Cost: clock skew handling (NTP-grade, not GPS — ±20 ms EMA), one wire
field.

## 5. Sequencing

D1 first — smallest, finishes the job today's patch half-did. D4 next —
it's the measurement layer that proves D1 worked (velGap→~0, bodyRefuse
by arc-divergence→0). D3 then, since it removes the resync cliff that
today's replay-less resume still creates. D5 and D2 are the long
poles — D5 unlocks provable epochs for everything above it; D2 is the
end state the others point at. Estimated shape: D1 ~1 pilot session,
D4 ~half a session, D3 1-2, D5 2-3 (skew EMA + epoch plumbing), D2 is
the multi-pilot upheaval already tracked as C5.

## 6. Sources

CombatHandler.ts (shotAdmit/simmedShot/ownerVelOf @ `edea3619`),
projContact.ts (bodySweep/aimGhosts/ghostLateSweep), combatBlast.ts
(splashOne/env gate), claimLedger.ts (clampPing), moveJudge.ts,
moveClaims.ts, TickLoop.ts, ConnectionManager.ts (backlog shed),
MessageHandler.ts, wireIn.ts, shared/wire.ts, shared/protocol.ts,
shared/worldModel.ts; prod `journalctl -u kribes-fleet` refuse
forensics 2026-11-23; JP's client diag dumps (2× rimrock headhunt).
Candidate ledger: `_docs/UPHEAVAL/CANDIDATES.md` (C5/C7).
