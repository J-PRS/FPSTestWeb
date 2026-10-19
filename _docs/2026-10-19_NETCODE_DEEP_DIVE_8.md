# NETCODE DEEP DIVE 8 — client/transport reality, ops, and a critical reclaim hole

Eighth audit round. Seven reports + two implementation waves have hardened the
server core: deadline tick scheduler, deterministic math, intro gate,
per-recipient fulls, seeded LCG, drift probe, swarm fuzz, cpu-prof soak. This
round goes at the **client-side truth of networking** (what the server can't
see), the **operational reality of actually hosting this for friends**, and a
fresh audit that found a real auth bypass.

## 🔴 The one that matters — unauthenticated seat destruction via different-room join

`SessionManager.ts:126-128`:

```ts
const reclaimRoom = this.d.roomOfPlayer(playerId);
if (reclaimRoom && reclaimRoom.name !== roomName) {
  this.d.removePlayerCompletely(reclaimRoom, playerId, 'different-room join');
```

`roomOfPlayer` resolves **live and grace** seats. A join for `room=B` while a
player sits in room A destroys their seat **before any token check** — the
`claimIdentity`/`reclaim` token check happens later (line 183/234) and never
runs on this path. The attack: any client that knows `playerId` sends
`{type:'join', room:'other', playerId:'victim'}`. The victim's seat is destroyed
(roster, sessionTokens, playerLeft broadcast) and their live socket stays
registered-but-orphaned — `roomOfPlayer` now fails, so every message silently
drops. Grief-kick of any connected player.

**Fix (one line):** check `token === reclaimRoom.sessionTokens.get(playerId)`
before `removePlayerCompletely` — the client holds the same id-keyed HMAC
(`tokenFor`, line 83). No token → `rejectIdentity`, seat untouched.

