# Known issues, verification status, and repo state

Scope: what is open, what is verified, and what changed in the repo but is not committed.
Index: `readme.md`.

## Open issues

- **Session reject benches WebTransport: FIXED in code, not verified live.** A server
  `sessionRejected` (stale token, id claimed) used to bench a healthy WT tier for 30 s. `tiers.ts`
  now marks a session as rejected and skips the bench. Check the logs in a live join: a reject
  should not produce `session flapped — tier benched`.
- **Headhunt token sources (verified 2026-10-24).** Tokens come from player deaths: a victim's
  held tokens scatter from the corpse with the victim's velocity, plus a bounty coin
  (`roomScore.ts`, headhunt branch of the player-kill path). Tokens also come from a carrier
  leaving the room (`Room.ts`). Creature kills drop tokens too, but creatures are off, which
  does not remove headhunt tokens. An earlier note claimed otherwise; that was wrong.
- **Headhunt tokens: unverified.** Tokens now launch from the corpse with server velocity
  and tumble on the shared integrator. Deployed, not yet confirmed in a live round. Look for
  tokens arcing and falling rather than snapping down. If they still snap, capture
  `pickupSpawn` messages (with `vel`) and nugget logs.
- **Death desync: unverified.** Client-predicted death (`killLocal`) could leave `isDead` stuck
  when the server disagreed. Mitigation: `Player.deadConfirmedByWire`, and a server hit on a
  predicted corpse revives the seat (`game/net/players.ts`). Not verified live.
- **Remote ghost offset on WebTransport.** `ghosts.max` reached 51 m on fast movers, mostly on
  the wire-to-ghost gap (`wg`). Tracked in the netcode audit. Re-measured 2026-11-05 after the
  `remoteDeployables` flash-bind fix (`ghostsoak.ts --secs 120 --bots 12 --map lagoon --net wt`,
  commit 8b0e3e26): `rg` p95 0.19 m / max 1.9 m, `rw`/`wg` p95 ~9 m / max ~31 m — the spawn
  exceptions were spamming the remote-entity path; still worth a WAN re-check before beta.
- **Hit-desync logs:** `[StateHash] DESYNC DETECTED` appears on death edges, as in the
  2026-10-24 diagnostic dump (`isDead: client=true server=false`).

## Verification status

| Check | Result | Date |
|-------|--------|------|
| Client `tsc --noEmit` | clean | 2026-11-05 |
| Server `bunx tsc --noEmit` | clean | 2026-11-05 |
| Full server `bun test` | 1572 pass, 1 fail: `capper run > real T2 Katabatic stands` — the only remaining scenario red, failing on clean HEAD since at least 2026-10-24. Real bot-capability gap, not test debt | 2026-11-05 |
| Client `vitest run` | 683 pass, 0 fail — the `workerTransportDrain` failure is gone (fixed by intervening commits) | 2026-11-05 |
| Client `oxlint src` | exit 0, warnings only (main.ts complexity cluster is the bulk) | 2026-11-05 |
| `bash _tools/check.sh` | not run this cycle; rootcheck verified green standalone | 2026-11-05 |
| WebTransport browser handshake to `play.jprice.app:443` | READY | 2026-10-24 |
| WebTransport live match (direct IP) | 14 bots, ~48 ms ping, 5% loss, held through respawns | 2026-10-24 |
| Headhunt token behaviour live | not done | - |

Three scenario failures predate this work. They also fail on a clean `HEAD` export:
- `blast knockback distance > disc pull blast displaces the victim but does not catapult them`
- `capper run on real terrain > 300m stands on peaks.bin`
- `capper run on real terrain > real T2 Katabatic stands`

## Uncommitted repo changes from this work

> Historical (2026-10-24 snapshot) — superseded; see `git status` for the
> live tree. The casing note below is resolved: git tracks `deployment/`
> lowercase consistently.

Server (`server_bun/src`):
- `roomScore.ts`: headhunt creature-drop tokens launch from the corpse with velocity.
- `RoomPickups.ts`, `Room.ts`: the pickup snapshot carries `vel`.
- `config.ts`: `wtAdvertisePort` (`FPS_WT_ADVERTISE_PORT`).
- `serverRoutes.ts`: `/wthash` advertises `wtAdvertisePort`; `/ping` route.

Client (`client/src`):
- `entities/Nugget.ts`: `relaunch`, `atRest`.
- `game/net/pickups.ts`: server velocity replaces local spread; re-spawn handling.
- `entities/Player.ts`, `game/net/playerKill.ts`, `game/net/players.ts`: `deadConfirmedByWire`.
- `main.ts`: URL pinning, `reviveLocal` guard.
- `core/params.ts`: `/pub/` and `/jp/` path aliases.
- `networking/endpoints.ts`: `NAMED_SERVERS`, explicit `ws(s)://` and `https://`.
- `client/public/server.json`: default `https://play.jprice.app`.

Docs: `DEPLOYMENT/`.

Other files in `git status` were modified before this work. Do not stage them with this change.

Folder casing: git shows `deployment/` as untracked; the docs live in `DEPLOYMENT/`. On Windows
these are the same folder. Pick one casing before committing.

## Before committing

1. `cd server_bun && bun test` (full suite)
2. `cd client && ./node_modules/.bin/tsc --noEmit`
3. `cd client && ./node_modules/.bin/vitest run`
4. `bash _tools/check.sh` (the repo's definition-of-done gate)
5. Review the diff and the file list above.
