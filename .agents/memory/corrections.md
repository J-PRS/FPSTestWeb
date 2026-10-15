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
- 2026-10-13 — --no-verify is for a fix that genuinely CANNOT batch, not for a leftover 4-liner; hold it for the next topic batch instead
- 2026-10-14 — timestamp renormalization is asymmetric across collectors: proj/target renormalize in extractClip, remotes inside collectRemoteFrames — refactoring collectors must preserve which layer shifts or time shifts twice
- 2026-10-14 — check.sh's oxlint --fix rewrites EVERY file git-diff lists: a wide diff got ~190 unrelated files cosmetically rewritten and the gate failed on pre-existing errors elsewhere → confirm `git diff --name-only HEAD` is narrow before running check.sh; if it isn't, scope manually (tsc + related vitest + targeted probe/shot) and revert unrelated fixer churn with git checkout
- 2026-10-15 — check.sh diag: gate listed 936 ts files vs ~15 real edits; trigger UNPROVEN (status clean 40min earlier; line-10 repro now returns 0 under both shells; reflog shows no foreign commits; both detached worktrees are stale ancestors, no foreign history). Prime suspect is a concurrent session/process on this busy box (100+ stale node/bun, 2 extra worktrees) touching the tree mid-window — my revert may have erased uncommitted foreign work alongside fixer churn (sampled diffs were all oxlint-cosmetics). Proposed guard for check.sh (not yet applied): abort when changed count exceeds sanity threshold + xargs -r
