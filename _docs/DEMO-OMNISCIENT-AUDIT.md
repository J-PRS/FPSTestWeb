# Demo as Omnidirectional Artifact — Audit

Question: if a demo were a *tournament recording* — the whole match, reviewable
from any player, any angle, any moment — what does the current format capture,
and what's missing?

Verdict up front: **the format is a highlight-reel format, not a match
archive.** It records the recorder's observable world very efficiently —
perfect for cool shots, wrong tool for omniscient review. Closing the gap is
mostly additive (v7 fields) except one hard requirement: **the recorder must
see everything, and today it can't** — the client only knows what the server's
interest management sent it.

## What v6 already records

| Lane | Data | Sufficiency for review |
|---|---|---|
| `frames` | Local player 30Hz: pos/vel/yaw/pitch, input flags, mouse deltas, jetpack, held weapon | Good — full POV replay of the recorder |
| `remoteFrames` | Every remote the client saw @20Hz: pos/vel/yaw/pitch, dead+ski flags, roster-deduped ids | Body replay works, but **interest-limited** (see below) and thin (no health/class/team/weapon) |
| `projectileEvents` | fired/bounce/hit/destroyed with pos/vel/weaponType, target id+lane, surface normal, peak pos | Combat reconstructs well incl. audio |
| `targetEvents` | Balls/creatures/deployables: spawn/bounce/hit/state/destroyed + health | Non-player world replays |
| Marker lane | Kills (victim pos, weapon, shooter roster idx), flag state+carrier, pickups | Sparse but present |
| `roster` | Player ids | Names only — no team/class/score |
| `heightmap` trailer | Coarse u8 terrain grid | Map survives even if file doesn't |
| Header | room/mode/playerName, format version, tableHash (enum-table crc) | Clips are self-describing |
| Audio | Event-edge sfx now replay the live mix (positional) | Done as of 2026-10-11 |

## The gap list — what omniscient review needs vs. has

### P0 — the recorder is blind

Client recording sources from `world.remotePlayers` — i.e. what the server
**distance-tiered send** chose to show this client (`CreatureSim.ts`, wire
tiering). A recorder standing on the east stand has *no data at all* about the
west-side duel. For a cool shot that's correct; for a tournament artifact it's
fatal — you cannot review what was never sent.

**Options:**
- **Server-side recording** (the real fix): Room already sees every entity
  every tick — emit the same event lanes server-side into a `.krb` demo.
  Authoritative, complete, no client trust. Cost: a serializer + per-room
  event taps; the demo format was designed client-first but the lanes map
  1:1. This is the path if tournaments matter.
- **Spectator/observer slot with interest management disabled**: client
  recorder, but the room sends it everything. Smaller change, keeps
  client-side pipeline; burns one player slot and real bandwidth.
- Cheat: record from the host/broadcaster client and accept the blind spots.
  Cheapest, worst.

### P0 — seek index for match-length files

