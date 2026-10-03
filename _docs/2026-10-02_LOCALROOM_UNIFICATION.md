# LocalRoom — unify offline bots with the real Room

Date: 2026-10-02 · Status: proposal / audit complete · Scope: `client/`, `server_bun/`, `shared/`

## 1. The problem

Two bot implementations exist in parallel:

| | Client (offline) | Server (authority) |
|---|---|---|
| Roster/orchestration | `game/bots.ts` `TeamBots` (~500 ln) | `ServerBots.ts` (~531 ln) |
| Perception | `botSenses.ts` | `serverSenses.ts` (634 ln) |
| Firing | `botFire.ts` (262 ln) | `botArsenal.ts` (397 ln) + `botBeam.ts` |
| Movement drive | `botBrain.ts` GameBot wrapper | `botDrive.ts` |
| Anti-pedestrian meter | `botSheep.ts` (203 ln) | `botSheep.ts` (183 ln) |
| Kill/match/CTF | `botKill.ts`, `botMatch.ts`, `botCtf.ts` | `Room.ts`, `RoomFlags`, `roomScore` |
| Roster | inline in `bots.ts` | `botRoster.ts` (275 ln) |

Total: ~1,800 client lines mirroring ~2,100 server lines.

The **decision layer is already unified**: `shared/botBrain.ts` (514 ln),
`botMoves`, `botGoals`, `botHunt`, `botLines`, `botSkill`, `botSteer`,
`botLoadouts`, `botTaunts` (~1,800 ln total) run identically on both ends.
What remains split is the **host shell** — the code that gives the brain a
body, senses, and consequences.

