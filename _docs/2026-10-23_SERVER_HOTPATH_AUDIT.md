# Server hot-path footgun audit — 2026-10-23

Follow-up to the perf arc (`b8e31e93` chord-lattice, `5c08fcb5` publish-fanout,
`e6183494` rewind amortization, `28136805` Math.hypot → dhypot*, `4c442fca`
reconcile squared-distance fast path). This is a *read* of `server_bun/src/`
for remaining per-tick allocations and hot-loop antipatterns — not a profile
run. Ordering is by expected payoff per unit of risk, not by severity.

**Status legend:** `[ ]` todo · `[~]` started, unlanded · `[x]` done

---

## 1. `projStep` allocates a `Vec3` per projectile per tick  `[ ]`

`shared/projSim.ts:22`

```ts
export function projStep(p, dt, gravity): Vec3 {
  const from = Object.assign({}, p.pos);   // <-- allocation, every call
  ...
  return from;
}
```

The returned pre-step position feeds swept collision (`stepContact`,
`catchRiders`) and is read-only in every consumer —
`server_bun/src/projContact.ts` only does `from.x/y/z` arithmetic.

Same pattern repeats inside the projectile tick itself:

- `server_bun/src/RoomProjectiles.ts:308` — `proj.stuck ? Object.assign({}, p.pos) : projStep(...)`
- `server_bun/src/RoomProjectiles.ts:309` — `this.detonate(proj, Object.assign({}, p.pos))`

**Fix:** give `projStep` an optional `into?: Vec3` scratch and reuse one object
per `RoomProjectiles` instance; replace the two `Object.assign({}, p.pos)` sites
with property writes into the same scratch. `Object.assign` also walks
enumerable keys — a literal `{x,y,z}` write is cheaper even when allocating.

**Why it's safe:** the scratch is consumed synchronously (`catchRiders` then
`stepContact`) before the next projectile in the loop calls `projStep`, so a
single reused object per room is correct. Client callers
(`client/src/lab/simKit.ts`, `client/src/lab/scenarios.ts`) keep the allocating
form by passing nothing.

**Risk:** low. Covered by `bun test` projectile/ball suites + E2E smoke.

---

## 2. 55 remaining 3-arg `Math.hypot` calls  `[ ]`

`28136805` migrated the hottest five files (moveJudge, ballCombat, BallSim,
beamSweep, RoomMoveSim) to `dhypot2`/`dhypot3`. Remaining clusters:

| File | count | hot? |
|---|---|---|
| `botArsenal.ts` | ~15 | bot brain is 4 Hz staggered — warm, not hot |
| `combatBlast.ts` | ~5 | per AOE event |
| `CombatHandler.ts` | ~5 | per shot/damage event |
| `projContact.ts` | ~3 | per projectile contact test |
| `Room.ts` | ~4 | proximity scans (throttled) |
| `CreatureSim.ts` | ~4 | creature step |
| `claimLedger.ts`, `combatAoe.ts`, `botBeam.ts` | 1 each | event paths |

`Math.hypot` with 3+ args allocates an arguments array in V8/JSC; `dhypot3`
takes three scalars. `projContact.ts` and `CombatHandler.ts` are the ones that
compound with projectile/fire volume.

**Fix:** mechanical swap to `dhypot3` / `dhypot2` (already imported in several
of these files from the earlier migration). No behaviour change — `dhypot3` is
the same formula.

**Risk:** very low.

---

## 3. `JSON.stringify(Object.assign({}, msg, {ev: seq}))`  `[ ]`

`server_bun/src/ConnectionManager.ts:210`

Builds a throwaway object then serialises, per outbound JSON message. The
binary `tickUpdate` path already bypasses JSON (`ConnectionManager.ts:329`
comment confirms). This is the fallback/envelope path.

**Fix:** only worth it if a high-frequency message rides it. Inline the `ev`
field into a single object literal (`{...msg, ev: seq}` is still an allocation,
but one instead of two-into-one). Better: check whether `seq` can be appended
during the existing serialise step. **Verify with `/wire` meter before
touching** — if JSON fallback traffic is negligible, leave it.

**Risk:** low, but measure first.

---

## 4. Spatial grid rebuilt per tick in `RoomMoveSim`  `[ ]`

`server_bun/src/RoomMoveSim.ts:~620`

Per tick, per controller with bodies:

```ts
const grid = new Map<number, number[]>();
for (...) { ... grid.set(k, [i]) }
...
idx.sort((a, b) => a - b);       // per query
for (const i of idx) { scratch.push(bodies[i]!) }
```

