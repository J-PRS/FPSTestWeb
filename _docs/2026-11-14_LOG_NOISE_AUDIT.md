# Log-noise audit — two-human igunffa session (2026-11-14)

Source: console paste of the supervised `dev-watch` server log from a
~20 min play session (two humans, `player_ksto9lpla` + `player_hqcc0x94d`,
room `igunffa-1`) plus the same session's vite client warn feed.
Every WARN class in the paste is classified below: **noise** (fixed),
**working signal** (correct refusal/detection, kept), or **unexplained**.

## Noise — fixed this session

### 1. Orphaned-demo re-warns on every boot (14 files, every restart)

Symptom: `Failed to parse orphaned demo ... Malformed demo header`
re-emitting for the same 14 files on every child boot.

Root cause: `DemoStorage.reconcileIndex` retried unparseable files
forever. Inspected the files — **all 14 are 0 bytes**
(`clip_2026-11-14T11-09-2x_*.demo`, `stream_gmwg*.demo`): writers killed
between file create and first flush (the force-quit / crash session at
11:09–11:10).

Fix (`server_bun/src/DemoStorage.ts`):
- 0-byte orphans → `unlink` silently (no bytes, no forensic value).
- Nonzero unparseable → rename `<file>.demo.bad`, warn once, never retried.

Verified live: the 14 files were quarantined to `.bad` on the next boot
after the first fix; the empty-delete lands with this change.

### 2. `Join sim gates differ from room` on every bare join

Symptom: warn fired on every join to `igunffa-1` —
`wantGungame:false wantIgun:false` vs `roomGungame:true roomIgun:true`.

Root cause: `roomFactory.roomFor` warned whenever the joiner's derived
gate flags differed from the room's — but a bare join carries `mods={}`,
which derives to all-false. A joiner declaring *no* preference isn't
requesting different rules; they just play the room's. Every `/s/` link
join to a modded standing room spammed the line.

Fix (`server_bun/src/roomFactory.ts`): the warn now requires the joiner
to have explicitly set at least one gate (`mods.* === true`). The
bot-only-room gate adoption path is unchanged (it legitimately reads the
derived flags). Trade: a genuinely conflicting *bare* join no longer
warns — but bare joins never had a gate preference to conflict.

### 3. `EADDRINUSE` UDP respawn cascade

Symptom: after `[dev-watch] restart`, the new child died at
`UdpLane.listen` with `bind EADDRINUSE` — twice in a row, tripping the
<3s bind-fail counter and the `portConflict` kill prompt (which can't
even see the squatter: `portOwner()` only checks TCP LISTENING on
:8000, not UDP :9898).

Root cause: dev-watch awaits `child.exited`, but Windows frees the
datagram port a few ms *after* process exit. The new child bound too
early.

Fix (`server_bun/src/UdpLane.ts`): `listen` retries the bind on
EADDRINUSE up to 10×300ms (~3s) before letting it throw — a real
squatter still crashes loudly, a dying predecessor just delays boot.

### 4. dev-watch observability gaps (also fixed earlier this session)

- Unexpected child death now logs its exit code:
  `[dev-watch] server exited (code N) — respawning`.
- `portConflict`'s denied `taskkill` now offers an elevated retry
  (`Start-Process -Verb RunAs` → real UAC consent prompt) instead of
  failing dead. Elevated squatters happen when the server was started
  from an admin terminal.

## Working signal — verified correct, kept loud

### 5. `aoe-refuse gate:env` (~40 lines — the biggest block)

Emitter: `combatBlast.splashOne` refuses with `env` when
`dist − t1Minbox(cls) > radius` — **the victim was outside the blast
envelope** on the server's sweep. It only logs human-involved misses
within 15m of the rim (`dist − radius ≤ 15`), volume-capped at
4 per shooter+gate per 2s with a suppressed counter.

