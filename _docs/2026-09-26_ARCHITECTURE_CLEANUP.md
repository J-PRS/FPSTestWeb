# Architecture Cleanup Plan — Client + Server

Audit date: 2026-09-26. Post-cleanup state: `main.ts` 587 lines, networking
still a frankenstack, server never audited until now.

> **STATUS UPDATE (post-execution):** Phases 1, 2, 3, 3b, 4(partial), 5
> are DONE. `shared/` exists: `wire.ts` (30B position / ~39B-per-player
> tickUpdate) + `weapons.ts` (WEAPONS table) + `protocol.ts` (typed
> `ClientMessage`/`ServerMessage` unions + `PROTOCOL_VERSION` handshake —
> stale clients force-reload on mismatch). Networking stack is
> `NetworkManager → WebSocketConnection → ws`.
>
> The bandwidth ladder is fully landed: binary wire → distance tiers
> (150m/400m) → **extrapolation-aware suppression** (skip records within
> 0.3m of client dead-reckoning; yaw/pitch/health/dead/ski changes always
> force-send; hit/knockback arms a 900ms `forceSendUntil` full-rate window
> so predicted knockback gets real trajectory — fixed the extreme
> rubberbanding regression). Upstream `inputMove` now sends on change only
> (was 60Hz JSON for one bit). Server logs a 10s tick-bandwidth rollup
> (kbps/records/suppressed/tierSkipped). `stateDebug` is DEV/`?debug`
> gated via dynamic import. RemotePlayer jitter EMA is cadence-relative so
> suppression heartbeats don't inflate the interp delay.
>
> Remaining: Phase 6 move-replay (deferred — anticheat axis), WebTransport
> (seam ready, waiting on Bun/Firefox), `getPlayers()` typing, Player.ts
> split.

## 0. What we're building toward (reference games)

Researched the four models this game sits between:

**Krunker.io** — WebSocket + msgpack positional arrays (`["k",42,1.0,…]`);
server authoritative for health/score/state, client predicts its own
movement (`disablePrediction()` exists because prediction is default-on).
**This is our current architecture**, minus the binary wire format.

**Narrow.one** — Three.js + custom WebSocket backend on ~$4 DigitalOcean
boxes, ~200 players/box. Proof that our exact stack (Three.js + tiny
stateful WS server) is production-viable at real scale. No exotic
protocol — the win is being small and stateless-adjacent.

**Tribes 1/2 (the Tribes Engine Networking Model, Frohnmayer/Gift)** —
UDP, 32ms synchronized ticks, five stream managers: **Event** (ordered,
guaranteed), **Ghost** (most-recent-state partial updates + scoping),
**Move** (client inputs → server control object), Datablock, String.
Clients interpolate ghosts and predict their control object; the server
replays moves and sends back which move was last applied. Altimor's
netXT retrofit (see `2026-09-26_T1.md`) adds clock sync, subtick, and
lag-comp rewind on top of this skeleton.

**Tribes: Ascend** — UE3, same ghost/moves model over Unreal's replication;
proves the model survives modern-ish engines, still position-trust +
server reconciliation.

**The synthesis for us:** we already run the Krunker shape
(client-authored movement, server-authored health/hits/spawns, lenient
validation). The deleted `Tribes2Adapter` was a half-built attempt at the
full ghost/move model — worth keeping as `.old` reference, not worth
resurrecting. The plan below hardens the Krunker shape now and leaves a
documented path to real Tribes-style move replay if cheating ever matters.
Phase 6 *is* the Tribes model, properly scoped.

## 0b. The modern version — what 2025 says

Researched current browser-FPS practice (WebTransport papers, growordie's
1k-players-per-core writeup, nape/Colyseus stacks, NSDI'25 transport
comparison). Where the field actually landed:

