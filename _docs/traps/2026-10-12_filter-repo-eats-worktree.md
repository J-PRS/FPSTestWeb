# Trap: `git filter-repo` is not history-only — it eats the worktree

Cost: ~40 files lost permanently (never pushed, only copy was the
working tree): `client/public/assets/anims/*.glb` ×7, several
`models/*.glb`, ~25 `weapons/*.webp`.

## What happened

Asked to "remove dead weight from git but keep files locally". Ran
`git filter-repo --invert-paths --path <dirs>` — then repeated it
three more times for `_tools` binaries, image dumps, and the vendored
asset dirs (`models/`, `anims/`, `weapons/`).

filter-repo rewrites history **and then checks out the rewritten
HEAD**. Any file that existed in the old HEAD but not the new one is
deleted from disk. Gitignored and already-deleted files survive —
that's why the `_tools` scratch lived — but *tracked* files under a
stripped path are gone from both history AND the filesystem.

The vendored-dirs pass deleted live assets the user wanted to keep in
the repo. Files that had been pushed were recovered via
`git fetch origin` + `checkout FETCH_HEAD --`. Files never pushed had
no second copy anywhere — real data loss.

## Secondary damage: gc raced an in-flight commit

While the fetched objects sat prunable, a `git gc --prune=now` ran
while the user's IDE was mid-commit. The commit's index cache-tree
baked in tree SHAs that gc then deleted → HEAD referenced missing
trees (`client/src/{effects,feed,networking}`), fsck broken links.
Repaired by rebuilding the index from the worktree (`rm .git/index;
git add -A`) — content-addressed hashing regenerated the exact missing
objects only because the worktree still matched the commit.

## The rules

- **Before any history rewrite: `git stash -u` is not enough.** Stash
  only covers modified/untracked-vs-HEAD files. Copy every *tracked*
  path you're about to strip to a dir outside the repo first —
  especially anything never pushed (`git ls-tree` vs
  `git ls-tree origin/HEAD` diff tells you exactly what's local-only).
- "Keep the files, purge the history" needs the sequence: copy out →
  filter-repo → copy back → re-add → commit. filter-repo alone does
  the delete.
- **Never `gc --prune=now` while a commit could be in flight** in the
  same repo — the index cache-tree holds references gc can't see.
- After filter-repo: `origin` remote is removed (by design), commit
  SHAs all change → next push must be `--force`, and the stale
  commit-graph + `refs/remotes/origin/HEAD` symref need cleanup or
  fsck reports phantom breakage.
