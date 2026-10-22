# Workflow: Robustify round

Spec for one "Robustify skill" message — the recurring hardening loop.

## Trigger

**Event**: JP sends "Robustify skill" (or equivalent) in a Devin session.

## Run

1. Pick the next unhardened lane — rotate: registry capacity →
   validation → state lifecycle → spawn/resync → input window →
   log/warn/reject → storage → resume -> dedupe -> send-backpressure ->
   host-maps -> sync-fallback -> recent server-side edits -> rarest.
   Fresh lanes beat re-sweeps; announce the pick in one line.
2. Audit the lane before touching it: read the code, state what's already
   covered vs. what the round adds.
3. Ship exactly one of: **fix** (a found bug), **pin** (a test asserting
   existing correct behavior), or **structural hardening** (cap/bound/
   funnel). One concern per round.
4. Verify: `cd client && ./node_modules/.bin/tsc --noEmit` +
   `./node_modules/.bin/vitest run`; `cd server_bun &&
   ~/.bun/bin/bun test` + `bun x tsc --noEmit`. Scoped reruns while
   iterating, affected suite in full before reporting.
5. Append §2.x to `_docs/ROBUSTIFY/ROBUSTIFICATION.md` — concrete
   evidence (repo actions + before/after), ends `### 2.x - end`.
6. Prepend `YYYY-MM-DD - <summary>` to `changelog.txt` (ASCII only).
7. Commit: `git add` explicit paths, one commit per concern. Never push.
8. Report: commit hash, what shipped, verify result, remaining gaps.

## Checkpoint

None — fully autonomous per round. JP steers between rounds only.

## Done when

The commit lands green with doc + changelog. A round that finds nothing
shippable still ships a pin — never ends empty.
