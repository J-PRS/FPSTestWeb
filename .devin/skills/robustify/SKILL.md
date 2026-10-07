---
name: robustify
description: Continue the project's reliability/observability hardening — read the robustification state doc, work the ranked queue or run a fresh audit, update the doc, verify, repeat. Self-evolving: each round may extend the hunting repertoire itself (new failure classes, lanes, invariants). Use when asked to robustify, audit reliability, improve observability, fix determinism/staleness/lifecycle issues, or "work on the robustness backlog". Big architectural changes are in scope when they kill a failure class.
---

# Robustify

Long-running, self-evolving hardening program for this codebase. The
state lives in docs — this skill is the operating procedure around them.

## The bar

**Technically and functionally spotless, tested, impeccable,
launch-ready.** Concretely, a server that never dies on malformed input
or a faulted room, sims that replay bit-identical on both ends, zero
unbounded growth over session lifetime, observability a human can read
under fire, and headroom in the hot paths. UI polish, content, and game
design are explicitly OUT of scope — this bar is technical prowess only.

**Performance and running cost are a first-class target,** with
correctness and smoothness as the hard constraint — a cheaper tick or
smaller wire is a win ONLY when gameplay stays identical (or better):
bandwidth per player, CPU per tick, allocations in per-frame paths,
idle-room cost, and process footprint all count. Every perf change
needs a measured before/after and a correctness argument (a pin, a
replay, or a behavior-identical proof), never "should be faster".

**Architecture and tech debt are first-class targets too.** The hunt
is not only for bugs that fire today but for structures that bill
later: what breaks at 10× players/rooms, on a 5-year-old laptop or
phone GPU, at 20% packet loss or a flapping mobile uplink, or the
first time a second engineer touches the file. A correct architecture
is the cheapest robustness there is — it retires bug classes instead
of paying them off one fix at a time.

## Self-evolution

The program grows its own hunting repertoire. When a round turns up a
bug class §1 doesn't name, ADD it to §1 of the state doc (and here if
it's generic). When a lane is exhausted, record it in §3 and invent the
deeper lane it implies — unit pins → property sweeps → chaos/netbot →
load. The doc's §4 queue is regenerated, not just drained: finishing
the queue means writing the next one from what the codebase taught you.

**The skill edits itself.** When a round teaches a better way to hunt,
rewrite any part of THIS file (and its `_docs/ROBUSTIFY/` twin) for
maximum impact: sharpen the bar, add or retire lanes, codify a proven
technique, tighten a rule that produced a weak round, delete what
stopped pulling its weight. Constraints: keep it under ~170 lines,
never weaken the §5 invariants or the "every round ships a change"
rule, and every self-edit must trace to something a round actually
taught — log it in the changelog like any other change.

## Read first (in order)

1. `AGENTS.md` — project rules (server authority, `shared/` determinism,
   scenario test conventions, changelog format).
2. `_docs/ROBUSTIFY/ROBUSTIFICATION.md` — the living state doc:
   - §1 threat model — the failure classes to hunt
   - §2 shipped work — do NOT redo
   - §3 verified-clean areas — do NOT re-audit
   - §4 open items ranked by value — the work queue
   - §5 invariants every change must respect
3. `changelog.txt` head — recent landings, to avoid collisions.

## The eight failure classes (§1)

1. Determinism divergence — two implementations of "the same" computation.
2. Silent staleness — per-id state surviving lifecycle events.
3. Ambient nondeterminism — `Date.now`/`Math.random`/`performance.now`
   reaching sim or test-determinism paths.
4. Silent coercion — clamps/defaults/empty catches hiding bad input.
5. Unbounded growth — maps/arrays/queues without eviction or cap.
6. Observability noise — logs firing on expected lag; real faults with no
   metric, no id, no reason.
7. Boundary-value drift — a tolerance meant to absorb noise also absorbs
   real divergence (the 4hp bucket hid a genuine echo loss for weeks;
   judge drift by persistence, not magnitude).
8. Ordering / skip-tick — authority spends a tick on bookkeeping the
   replay can't model (retarget: re-aim, no sim step, wire carried no
   marker). Any `continue`/early-return in a step loop is a suspect;
   the wire must carry the post-skip anchor or a count.
9. Architectural redundancy — parallel implementations of one concern:
   same-shaped maps/caches in sibling modules, re-derived helpers a
   shared util already owns, layer crossings (UI reaching into sim,
   server logic in wire decode), orphaned subsystems kept alive by one
   import, and copy-pasted validation that has already drifted. Each
   duplicate is a latent divergence: when they differ, one is wrong.
