# Corrections — agent memory

Append-only log of "you got this wrong" — the thing an agent broke or
was about to break. Format: `- YYYY-MM-DD — <what went wrong> → <rule>`.
Keep entries one line; the fix lives in git, the *lesson* lives here.
When the same class recurs, promote it to AGENTS.md/a skill/an oxlint
rule and delete the lines — memory is a staging area, not an archive.

- 2026-10-11 — regex sweep spread→Object.assign emitted invalid syntax + broke narrowing/const-literal types → mechanical rewrites must pass tsc before commit, not just look plausible
- 2026-10-11 — prefer-math-trunc "fixed" `x | 0` → `Math.trunc(x)` → `|0` is int32 wrap, not trunc; check semantics before applying a fixer rule in sim/hash code
- 2026-10-11 — Boolean(x) && doesn't narrow for tsc inside expressions → keep `x &&` / `x != null &&` for narrowing
- 2026-10-11 — test pinned stale behavior (remoteRemove killCounts) vs deliberate comment-documented choice → when test contradicts a WHY comment, the comment is probably the newer truth — check before "fixing" either side
- 2026-10-11 — per-ledger-row commits all day → commits batch a settled topic; the 50-line floor now enforces it
git filter-repo deletes worktree files stripped from HEAD — copy tracked paths out BEFORE rewriting, verify never-pushed files (ls-tree HEAD vs origin), never gc --prune=now mid-commit
