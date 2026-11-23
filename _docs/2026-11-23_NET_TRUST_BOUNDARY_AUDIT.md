# 2026-11-23 — Net trust-boundary audit: where correctness is structural vs heuristic

Triggered by the shot-divergence incident: painted hits refused 16-41m out
on prod because a per-field gate (`ownerVel` 20 m/s shadow-diff) silently
swapped the claim's velocity for a stale one. JP's directive: robust and
correct by design, no monkeypatching. This audits every place a client
number crosses into server truth and asks which gates are *structural*
(can't express a bad outcome) vs *heuristic* (a threshold tuned until the
bugs stop being reported — i.e. monkeypatch-shaped).

## Current authority map (verified this session)

| Concern | Client sends | Server trusts | Gate type |
|---|---|---|---|
| Movement | pos/vel reports + inputs | shadow sim re-simulates; `moveJudge` resyncs client, N teleport gaps = cheat hook | **structural** — server never runs client numbers, only compares them |
| Remote replicas | nothing | tick/interp replay | structural |
| Shot spawn origin | `pos` | within 3 m of a rewound body sample else rewound pos | heuristic (clamp, not derivation) |
| Shot spawn direction | `dir` | sanitized + deterministic bloom re-jitter | heuristic (sanitization) |
| Shot spawn ownerVel | `vel` | ~~within 20 m/s of shadow else shadow~~ → claimed, magnitude-capped 140 | heuristic both ways |
| fireAt | timestamp | drain ordering + deep-past clamp | structural (can't reorder past the queue) |
| Painted victim ghost | `aimGhosts` drawn spot | <300 ms freshness + rewind/live drift slack | heuristic |
| Victim position at contact | rewind to shooterTransit+renderLag−victimTransit, bounded 1.7 s | structural (server owns the history) |
| Blast victims | detonation at server shell's pos | envelope check vs rewound ghost | structural once the arc is right |
| Combat claims (legacy) | any outcome | refused at `claimsAccepted=false` on dedicated | structural |
| Tick fanout | nothing | distance tiers + backlog shed | structural |

The outlier is still the spawn row: C1 made the *shell* server-simmed but
kept the *spawn inputs* as trusted-with-gates claim fields. Each field
grew an asymmetric gate tuned for cheats, and each gate is a new way to
break honest play (today: velocity; previously: origin clamp dropping
claims >3 m off the sample buffer).

## The design rule that falls out

**Movement already solved this**: the client sends *inputs and reports*,
the server derives everything else from its own shadow — zero client
numbers enter the sim. Shots are the same shape with a shorter history
need: the server already keeps a ~1.7 s rewind buffer of shooter shadow
state (pos, vel, yaw, pitch) for victim adjudication.

**Claim-free spawn frame**: `shotFired` carries only `fireAt`,
`weaponType`, `shotId`. The server rewinds the *shooter's own shadow* to
`fireAt` and derives origin = rewound muzzle pos, dir = rewound aim
(+bloom), ownerVel = rewound velocity. Every per-field gate and its whole
failure class disappears — there is nothing left to forge or desync
against. Client prediction is unchanged (it uses its live values, which
equal the server's rewound values within normal interp error), and the
aim ray the client led with is the one the client actually saw —
fireAt-bounded, not arrival-bounded.

- Cheat surface left: lying about `fireAt` (already bounded by
  claim-window + drain ordering) — nothing else exists.
- Honest-play surface gained: a mid-knockback or post-ski-spike shot can
  never diverge — the rewound velocity IS the velocity the client
  predicted with (same sim, same epoch).
- What dies: `claimOrigin`/`originVelOf`-style per-field gates
  (ownerVelOf, dir sanitize for spawn), `spawnWarp` forensics, and the
  3 m clamp path. ~2 clauses each, one concept: *derive, don't arbitrate*.
- Cost: rewind accuracy for the shooter at fireAt becomes the spawn
  error — same error class as victim rewind, bounded by the same buffer.
  Rendered-vs-shadow lag at fireAt is the residual; sub-meter on normal
  links.
- Falsifier: a shooter whose rewind buffer is thinner than its
  transit+jitter at fireAt (reconnects, tab-resumes) needs a fallback —
  today's clamped-claim path is exactly that fallback.

## Other heuristic seams found (ranked by live-pain evidence)

1. **`aimGhosts` freshness window (300 ms)** — freshness is a budget of
   (transit + shell flight), not a constant. At 45 ms + short-TTL shells
   it's fine; at 150 ms uplink + fast discs, the drawn ghost goes stale
   before the last sweep. Better: key freshness to `fireAt`-derived
   report age (report.at − fireAt ≤ shell TTL), not arrival age.
2. **Blast adjudication center** — `aoe` evaluates at the server shell's
   detonation pos vs rewound ghosts. Correct-by-construction *if* the
   arc is right; every `env` refuse in the prod log was arc divergence,
   not a real miss. After the spawn-frame change the residual is
   victim-side slack only.
3. **kb-unpredicted census** — server knockback without a client stamp
   is the symptom ledger for all of the above. Post-fix it should sit
   near zero; wire it to the rejectCensus dump (already counted; make it
   a promoted per-room metric next to `shot.velGap`/`shot.velClamp`).
4. **Resync storms after hidden tabs** (3 resyncs in JP's dump) — a
   visibility-driven correctness cliff. Design fix is journaled replay
   (server replay of missed ticks at 4-8× cadence) instead of
   snap-resync; that's its own candidate.

## Proposal (for CANDIDATES)

**C7 — Derive, don't arbitrate: the claim-free spawn frame.** End state:
`shotFired` is an intent like movement input; server derives the spawn
frame from the shooter shadow's rewind buffer at `fireAt`. Kills the
remaining per-field trust gates; keeps the declared fallback for thin
history. Pilot scope: spawn frame only (origin+dir+ownerVel), claim
fields still sent but ignored unless shadow history is thin — soak on
live rooms, falsifier = rewind-thin shooters producing worse spawns than
clamped claims.

Sources: CombatHandler.ts (shotAdmit/simmedShot/ownerVelOf as of
`edea3619`), projContact.ts (bodySweep/aimGhosts/ghostLateSweep),
combatBlast.ts (splashOne/env gate), claimLedger.ts (clampPing/MAX_REWIND),
prod journalctl `body refuse`/`aoe-refuse` forensics 2026-11-23.
