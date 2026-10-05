# Perpetual Robustification Prompt

Paste this to the agent at the start of a session. It loops: read → work →
audit → update → verify → report → **keep going**. This is not a bug-hunt
that ends when the list is empty — it is a standing mandate to keep
making the game faster, more robust, and cleaner until there is genuinely
nothing left worth doing.

---

You are continuing the reliability/observability hardening of this project.
Your mission is broader than the doc's §4 queue: **anything that makes the
game more performant, more robust, more deterministic, or cleaner/higher
quality code is your job.** Keep grinding.

## Read first (in order)

1. `AGENTS.md` — project rules (server authority, shared/ determinism,
   scenario test conventions, changelog format).
2. `_docs/ROBUSTIFY/ROBUSTIFICATION.md` — the living state doc. It has:
   - §1 threat model (the six failure classes to hunt)
   - §2 what already shipped (do NOT redo it)
   - §3 verified-clean areas (do NOT re-audit them)
   - §4 open items ranked by value — the *known* work queue, not the whole job
   - §5 invariants every change must respect
3. `changelog.txt` head — what recently landed, so you don't collide.

## Work loop — pick the highest-value thing, then the next one

Do not stop after one item. Do not stop because §4 is empty. Each session:

1. **Take the top §4 item** if one exists. Implement it properly —
   `shared/` code for anything both ends compute, tests for every new
   guarantee. Move details to §2.
2. **Hunt the six failure classes** (§1) across `shared/`, `server_bun/src/`,
   `client/src/` when §4 runs thin: determinism divergence, silent
   staleness, ambient nondeterminism, silent coercion, unbounded growth,
   observability noise. Classify findings: fix now / §4 / §3.
3. **Hunt beyond the six classes** — the mandate is the whole game:
   - **Performance**: per-frame allocations in hot paths, unbatched draws,
     redundant per-tick work, growth-only buffers that never shrink,
     work in loops that could hoist, missing distance/lod tiers.
   - **Duplication**: two implementations of one computation anywhere
     (the bug class that keeps biting — constants, validators, solvers).
   - **Structural smells**: oversized files growing past their sizeWatch
     pin, leaky abstraction seams, manual bookkeeping a type or registry
     could enforce.
   - **Untested invariants**: behaviors that MUST hold but nothing pins —
     write the scenario test before the bug teaches it to you.
   - **Dead code / dead fallbacks**: paths that can't fire, config values
     nothing reads, compatibility shims past their compat horizon.
   - **Error surfaces**: places that warn where they should count, count
     where they should throw, swallow where they should report.
4. **Fix regressions** found along the way — prefer fail-loud over
   tolerate-quiet, but keep legit teardown guards (commented dead-socket
   catches, optional-asset 404s, malformed-packet drops).

When a lane is exhausted, say so in the report — then move to the next
lane. "The audit lane is clean" is a checkpoint, not a stopping point.

## Rules

- **Big changes are on the table.** If an architectural change buys real
  robustness, performance, simplicity, or maintainability — collapsing
  parallel implementations into one shared module, moving channel
  ownership, restructuring a protocol flow, deleting a patch-layer
  subsystem — take it. The bar: it kills a whole failure class or removes
  meaningful complexity, tests prove the guarantee, trade-off explained in
  the report. Not a license for: style churn, complexity-swapping rewrites,
  or breaking determinism/authority boundaries. A correct architecture
  beats a hundred local patches.
- Respect §5 invariants: declare the sync channel for new replicated
  fields; one implementation in `shared/` for anything two ends compute;
  no ambient draws in sim paths (`botRng`/`botRngRelease` under strictRng);
  coercion reports itself; lifecycle = delete; lag is not a warning.
- Tests: one scenario file per guarantee under `server_bun/tests/scenarios/`
  using `harness.ts`; seeded RNG, `step(dt)` driving, no wall-clock.
- Every change answers "what failure does this prevent, or what class of
  future change does this make safe/cheap/faster?" — that question is what
  licenses both local fixes and architectural work.
- Comments say WHY, not WHAT. Match existing file style.
- Update `_docs/ROBUSTIFY/ROBUSTIFICATION.md` as you go — it's the source
  of truth; §3 and §4 must reflect reality when you finish.
- Prepend `changelog.txt` (`YYYY-MM-DD - <summary>`, ASCII) when work
  settles.
- **Never declare victory prematurely.** "Everything I looked at is clean"
  is not "the game is clean". State exactly what was covered and what
  remains unexamined. If asked "is the whole game spotless", the honest
  answer includes coverage limits (uncommitted WIP, pattern-level sweeps,
  untested paths).

## Verify before you stop

```bash
cd server_bun && bun test tests/scenarios/
cd server_bun && bunx tsc --noEmit
cd client && ./node_modules/.bin/tsc --noEmit
# plus focused tests for what you changed; full `bun test` if broad
# bun: export PATH="$HOME/.bun/bin:$PATH"  (Windows, Git Bash)
```

## Report back

- What you changed (files + why)
- What you audited and found clean (moved to §3)
- What's now in §4 (new findings + re-ranked queue)
- What lanes you *didn't* get to — the next session starts there
- Test/typecheck results
- Remaining failures — yours or pre-existing

## Done state

"Spotless" means ALL of: §4 holds no bugs (only marked optional
enhancements), every lane in the work loop has been swept recently
(performance, duplication, structure, testability — not just the six
classes), suites green, and a fresh audit finds nothing unclassified.
Even then, say *what was covered*, not "the whole game is clean" — that
claim is never true at this codebase's size.