Cool shots are seconds; a match is tens of minutes. Seek today reconstructs
by replaying the event log forward (`reconstructSeek` + `deadIds`) — fine at
10s, unusable at 40min. Needs **periodic committed snapshots** (say every
30–60s: all live remotes' pos/vel, balls, deployables, flags, scores) so seek
jumps to the nearest checkpoint and only replays the tail. This is the single
biggest usability feature — without it nobody reviews a whole match.

### P1 — per-player vitals on remote frames

`RemoteFrame` is ~45 bytes of motion. Review wants, per player per sample
(or as change-events):
- **health / armor class / team** — overlay bars, "who was winning the duel",
  class identification. ~6 bytes more, or a sparse `PlayerStateEvent` lane on
  edges only (cheap).
- **held weapon** — the local frame has it; remotes don't. Needed for "what
  was he running".
- **jet/ski/alive already there** in flags; add `CarryingFlag` bit (exists
  indirectly via flag carrier idx — a flag bit is one bit, easier to consume).

### P1 — kill/damage attribution depth

Kill markers record victim pos + weapon + shooter roster idx — enough for a
kill feed. Missing for review:
- **damage amounts / assists** — who softened whom. Needs a damage-edge
  event (attacker, victim, amount, weapon) — sparse lane, few bytes per hit.
- **death cause** beyond weapon (suicide, env/creature, fall). Weapon field
  partly covers; a `cause` enum is cleaner.
- **mid-air / direct-hit flags** — already inferable from projectile hit
  events, but only if the hit was recorded with target linkage (v6 does).

### P1 — match clock + scoreboard

Header has wall-clock timestamp; nothing records **match time, team scores,
flag-cap count, per-player frags/deaths over time**. A reviewer scrubbing to
"the tying cap" needs scored events + a clock. Small `MatchEvent` lane:
periodic score rows + cap/period edges. Cheap.

### P2 — comms & misc

- **Chat/VGS**: not recorded. Tournament review often wants it — a text-event
  lane is trivially cheap (string table + timestamps). Include sender idx,
  kind, text.
- **Melee/slam/teleport edges**: slam is adjudicated but is it an event lane?
  Slam/swing VFX replay probably falls out of projectile/animation; teleports
  (respawns, portal) need a marker or they read as snaps.
- **Joins/leaves/name changes**: roster grows lazily on first sample — a
  join-time event would timestamp arrivals.
- **Aim/fire input flags for remotes**: local frame records inputs; remotes
  only pos/vel/yaw. For "was he even aiming at the capper" review, remote
  yaw/pitch covers direction — inputs are a nice-to-have.

### P2 — playback-side tooling (format-independent)

The artifact is only as good as the viewer:
- **POV lock to any roster player** (playback already builds `RemotePlayer`
  replicas; attach camera to one) — moderate work, no format change.
- **Timeline bookmarks** — kills/caps indexed in the file or computed at
  load; jump-to-event UI.
- **X-ray / name plates / health bars** in playback HUD — data already
  available once P1 vitals land.
- **Top-down tactical view** — free camera exists; a minimap-style ortho
  mode is viewer work only.
- **Speed controls** — exists for playback presumably; for review also
  frame-step and reverse-would-need-snapshots (P0 seek index).

### P3 — integrity & economics

- **Determinism note**: playback reconstructs visuals, not the sim — fine for
  review but means "replay truth" = recorded events, not re-simulation. Good
  (cheap, robust) — just don't claim deterministic replay.
- **File size estimate** (16 players, 20Hz, sparse edges): remoteFrames ≈
  45B × 16 × 20 = ~14KB/s ≈ 0.85MB/min — 25MB for a 30-min match. Dead-reckon
  skip cuts that maybe 40%. Very tractable; server-side recording similar.
- **Integrity**: header has a checksum field — is it computed/verified? For
  tournament evidence you'd want a real hash over the event lanes and maybe
  a signature from the recording server.
- **Format**: everything above is additive v7 — new lanes + new remote-frame
  fields + snapshot blocks. `tableHash` already guards enum drift. Keep v6
  playback working (it's already the compat floor).

## Suggested order

1. **Snapshot checkpoint index** (P0 seek) — biggest unlock per line of code,
   works for today's clips too.
2. **Sparse `PlayerStateEvent` lane** (health/class/team/weapon edges) +
   remote-frame flag bits — small format bump, huge review value.
3. **`MatchEvent` lane** (clock/scores/caps) + kill assists/damage edges.
4. **Decide the recorder question** — spectator-observer (cheap) vs
   server-side (right). This gates whether "omnidirectional" is even possible.
5. Viewer tooling (POV lock, bookmarks, x-ray) once the data exists.

Bottom line: ~80% of omniscient replay is three additive lanes plus one
architecture decision (who records). Nothing recorded today is wasted — the
cool-shot pipeline becomes the event vocabulary for the match archive.
