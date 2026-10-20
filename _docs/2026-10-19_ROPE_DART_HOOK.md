# Rope Dart (Hook) — reference

Belt item. A thrown rope dart that is a **momentary reel**, not a sustained
grapple (the T:V-style tether is a possible later weapon). One contact, one
impulse, rope snaps.

## Rules

- **Terrain/structure/anything-else connect** → the *thrower* is reeled toward
  the anchor point (the movement tool).
- **Body connect** → the *victim* is reeled toward the thrower
  (get-over-here). Works on friendlies — reeling your flag carrier home is an
  assist. Spawn-shielded enemies are exempt, same gate as blast shove.
- **Whiff** (fuse expiry mid-air, no contact) → snapped line, *nothing
  happens*. No reel, no payload.

No damage, no splash — the yank is the entire payload. `aoeRadius: 0`,
`directDamage: 0`.

## Impulse model — `aim`, not `pull`

Blast shove has two stock flavors (`BlastRunner.shove`, `playerImpulse`):

- `push` — away from center + `+0.5` up-pop
- `pull` — horizontally toward center + `+0.3` up-pop (disc-suck flavor)

The hook adds a third: **`aim`** — the dv is the unit vector *toward the
anchor* (or toward the shooter for a victim reel), vertical component
included, **no up-pop**. A high wall reels you upward; a flat wall doesn't
pop you off the ground.

Wire side: the `knockback` message carries `pull: true` plus a `yank` flag
(`shared/worldModel.ts`, `protocol.ts`). `yank` tells the victim's client to
aim at `position` directly and skip the up-pop, so the wire echo and the
shadow dv agree. It also exempts the message from the
"knockback-without-prediction" phantom-explosion path — a reeled victim
never predicted a blast (`game/net/players.ts`).

## Force tuning

`knockbackForce: 18` in `shared/weaponTable.ts` `[WeaponType.Hook]`.

Important: a flat impulse hits *much* harder per point than a blast. Disc's
45 only reaches peak at the T1 impulse curve's sweet spot — the hook pays
full freight at any range (it's `force`, not `force × falloff`). 18 lands
about half a good disc jump. 40 was ~5 disc jumps and read as broken.

Flight: `speed 110`, `gravity: false` (ropes fly flat — a drooping line
can't reach what you aimed at), `maxLifetime 0.45` ≈ ~50 m of rope.

## Server path

`RoomProjectiles.detonate` → if `weaponType === Hook`:
- `directHitId != null || proj.p.age < proj.ttl` (a real contact, not fuse
  expiry) → `messages.grapple(ownerId, at, victimId)`
- then `return` — never reaches `serverBlast` (no blast exists to claim).

`grapple` lives on `BlastRunner` (`combatBlast.ts`) and forwards through
`MessageHandler`/`CombatHandler` like `serverBlast`. It computes the aim
vector itself and calls `shove` with `{ pos, pull: true, aim }` — velocity
write, `impulse` emit, wire knockback, and `forceSend` all ride the proven
path.

## Client path

- `projectiles/types.ts`: `hook?: boolean` config flag.
- `beltConfigs.ts` `HOOK_CONFIG`: javelin mesh, `noExplosion`, **`ribbonTrail:
  false` mandatory** — ribbons default ON (`projectileVisuals.ts` opt-out),
  and a default 3-lane glow ribbon reads as "rocket". No trail, no glow —
  a dart with a rope is the read.
- `Projectile.setRope(from)` / `hideRope()` / `ropeTo` / `ropeT` /
  `ropeActive`: a shared 5-vert cylinder stretched thrower→dart every frame.
  Near-black (`0x1A140C`), radius `0.05`. Anchored at **chest** (`pos.y - 0.7`)
  in `updateProjectiles` — an eye-mounted rope starts inside the shooter's
  own camera.
- On a real connect, `explode()` sets `ropeTo` (terrain anchor, or the
  victim's *live* position repointed per frame on body hits) and `ropeT =
  0.55` — the rope stays drawn through the reel; the moving end sliding
  along the taut line IS the pull animation. `ropeT` holds the shell alive
  via the `settled()` death gate. Whiff → rope dies with the dart.
- `impact.ts` `hookConnect`: predicts the owner reel (`applyPull(anchor,
  mag, yank=true)` + `selfBlastStamps` entry so the wire echo dedupes),
  dead-reckons a victim reel via `applyPredictedKnockback`, and handles
  the "a bot hooked me offline" case. Early-returns on whiffs.
- Belt plumbing: `Player.BELT_ITEMS` `'hook'`, `loadoutMenu` label "Hook",
  `fire.ts` `BELT_CONFIGS` entry, `botLoadouts` wildcard belt pool.
- Sfx (`core/sfx/weapons.ts`): `dash2` whoosh + high `hg_tick` zip = the
  line unreeling. Synth fallback mirrors it.

## Test

`server_bun/tests/scenarios/hook.test.ts` — terrain connect yanks the
thrower toward the anchor; body connect yanks the victim toward the
shooter, pays zero health.