The split is maintained by comment convention ("mirrored against
ServerBots' senses", "a bot offline is held to the same standard it is on
the wire"). That is drift-by-design:

- The client `SheepMeter` lagged the server's energy model until ported
  by hand.
- `botFire` resolves projectiles through the client's cosmetic projectile
  system; `botArsenal` resolves through the authoritative claim path —
  subtly different blast/self-damage outcomes.
- Server senses read the honest move-shadow energy tank; client senses
  read live player state — different energy provenance.
- `TeamBots` maintains its own kill feed, scoring, win check, CTF bridge,
  respawn, nugget drops — a re-implementation of `Room`'s match logic.

Every behavior fix costs twice, or lands once and rots in the other path.

## 2. Why the embed is already viable

The codebase was steered toward this and most of the hard parts exist:

- **`client/src/networking/p2p/host.ts`** already runs
  `PlayerManager` + `MessageHandler` + `RateLimiter` + `validateMessage`
  verbatim from `server_bun/` inside the browser, over a `P2PLink`
  interface that *is* a loopback for the host's own client. Browser
  embedding of server modules is proven, not hypothetical.
- **`server_bun/src/logger.ts`** explicitly guards `globalThis.Bun` with
  the comment "browser hosts (P2P embeds of PlayerManager/CombatHandler)
  have no fs" — written for this.
- **Client heightmap already produces `shared/heightfield.ts`
  `Heightfield`** (`world/heightmap.ts` `getHeightfield()`) — the exact
  `Room` ctor argument, added for server-owned creatures/ballSim replay.
- **`Room`'s transport surface is tiny**: `connections.register/unregister`,
  `broadcast(msg)`, `sendToPlayer(pid, msg)`, `broadcastBinaryReliable(data)`
  — `ConnectionManager` only calls `ws.readyState`, `ws.send()`,
  `ws.getBufferedAmount()`. A loopback socket shim is ~20 lines.
- **Room owns every sim offline mode fakes**: `sims[]` ticks `ServerBots`,
  `RoomPickups`, `RoomArena`, `RoomDeployables`, `RoomProjectiles`,
  `RoomMoveSim`, `InfluenceMap`, `BallSim`, `CreatureSim`, `RoomFlags`,
  `MatchClock`, `RoomScore`. Every `BotsDeps` hook (`nearestNugget`,
  `damageCreature`, `botDeploy`, `botWeld`, `dropNuggets`) is a real sim.
- **Client message consumption is transport-agnostic**: `netHandlers`
  decode JSON + binary wire frames; loopback delivery exercises the exact
  same path a socket does.
- **`simNow()`** = `Date.now() + warp` — correct in-tab without changes.
- `Room` ctor is pure TS; its only bun imports are *types*
  (`ServerWebSocket` — erased at compile). Files Room does NOT pull are
  the bun-only ones: `GameServer`, `DemoStorage`, `matchJournal`,
  `mapCatalog` (fs), `ConnectionManager` only needs a socket *shape*.

## 3. The design

Offline mode becomes: **a `Room` running in the browser tab, behind a
loopback transport.** Not a fake — the same authority code, same messages,
same claim validation, zero network.

```
today:   client ──ws──> Bun Room ──ws──> client          (online)
         client ──TeamBots (parallel fake)──> client     (offline)

after:   client ──ws──> Bun Room ──ws──> client          (online)
         client ──fn──> Room ──fn──> client              (offline)
         client ──fn──> Room ──DataChannel──> guest      (P2P, upgraded)
```

### 3.1 `LocalRoom` (new, client-side, ~200 lines)

```ts
// client/src/networking/localRoom.ts
class LocalSocket {
  readyState = 1;
  data: { playerId: string } | null = null;
  constructor(private deliver: (data: string | Uint8Array) => void) {}
  send(d: string | Uint8Array) { this.deliver(d); }       // → netHandlers
  getBufferedAmount() { return 0; }
  close() {}
}

export class LocalRoom {
  room: Room;
  socket: LocalSocket;
  constructor(name, field, mode, spec, playerId) {
    this.room = new Room(name, field, mode, spec, /* moveAuthority */ false);
    this.socket = new LocalSocket(d => networkManager.deliverLoopback(d));
    this.room.players.addPlayer(playerId);
    this.room.connections.register(playerId, this.socket as never);
    this.room.messageHandler.handleHandshake(playerId, 'local', false);
  }
  step(dt: number) { for (const s of this.room.sims) s.tick(dt); /* + flags/matchClock */ }
}
```

The local player's outbound messages route through the loopback into
`MessageHandler.handleMessage` — claims get real validation (`CombatHandler`,
fire-rate gate, hit ledger) offline, identical to online.

### 3.2 Tick driving

`TickLoop`/`TickFanout` live in `GameServer`, not `Room`. Two options:

- **Reuse `TickFanout`** (records + interest tiers + suppression): identical
  wire shape, but heavier than one player needs.
- **Minimal fanout**: per-step, encode `tickUpdate` for everyone except the
  local player through `encodeTickFrame` — bots arrive as normal wire remotes
  (interpolated, `isBotId` names, health bars, everything).

Recommendation: reuse `TickFanout` if it lifts cleanly (it's pure TS over
Room + connections); a hand-rolled fanout reintroduces a mirror file — the
very disease being cured. Drive it from `gameLoop.step(dt)` — fixed
accumulator at `1/CONFIG.tickRate`, so tab-blur pauses the sim correctly
and the sim aligns to frame budget rather than wall-clock `setInterval`.

### 3.3 What dies

- `game/bots.ts` `TeamBots`, `botSenses.ts`, `botFire.ts`,
  `botSheep.ts` (bot meter — `playerSheep.ts` stays, it's a HUD readout),
  `botKill.ts`, `botMatch.ts`, `botCtf.ts`, `botWatchdog.ts`,
  `botBrain.ts`'s `GameBot` wrapper.
- `networkManager.localAuthority.envDamage/heal` — Room's own env/claim
  paths replace the clamps.
- `Projectile.sweepLocal`/`localClass` (offline bots shooting the local
  player through a special case) — bots are now wire projectiles like
  everyone else's.
- `world.remotePlayers` `localDriven` path for bots — bots become normal
  interpolated remotes; the "bots keep moving during conn-down" weirdness
  disappears because offline = conn-up.

### 3.4 What stays client-side

- Rendering, `RemoteInterp`, prediction/reconciliation for the local
  player, `playerSheep` HUD meter, viewmodel, VFX — untouched.
- Chat local echo is unnecessary offline — room chat broadcast reaches
  the local socket through the loopback like any peer.

### 3.5 Bonus: `P2PHost` upgrade path

`P2PHost` today is deliberately thin: no Room, no bots, no balls, no
flags. `LocalRoom` is exactly the primitive that upgrades it — host a real
Room, attach DataChannels alongside the loopback socket. Not required for
step 1, but the design should not preclude it (e.g. don't hardcode
"exactly one local player").

## 4. Risks and edge cases

- **Bundle weight**: Room + MessageHandler + CombatHandler + sims ≈
  +80–120KB min. Mitigate with dynamic `import()` on `?mode=` entry so the
  online path doesn't pay it.
- **Boot sequence becomes real**: offline must run handshake → gameState →
  roster → team assignment. Feature (same path exercised), but the fiddly
  part of the spike.
- **Local-player state latency-free assumptions**: health/respawn now
  arrive via gameState/tick. Anything in offline code that mutated health
  directly must go through Room (`applyDamage`, respawn claim — the
  `respawn` message type already exists).
- **`moveAuthority`**: Room ctor flag — offline wants the same
  client-authoritative-move default the dedicated server uses; verify.
- **Determinism**: `simNow = Date.now()` is wall-clock in-tab. Fine for
  play; if offline replays/soaks want sim-time, wire `simNowAdvance`.
- **Respawn timers are the known wall-clock edge** (server AGENTS note) —
  fine offline.
- **Rate limiter**: joins/claims through the loopback hit `RateLimiter` —
  legit, keep it on (identical rules); if it false-fires at 0ms latency,
  that's a real finding about the limiter.
- **Room teardown**: leaving offline mode must dispose Room sims —
  no `setInterval`s inside Room itself (TickLoop owns those), so teardown
  is "stop stepping it" + clear connections. Verify no timers leak.
- **`isBotId` / bot naming**: `botRoster` already names bots; ensure the
  killfeed/remotes paths see the same ids.

## 5. Plan

**Phase 0 — spike (prove the shape, no teardown)**
1. `LocalSocket` shim + `LocalRoom` construction: `new Room('local',
   getHeightfield(), 'nuggets', spec)` + register local player via the
   real join path.
2. Drive `room.sims` at fixed dt from `gameLoop`.
3. Minimal fanout (or reused `TickFanout`) → `tickUpdate` frames into
   `netHandlers`.
4. Gate behind `?mode=nuggets&localroom=1`; run alongside `TeamBots`
   for A/B.

**Phase 1 — parity**
5. Route local outbound messages through the loopback (join, input,
   shot claims, deploy, flag pickup, respawn, chat/VGS).
6. Verify: bots ski/hunt/cap; kill feed, respawn, scoreboard, match end,
   pickups, deployables, creatures all work via wire messages only.
7. E2E: extend `smoke.ts`/`duo.ts` to cover the loopback room.

**Phase 2 — teardown**
8. Delete the `TeamBots` family; remove `localAuthority`,
   `sweepLocal`, `localDriven`-for-bots paths.
9. Update `main.ts` offline setup to `new LocalRoom(...)`; lobby
   "offline" entries can reuse it or drop the distinction.
10. Docs: AGENTS.md map sections, ROADMAP, changelog.

**Phase 3 — optional**
11. `P2PHost` → hosts a real `Room` (bots/creatures/flags/balls in
    hosted games).
12. Sim-time offline mode via `simNowAdvance` for deterministic
    replays/soaks.

## 6. Validation

```bash
cd client && ./node_modules/.bin/tsc --noEmit
cd client && npx -y oxlint src
cd client && ./node_modules/.bin/vitest run
cd server_bun && bunx tsc --noEmit
cd server_bun && bun test
cd server_bun && bun test tests/scenarios/
bun _tools/e2e/all.ts
```

Note: `bun --watch` doesn't reload `../shared/` — restart after shared edits.
The vitest suite will need a fake-DOM `Room` harness or the loopback tests
can live in `server_bun` (Room already typechecks under bun).

## 7. Verdict

Recommended. This finishes an architecture the codebase is already
converging on (shared brain, browser-safe server modules, transport
abstraction, `getHeightfield`, `P2PLink`). It deletes a mirror layer that
has already drifted, makes offline = online-at-0ms, and produces the
`LocalRoom` primitive `P2PHost` needs. Sequenced as spike → parallel-run →
teardown, not a flag-day rewrite.
