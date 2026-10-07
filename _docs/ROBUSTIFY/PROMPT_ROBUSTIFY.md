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

**The bar is: technically and functionally spotless, tested, impeccable,
launch-ready** — a server that never dies on malformed input or a faulted
room, sims that replay bit-identical on both ends, zero unbounded growth
over session lifetime, observability a human can read under fire, headroom
in the hot paths. UI polish, content, and game design are explicitly OUT
of scope — this bar is technical prowess only.

**Performance and running cost are a first-class target,** with
correctness and smoothness as the hard constraint — a cheaper tick or
smaller wire is a win ONLY when gameplay stays identical (or better):
bandwidth per player, CPU per tick, allocations in per-frame paths,
idle-room cost, and process footprint all count. Every perf change
needs a measured before/after and a correctness argument (a pin, a
replay, or a behavior-identical proof), never "should be faster".

**Architecture and tech debt are first-class targets too.** Hunt not
only bugs that fire today but structures that bill later: what breaks
at 10x players/rooms, on a 5-year-old laptop or phone GPU, at 20%
packet loss or a flapping mobile uplink, or the first time a second
engineer touches the file. A correct architecture retires bug classes
instead of paying them off one fix at a time.

**The program is self-evolving.** When a round turns up a bug class §1
doesn't name, ADD it to §1 of the state doc. When a lane is exhausted,
record it in §3 and invent the deeper lane it implies — unit pins →
property sweeps → chaos/netbot → load. §4 is regenerated, not just
drained: finishing the queue means writing the next one from what the
codebase taught you.

**The skill edits itself.** Between runs — and inside a run when a
round teaches a better way to hunt — you may rewrite any part of the
skill file (`.devin/skills/robustify/SKILL.md`) and this prompt for
maximum impact: sharpen the bar, add or retire lanes, reorder the work
loop, codify a technique a round just proved, tighten weak rules, drop
dead weight. Constraints: keep it small (a bloated skill dilutes
itself), never weaken the §5 invariants or the "every round ships a
change" rule, and every self-edit must trace to something a round
taught — changelog it like any other change.

## Read first (in order)

1. `AGENTS.md` — project rules (server authority, shared/ determinism,
   scenario test conventions, changelog format).
2. `_docs/ROBUSTIFY/ROBUSTIFICATION.md` — the living state doc. It has:
   - §1 threat model (the failure classes to hunt)
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
2. **Hunt the §1 failure classes** (§1) across `shared/`, `server_bun/src/`,
   `client/src/` when §4 runs thin. Classify findings: fix now / §4 / §3.
3. **Hunt beyond the classes** — the mandate is the whole game:
   - **Performance**: per-frame allocations in hot paths, unbatched draws,
     redundant per-tick work, growth-only buffers that never shrink,
     work in loops that could hoist, missing distance/lod tiers.
   - **Duplication/architecture** (class 9): pick a concern — validation,
     cooldowns, eviction, vector math, roster bookkeeping — and enumerate
     EVERY implementation; near-identical bodies in different files are
     drift waiting to happen. Collapse into the single owner, delete
     orphans, route strays through the canonical path. Evidence: quote
     the two bodies side by side — "looks similar" is not a finding.
   - **Scale & future-cost** (class 10): audit one hot path per round like
     an operator — cost per player per tick, bytes per message x fan-out,
     allocs per frame, work on the reconnect path, empty/full room
     behavior. Counters and arithmetic over "seems fine"; a measured
     N^2 at N=32 is a finding even when today's N=8 hides it.
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

**Pins are earned by probes, not greps.** A test pin only counts as the
round's deliverable when preceded by a falsifiable probe — a soak log
read, a replica-hash diff, a runtime bisect — not by a pattern sweep.

**Every third round starts in the logs.** Before touching code, read the
latest `logs/client*.log` and the newest session JSONL tail.

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
- **Every round must change something.** No exceptions: each session
  ends with a code fix, a new or tightened test, a perf fix with
  numbers, or a structural improvement — never just an audit verdict.
  A pattern sweep that finds nothing supports the change you ship that
  round (e.g. "swept X, found nothing — pinned it anyway"); it does
  not replace it. An audit-only report means you didn't look hard
  enough.
- **Lint/typecheck silence is not proof.** oxlint and tsc clean on a large
  repo proves syntax and shallow patterns, nothing more. Never cite them
  as evidence of robustness — they are the floor, not the result.
- **Research liberally.** When a round surfaces a real concern, search
  the web for how modern engines/servers solve it before settling on a
  fix — proven solutions over locally-invented ones, cited in the
  changelog. Still has to pass the "what failure does this prevent" bar
  and the §5 invariants.
- **The log is the product.** Run a live bot-populated game (harness soak
  or real session — `_tools/sweeps/matchSim.ts`, `neutralSoak.ts`, or a
  room full of GameBots) and READ the output stream. If a human scanning
  the log can't distinguish anomaly from heartbeat, observability work
  remains: per-hit/per-tick INFO spam, warns that refire without
  hysteresis, debug payloads at info tier, unformatted floats in status
  lines. Noise floods are findings, not atmosphere.
- **Never declare victory.** There is no "clean enough" — the target is
  literally bug-free, a state you approach and never declare. Do not
  report "clean", "classified-clean", or "spotless" as an outcome:
  report what you CHANGED. If a lane produced nothing fixable, say so
  in one line and move to the next lane in the same session. State
  exactly what was covered and what remains unexamined.

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
- **Evidence, not file names** — each claim carries its observation
  ("warn count N->0 across soak X", "493 anchor asserts incl. bounces")
- What you audited with no fixable findings (recorded in §3 — one line,
  never the headline)
- What's now in §4 (new findings + re-ranked queue)
- What lanes you *didn't* get to — the next session starts there
- Test/typecheck results
- Remaining failures — yours or pre-existing

## Done state

There is no done state. The program runs until the user stops it. The
target is literally bug-free — every round produces a fix, a tightened
test, or a structural improvement; when one lane stops producing
findings you move to the next lane, not to a verdict.