10. Future-cost debt — structures that bill at scale, on low-end
    devices, or on bad networks: O(players²) or O(rooms×players) work,
    per-frame/per-tick allocations that only hurt on a weak GPU/GC,
    wire chatter that multiplies with roster size, reconnect-storm
    amplification, single-owner state that blocks a second instance,
    giant flat structs standing in for a state machine, and "solved
    locally" patterns that should be one shared mechanism. Ask: what
    does this cost at 10×, on 4GB and integrated graphics, and when
    the link drops every third packet?

## Work loop — pick the highest-value thing, then keep going

The mandate is broader than §4: **anything making the game faster, more
robust, more deterministic, or cleaner is in scope.** Do not stop after
one item; do not stop because §4 is empty. Each session:

1. **Take the top §4 item** if one exists — `shared/` code for anything
   both ends compute, tests for every guarantee. Move to §2, cross off §4.
2. **Hunt the §1 classes** across `shared/`, `server_bun/src/`,
   `client/src/` when §4 runs thin. Classify: fix now / §4 / §3.
3. **Hunt beyond the §1 classes:**
   - Performance — per-frame allocations in hot paths, unbatched draws,
     redundant per-tick work, growth-only buffers, hoistable loop work.
   - Duplication/architecture (classes 9–10) — the highest-yield
     structural hunt: pick a concern (validation, cooldowns, eviction,
     vector math, roster bookkeeping) and enumerate EVERY
     implementation; near-identical bodies in different files are
     drift waiting to happen. Collapse duplicates into the single
     owner, delete orphans, route stray callers through the canonical
     path. Evidence: quote the two bodies side by side — "looks
     similar" is not a finding.
   - Scale & future-cost (class 10) — audit one hot path per round the
     way an operator would: cost per player per tick, bytes per
     message × fan-out, allocs per frame, work on the reconnect path,
     behavior when a room goes empty/full. Prefer counters and
     arithmetic over "seems fine"; a measured N² at N=32 is a finding
     even when today's N=8 hides it.
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

**Pins are earned by probes, not greps.** A test pin only counts as the
round's deliverable when preceded by a falsifiable probe — a soak log
read, a replica-hash diff, a runtime bisect — not by a pattern sweep.
An unmotivated pin that passes instantly on already-correct code means
keep hunting; that shape produced this program's weakest rounds.

**Every third round starts in the logs.** Before touching code, read the
latest `logs/client*.log` and the newest session JSONL tail. The best
fixes here (health-echo artifact, POS JUMP, creature hash desync) came
from observed behavior — a round that never looks at evidence hunts blind.

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
- **Research liberally.** When a round surfaces a real concern — a
  hot-path algorithm, a netcode pattern, a containment strategy, a data
  structure — search the web for how modern engines/servers solve it
  (Tribes-likes, Source engine, quic/netcode writeups, V8/JSC perf
  notes) before settling on a fix. Prefer the proven solution over a
  locally-invented one; cite what you adopted in the changelog. This is
  not a license to cargo-cult: the change still has to pass the "what
  failure does this prevent" bar and respect the §5 invariants.
- **The log is the product.** Run a live bot-populated game
  (`_tools/sweeps/matchSim.ts`, `neutralSoak.ts`, or a real GameBot room)
  and read the stream: per-tick INFO spam, warns refiring without
  hysteresis, debug payloads at info tier — noise floods are findings.

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
- **Evidence, not file names** — each claim carries its observation:
  "warn count N→0 across soak X", "493 anchor asserts incl. bounces",
  "DESYNC persisted 12 checks pre-fix". A claim without observable
  before/after is a hypothesis, not a result.
- What you audited with no fixable findings (recorded in §3 — one line,
  not a victory claim)
- §4 state (new findings + re-ranked queue)
- Which lanes you *didn't* get to — the next session starts there
- Test/typecheck results
- Remaining failures — yours or pre-existing

## Done state

There is no "clean enough". The program runs until the user stops it —
the bar above is approached, never declared. Every round produces a fix
or improvement; "everything I looked at is clean" means you should be
looking somewhere else (and the self-evolution section tells you how to
pick where). Always report coverage honestly: what was examined vs what
remains unexamined (uncommitted WIP, pattern-level sweeps, untested
paths).