**Transport — WebSocket now, WebTransport when it matures.** The NSDI'25
study measured WebSockets vs WebRTC vs WebTransport under game workloads:
WebTransport (QUIC datagrams) eliminates TCP's head-of-line blocking —
retransmitted position updates arrive *after* their tick is stale anyway,
which is exactly why T1 used UDP. Datagrams for position/state, reliable
streams for hits/joins — the T2 stream-manager lanes, reborn as a
standard. **Bun's WebTransport server isn't production-ready yet** and
Firefox support is still landing — so: keep the WS transport behind
`Socket.ts` and revisit in 6–12 months. This is *why* Phase 2 isolates
transport as a single file: swapping to WebTransport later touches one
file, not five.

**Wire format — binary is THE scaling lever.** growordie holds ~1,000
players per CPU core on vanilla Node by sending 3-byte intents in and
11-byte snapshots out. Our `tickUpdate` is pretty-printed JSON objects
per player per tick — the single largest per-tick cost once player count
grows. Phase 3b (new): binary pack the hot path (position ×3, yaw/pitch,
vel ×3, health, flags ≈ 30 bytes vs ~150 JSON chars). Protocol stays
JSON for rare messages (join/hit/kill) where readability is free. Krunker
does exactly this — msgpack positional arrays for hot traffic, JSON-ish
for events.

**Reconciliation — soft/hard thresholds, not reject/accept.** The CFWK
stack's three-tier model: below soft threshold → silently accept; soft→hard
→ gentle nudge the client blends toward; above hard → snap. Our
reject-streak + correction approach is the same shape but binary —
adopting the nudge tier would kill the remaining visible warps entirely.

**Cheap-to-run — the real cost drivers are broadcast fan-out and JSON.**
Narrow.one runs ~200 players on $4/month. Our per-recipient
`tickUpdate` filtering + stringify-per-player is the quadratic cost to
attack first: serialize the shared envelope once per tick, splice only
ackSeq per recipient. Bun already handles the rest.

**Fun — the T1 physics dig applies here, not in netcode.** From
`2026-09-26_T1_ALTIMOR.md`: authentic skiing is `verticalDot × friction`
traction + momentum-preserving collisions, slope-jump impulse off
`jumpSurfaceNormal`, lateral-jet taper near `maxJetForwardVelocity`.
Those are movement-code ports in `movement.ts` — the feel wins that make
it *play* like Tribes rather than just netcode like Tribes.

**Updated phase list** — one insertion: Phase 3b binary hot path.

## 1. Where we are

### Client (`client/src`, ~14k lines)

```
main.ts (587) ─ orchestrator only: state, loop, init
├─ game/      combat.ts · netHandlers.ts · remotes.ts · demoLifecycle.ts
├─ networking/ NetworkAdapterFactory → INetworkAdapter → FastAPIAdapter
│              → WebSocketConnection → ws      ← 4 layers for 1 socket
│              NetworkManager (roster, handlers, prediction, ping)
├─ entities/  Player (523) · RemotePlayer (538) · PlayerModel · balls · Nugget
├─ projectiles/ Projectile (660) · per-weapon *Config.ts · RibbonTrail
├─ world/     terrain (612) · scene · atmosphericSky
├─ effects/   explosion · implosion · scorch · debris · effects
├─ demo/      DemoManager (646) · DemoPlayer · playbackReconstruction · …
├─ ui/        hud (484) · HealthBarSystem · FragMessages · CoolShotsPanel
└─ core/      config · Logger · renderer · stateDebug (317, always wired)
```

### Server (`server_bun/src`, ~1.4k lines)

```
server.ts (146)   Bun.serve: /ws upgrade, /health, /demos CRUD, CORS
GameServer (321)  ws callbacks, handshake, 10s reconnect grace,
                  20Hz tickUpdate broadcast, 2s stateHash broadcast
MessageHandler (422) protocol dispatch: position, shot, ×3 AOE, jump,
                     jetpack, projectileDestroy, ping, snapshot
PlayerManager (192) roster: pos/vel/health/kills + lastValidState
ConnectionManager / RateLimiter / validation / DemoStorage
```

The server is honestly in decent shape — small, layered, no dead code. Its
problems are *duplication* and *trust*, not structure.

## 2. Root problems (both sides)

