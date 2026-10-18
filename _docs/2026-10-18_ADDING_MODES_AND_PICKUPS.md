# Adding a Game Mode or Pickup Type — the blast surface

Field notes from building `headhunt` + the `token` pickup (2026-10-18).
This is the checklist of every file a new mode or pickup kind must touch,
grouped by layer. Order matters: shared → server → client → tests.

## Adding a PickupKind

### Shared
- `shared/pickups.ts` — the `PickupKind` union. If it's not a buff,
  exclude it from `PowerupKind` too.
- `shared/worldModel.ts` — pickup fields only if the kind needs extra
  wire state beyond id/kind/pos/vel (token needed none).

### Server
- `server_bun/src/RoomPickups.ts` — `scorePickupKinds` decides which kinds
  route to `host.onScorePickup` vs `onPowerup`. Anything new that drops
  from deaths/creatures also goes through `add()` automatically.
- `server_bun/src/roomScore.ts` — `onScorePickup` switch: what a touch
  does (score, belt charge, held counter). `addPickup`/`scatterGems`
  call sites for death/creature drops.
- `server_bun/src/Room.ts` — collect path: `RoomPickups` reports a
  touch; the room decides legality (teamless players can't score).

### Client
- `client/src/entities/PickupModel.ts` — geometry + accent per kind
  (token = octahedron, scaled ~1.3×, `beam: true` part flag).
- `client/src/entities/Nugget.ts` — per-kind render extras (the beam
  sprite is built/faded/disposed here, riding the existing tumble).
- `client/src/game/net/pickups.ts` — spawn/gone edges → Nugget replicas;
  collect reward table (what a local grab feels like).
- `client/src/demo/types.ts` — demo pickup-kind index table or the kind
  won't resolve in demos/posedump.

Physics (tumble, knockback, rest correction, 50ms-cell replay) is free —
it lives in `RoomPickups`/`Nugget` keyed only by pickup id.

## Adding a Mode

### Shared
- `shared/teams.ts` — `ModeId` union + `ModeSpec` (team scoring, timer,
  flags/gates).
- `shared/mapSpec.ts` — default legal mode list for maps; individual
  map JSONs may also whitelist modes (`maps/*.json`).
- `shared/protocol.ts` — any new ServerMessage/ClientMessage members
  (`playerHeld` for headhunt) + roster/local-state fields.
- `shared/worldModel.ts` — declare new player fields (`held`) and new
  event verbs with their field lists. Wire is law: if it's not declared
  here, the conformance tests will (correctly) reject it.

### Server
- `server_bun/src/types.ts` — `PlayerState` field.
- `server_bun/src/PlayerManager.ts` — init on create, reset on respawn,
  include in `toGameStatePlayer` (joiners get current values).
- `server_bun/src/roomScore.ts` — mode-specific score math. Headhunt
  recomputes team score as a live sum (`resyncHeld`) instead of banking;
  death scatters `held + base` and zeroes the carrier.
- `server_bun/src/Room.ts` — collect dispatch per mode, leaver/death
  hooks, mode seeding at match start.
- `server_bun/src/MessageHandler.ts` — event emission + serialization
  of new state into `gameState`/`localState`.

Key wire decision for headhunt: `held` rides the JSON roster + a rare
`playerHeld` edge event — NOT the binary tick frame. Rare-changing ints
don't belong in the high-frequency packed channel.

### Client
- `client/src/networking/NetworkManager.ts` — remote state field +
  message handler.
- `client/src/networking/wireIn.ts` — dispatch the new message type.
- `client/src/game/net/world.ts` — restore the field from gameState
  (join/reconnect).
- `client/src/game/net/players.ts` — patch remote state on the event.
- `client/src/game/remotes.ts` — feed it into the indicator/healthbar
  path.
- `client/src/ui/hud/indicators.ts` + `hud.css` — overhead badge
  (team-colored, count-scaled, cached DOM writes).
- `client/src/ui/hud/dom.ts` + `hud.ts` + `client/src/game/gameLoop.ts`
  — prominent local counter; mode-gate it so other modes keep their
  existing HUD.

### Tests
- `server_bun/tests/headhunt.test.ts` — mode rules end-to-end via the
  harness (collect→held→score, death→scatter, leaver, teamless).
- `server_bun/tests/worldModel.test.ts` — update pinned field sets when
  you add declared fields, or it fails for the right reason.

## Traps hit during headhunt
- **Creature drops roll an independent powerup** — tests asserting "all
  drops are X" flake; assert "no gem" instead.
- **Mode availability is 3 places**: `teams.ts` ModeId, `mapSpec.ts`
  defaults, per-map `modes` whitelist.
- **Joiners vs live updates are separate paths** — a field in
  `toGameStatePlayer` alone leaves live clients stale; you need the
  event too (and vice versa).
- **`localState` is not the roster** — the local player's own copy of
  new fields needs its own serialization or the local HUD won't see it.
