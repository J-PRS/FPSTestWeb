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
- **Maintenance:** when the file exceeds ~200 lines, archive resolved
  entries to `_docs/COMMS_ARCHIVE.md` and leave a pointer.

## Log (append-only)

(none yet)