Reading the fields: `dist:15.8, radius:5` means 10.8m past the rim —
the blast never reached. `gM` is the lag-comp rewind ghost vs live
position gap; entries ran 0–26m, most 0–8m (honest rewind noise at
ski speed). Not one entry shows a victim inside the envelope being
refused — these are the sweep's *working* near-misses, i.e. the
prediction-vs-authority splash divergence census doing its job.

Not a bug; it is the measurement channel for "my splash should have
hit" complaints.

### 6. `Movement cheat detected` dist:74.4 — forged-warp class

One strike line for `player_ksto9lpla` (`severeM:62`, `inp:0,0,0,0`,
`impAgo:4678`, `repDt:52`). The judge (`moveJudge.ts`) fires at
`SEVERE_N=3` step-function divergences >60m in 60s — so ~3 undisclosed
jumps happened inside the window.

Mechanism: `moveClaims.handleTeleport` reseats the judge shadow on
*honored* warps — but the `drift > 25 && !skilled` forged-warp path
returns **without** reseating. The client already moved client-side,
so the next position report lands ~74m off the shadow → strike. Also
consistent with a client-side warp that never sends a `teleport`
claim at all (dev noclip/unstuck key).

Verdict: detection working as designed — this is exactly what a real
teleport hack looks like. If the friend was using a dev warp key, that
key should emit a `teleport` claim (or `skillUse` first) so the warp
is honored instead of banked.

### 7. `Shot rejected: gun-game weapon` (~10, suppressed counter)

In igun, `gunGameAllows` permits only the current rung's weapon
(+Hook +Melee). A pull already in flight when a kill advances the rung
claims the stale weapon → refuse. Rate is normal prediction-vs-
authority drift, not desync — the post-fix `bloomSeq` stamp is
unrelated (that's cone direction, not legality).

### 8. `Shot rejected: ammo dry` — same class

Client predicted one more pull than the authority pool had. Legit
refusal; the reject carries `health` resync for predicted self-splash.

### 9. `pre-join frame rejected {got:chat}`

`SessionManager` drops non-handshake frames before join completes —
the friend typed chat during the connect window. Correct by design;
queuing chat pre-join isn't worth it.

### 10. `teleport spam: inside cadence window — honored, counted`

Cadence window working: the warp is honored (client already moved)
and banked toward the violation counter. Five occurrences for
`player_ksto9lpla` — rapid beacon use, within the design.

### 11. dev-watch `restart — shared/ or src/ changed` spam

Expected — files were being edited during the session (5s debounce
batches each edit burst into one restart). Dev-only.

### 12. Client-side feed (vite warn relay)

- `bot X maxed sheep` / `bot X stuck — N m net travel in 10s`: bot
  watchdog reports — real AI-quality signal (bots idling 100–400s with
  `dest=y` but not traveling), not wire noise. Deserves its own look
  under bot brains, not the netcode lens.
- `Camera spinout 52.5deg/frame`: refocus mouse-jump detector, cosmetic.
- `post-veil 10s pacing` hitches (one 3167ms worst): boot/return
  warmup — shader compile + GC after unhide. Known class.
- `[Resync] hidden Ns offline — dropped 0 remote shells`: the
  hidden-tab resync path working as designed.

## Unexplained

- One `[dev-watch] server exited — respawning` with no preceding
  `restart` line — the child died for a non-file reason and the old
  log line carried no code. Now instrumented (item 4); if it recurs
  the exit code disambiguates crash vs external kill.

## Changeset

| File | Change |
|---|---|
| `server_bun/src/DemoStorage.ts` | 0-byte orphans deleted silently; unparseable renamed `.bad` |
| `server_bun/src/roomFactory.ts` | join-gates warn gated on explicit joiner request |
| `server_bun/src/UdpLane.ts` | bind retry ~3s on EADDRINUSE |
| `server_bun/dev-watch.ts` | exit code on unexpected death; UAC-elevated kill retry |

Verified: `tsc --noEmit` clean (except pre-existing
`tests/scenarios/spearReclaim.test.ts(44)` from WIP chambered-spear
work); worldModel conformance 58/58; `.bad` quarantine observed on the
live demos dir.
