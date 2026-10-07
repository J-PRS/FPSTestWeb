# Claimless Combat — migration spec

Kill the claim layer. Combat predicts/reconciles exactly like movement:
client sends a fire *intent*, the server sims the shell authoritatively,
outcomes are server-derived broadcasts, never client claims.

## Why

The claim path (`shot`/`aoeShot`/`heal`/`envDamage`) is a client-decides,
server-rubber-stamps model. Every desync class we keep patching —
'flight blocked', 'end beyond reach', 'no known projectile',
'dropped deferred claims', shotId nonce pairing, spawn-vs-hit binding —
exists because two parties each derived an outcome and must now agree.
With one sim, agreement is structural: the client predicts, the server
decides. Prediction errors are visible and rare; adjudication code dies
entirely (~1.4k lines server + ~200 client claim ledger).

## What already exists (verified)

- `shotFired` intent wire type (weaponType + dir) — currently a cosmetic
  relay; `handleShotFired` rewinds origin via `rewindPos(clampPing)`.
- `RoomProjectiles` — full server shell sim (projStep, terrain sweep,
  structure colliders, player capsules, contact/blast funnels into
  CombatHandler). Bot-fired shells already run end-to-end authoritative.
- `projectileCreated`/`projectileDestroyed` broadcasts carry `shotId` —
  the predicted-shell binding echo already exists.
- Client `spawnProjectile` instant-spawns the local shell with a minted
  `shotId` nonce — predicted shell + binding nonce both exist.
- Predicted feedback: `predictDamage`/hitmarker, blast knockback
  (`applyForceToRemotes`/`applyExplosionForce`), self-splash impulse —
  all local and unchanged.
- `rewindPos` lag comp in claimLedger.ts.

## Target: fire intent → one sim

### Wire

- `shotFired` gains `shotId?: string` + `pos?: Vec3` (spawn origin hint
  for the predicted-shell binding; server still derives truth from
  rewindPos + player vel).
- `shot`, `aoeShot` deleted for simmed weapons (pilot: BoltLauncher).

### Server (`handleShotFired` for pilot weapons)

1. Gates: player alive, weapon allowed for class, fire-rate limiter.
2. Origin: `rewindPos(player, clampPing(ping))` + eye height.
3. Velocity: `dir * stats.speed + playerVel * 0.5` — same formula the
   client predictor runs (deterministic, shared/weapons.ts constants).
4. Spawn LiveProj via RoomProjectiles (existing path bots use).
5. Broadcast `projectileCreated` to ALL clients including the shooter,
   echoing `shotId` — that echo is the predicted shell's birth cert.
6. Contact in RoomProjectiles → existing blast/hit funnels → playerHit /
   projectileDestroyed broadcasts. No claim processing.

### Client (pilot weapon only)

1. Trigger: spawn predicted shell (unchanged path), mint `shotId`,
   send `shotFired` intent — never `sendShot`/`sendAOEShot`.
2. On `projectileCreated` where `ownerId === self && shotId` matches a
   pending shell: stamp `projectileId`, mark `netConfirmed`. If the
   server-derived spawn pos differs > small eps, snap the replica (the
   shell is ~1 frame old — invisible).
3. No echo within ~RTT×3 → the intent was rejected (rate/dead) →
   despawn the predicted shell quietly (no detonation FX).
4. Detonation FX on predicted contact stays local; *damage* waits for
   `playerHit`/`projectileDestroyed` — hitmarker predicted, refund on
   server echo if it never comes (rare).

### What dies (pilot scope)

- `sendShot`/`sendAOEShot` calls for BoltLauncher.
- Server claim handlers for that weapon: `shotClaims` spawn-claim
  replay, `arcBlockedAt`, defer/bind/notifyDrop for BoltLauncher claims.
- `projectileRegistry` shotId binding survives — it becomes the echo
  binding, same map.

## Costs (accepted)

- Damage confirms land ~half-RTT later; predicted hitmarker covers feel.
- A predicted shell can detonate visually on a wall the server sim says
  missed — rare (shared sim), FX-only divergence, no damage.
- Server CPU grows per live shell — bounded by ttl × cadence × players;
  soak already runs 16-bot fleets.

## Phases

1. **Pilot**: BoltLauncher end-to-end (intent → server sim → echo bind).
   Metrics: shotRejected classes for BoltLauncher reach zero; no
   'flight blocked'/'no known projectile' warns can exist by construction.
2. **Generalize**: weapon table flag `serverSimmed: true`; all ballistic
   weapons move; hitscan keeps `playerShot` cosmetic + server raycast.
   Status: `SERVER_SIMMED_WEAPONS` now covers every kind the server sim
   models — contact pops (Bolt/Disc/PlasmaGun/PlasmaCannon/ImpactGrenade/
   Javelin), bounce+arm+fuse shells (Grenade, GL, Mortar, Sticky, Conc),
   cluster carriers (ClusterBomb, MRV), rail discharge (RemoteRailgun),
   and heal/armor payloads. Intent path enforces belt charges, class
   locks, and a 20/s flood window (the cosmetic 50ms relay throttle
   bypassed — a dropped intent orphans a predicted shell). Excluded:
   burst fans (one intent → N pellets needs per-pellet echo binding),
   ProximityGrenade + SatchelCharge (client-triggered — need a
   detonate/proximity intent), and hitscan/beam (no shell body).
3. **Demolition**: delete `shot`/`aoeShot` wire types, shotClaims.ts,
   claimLedger defer/bind machinery, envDamage/heal claim paths get the
   same intent treatment or stay self-only-claims (they're low-risk).
