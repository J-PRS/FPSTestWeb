# Rejoin handling: journal replay vs snapshot resync — SOTA audit

Date: 2026-11-12. Trigger: F5 in `igunffa-1` dumped the pre-death feed
(kill rows, "settings overridden" warns ×3, suicide notices) as fresh
lines. Question raised: does any of this *need* to replay?

## What SOTA actually says

Three independent sources converge on the same invariant:

- **supercraft reconnect playbook** — "Replaying every missed transient
  delta is usually unnecessary unless your protocol is designed around an
  ordered retained log." Rejoin order: auth → reattach seat → **fresh
  snapshot/checkpoint** → resume incrementals → replay nothing already
  committed (idempotency, not history).
- **oldlight.io galaxy anatomy** — the purist version: *no journal at
  all*. Absolute (non-delta) values make every message idempotent; a
  missed update is repaired by the next one. Reconnect = throw state
  away + resnapshot. Journal deliberately rejected: "the snapshot code
  has to exist anyway."
- **Socket.IO connection-state-recovery model** (what our journal
  explicitly cites, `ConnectionManager.ts:219`) — offset cursor + bounded
  journal, replay only the missed slice. Legitimate — but its purpose is
  recovering **truth not expressible as current state** (chat, ordered
  causal edges), not presentation.
- **Gambetta/Fiedler/Source lineage** — sequence numbers detect gaps;
  gaps trigger resync, never ordered patching. "Applying message 4815 on
  top of 4812 creates a state that never existed on the server."

Consensus shape: **resnapshot is the baseline; replay is for truth the
snapshot cannot express.** Presentation-only lines have no business in
the replay path at any age — the only debate is whether to drop them
outright or bound them with a TTL.

## Our architecture (server_bun/src/ConnectionManager.ts)

Every reliable JSON frame carries a room-scoped `ev` seq; last ~2048
frames sit in a journal. Reclaim presents its watermark (`resumeSeq`),
`replayTo()` replays `seq > watermark` before the handshake reply, so
the fresh `gameState` remains the final word on truth.

Three classes before the fix:

| Class | Mechanism | Members |
|---|---|---|
| Drop-safe | never journaled | ticks, ball segs, yourHealth/Charge/Ammo, stateHash, ping/pong/srvPing, gameState (`NO_JOURNAL_TYPES`) |
| Volatile | journaled, 3s replay TTL | playerShot, jump, jetpack, knockback, playerHit, proj create/destroy, claimAck (`VOLATILE_TYPES`) |
| "Durable" | journaled, replayed at any age | **everything else** — kills, joins, flag/deploy/pickup edges, chat, matchNotice, serverWarn |

The comment justified it: "State events (joins, kills, flag/deploy/
pickup edges, chat) always replay — they carry durable fact a snapshot
gap would lose." Audited against what the client actually derives:

## Per-type audit: truth or presentation?

| Type | Client consumer | Snapshot echo? | Verdict |
|---|---|---|---|
| roster/joins (`playerJoined/Left`) | remote shells | gameState players list reseeds | redundant — replay buys causal order only |
| `playerStale`, `weaponUpdate`, `held` | ghost flag + hand prop | roster `stale`/`weapon` fields reseed | redundant |
| flag/deployable/pickup edges | entity state | `flags[]`/`deployables[]`/`pickups[]` in gameState reseed | redundant — ordering only |
| `playerRespawn`/`playerKilled` (isDead) | remote life | roster isDead reseeds | redundant for life state |
| **`playerKilled` (score edge)** | `killCounts`/`deathCounts` deltas | **NONE** — `match.ts:160-162` comment: "they ride kill-edge deltas with no snapshot echo" | **load-bearing** — dropping it corrupts scoreboard frags/deaths |
| `matchNotice` | chat line + banner + TTS announce | n/a (text) | presentation — replay re-fires stale banners/audio |
| `chat` | chat log | n/a | presentation; arguable "missed while dead" value |
| `serverWarn` | banner + chat | n/a | presentation — join warns replayed ×3 was the visible bug |

Net: the journal's only *load-bearing* type is `playerKilled`, and only
because scoreboard frag/death counts exist nowhere in the snapshot.

## Fix landed (2026-11-12)

`COSMETIC_TTL` in `ConnectionManager.ts`: `matchNotice`, `chat`,
`serverWarn` journal entries carry a 15s TTL, enforced through the same
`stale()` gate volatile types already use (`ttl` field on the journal
entry; `journalBinary` passes `VOLATILE_TTL_MS` or undefined). A 3s
connection flap still catches the missed frag line; an F5 doesn't
resurrect feed history, banners, or TTS from a dead tab's past.

Kill/deploy/flag edges unchanged — durable per the audit above.

## The pure-SOTA option (not taken)

Demote the journal to cosmetic-only:

1. Add `frags`/`deaths` int fields to roster rows in
   `shared/worldModel.ts` (the scoreboard's only unsnapshotted truth).
2. On reclaim gameState, reseed `killCounts`/`deathCounts` from roster
   instead of accumulating deltas.
3. `playerKilled` becomes presentation → same 15s TTL.

Payoff: the entire replay path becomes optional nicety — could shrink
to chat+killfeed only, or the journal could go away entirely
(oldlight-style). Cost: roster rows +2 fields, and the scoreboard's
whole accumulation path gets rewired (bot-side `botKill.ts` mirrors the
same delta bookkeeping — it would need the same reseed).

Why not taken: it's a scoreboard-semantics refactor to save a pattern
(journal-for-truth) that is itself a legitimate industry design —
Ably, Socket.IO, and Fish-Net all ship retained-log resume. The actual
defect was presentation lines masquerading as durable truth, now TTL'd.

## Residual gaps worth knowing

- **Reclaimed `playerKilled` still renders killfeed rows** — required
  for the count deltas; the rows ARE the event stream being honest.
  If the roster-reseed option lands, kill rows get TTL'd too and the
  feed stops backfilling entirely.
- **Replayed chat/notices within the 15s window still fire banners +
  TTS.** No replay flag reaches the client — distinguishing "replayed"
  from "live" would need a wire marker (e.g. `ev` seq ≤ watermark →
  suppress presentation, apply truth only). Cheap follow-up if the
  remaining within-window announce blurbs annoy.
- **Journal is room-scoped and shared** — every seat's missed-slice
  replays the same ring; a 2048-frame eviction during a grace gap is
  counted (`reclaimGap`, `journalDropped`) and the client falls back
  to gameState truth. Sound, just bounded.

## Sources

- crux.supercraft.host/blog/player-reconnection-and-session-resumption
- oldlight.io/blog/anatomy-of-a-galaxy-delta
- mnevfel.com/notes/design-the-reconnect-first
- springfuse.com real-time game state sync (bounded ring + snapshot
  threshold: "disconnected >3s during an active match is better served
  by a clean resync")
- gabrielgambetta.com client-server architecture series
