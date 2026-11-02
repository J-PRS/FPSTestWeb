# Commit scope gate — reference + commit hygiene

The `.githooks/pre-commit` scope gate (added 2026-11-01) exists because a
grab-bag commit is unreviewable: 55 files across 12 areas can't be diffed,
can't be bisected, and can't be reverted piecemeal. The gate doesn't ban
wide commits — it forces the committer to *look at the list* and pick a
lane deliberately.

## How it works

```bash
FILES = git diff --cached --name-only
NF    = file count
AREAS = awk -F/ bucketing:
        client/src/*        -> "client/src"   (one area; legitimately cross-cutting)
        a/b/c/...  (NF>=3)  -> "a/b"          (two top dirs)
        a/b        (NF==2)  -> "a"            (one top dir)
        bare file           -> "."            (repo root)
TRIGGER = NF > 12 AND AREAS > 4
```

Both thresholds must trip — a big commit inside one or two areas is a
single topic and passes; 13 files across 7 areas is a grab-bag and trips.

## The three lanes

| Caller | What happens |
|---|---|
| Human at a terminal | `[y/N]` prompt via `/dev/tty` — stdin of the hook is the commit's stdin, so it reads the terminal directly |
| Agent/CI (no TTY) | `exit 1` + the file/area list + the decision menu — the agent **must** read stderr, then choose: `git add -p` to split, `FPS_SCOPE_OK=1` to accept the wide commit (skips ONLY this gate), or `--no-verify` (nuclear, skips every guard) |
| `FPS_SCOPE_OK=1` set | Prints `wide commit accepted, scope gate skipped`, continues to the remaining guards (lint, secrets, determinism, test-integrity, lockfile, blob size, etc.) |

The agent lane is the "forced read" pattern: **the exit code is the
question, stderr is the prompt, the next command is the answer.** An LLM
can't answer `y/N` (no TTY — stdin is a pipe), but it always reads
command output, so the refusal text is the prompt. Verified live: a
13-file/7-area stage refused with exit 1; `FPS_SCOPE_OK=1` accepted the
scope gate while downstream guards still ran (lint caught the test files).

## Why not just a prompt for everyone

- Agents can't answer prompts — `[ -t 0 ]` is false under exec pipes, so
  `read` EOFs or hangs. A gate that can't be answered is a hang, and
  hangs are how 278h zombie processes happen.
- An answer the agent gives *itself* (split vs env-flag vs nuclear) is a
  real decision in its transcript — an auto-typed `y` is theater.
- `FPS_SCOPE_OK=1` is a **scoped** escape: unlike `--no-verify` it skips
  only this check. Wide-but-legit commits (renames, mass refactors,
  generated code) use it without disarming lint/secrets.

## Implementation notes / traps hit

- **`sed \1` backrefs silently die when written via some editors/scripts**
  — the first version's bucket sed collapsed everything to `''`, AREAS
  always ≤4, gate never fired. Lesson: prefer `awk` for path bucketing;
  verify gates with a real stage+commit, not `bash -n`.
- **Test the gate, don't just lint it.** `bash -n` passed the broken
  version. The live test: 13 scratch files across 6 areas → expect
  refusal → `FPS_SCOPE_OK=1` → expect pass.
- **Guard ordering matters.** The scope gate sits before the lint-fix
  stage, so a refused commit never rewrites your files; after it, oxlint
  + `git add` re-stage fixes — fine when the commit proceeds.
- **Thresholds are tuned to this repo.** `client/src` collapses to one
  area because demo work legitimately touches `demo/` + `ui/` +
  `effects/`; if another root starts accumulating cross-cutting churn,
  bucket it the same way rather than raising the global count.

## Commit hygiene this encodes

1. **A commit is one topic.** If the message needs "and" twice, it's two
   commits. Per-topic commits revert cleanly and bisect fast.
2. **Commit per settled topic, not per file and not per day.** The hook's
   other floor (<50 lines) exists for the symmetric sin — commit spam.
3. **Stage deliberately.** `git add -A` is how _scopet*.ts test files
   ended up inside someone else's bulk commit (real incident, swept into
   `00940bac`). `git add <files>` or `-p` keeps you honest.
4. **Read your own staged diff.** `git diff --cached --stat` before
   commit is the 5-second version of this whole gate.
5. **When a gate refuses, that's information, not obstruction.** The
   correct response is never reflexive `--no-verify` — it's read the
   message, fix or consciously bypass via the scoped flag.

## Related guards in the same hook

size floor (<50 lines), shared/ determinism sentinel
(Date.now/Math.random/new Date/performance.now/console), test-integrity
(blocks test deletion + net expect() removal), secrets patterns,
>100KB new-blob gate, packageManager pin, lockfile sync, hardcoded
machine paths, scratch-artifact patterns, oxlint --fix + restage,
zombie-proc sweep, per-commit version bump.

## Provenance

- Gate verified: `git commit` on 13-file/7-area synthetic stage →
  refusal text + exit 1; `FPS_SCOPE_OK=1 git commit` → scope skipped,
  later guards active (lint errors surfaced). `bash -n` clean.
- Doc written from `.githooks/pre-commit` as of commit `2eaed2`.
