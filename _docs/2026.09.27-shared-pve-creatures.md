# Shared PvE creatures — feasibility & design options (2026-09-27)

Context: today **all creatures are client-local**. `entities.ts` + `waveDirector.ts`
run per-client with local RNG and timers; the protocol carries zero enemy
messages (verified — no creature types in `shared/protocol.ts`). Every player
sees a *different* ecosystem, kills/damage are self-reported
(`environmentDamage`, `heal`), and remote players see each other "shooting
nothing".

This doc collects the feasibility answer and the realistic paths to shared PvE.

## Feasibility: is server-simmed PvE affordable? — Yes, trivially at our scale

| Evidence | Number |
|---|---|
| Roblox JECS demo (comparable ECS+replication) | ~150 server-driven mobs ≈ **80 KB/s** downstream, AI 8Hz / movement 20Hz / client interp 60Hz |
| Our scale | ~40 enemies, few players |
| Our estimated cost | 40 × ~30B compact record (id+pos+vel+state) @ 10–15Hz ≈ **12–18 KB/s per player** |

40 steering sims on a Bun thread is negligible CPU. Interest management
(visibility filtering) costs ~10% more CPU and saves the majority of bandwidth —
but at 40 enemies it's unnecessary; file away for scale.

**The real cost is not bandwidth or CPU — it's the port.** `entities.ts` is
~900 lines tied to `THREE`, `Terrain`, and `deps.player()` *singular*.
Everything downstream of "shared world" needs a **retarget rule** — every enemy
currently chases *the* player. Standard cheap rule: nearest player + aggro on
last damager.

## Options

### 1. Server-authoritative sim (the "correct" endgame)

Server runs the creature sim, streams delta-compressed records ~12Hz, clients
interpolate exactly like `RemotePlayer` today.

- Pros: single truth, anticheat-ready later, kills/damage validated, host
  migration is a non-issue, slots cleanly into the existing tickUpdate
  machinery (binary records, suppression, `forceSendUntil`).
- Cons: the biggest port — creature sim must run headless (no THREE needed if
  sim state is plain vectors; terrain height lookup already exists server-side
  for spawn validation? — verify), plus retarget rule + per-player interest if
  scale grows.
- Bandwidth is fine; authoring effort is the bill.

### 2. Host-authoritative ("listen server") — recommended first step

First joiner (or lowest-ping client) runs the **existing sim unchanged** and
broadcasts compact creature state; the server is a dumb relay or light
validator. Other clients render + interpolate.

- Pros: reuses `entities.ts` verbatim — the sim code doesn't move, only its
  outputs get streamed. Zero server CPU. Matches the "efficiency and
  correctness" goal cheaply.
- Cons: host advantage (host's creature reactions are zero-latency, others see
  them delayed); host leave needs migration (elect next client, resend full
  state — creatures are ephemeral so a coarse resync is acceptable);
  host can lie about creature state (acceptable pre-anticheat).
- This is the classic co-op cheat (Deep Rock Galactic, most peer-hosted co-ops).
  Upgrade path: swap host sim → server sim behind the same message format;
  clients can't tell.

### 3. Closed-form trajectories (sneaky middle ground)

Server only announces spawn events: `spawn ball #42 at P, vel V, t=T0`.
Ballistic species (balls, baneling hops, turret bolts, roller arcs) are pure
`p(t) = p0 + v·t + ½g·t²` — every client solves the same equation and **no
position stream is needed**, only events (new hop/launch, retarget, death).

- Pros: near-zero bandwidth for the species it fits.
- Cons: only works for path-independent motion. Steering/chasing enemies
  (seeker, gnat, crawler pursuit, gnat clouds orbiting *a player*) are
  path-dependent — they need a target's live position, which reintroduces
  either a stream or deterministic input. Also: which player do they chase?
  Retarget rule again.
- Verdict: good optimization *inside* option 1/2 for the ballistic subset, not
  a standalone architecture.

### 4. Deterministic lockstep (rejected)

Shared seed, clients sim identically, wire carries only inputs.

- Fragile: FP non-determinism across JITs/browsers, `Math.random`/`Math.sin`
  sprinkled through AI, and creature AI depends on *player positions* — so
  "inputs" are effectively full position streams anyway.
- Lockstep shines at thousands of units with few inputs (RTS). At 40 enemies
  the stream is cheaper than the engineering. Skip.

## The retarget problem (applies to every option)

Current: all enemy update calls take `deps.player().pos` — one player.
Shared world needs, per enemy: `targetPlayerId` + position fed from remote
player state.

Cheap standard rule:

- **Acquire**: nearest living player within `AGGRO_DIST`.
- **Hold**: keep current target until dead/out-of-range/LOS-gone too long.
- **Aggro shift**: on taking damage from a non-target player (optional weight).

Client-side the player's own sim already has remote player positions
(`world.remotePlayers`), so a host-auth build can literally feed
`{me, ...remotes}` into the same update signature.

## Wire format sketch (host-auth version)

JSON for rare events, binary for streams — mirrors the existing protocol split.

```
// Rare (JSON):
creatureSpawn  { id, species, uber, pos, vel, t0 }      // announce
creatureDie    { id, killerId?, pos }                    // corpse pop is local FX
creatureEvent  { id, kind: 'pounce'|'launch'|'blink'|'drop'|..., pos? } // telegraphs

// Stream (binary batched, ~12Hz, delta-compressed like tickUpdate):
creatureUpdate { records: [{ id, pos, vel, state? }] }   // interpolation targets
```

- `id`: host-allocated (host playerId prefix + counter) — server needn't care.
- `state` byte: animation/aggro state so remote clients can play the same
  tells (charge-up, dive, planted vs airborne).
- Client damage claims on shared creatures get reported **to the host**
  (`creatureHit {id, dmg}`) — host applies them in its sim; death broadcasts
  back. Keeps hit registration instant-feeling while authority stays single.
- Migration: server elects new host on disconnect → new host sends full
  `creatureSpawn` batch for everything alive. Creatures are ephemeral (max ~40
  alive, seconds-to-minutes lifetime) — a coarse resync is acceptable.

## Recommendation

1. **Phase 1 — host-auth.** Extract a `target` param in entity updates (me +
   remotes), add the three message types, relay via server. Zero server CPU,
   days not weeks.
2. **Phase 2 (optional) — server sim.** If host advantage/migration proves
   annoying, port the sim headless behind the identical wire format. Clients
   already interpolate the same records.
3. Do **not** invest in lockstep or pure closed-form-only design; use
   closed-form interpolation *within* the stream for ballistic species if
   bandwidth ever matters.

## Open questions

- Do creatures need to damage *remote* players via the host too, or does each
  client still self-report `environmentDamage` when a shared creature hits
  *it*? (Self-report stays simplest: host sims contact, each client reports
  its own damage — same trust level as today.)
- Score/nuggets: are they per-player pools or shared world drops? Shared
  nuggets need ownership or first-claim rules.
- Server validation of `heal`/`environmentDamage` claims vs host-reported
  creature events — the seam where future anticheat hooks in.
