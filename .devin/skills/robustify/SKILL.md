---
name: robustify
description: Continue the project's reliability/observability hardening — read the robustification state doc, work the ranked queue or run a fresh audit, update the doc, verify, repeat. Use when asked to robustify, audit reliability, improve observability, fix determinism/staleness/lifecycle issues, or "work on the robustness backlog". Big architectural changes are in scope when they kill a failure class.
---

# Robustify

Long-running hardening program for this codebase. The state lives in docs —
this skill is the operating procedure around them.

## Read first (in order)

1. `AGENTS.md` — project rules (server authority, `shared/` determinism,
   scenario test conventions, changelog format).
2. `_docs/ROBUSTIFY/ROBUSTIFICATION.md` — the living state doc:
   - §1 threat model — the six failure classes to hunt
   - §2 shipped work — do NOT redo
   - §3 verified-clean areas — do NOT re-audit
   - §4 open items ranked by value — the work queue
   - §5 invariants every change must respect
3. `changelog.txt` head — recent landings, to avoid collisions.

## The six failure classes (§1)

1. Determinism divergence — two implementations of "the same" computation.
2. Silent staleness — per-id state surviving lifecycle events.
3. Ambient nondeterminism — `Date.now`/`Math.random`/`performance.now`
   reaching sim or test-determinism paths.
4. Silent coercion — clamps/defaults/empty catches hiding bad input.
5. Unbounded growth — maps/arrays/queues without eviction or cap.
6. Observability noise — logs firing on expected lag; real faults with no
   metric, no id, no reason.

## Work loop — pick the highest-value thing, then keep going

The mandate is broader than §4: **anything making the game faster, more
robust, more deterministic, or cleaner is in scope.** Do not stop after
one item; do not stop because §4 is empty. Each session:

1. **Take the top §4 item** if one exists. Implement properly — `shared/`
   code for anything both ends compute, tests for every new guarantee.
   Move details to §2, cross off §4.
2. **Hunt the six classes** across `shared/`, `server_bun/src/`,
   `client/src/` when §4 runs thin. Classify: fix now / §4 / §3.
3. **Hunt beyond the six classes:**
   - Performance — per-frame allocations in hot paths, unbatched draws,
     redundant per-tick work, growth-only buffers, hoistable loop work.
   - Duplication — two implementations of one computation (constants,
     validators, solvers — the recurring bug class).
   - Structure — files past their sizeWatch pin, bookkeeping a type or
     registry could enforce.
   - Untested invariants — behaviors that must hold but nothing pins;
     write the scenario test before the bug teaches it.
   - Dead code — unfireable paths, unread config, stale compat shims.
   - Error surfaces — warns that should count, counts that should throw.
4. **Fix regressions** found along the way — fail-loud over
   tolerate-quiet, but keep legit teardown guards (commented dead-socket
   catches, optional-asset 404s, malformed-packet drops).

When a lane produces nothing fixable, say so in one line and move to the
next lane in the same session — an empty lane is never the deliverable.
Do not report "clean", "classified-clean", or "verified-clean" as an
outcome: report what you CHANGED. Every session ships a fix, a test, or
a concrete improvement; an audit-only session means you didn't look
hard enough.

## Rules

- **Big changes are on the table.** If an architectural change buys real
  robustness, performance, simplicity, or maintainability — collapsing
  parallel implementations into one shared module, moving channel
  ownership, restructuring protocol flow, deleting a patch-layer subsystem —
  take it. The bar: it kills a whole failure class or removes meaningful
  complexity, tests prove the guarantee, and the trade-off is explained in
  the report. Not a license for: style churn, complexity-swapping rewrites,
  or breaking determinism/authority boundaries. A correct architecture
  beats a hundred local patches.
- Respect §5 invariants: declare the sync channel for new replicated
  fields (`sim`/`edge`/`echo` in `shared/stateHash.ts` `FIELD_CHANNELS`);
  one implementation in `shared/` for anything two ends compute; no
  ambient draws in sim paths (`botRng`/`botRngRelease` under strictRng);
  coercion reports itself; lifecycle = delete; lag is not a warning.
- Tests: one scenario file per guarantee under `server_bun/tests/scenarios/`
  using `harness.ts`; seeded RNG, `step(dt)` driving, no wall-clock.
- Every change answers "what failure does this prevent, or what class of
  future change does this make safe/cheap?" Cosmetic refactors of passing
  code are out of scope.
- Comments say WHY, not WHAT. Match existing file style.
- Update `_docs/ROBUSTIFY/ROBUSTIFICATION.md` as you go — it's the source
  of truth; §3 and §4 must reflect reality when you finish.
- Prepend `changelog.txt` (`YYYY-MM-DD - <summary>`, ASCII) when work
  settles.
- **Every round must change something.** No exceptions: each session
  ends with a code fix, a new or tightened test, a perf fix with
  numbers, or a structural improvement — never just an audit verdict.
  If a pattern sweep finds nothing, it supports the change you ship
  that round (e.g. "swept X, found nothing — pinned it anyway"), it
  does not replace it.
- **Lint/typecheck silence is not proof** — oxlint/tsc clean is the floor,
  not evidence of robustness. Never cite it as a result.
- **The log is the product.** Run a live bot-populated game
  (`_tools/sweeps/matchSim.ts`, `neutralSoak.ts`, or a real GameBot room)
  and read the output stream. Per-hit/per-tick INFO spam, warns refiring
  without hysteresis, debug payloads at info tier, unformatted floats in
  status lines — noise floods are findings. If a human can't spot an
  anomaly in the stream, the observability lane isn't done.

## Verify before stopping

```bash
cd server_bun && bun test tests/scenarios/
cd server_bun && bunx tsc --noEmit
cd client && ./node_modules/.bin/tsc --noEmit
# focused tests for the change; full `bun test` if broad
# bun: export PATH="$HOME/.bun/bin:$PATH"  (Windows, Git Bash)
```

## Report

- What changed (files + why) — the deliverable, every round
- What you audited with no fixable findings (recorded in §3 — one line,
  not a victory claim)
- §4 state (new findings + re-ranked queue)
- Which lanes you *didn't* get to — the next session starts there
- Test/typecheck results
- Remaining failures — yours or pre-existing

## Done state

There is no "clean enough". The program runs until the user stops it:
the target is literally bug-free — a state you approach, never declare.
Every round produces a fix or improvement; "everything I looked at is
clean" means you should be looking somewhere else. Always report
coverage honestly: what was examined vs what remains unexamined
(uncommitted WIP, pattern-level sweeps, untested paths).