### A. One weapon balance table, two copies

`server_bun/src/config.ts`: `aoeDamage:15, aoeRadius:6, knockbackForce:28,
discPullForce:25, grenade{20,10,45}, chaingunDamage:5, shotDamage:50`

`client/src/projectiles/*Config.ts` + `core/config.ts`: the same numbers
re-declared (damage falloffs, radii, forces, weaponType ints).

This already shipped a real bug — client's predicted splash used the
knockback `falloffAt` curve while server used `1 - dist/radius` (fixed in
combat.ts). Every future weapon tune is a two-place edit that will drift.

### B. Frankenstack transport (client)

`Factory → INetworkAdapter → FastAPIAdapter → WebSocketConnection`: ~450
lines where ~3 real jobs live (playerId persistence, join handshake,
JSON.stringify). `INetworkAdapter` abstracts zero remaining alternatives.
`WebSocketConnection` still imports `msgpack-lite` for a binary path the
JSON-only server never exercises. `NetworkManager.setControlObject` calls
a method no adapter implements — dead API surface.

### C. Message types are `any` everywhere

`NetworkManager.handleMessage(data: any)`, handlers table `(data: any)`,
`RemotePlayerState` partial-splat upserts. Server has proper
`ClientMessage`/`ServerMessage` unions in `types.ts`; the client validates
nothing and casts nothing. A protocol change compiles clean while breaking
at runtime.

### D. Position semantics live in comments

`RemotePlayer.position` = eye height, `Player.pos` = feet, `Nugget.update`
= eye, `sweepPlayer` = feet, `spawnSkiDust` = eye − 1.8. The 1.8m-too-high
hitbox bug was a direct result. Still no type-level distinction.

### E. Server trusts client sim

The position validator only rejects impossibilities (>50m/step, >300 m/s).
Knockback, respawn, and damage are server-authored; everything else is
client-authored and relayed. That's a valid architecture for now (and it
matches the "leniency over simulation" fix from earlier) — but it should
be *named* and its boundaries made explicit instead of accidental.

### F. Smaller stuff

- `MessageHandler` refetches `getPlayer()` twice per message (once in
  `handleMessage`, again in each `handle*`).
- `processAOE` is one function driven by `'rocket'|'disc'|'grenade'`
  ternaries — fine now, but it's the exact place the shared weapon table
  eliminates.
- `tickUpdate` rebuilds `updates.filter(id !== recipient)` per player —
  O(n²) at 20Hz; harmless at 32 players, ugly shape anyway.
- `stateDebug.ts` (317) + `?dummy` block ship to production.
- `updateDebt`-style flood protection (from the T1 source dig) is absent —
  a client can spam position messages and each gets validated.

## 3. Target architecture

```
repo/
├─ shared/                      ← NEW: imported by both sides
│   ├─ protocol.ts              ClientMessage / ServerMessage unions,
│   │                           Vec3, Rotation, wire field names
│   └─ weapons.ts               WeaponId enum + table: damage, aoeRadius,
│                               aoeDamage, knockbackForce, pullForce,
│                               speed, gravity, rateOfFire, hitbox sizes
│
├─ client/src/networking/
│   ├─ Socket.ts                ws lifecycle: connect/reconnect/queue/
│   │                           parse — transport only, no protocol
│   ├─ NetworkManager.ts        roster + dispatch + prediction history
│   │                           + ping, typed by shared/protocol
│   └─ endpoints.ts             (keep)
│
└─ server_bun/src/
    ├─ server.ts                transport + HTTP (keep)
    ├─ GameServer.ts            tick/hash loops, handshake, grace (keep)
    ├─ MessageHandler.ts        dispatch → one handler per message,
    │                           player fetched ONCE, weapon table lookups
    └─ (PlayerManager etc. keep)
```

Bun and Vite both resolve `../shared/*.ts` — no build tooling needed.
`shared/` is the single source of truth for anything that crosses the wire
or affects balance.

## 4. Execution phases

Ordered by correctness-per-risk, each independently shippable.