The reclaim code comments explain the order is deliberate ("reclaims run BEFORE
the join flood guard… reclaim is already authenticated by the session token")
— but the different-room early-out predates the auth that justifies it.

## Other audit findings (real bugs)

| Sev | Finding | Where | Fix |
|---|---|---|---|
| 🟡 | `replayTo` truncation invisible: `drownCheck` breaks mid-burst, the unsent tail is silently swallowed; `missed` overcounts `only`-targeted frames | `ConnectionManager.ts:177,185-197` | count the un-replayed eligible tail into `reclaimGap`/`onReclaimGap` |
| 🟡 | Intro window doesn't guarantee a per-wireId full: a suppressed/idle player emits *no* record in a joiner's 20-tick window; their first post-window masked delta decodes wrong against the recipient's zero basis | `tickRecords.ts:122-144,278-279` | `room.lastSentPositions.clear()` when stamping `introPlayers` |
| 🟡 | Spectator `tickNack` is an uncapped re-arm: every nack re-stamps `introPlayers` → `introPending` stays true forever at spec-fleet scale → every record double-encodes `rec.full` permanently | `Room.ts:881-884` + `tickRecords.ts:248-251` | no-op re-stamp while the spec's window is still open, or floor re-arms to ~2s |
| 🟡 | RtcServer offer-cap evasion / peer leak: `onClose` frees the `peers` cap slot while the `PeerConnection` lives on via `staleTimer`; close-signal-early keeps spawning PCs past the 64 cap | `RtcServer.ts:171,250-256` | key `peers` by `pc`, delete inside the actual close path |
| 🟡 | Reclaim/reconnect burst is one giant main-thread task: `WorkerTransport` drains all pending events in one macrotask + `wireIn` `JSON.stringify(data).length` per message for `noteRx` — a ~1024-frame replay → one visible hitch at exactly the rejoin moment | `WorkerTransport.ts:151-175`, `wireIn.ts:113` | carry byte length on the event, budget drain iterations |
| 🟢 | `lastSeen` only stamps inside seq/plausibility gates — a seq-regressed but live client never refreshes liveness → idle-kicked while sending | `moveClaims.ts:59-62,120` + `PlayerManager.ts:226-233` | stamp `lastSeen` for any well-formed report |
| 🟢 | `roomFactory` heightfield cache never invalidates on `reloadRoom` — a changed `.bin` survives until restart | `roomFactory.ts:41-56` | evict on `reloadSpec` |
| 🟢 | remote respawn hardcodes `health:100` — clobbers class health until the next record | `wireIn.ts:422` | pass the event's health |
| 🟢 | `RtcRelay` pools all param-less `/rtc` sockets in shared room `''` — no size/rate cap on relayed signaling | `RtcRelay.ts:31` | name the room or cap the pool |

### Test gaps
- `SPEC_VERBS`: no test that a spec's `ping`/`resync` reaches handlers or that a
  non-allowlisted verb drops.
- Pre-join budget: no test for the 64KB/16-frame close.
- `reclaimShields`: no test asserting the >3-flap shield expiry.
- `replayTo`→drown truncation: the break path is untested.
- Intro + suppression overlap (finding above): no scenario test with a silent
  player during a join.

## What the research says we should do about the *client* side

The prior rounds focused on the server. The client-side truth of a browser FPS
is different:

1. **Main-thread stalls ARE network symptoms.** Any task >50ms delays delivery
   of already-arrived WebSocket messages — `onmessage` queues behind long
   tasks. From the client's view this is indistinguishable from packet
   loss/jitter: burst arrivals after a stall, stretched RTT, interp underruns.
   **Fix:** run the WebSocket in a DedicatedWorker and post `ArrayBuffer`s back
   (transfer, not clone). Worker→main delivery is still a main-thread task, but
   the worker removes *decode* work and GC from the frame budget. Our own
   `wireIn` + decode sits on the main thread today — this is the single
   biggest client-side networking win left.

2. **GC discipline: transient garbage is cheap, retained-then-dropped is
   expensive.** Minor GC (Scavenger) is sub-ms for transient allocs. Major GC
   (Mark-Compact) has stop-the-world slices — the 10-50ms frame killers. Rule:
   entity maps are fine; *churning* them isn't. Anything surviving two
   scavenges gets promoted; allocate in the sim loop, never retain references
   to per-tick objects. We already do this mostly (scratch vectors, pooled
   records) — worth a `performance.memory` trend check on the heap to confirm.

3. **WebTransport datagrams are an upgrade, not a requirement.** Chrome 97+,
   Firefox 114+, Chrome Android 155+ — **Safari/iOS only since 26.4 (2026)**.
   Design assumption: WS is the floor, WT datagrams are the fast lane. Our
   protocol already degrades correctly (datagram loss → seq gaps → tickNack).
   Plan for WS-only clients for years.

4. **Background tabs can't be fought.** Chrome: rAF stops immediately, timers
   → 1Hz, after 5min hidden → 1/min. iOS Safari kills the WS without firing
   `onclose` — `readyState=OPEN` but nothing flows; worse, a backgrounded
   Safari can't even `new WebSocket()` on resume (WebKit 308073). **Fix:**
   treat the socket as dead-on-hidden; on `visibilitychange`/`focus`/`online`,
   if no app-level pong within 3-5s, force-close and reconnect. Server-side:
   the reclaim window already handles this; the client just has to trigger it.

5. **`navigator.connection` is a coarse hint, not a driver.** `effectiveType`
   (3g/4g) and `rtt` are rounded/noised and measure the access link, not our
   server path. Useful only to drop tick rate / raise interp buffer on '3g'.
   Always prefer our own measured RTT for adaptation.

## What the research says about actually hosting for friends

1. **Cost:** a Hetzner CX22 (€3.79/mo, 2 vCPU) or CPX21 (~€6/mo) handles
   hundreds of concurrent players at 20Hz — CPU is trivial (~1-5% per room);
   the limit is fanout bandwidth (~3KB/s/player), not compute. One VPS per
   region; no sidecar until cross-region matchmaking.

2. **DDoS reality:** Cloudflare free does **not** cover raw UDP/TCP game
   traffic — Spectrum is an Enterprise paid add-on. A UDP flood saturates a
   naked 1Gbps port regardless of firewall. Practical: OVH/Hetzner include
   L3/L4 game mitigation free; don't expose the real IP behind proxy leaks;
   rate-limit handshakes. For playing with friends, this is mostly irrelevant —
   for "anyone can host a public server," it matters.

3. **Rolling deploys:** SIGTERM → mark `draining`, remove from matchmaking, let
   in-flight rooms finish, hard-kick stragglers at deadline with a "reconnect"
   message. Session migration between tick processes is enterprise
   gold-plating — skip it. A simple drain flag + systemd is enough at this
   scale.

4. **Memory leaks:** the classic is `Map`/`Set` keyed by player/room/socket
   never deleted on disconnect. Detection: `Bun.generateHeapSnapshot()` →
   Chrome DevTools comparison view, or `heapStats().objectTypeCounts` from
   `bun:jsc` with `Bun.gc()` before/after for per-type deltas. Cheap mitigation
   at our scale: **daily rolling restart during low-CCU hours** — leaks almost
   never justify heroics.

5. **Metrics discipline:** the cardinality trap is the #1 production bug — never
   label Prometheus metrics by `room_id`/`player_id` (churn blows up series).
   Aggregate per-room stats into fleet histograms; log per-room debug, don't
   metric it. Our `/metrics` already does this correctly; if we add more
   gauges, keep the rule.

## What it says about keeping it playable at 100-200ms

- Own-player: full prediction + reconciliation (already done); at 200ms RTT
  un-predicted movement is unplayable. What breaks first: knockback/damage
  impulses and player-player collision — corrections via error-blending
  (~100ms lerp), never snap. Our `RemotePlayer` already does the interp; the
  *server-correction* path for own-player needs the same blending check.
- Remote entities: interpolation delay of ~3× snapshot interval absorbs 2
  consecutive losses at 2-5% — our adaptive delay already does the NetEQ
  equivalent.
- Lag compensation: server rewind for hit registration is required above
  ~80ms; cap at ~250ms. We already have rewind — the question is whether
  the window and cap are right.
- Effective view delay at 150ms RTT: ping/2 + interp ≈ 200-250ms. Accept it;
  shooting-at-ghosts is worse than shooting-the-past.

## What it says about mobile/WAN reality

- Mobile first-hop RTT ~27-29ms; end-to-end same-coast ~55-65ms; p90 tail
  90-142ms + handover spikes + ~0.4-2% baseline loss. 5G isn't materially
  better than 4G for latency.
- Residential: continental 20-50ms; transatlantic ~80-110ms. Bufferbloat adds
  100-500ms under saturating load — a housemate's stream hurts more than
  distance.
- The client's `effectiveType='3g'` is a signal to raise the interp buffer,
  not a reason to degrade the sim.

## The plan table

### P0 — ship this round (all small)

| Fix | Effort | Why |
|---|---|---|
| **Different-room join auth check** | ~1 line + test | The only 🔴 — grief-kick of any player by id+room |
| `replayTo` truncation: count eligible tail into `reclaimGap` | ~5 lines + test | Honest metric; un-replayed kills/chat currently invisible |
| `introPlayers` stamp → `lastSentPositions.clear()` | ~2 lines + test | Guarantees a per-wireId full during the window; fixes silent-player wrong-decode |
| Spectator `nackFor` re-arm cap | ~3 lines + test | Uncapped DoS amplifier at spec-fleet scale |

### P1 — this week

| Item | Effort | Why |
|---|---|---|
| Net worker + transferable decode | ~½ day | Biggest client-side win left — removes decode/GC from main thread |
| `lastSeen` on any well-formed report | ~1 line + test | Idle-kicked while actively sending is a live bug |
| RtcServer peer cap keyed by pc | ~5 lines | Offer-cap evasion is real |
| WorkerTransport drain budget + byte-length metric | ~10 lines | Reclaim burst hitch is real and timed badly |
| `wireIn` respawn health passthrough | ~1 line | Wrong health until next record |
| RtcRelay room naming/cap | ~3 lines | Unbounded pool is a leak |

### P2 — this month

| Item | Effort | Why |
|---|---|---|
| Client decode worker (OffscreenCanvas later, DedicatedWorker now) | ~1-2 days | Worker→main message delivery still a main task, but removes decode GC/CPU |
| `visibilitychange` reconnect heuristic | ~½ day | iOS Safari background-socket death is silent and unrecoverable |
| `roomFactory` field invalidation on reload | ~5 lines | Stale `.bin` after a map edit is a footgun |
| Drain flag + `/dev/shutdown` rollout script | ~½ day | Rolling deploys without Agones |
| Own-player server-correction blending check | ~½ day | Remote interp is smooth; own-player correction may still snap |
| Bun `heapStats().objectTypeCounts` leak probe | ~½ day | Cheapest possible leak detector |

### P3 — when it matters

| Item | Effort | Why |
|---|---|---|
| Prometheus histogram buckets + alert thresholds | ~½ day | Formalize what `/metrics` already emits for Grafana |
| Daily rolling restart cron | ~1 line | Leaks at this scale don't justify heroics |
| coturn sidecar for LAN P2P rooms | ~½ day | Only if P2P co-op becomes a feature |
| OffscreenCanvas render worker | ~2 days | Deferred until decode worker proves the pattern |

## Open verifications

- Whether the different-room-join path is exercised in any test (it should now
  fail the auth check).
- Whether `room.sessionTokens` survives `removePlayerCompletely` — the fix
  assumes it's still readable at the check point.
- Whether iOS Safari's silent-socket-death reproduces on our stack (needs a
  real device; the WebSocket-in-worker change may already dodge the WebKit
  bug).
- Whether `replayTo`'s `missed` count ever fires in production — the
  overcounting bug may have been masking real gaps.
