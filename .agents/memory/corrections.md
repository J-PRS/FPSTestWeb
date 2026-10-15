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
- 2026-10-15 - running/runner are ROLE flags in botRouting (~line 778), not "carrying": a capper has running=true for his whole run. The inherited botLines stagnation escape gates on `!ctx.running`, so it is DEAD for cappers -- do not assume the field name means the state.
- 2026-10-15 - strikeTapMin=2 only governs the HOLD latch; the mountE burn-START floor overrides it. Lowering that start floor to strikeTapMin measured worse on every axis (grabV 22.4->15.0, oasis 22.4->8.7) -- a capper arriving on 2E cannot mount the dais and crawls the last meters.
- 2026-10-15 - capStat/measureRepeat freeze every non-capper (room.bots.quiet), so there is no wave and no enemy: grab times there isolate MOVEMENT, not survival. Do not tune interception off these numbers.
- 2026-10-15 - check.sh ABORT "931 changed files" on Windows is NOT a foreign process: `bash` on PATH is WSL (C:\Windows\system32\bash.exe), whose git sees every CRLF file as modified (1330 vs the real 8). Run the gate as & "C:\Program Files\Git\bin\bash.exe" -lc "bash _tools/check.sh". The earlier revert of unrelated files on this theory was probably unnecessary.
- 2026-10-15 - the flag toss arc (~4m, FLAG_THROW_SPEED 20) is SHORTER than the touch ring (FLAG_PICKUP_R 6m since the capper graze bump). So any guard that releases on "settled" is self-defeating: the toss rests inside the thrower's own ring and he re-grabs it, i.e. G is a no-op while standing. Release on "settled AND stepped >1m off the release spot" instead. Rule: whenever a grab radius grows, re-check everything that assumed the object leaves your radius on its own.
- 2026-10-15 - a guard that survives settle can leak across a flag return: RoomFlags.tickDropped/lazyClient drop-timers send the flag home WITHOUT clearing airborneBy, so the ex-thrower could be blocked from taking the ENEMY flag at its own stand. Clear the guard on every change-of-hands / return-home, not just on grab.