### Phase 1 — Shared protocol + weapon table (highest value) — ✅ DONE

- Create `shared/weapons.ts`: `WeaponId` (rocket=0, disc=1, discLauncher=2,
  chaingun=3, grenade=4 — verify against client `weaponType` values) and a
  `WEAPONS` table covering every number currently in both configs.
- Server: replace `CONFIG.shotDamage/chaingunDamage/aoe*/disc*/grenade*`
  with table lookups. `processAOE` becomes ~15 lines:
  `const w = WEAPONS[mode]; radius=w.aoeRadius; …pull=w.pullForce>0`.
- Client: `*Config.ts` files import the table instead of literals.
- Create `shared/protocol.ts` with the two message unions (copy from
  server `types.ts`, which is already correct) + `RemotePlayerState`.
- Client `NetworkManager.handlers` typed `Record<ServerMessage['type'],
  (m: ServerMessage) => void>`.
- **Do not** move physics constants (jetpack, gravity) into shared yet —
  that's Phase 6's problem.

Files: +2 new, ~6 edited. Risk: low — pure constant move. Validates with
tsc on both sides + a manual shoot test.

### Phase 2 — Client networking collapse — ✅ DONE

(The plan from the earlier conversation, unchanged.)

- Absorb FastAPIAdapter's 3 jobs into `NetworkManager`: sessionStorage
  playerId, `join` on connect, `JSON.stringify` send.
- `WebSocketConnection` → `Socket.ts`: remove msgpack import/fallback,
  `msgpack-lite` dep + `.d.ts`. Keep reconnect + bounded queue.
- Delete `NetworkAdapterFactory.ts`, `INetworkAdapter.ts`,
  `FastAPIAdapter.ts` → rename to `.old` per convention.
- Remove `NETWORK_BACKEND` config; `init()` becomes
  `networkManager = new NetworkManager(); networkManager.connect(url)`.
- Delete dead API: `setControlObject`, `getSessionId`, `sendBinary`,
  `handleBinaryMessage` stub, `sendInputMove` (if unused — verify).

Files: 3 deleted-renamed, 2 edited, 1 config. Risk: medium — it's the
runtime path; smoke test locally before deploy.

### Phase 3 — Server handler cleanup — ✅ DONE (processAOE via weapon table; fan-out stringify eliminated in 3b; updateDebt cap still open)

- `handleMessage` fetches player once, passes it down to handlers.
- Weapon-table driven `processAOE` (lands with Phase 1).
- `tickUpdate`: build per-recipient payloads in one pass —
  `for u of updates: for r of recipients: if u.id!==r.id push` is still
  O(n²) but avoids re-allocating n filtered arrays; or just accept it at
  n≤32 and add a comment. Prefer: serialize once per player set is wrong
  since each needs own ackSeq — keep per-recipient but hoist the message
  envelope. Low priority.
- `updateDebt`: cap processed position messages per player per tick (T1's
  scheme — max ~5/tick, excess dropped). Cheap DoS hardening. ~15 lines.

Files: 2 edited. Risk: low, covered by existing tests pattern.

### Phase 3b — Binary hot path (the scaling lever) — ✅ DONE (+ distance-tiered interest scoping landed alongside)

JSON is fine for rare events; it's the wrong tool for the 20Hz
`tickUpdate` fan-out. Krunker proved the hybrid: msgpack positional
arrays for hot traffic, readable messages for events. Ours, simpler —
no msgpack dep, a hand-packed `DataView` writer (the wire IS the spec):

- `position` outbound and `tickUpdate` inbound become binary frames:
  `[u8 type][u8 count][per-player: u32 id | f32 x,y,z | f32 yaw,pitch |
  f32 vx,vy,vz | u8 health | u8 flags]` ≈ 30B/player vs ~150 JSON chars.
- Server `GameServer.tick` serializes the shared envelope once, splices
  `ackSeq` per recipient (kills the per-player JSON.stringify fan-out —
  the real quadratic cost, not the filtering).
- Rare messages (`playerJoined`, `playerHit`, `correction`…) stay JSON —
  zero readability cost.
