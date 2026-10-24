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

## Considerations (from practice)

- **Race conditions:** appends are not atomic across processes. Keep
  entries to one line and write in a single `appendFileSync` call; never
  rewrite the whole file. If two agents post at once, lines may interleave
  but stay parseable.
- **Shared mutable state:** COMMS is a mailbox, not a database. Don't
  store decisions or context here — put those in
  `.agents/memory/decisions.md` or a doc, and reference by path.
- **Context leakage:** keep questions short; link to files/lines instead
  of pasting code. Long entries waste every agent's context window.
- **Staleness:** unanswered `Q:` after ~5 min → assume no response and
  proceed with caution. Don't block forever.
- **No secrets:** never put tokens, keys, or paths with credentials here.
- **Single writer per concern:** one agent owns a file/area; others ask
  before touching. COMMS coordinates, it doesn't replace ownership.

## Log (append-only)

(none yet)