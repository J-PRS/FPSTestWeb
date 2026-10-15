# Demo seek checkpoints — decision record

## Recorder question (from DEMO-OMNISCIENT-AUDIT P0)
Server-side recording is the right end state (authoritative, complete,
no client trust — the leaderboard's evidence tier needs it), but it is
a separate project (serializer + per-room taps + storage/retention). It
does NOT gate the seek index: checkpoints are recorder-agnostic (just
timestamps) and work for today's client clips too. So: checkpoints now,
server-side recording later.

## Checkpoint shape: timestamps only, not live-state
Rejected: storing committed live-state per checkpoint (entity tables).
The clip-window synthesis in `client/src/demo/demoClip.ts`
(`findAliveTargets` + synthetic Spawned at window start,
`collectProjectileEvents` in-flight Fired synthesis,
`recoverMissingSpawns`) already reconstructs alive-at-window-start from
the raw edge stream. A checkpoint is therefore just a timestamp; seek
replays the window [checkpoint, t] through the same synthesis. No new
entity-state format, no recorder entity enumeration, no fidelity fork —
one synthesis path serves clips AND seeks.

## Codec: SECTION_SNAP=3 trailer, no version bump
Trailer sections are tag+len skipped by old readers, so checkpoints
ride the existing extension point (`demoWriter.ts:55`). All parsers
share `demoReader.deserializeDemo` (client, `_tools/verify.ts`,
`server_bun/src/leaderboard.ts` via verifySolo) — one reader change
covers every consumer.

## Seek semantics
`reconstructToTime` picks the nearest checkpoint ≤ t (default 0 =
today's behavior) and replays the tail window with absolute timestamps
(new `window*` collectors = existing `collect*` minus renormalization).
Tail replay is O(checkpoint interval), not O(file). Reverse playback
and loop-wrap inherit it (both funnel through `reconstructToTime`).
Fidelity note: tail baselines are synthetic (≤1s stale for 1Hz
snapshot entities); the first tail edge after the checkpoint re-anchors
absolutely, so drift is bounded and invisible.

## Interval: 30s
Matches the recorder's rolling-window order (30s ring) and bounds tail
replay to ≤30s of sim. Cost per checkpoint: 4 bytes. A 40-min match
carries 80 checkpoints = 320 bytes.