- `Socket.ts` binary lane = raw `ArrayBuffer` both ways (the stripped
  msgpack path was accidentally the right shape — we keep the plumbing,
  lose the library).
- Quantize later if needed (pos f32→3×i16 cm, yaw→u8 turn) — start
  with f32s, the win is already 5×.

Files: `Socket.ts`, `NetworkManager.ts` encode/decode, `GameServer.ts`
tick loop, `types.ts` frame layout, + a `BitStream`-lite ~60-line
`shared/wire.ts` (DataView pack/unpack, shared by both sides — finally
a justified use for the concept). Risk: medium — hot path, but
`server_bun/tests/` already has the harness style to cover codec roundtrips.

### Phase 4 — Position semantics

- `RemotePlayer`: rename semantics — `position` stays the networked eye
  pos but add `get feetPos()` (position − EYE_OFFSET) and use it at every
  call site currently doing `- 1.8` inline (remotes.ts ski dust, combat).
- `sweepPlayer(playerPos)` → param named `eyePos` + doc.
- `Nugget.update` already commented; unify to pass `eyePos`.
- Optional: `type EyeVec3 = THREE.Vector3 & { _eye: true }` brand — probably
  overkill; doc + accessor is enough.

Files: ~4 edited. Risk: low.

### Phase 5 — Debug code out of production

- `stateDebug.ts` + `?dummy` block: gate behind `?debug` or
  `import.meta.env.DEV`, dynamic `import()` so it doesn't ship to surge.
- Keeps the desync tooling without the bundle weight.

### Phase 6 — (documented, not scheduled) The actual Tribes model

The real integrity fix — and it's the real T1/T2 architecture, not an
approximation: **Move manager + ghost resimulation**.

1. `shared/movement.ts` — extract `entities/movement.ts` so the server
   runs the same sim (terrain height callback injected; heightmap baked
   to `.bin` for Bun to load at boot).
2. `inputMove` becomes the authoritative input stream (it already exists
   and carries forward/right/jump/ski — the Move manager lane). Server
   replays inputs through shared sim on its 20Hz tick; `position`
   messages become diagnostics, not state.
3. Server echoes `lastAppliedInputSeq` in `tickUpdate` (the control-object
   update in the T2 model) → client reconciles: rewind to acked state,
   re-apply in-flight inputs. `stateHistory` already stores these.
4. `updateDebt` cap (T1: ≤5 queued moves/tick, synthetic empty move past
   that) — anti-flood, already planned as cheap version in Phase 3.
5. Optional, from the netXT dig: lag-comp rewind for AOE hits (store
   per-player position ring, rewind ~½RTT + render delay during
   `processAOE`), subtick shot timestamps.
6. **WebTransport swap** (when Bun + Firefox land): `Socket.ts` becomes a
   QUIC session — datagrams for `position`/`tickUpdate` (UDP-like, stale
   retransmits never block), reliable streams for hits/joins. The Phase 2
   isolation makes this a single-file migration — this is the payoff for
   collapsing the stack instead of patching it.

Only worth it when cheating actually matters — Krunker proves the
trust-but-validate shape ships real games. But this is the correct
destination architecture; Phases 1–4 are deliberately chosen to be
compatible with it (shared sim, shared protocol, typed wire).

## 5. Conventions to adopt

- `.old` suffix for soft-deleted files (already in force).
- Anything that crosses the wire or affects balance lives in `shared/` —
  never in both configs.
- Modules take a `deps` object of getters + shared containers
  (`combat`/`remotes`/`demoLifecycle` pattern) — no new god objects.
- Client sends eye-position on the wire; every consumer converts
  explicitly via `feetPos`/`EYE_OFFSET`, never bare `- 1.8`.

## 6. Success metrics

- `networking/` goes 6 files → 3, ~450 → ~300 lines.
- Zero `any` in `NetworkManager` message dispatch.
- A weapon stat change touches `shared/weapons.ts` only.
- `tsc` + server tests stay green at each phase boundary.
