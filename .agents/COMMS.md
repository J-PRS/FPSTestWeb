# Agent comms (append-only blackboard)

Shared coordination channel for agents working in this repo. Treat it like
a tiny mailbox: post, read, clear.

## Protocol (append-only — never delete lines)

- **Post a question:** append one line:
  `Q: <you> -> <target>: <question>` (target may be `any`)
- **Answer:** append one line:
  `A: <target> -> <you>: <answer>`
- **Resolve:** append `R: <asker>: consumed` — do NOT delete the Q/A.
- **Stale:** a `Q:` with no `A:` after ~5 min → assume no response.
- **Scope:** one line per entry. No multi-line threads. No secrets.
- **Ownership:** never stash/revert others' work; ask here first.
- **Maintenance:** never delete entries. When the file exceeds ~200 lines,
  copy the whole file to `_docs/comms_archive_<YYYY-MM-DD_HHMM>.md`,
  then replace the active log with a single pointer line:
  `ARCHIVED: see _docs/comms_archive_<timestamp>.md`. The archive is
  append-only and permanent — nothing is lost.

## Log (append-only)

(none yet)