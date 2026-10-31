# Bot multitasking plan — eyes, feet, hands as separate lanes

**Context.** Headhunt exposed the structural limit: bots hunt ONE thing
(`st.hunt`), and that one thing drives aim, fight position, and feet.
A human holds several tracks at once — ski toward the carrier, hose the
guy in your face, scoop the nuggets you pass. This doc audits the current
lanes and plans the split.

## Audit — what exists today

`shared/botBrain.ts` drives `shared/botHunt.ts`:

| Lane | Where | Reality |
|---|---|---|
| **Aim target** (`st.hunt`) | `pickHunt` | One enemy — `best` (nearest visible) else `thief` (flag beacon) else `spotted` (squad callout) else `ghost` (pursue memory). |
| **Fire** | `pickFire` | Shoots `st.hunt` only — reaction ticks, reach gate, suppressive fire on the stale ghost. |
| **Feet** | `planFight`/`pickGoal` | `fightPos` orbit when enemy within `st.orbitFar`; else the brain's goal pick (objective/economy/wander). |
| **Objective override** | `ctx.runner`/`ctx.wave` | The only existing feet-vs-eyes split: runner/wave orbit shrinks to 45m and feet resume the run the tick the fight ends — "he still FIRES off st.hunt, only the position commitment shrinks." |
| **Non-LOS lanes** | `thiefBeacon`, `nearestSpot`, ghost | Flag thief, squad spot-report, and last-seen pursuit are already legal-no-LOS targets. |
| **Bounty read** | `scanVisible` | `held ≥ 10` bypasses LOS; `effD = d · (1 − held·0.03)` prices hoards closer. Tuned 2026-10-30 from a dead 27/0.008. |
| **Economy** | `pickGoal` economy rooms | Nugget farming runs when no threat outranks it — "a bot keeps farming past a firefight across the map." |
| **Commitment** | `fightHold`, `unreachUntil`, `dreadOf`, `foeScore` | Anti-twitch: held spots survive small score deltas, unreachable prey drops acquisition, nemesis memory shapes picks. |

**The gap:** `st.hunt` is a single target. If the hunt is a distant
carrier, the gun stares downfield while enemies pass; if a near threat
wins the hunt, the feet get pulled into the duel and the chase is
forgotten. `runner`/`wave` solve this only for flag cappers, not for
"chase X while fighting Y."

## Plan — three lanes + an attention budget

### 1. `st.objective` — the feet's own target (core change)

Add a second tracked entity distinct from `st.hunt`:

- `st.objective = carrierBeacon(ctx)` — headhunt's top `held` enemy
  (threshold ≥10, same as the LOS-bypass gate), or the flag thief, or
  null in FFA.
- `planFight` reads the objective for feet: fight-orbit only when the
  *hunt* is inside `orbit` (today's rule) — the objective keeps the walk
  going either way, same contract runner/wave already use. Reuse the
  existing goal machinery rather than a new path system: `pickGoal(ctx,
  objectivePos)` is a call we already make for `ctx.runner`.
- Carrier pursuit gets the same legality as `thiefBeacon`: close-range
  commit without LOS, full acquisition with the LOS-bypass bounty read.

### 2. Aim = nearest *threat*, feet = objective (the hunt decouples)

`st.hunt` stays what `pickFire` shoots — the nearest visible threat as
today (effD pricing now includes the carrier, so when the carrier is in
reach the gun is already on it). The new behavior falls out for free:
aim tracks whoever's dangerous, feet keep walking the carrier. The
"swarm the carrier and die" failure is prevented by `best`'s existing
priority — the gun always answers the close threat.

Risk to watch: a bot whose hunt is a close enemy but feet chase a
carrier can look "tunnel-walked" — mitigation already exists in
`planFight`'s fightHold/orbit which commits feet when the fight is real.
The carrier chase should behave like `ctx.runner`: orbit range shrinks
so the bot skis *through* contacts, not around them.

### 3. Opportunistic pickups — loot on the way

Economy goal becomes path-aware instead of either/or:

- When feet walk an objective, `pickGoal` may substitute the *nearest
  nugget within a corridor* of the objective path (e.g. token within
  ~15m of the line to the carrier) — humans scoop what's on the way,
  not what's optimal on a map.
- Implementation: in the economy-goal pick, rank candidates by
  `dist(self, nugget) + k·detourDistance(nugget, self→objective)`; pick
  only if detour ≤ threshold. One scoring term, no new machinery.
- If no objective: today's nearest-nugget behavior stands.

### 4. Attention budget — keep it honest, not superhuman

A human can only track so much; the split shouldn't make bots
omniscient:

- Cap concurrent tracks at **2** (one hunt + one objective). Ghost
  pursuit already expires at `PURSUE_MS`; the carrier objective should
  refresh on the same clock — a stale bounty isn't a legal target.
- The carrier beacon uses live `held` data from the last senses packet —
  it should not fire on a carrier the bot has never observed or that
  died since the read (wire legality, same rule as `thief`).
- Fire stays one-target-per-tick (existing burst cadence) — the gun is
  not multitasked, only the walk is.

### 5. Mode gates

- Headhunt/nuggets: full behavior (objective chase + corridor loot).
- CTF: runner/wave already do it — no change; the shared `st.objective`
  refactor should make `thief`/`runner` a special case of the same lane
  rather than a parallel one.
- FFA: `st.objective` null → today's behavior exactly.

## Build order

1. `st.objective` + headhunt carrier beacon (small — reuse thiefBeacon's
   shape).
2. `planFight`/`pickGoal` feet-vs-eyes split generalized from
   `runner`/`wave` to "objective exists."
3. Corridor-detour nugget pick (one scoring change).
4. Soak verification: headhunt room, bots=12 — watch carrier pressure,
   contact-fight behavior en route, and whether the kill feed shows
   bots arriving at the hoard. Success = carriers get hunted, bots
   don't ignore point-blank threats to do it, and nuggets get collected
   on approach legs.

## Risk surface

- **Goal thrash**: hunt/objective swaps each tick → jitter. `fightHold`
  and the acquire-tick reaction clock already exist as the template;
  give `st.objective` a similar short hold.
- **Wire legality**: chasing a non-LOS carrier on a fresh `held` read is
  legal (beacon model, same as flag). Chasing a *dead* carrier isn't —
  prune on `alive === false` like every other lane.
- **Difficulty creep**: more aware bots = harsher lobbies. `skill`
  tiers exist (moveSkill, aim) — low-skill bots could skip the
  non-LOS carrier read and only chase visible hoards, which is also
  the honest "newbie doesn't watch the scoreboard" read.