The 4 m cell grid, one `number[]` per occupied cell, and the per-query sort are
all fresh garbage every tick. It is correct and bounded, and the comment
justifies the 4 m cell size and the sort (contact order parity with the flat
scan). But it is O(bodies) allocations per tick.

**Fix:** reuse a persistent grid — flat typed arrays (`Int32Array` cell heads +
linked list, or `Map` cleared with generation stamps instead of `new Map`),
and sort only the *indices within the 3×3 ring* (bounded, small) rather than
allocating a fresh `idx` array. Keep the sort: it is load-bearing for contact
resolution order.

**Risk:** medium — order sensitivity is documented in the comment. Land with a
scenario test asserting contact-order parity before/after.

---

## 5. `[...map.values()].filter().map()` roster builders  `[ ]`

| site | path | note |
|---|---|---|
| `RoomFlags.ts:154` `snapshot()` | **`flagUpdate` broadcast** | 3 objects per flag, every flag send |
| `Room.ts:669` `noteChatPace` | chat/taunt only | rare |
| `Room.ts:880` | ? | inspect |
| `Room.ts:1168` | per-tick bot list? | **inspect** |
| `RoomDeployables.ts:274` `roster()` | joiner/snapshot | |
| `RoomPickups.ts:86` `snapshot()` | joiner/snapshot | |
| `BallSim.ts:161` `roster()` | joiner only | nested `Object.assign` × 4 |
| `roomScore.ts:48` | scoreboard send | |
| `TickLoop.ts:427` `stateHash` flag lane | hash lane (not every tick) | |

The only one on a *repeating broadcast* is `RoomFlags.snapshot()`; the rest are
join/snapshot or low-frequency. `Room.ts:1168` needs a look — if it runs per
tick it is the expensive one.

**Fix:** hand-rolled `for (const v of map.values())` + preallocated array where
the path repeats. For `RoomFlags.snapshot()` specifically, avoid
`Object.assign({}, f.pos)` / `Object.assign({}, f.home)` by writing literals.

**Risk:** low per site; measure `Room.ts:1168` first.

---

## 6. Nested `Object.assign` for power-scaled AOE stats  `[ ]`

`server_bun/src/combatBlast.ts:475` (also `combatAoe.ts:105`, `:157`)

```ts
const stats = power === undefined ? base
  : Object.assign({}, base, { aoeDamage: base.aoeDamage * power, ... });
```

Clones the whole stats record to vary three fields, per blast. Trivial relative
to the AOE scan that follows, but it is the same "clone to vary N fields" smell
and appears three times.

**Fix:** a `scaleAoe(base, power)` helper returning the three scaled fields plus
a reference to `base` (or a small typed struct), so no full spread.

**Risk:** low — but keep the exact multiplier formula; client prediction
mirrors it and any drift desyncs the blast envelope.

---

## Checked and clean

- **`TickLoop.ts`** — no `JSON`, no unbounded spreads, no per-tick clone of
  the player roster beyond the intentional `getAllPlayers().values()` walk.
- **No `.slice()`** inside server loops.
- **`Math.random` / `Date.now`** confined to seeding (`roomFactory`,
  `leaderboard`, `PlayerManager.spawnRng`), IDs (`resultSigner.nextMatchId`,
  `roomDemo` filenames), and journal/trace timestamps — the sim-determinism
  gate (`shared/` bans `Date.now`/`Math.random`/`new Date` in the pre-commit
  hook) looks intact. Spot check: `RoomProjectiles.ts:266` uses `Date.now()`
  for a *trace* `t`, not sim state.
- **`wireTx`/`wireRx`** already went to a kind table (`28906bbb`); no remaining
  per-send `Map` churn found in `ConnectionManager` beyond the JSON path above.
- **No `Array.from` / spread inside per-tick tick functions** (the six
  `Array.from` sites are ops/metrics/drain paths).

## Suggested order

1. **#1 projStep scratch** — pure win, zero behaviour change.
2. **#2 dhypot3 sweep** — mechanical, shrinks the args-array tax in
   `projContact` / `CombatHandler`.
3. **#4 grid reuse** — biggest remaining structural allocation, but needs the
   contact-order parity test.
4. **#5** — inspect `Room.ts:1168`; fix `RoomFlags.snapshot()` only if flag
   updates measure hot.
5. **#3 / #6** — tidiness; measure with `/wire` and the AOE path before touching.

## Measurement note

None of the above has a before/after profile yet. `bun _tools/profload.ts
--bots 64 --secs 40` is the tool; run it before and after each landed item and
record the phase deltas here (append a "Measured" subsection per item).
