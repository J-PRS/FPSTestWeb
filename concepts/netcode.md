# Netcode model — LAN-first, server-authoritative on damage

Cost constraint drives everything: cheap Bun WebSocket server, low tick
rate, thin messages. The client predicts, the server adjudicates.

## Authority split

| Thing | Owner | Notes |
|---|---|---|
| Your movement | client-predicted | position stream; server sanity-checks |
| Damage | server | hit claims + AOE claims validated against tracked projectiles |
| Projectile spawns | client-instant | spawn locally for zero-latency feel, bind server id after |
| Enemy AI | client-side | balls/crawlers/turretters/rollers are local sim (P2P-trust) |
| Kills/respawns | server | broadcast |

## The aoeShot/hitClaim hardening (tech debt pass)

Exploit surface that got closed:

- Every server-tracked projectile gets a `projectileId`; `aoeShot` claims
  must cite one plus `airtime`. `validateAoeClaim` recomputes reach from
  shared ballistic data (`shared/combat.ts` is single-sourced math).
- Slam has no projectile — blast bound to player's own position with a
  radius+20m reach cap.
- Wake/proxy hit radius (`hitRadiusAt`) is shared math so client and server
  compute identical hitboxes from airtime alone.

## Known soft spots

- **Enemy sim is client-trust** — a turret on your client isn't on theirs.
  Fine for co-op-ish messing around; a real release needs server sim or
  host-migration rules
- **Blink vs reconciliation** — mid-blink correction rubber-bands; not seen
  on LAN yet
- **Velocity inheritance** — 50% shooter-velocity on projectiles (Tribes
  Ascend style); server validates against the reported origin+vel, so a
  cheater can't claim impossible arcs

## Transport

`WebSocketConnection` is narrow (`string | Uint8Array`). Abstraction exists
for WebRTC/WebTransport later; nothing depends on it yet. `_run_tunnel.bat`
(cloudflared quick tunnel → :8000) + `_surge_deploy.bat <host>` is the
zero-cost "play with a friend" path.
