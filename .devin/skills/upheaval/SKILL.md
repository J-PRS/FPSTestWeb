---
name: upheaval
description: Find the biggest possible architectural change that is still valuable — total restructuring that retires whole bug classes, not incremental fixes. Maps authority/ownership models against the pain surface (warns, rejects, patch layers, duplicated truth), ranks candidate upheavals by value, and produces a smallest-true-pilot for the winner. Use when asked to find or plan a major architectural change, re-architect a subsystem, or "what's the biggest change worth making".
---

# Upheaval

A hunt for the largest architectural change still worth making. Different
from robustify: robustify pays bugs off one fix at a time; upheaval finds
the restructuring that makes a whole *class* of bug impossible. The
deliverable is a ranked argument, not a rewrite — the user decides what
lands.

## The bar

**The change must retire a failure class, not relocate it.** An upheaval
qualifies only when it (a) deletes a source of divergence/duplication
structurally — the bug can't reoccur because the code can't express it —
or (b) removes meaningful complexity measured in lines/channels/models.
"Cleaner", "more modern", "more scalable" alone are not findings. The
best upheavals end with *less* code, not different code.

**Honest cost accounting is mandatory.** Every candidate gets its real
costs named: latency added, CPU moved, capability lost, migration risk,
the pilot that would falsify it. An upheaval proposed without its
downsides is a pitch, not an analysis.

## Read first (in order)

1. `AGENTS.md` + `server_bun/AGENTS.md` + `client/AGENTS.md` — the
   invariants no upheaval may break (server authority, `shared/`
   determinism, wire-is-law, no ambient nondeterminism in sims).
2. `_docs/UPHEAVAL/CANDIDATES.md` if it exists — the ledger of
   evaluated/rejected/upcoming upheavals. Don't re-argue settled
   rejections without new evidence.
3. `changelog.txt` head + `_docs/ROBUSTIFY/ROBUSTIFICATION.md` §4 —
   recent landings and known structural debts.
4. `_reports/` — prior analyses saved by the user.

## The hunt — where big changes hide

Look for these shapes; each is an upheaval-shaped hole:

1. **Two models of one concern.** Movement predicts→server-sims→corrects
   while combat claims→server-validates. Two authority models for the
   same game is a latent desync factory — the upheaval is collapsing to
   the stronger model (usually authority+prediction). Enumerate every
   place the codebase says "the same thing" two different ways.
2. **A patch layer guarding an inversion.** If a subsystem exists to
   *validate* client decisions (claim ledger, defer queues, re-derivation
   checks), ask whether the decision should be client-made at all. A
   validator that re-derives the truth is the server doing the sim twice —
   once on the client, once to check it. Flipping who sims first often
   deletes the whole layer.
3. **The warn/reject census.** Read recent live logs. Recurring reject
   categories, `suppressed` counters, hysteresis band-aids, and
   "implausible X" verdicts name the seams where two models disagree —
   each sustained warn channel is a candidate for structural removal.
4. **Identity plumbing.** IDs/nonces/paired-claim bookkeeping that exists
   only to JOIN two independently-produced records (shotId nonces pairing
   spawn↔hit) signals a transaction that should be one record.
5. **Modes that could be one mode.** Offline/p2p/online already share
   `Room`; hunt the remaining branches where behavior differs by *who's
   hosting* instead of *what the sim does* — each is a divergence that
   one shared owner would delete.
6. **Subsystems kept alive by inertia.** An orphaned renderer, a
   duplicate physics path, a legacy claim shim — an upheaval that deletes
   a dead-but-loaded subsystem buys maintenance for free.

## Work loop

1. **Map the models.** Name every authority/ownership/sync model in the
   game (movement, projectiles, deployables, pickups, flags, creatures).
   For each: who sims, who decides, who validates, what wire it needs.
   The table itself usually exposes the candidate.
2. **Measure the pain surface.** Count the machinery the weaker model
   needs: lines of validation/defer/dedup, wire fields that exist only
   for validation, warn channels that only fire on that path. Cite
   numbers, not vibes ("~2–3k lines across shotClaims+combatAoe+ledger").
3. **Rank candidates** by `failure-classes-killed × complexity-removed ÷
   migration-risk`. Reject honestly: lockstep/GGPO-style maximal purity
   trades away working authority for a worse desync story — say so.
4. **Pick the winner; spec the smallest true pilot.** Not a plan for the
   whole migration — the narrowest end-to-end slice that would prove the
   model (one weapon class server-simmed; one entity kind moved onto
   state-edge replay). Define the observable verdict: which log lines,
   rejects, or test classes stop existing.
5. **Write the report to `_docs/UPHEAVAL/CANDIDATES.md`** — date, the
   candidate table, winner + pilot + costs + what dies. Changelog line
   when it settles.

## Rules

- **Never break the invariants.** Server owns outcomes; `shared/` stays
  deterministic; wire is law; prediction is for feel only. An upheaval
  that violates these isn't an option, it's a different game.
- **Deletion > addition.** Prefer changes whose end state removes a
  subsystem, a wire channel, or a validation layer. A candidate that
  adds machinery must justify why nothing simpler retires the class.
- **Evidence over architecture-appreciation.** The candidate earns its
  rank from observable pain (log census, bug-history in changelog,
  duplicated-truth diffs), not from how elegant the target picture is.
- **The pilot is part of the deliverable.** "Rewrite X" without a
  falsifiable first slice is not a finished report.
- **Report honestly.** Name the costs, name what you'd lose, name the
  runner-ups and why they lost. The user decides; your job is a correct
  ranking, not a sale.
- This skill does NOT implement the upheaval — it produces the ranked
  argument + pilot spec. Implementation starts only when the user says go.

## Report shape

- The candidate table (model → pain → upheaval → what dies → cost)
- Winner + the failure class it retires (with the evidence count)
- The pilot: files touched, the observable verdict, rollback cost
- Honest losers and why they lost
- Entry appended to `_docs/UPHEAVAL/CANDIDATES.md`
