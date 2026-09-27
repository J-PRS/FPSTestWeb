# Offline play / client-server logic sharing — plan (2026-09-28)

Commissioned by JP: "Make a plan how to share logic where appropriate between
client and server so we can support offline play ie enemy AI etc."

## What the server actually does today (the offline gap)

Enemy AI, spawning, wave director, terrain, physics are **already client-side** —
offline PvE needs no AI port at all. The server (`server_bun/`, ~3.6k lines) is a
thin authority, not a simulator:

| Server responsibility | File | Offline impact |
|---|---|---|
| Hit-claim validation (origin/airtime/ownership/radius) | `validation.ts` (216) + `CombatHandler.ts` (408) | Single player has no shooters → mostly dead code offline, but **env damage & heal flow through it** |
| Health bookkeeping + death/respawn timer | `PlayerManager.ts` (193) | `playerHit`/`playerDied`/`respawn` drive `player.health`, `showDamage`, kill feed |
| Position validation (>300 m/s correction) | `validation.ts` + `MessageHandler` | No-op offline (nothing to correct) |
| Bouncy-ball sim → `ballSegment` broadcasts | `BallSim.ts` (252) → `shared/ballSim.ts` | Balls freeze without a segment source |
| Roster/scoreboard/timer broadcasts | `GameServer.ts` | Scoreboard empty; fine or synthesize |
| Demo recording | `DemoStorage.ts` | Optional offline |

So "offline" = **a local authority that makes the same decisions the server
makes**, not a big port. Client code paths are already structured for it:
`netHandlers.ts` treats the server as an event source, `NetworkManager` as a
send sink. The work is defining that seam and filling the local impl from
`shared/` pieces.

## The seam — `NetAuthority` interface

Everything the client asks of the server is either a **send** (`sendShot`,
`sendAOEShot`, `sendEnvironmentDamage`, `sendHeal`, `sendTeleport`,
`sendPosition`, `sendProjectileDestroy`, `sendJump/Jetpack`, `sendInputMove`)
or a **callback** (`onPlayerHit`, `onKnockback`, `onPlayerJoined/Left`,
`onBallSegment`, `onGameState`, ...). That's already the shape — the task is to
name it:

```ts
// client/src/networking/authority.ts
export interface NetAuthority {
  readonly online: boolean;
  connect(): Promise<void>;          // local impl resolves immediately
  // sends (validated+applied locally when offline)
  sendShot(...)/sendAOEShot(...)/sendEnvironmentDamage(...)/sendHeal(...)/
  sendTeleport(...)/sendPosition(...)/sendProjectileDestroy(...)/
  sendJump(...)/sendJetpack(...)/sendInputMove(...)
  // callbacks the client wires (netHandlers does today)
  onPlayerHit/onKnockback/onPlayerJoined/onPlayerLeft/onBallSegment/... 
}
```

- `RemoteAuthority` — thin wrapper around the existing `NetworkManager`/
  `WebSocketConnection`. Nearly a rename; send methods delegate, callbacks
  pass through.
- `LocalAuthority` — in-process impl. Synthesizes `playerHit` (env damage &
  heal against local health), `knockback`, `ballSegment` (from local BallSim),
  and a `gameState`/`playerJoined` for the local player. Handles connect,
  respawn countdown, run timer.

`netHandlers.ts` binds to `NetAuthority` instead of `NetworkManager` concretely;
main.ts picks impl by URL param / failed connect / menu flag
(`?offline`, or auto-fallback when `connect()` rejects — recommend explicit flag
first; silent fallback confuses "why is nobody here").

## What moves to shared/ (and what doesn't)

Move (server imports these today, LocalAuthority will too):

1. **`validation.ts` hit-claim math → `shared/hitClaims.ts`** — the pure part:
   airtime window, hit-radius for weapon, spawn-origin bounds, rate caps.
   Keep the return type the server uses. Server + local authority both call it.
   (Already accompanied by shared `aoeDamage`/`weapons.ts` tables — no changes.)
2. **BallSim driver → `shared/ballDriver.ts`** — `server_bun/BallSim.ts` already
   wraps `shared/ballSim.ts`; extract the *tick loop + segment emission* (the
   glue, ~150 lines of `BallSim.ts`) so both the server broadcaster and the
   local authority run the identical driver. Client replay stays untouched.
3. **Health/respawn bookkeeping → `shared/lifecycle.ts`** — tiny: clamp
   `applyDamage` → `{killed, newHealth}`, respawn delay, kill credit.
   `PlayerManager.applyDamage` is already nearly pure; pulling the pure core
   out avoids two divergent health rules.

Don't move: enemy AI (client-only, single-player needs the full set — the
shared-PvE targeting aggregator is the only piece that's server-mediated; for
offline, `reportTargetDamage` just routes straight to the local threat table),
position validation (no peers to protect), `DemoStorage` (server file I/O —
offline demos already have a client-side path via demoLifecycle).

## Bots for offline PvP flavor

The `_tools/pvptest/bot.ts` protocol bot proves a fake player only needs a
position stream + legal shot claims. An in-game `LocalBot` (subclass
`RemotePlayer`, drive `pos/vel` from the same `SkillsCtx`-style mover) gives
"versus" matches offline without the server — its shots feed the same local
authority hit-claim path, so the validation code is *exercised* offline
instead of skipped.

## Slices (each independently committable, no behavior change until slice 4)

1. **Name the interface.** `networking/authority.ts` types + `RemoteAuthority`
   wrapper; main/netHandlers swap `NetworkManager` for `NetAuthority`. No-op.
2. **shared extractions.** `hitClaims.ts`, `ballDriver.ts`, `lifecycle.ts`;
   server refactors onto them; `bun test` must stay 91/91.
3. **`LocalAuthority`.** Health/respawn/env-damage/knockback local resolution +
   local ball driver + synthetic roster. `?offline` flag; client boots a full
   match with enemies (already local) and working balls.
4. **LocalBot.** Optional `--bot` count in offline mode; RemotePlayer subclass
   with the bot-harness mover logic ported in.
5. **Auto-fallback + UI.** Offer "offline" when connect fails.

## Effort

Slices 1–3 ≈ one session (the hard part is already done: server logic is thin
and shared modules exist). Slice 4 adds a bot driver — another session
including QA. Main risk: health currently lives in two places (server
PlayerManager vs player.health assigned on `playerHit`) — the local path must
write health the *same way* (authoritative number → assign, never decrement)
or the two modes diverge.

## Explicitly out of scope

Server-side enemy AI for real MP (enemies stay per-client sims; shared-PvE
consistency is a separate problem), persistence/saves, lobby UI beyond a flag.
