# Rabbit and Team Rabbit - complete reference

Date: 2026-10-26.
Scope: lineage, source-level rules, design analysis, and the KRIBES implementation plan.
Status: research/reference. Nothing here is implemented unless a file path in Section 8 says otherwise.

## 1. Short version

- **Rabbit** (base Tribes; KRIBES `ModeId = 'rabbit'`) is a free-for-all keep-away game. One neutral flag, one carrier, everyone hunts the carrier, and the carrier scores over time. There are no teams and no passing.
- **Team Rabbit** (2001 mod by Mike Johnston) is a two-team passing game. One neutral flag, keep it away from the other team, and the carrier must pass before a "hot potato" timer expires or dies. Passes score for speed, coolness, and difficulty.
- **Team Rabbit 2 / TR2** (Codality, shipped with Tribes 2) is the retail evolution: pass the flag upfield and throw it into the enemy goal. Completed passes build a shared jackpot; a goal cashes it. It is a total conversion, not a ruleset flag.
- **Legions: Overdrive** runs a simpler two-team, one-flag passing variant where passes score points directly.

The defining mechanic of every Team Rabbit is **passing**. A mode that only adds teams to Rabbit is not Team Rabbit.

## 2. Naming trap

The base `RabbitGame.cs` header literally says `// Team Rabbit script`, but the file is the FFA keep-away game. The Tribes 2 modding handbook is explicit about this: base Rabbit has no throw mechanic, no bonus matrix, and no roles. The passing game was a separate mod; TR2 was its retail evolution.

KRIBES currently has the FFA version only. Do not call it Team Rabbit in player-facing copy or design notes.

## 3. Base Rabbit

### 3.1 Tribes source behavior

- One neutral flag. The carrier is "it"; everyone else hunts.
- The longer the carrier keeps the flag, the more points they score.
- Scoring ticks on a fixed interval: `teamBonusTime = 15 * 1000` (one point per 15 seconds held).
- No team concept and no passing mechanic.

### 3.2 KRIBES current implementation

Files: `shared/teams.ts`, `server_bun/src/RoomFlags.ts`, `client/src/game/net/flags.ts`, `client/src/game/bots/botRabbit.ts`.

- `MODES.rabbit`: label `RABBIT`, `teams = false`, `ffa = true`, `flags = true`, `gems = false`, `winAt = 60`, `timeLimitS = 900`, `ptsPlayerKill = 1`, `ptsCreatureKill = 0`.
- `RoomFlags` runs a single neutral flag keyed `alpha` on the wire.
- The flag begins `unspawned` and enters play at the first corpse of the match.
- `RABBIT_PICKUP_R = 4.5` (wider than CTF's 6.0 is not used; the rabbit ring is 4.5).
- `RABBIT_MAGNET_R = 40`, `RABBIT_MAGNET_SPEED = 8`: a settled flag slides toward the nearest living player.
- `FLAG_THROW_SPEED = 20`: deliberate toss along aim.
- `FLAG_RESET_S = 20`: dropped flag walks home after 20 seconds.
- In `tickCarried`, the carrier pays one FFA point per second held (`holdAcc += dt`, one point per whole second). Note: this is faster than the Tribes 2 base script's 15-second interval, and `winAt = 60` means a 60-second hold wins.
- Kills pay one point each in KRIBES.
- Client callouts live in `rabbitCallout()`; the flag mesh is pinned to the carrier's rendered body in `remotes.ts`.

## 4. Team Rabbit (2001 mod)

Creator: Mike Johnston, 2001-2002. Sold to Sierra; he later joined Irrational Games.

Publicly documented rules:

- Two teams, one neutral flag.
- One team keeps the flag away from the other.
- The flag has a "hot potato" effect: after several seconds, the carrier must pass to a teammate or die.
- Passes score points based on how fast, cool, and difficult they are.
- Everyone has jetpacks and weapons in a large outdoor environment.

Confidence: medium. The creator's page is the source, and it does not give the exact timer, penalty, or win condition. Treat those as design intent, not verified constants.

## 5. Team Rabbit 2 (retail Tribes 2)

Source: `scripts/TR2Game.cs` (3204 lines), shipped inside `TR2final105-server.vl2` as part of the retail product. Studio: Codality, Inc. The Tribes 2 modding handbook quotes the script header and constants.

### 5.1 Core loop

Header comment from `TR2Game.cs`:

```
Get the flag and throw it into the other team's goal
You can only hold onto the flag for 15 seconds

Passing the flag increases the size of the Jackpot
Scoring a goal awards the Jackpot to your team!
When your health reaches zero, you are knocked down
Replenish your ammo by pressing your suicide button
```

Rules:

- One neutral flag. Carry it and throw it into the enemy goal.
- Hold limit: 15 seconds. You must pass before it expires.
- Passing builds a shared jackpot. Every completed pass adds to one pot that both teams can cash. Minimum to score is 40; the pot caps at 250.
- Scoring a goal awards the current jackpot to the scoring team.
- The pot is shared, not split: the other team can intercept your passes and cash what you built. This is the central tension of the mode.

### 5.2 No kills, no deaths

- Damage knocks you down instead of killing you.
- Knockdown lasts 2.3 to 7 seconds.
- You respawn where you fell.
- Opponents cannot loot your ammo.
- Pressing suicide resets you to your spawn hutch with a full loadout and refills ammo.

### 5.3 Automatic roles

Roles are assigned by distance from your own goal. There is no economy or class purchase.

| Role | Slots | Armor | Distance from own goal | Loadout |
|---|---|---|---|---|
| Goalie | 1 | Heavy | <= 70 m | Shocklance + 99 mortar rounds |
| Defense | 2 | Medium | <= 350 m | Shocklance |
| Offense | everyone else | Light | beyond 350 m | Speed and numbers |

### 5.4 Pass scoring

Every pass is rated on a ten-axis matrix that composes named bonuses with point values and sounds.

| Category | Axes | Entries | Examples from the handbook |
|---|---|---|---|
| Prefix | receiver orientation relative to the flag | 3 | - |
| Noun | passer speed, receiver speed, receiver height | 64 | - |
| Qualifier | horizontal flag speed, vertical flag speed, hang time | 24 | Sharp, Spitting, Whipped |
| Description | passer direction, pass direction, flag direction relative to receiver | 27 | Bullet (+5), Heist |

Composite names read like "Twister Cougar's Bursting Back Breaker". The matrix is the reason TR2 passes feel like a sport rather than a transport.

### 5.5 Physics and maps

TR2 is a total conversion with its own tuning:

- Gravity -43 versus the base -20.
- Flag mass 30, throw scale 3.0.
- Grid boost pads with minimum 80, scale 1.15, maximum 310.
- Out-of-bounds kills or drops the flag.
- Eight shipped maps (the handbook documents nine; Mount Olympus is not in the shipped set).

### 5.6 What TR2 is not

- It is not a `ModeSpec` flag. It is a 3204-line gametype with custom armor, weapons, HUD, and maps.
- It ships as three separate archives, not as a normal gametype file.
- It reuses `CTF_scoreLimit` as its win condition, but the value is mission-authored, not a global default.

## 6. Legions: Overdrive variant

Secondary source, not source-verified. The community description is:

- Two teams, one neutral flag.
- Pass the flag to teammates for points.

This is closer to the original Team Rabbit than to TR2: scoring is pass-based, with no goal/jackpot loop documented. Use it as a data point, not as a spec.

## 7. Design analysis

### 7.1 Why it works

- The 15-second hold limit prevents turtling. The carrier cannot sit on the objective.
- Passing is the skill expression. Speed, timing, and spacing all matter, and the matrix rewards style, not just completion.
- The shared jackpot creates risk/reward. Keep passing for a bigger prize, or score before the other team intercepts and steals it.
- Roles make team structure readable without a purchase screen.
- No permanent death lowers downtime and keeps the pace high.
- The goal gives a clean win condition and a closure beat.

### 7.2 Failure modes to avoid

- Pass farming. If passes score directly with no interception pressure, teams can farm in a corner. TR2 avoids this by requiring a goal to cash the pot.
- Snowballing. The shared pot means a trailing team can steal a large prize, but a leading team can also cash quickly. Keep the cap at 250 so one lucky pass does not decide the match.
- Timer frustration. The 15-second limit must be visible and audible. A silent expiry feels like a bug.
- Catch radius. Too generous makes interceptions feel random; too tight makes ping decide catches. Use a server-authoritative swept capsule, not a client claim.
- Bot quality. If bots cannot pass, catch, and space, the mode feels dead. This is the hardest part of the implementation, not the flag physics.
- Map readability. Goal rings, a carrier outline, and a clear "PASS" cue matter more than new art.

### 7.3 Comparison to adjacent modes

| Mode | Teams | Flag | Scoring driver | Death |
|---|---|---|---|---|
| Rabbit (KRIBES) | FFA | one neutral | hold time | normal death |
| CTF | 2 | two owned | carry to own base | normal death |
| Headhunt | 2 | none (tokens) | held tokens | normal death |
| Team Rabbit (2001) | 2 | one neutral | pass quality | pass or die |
| TR2 | 2 | one neutral | goal cashes jackpot | knockdown only |
| KRIBES V1 (proposed) | 2 | one neutral | goal cashes jackpot | normal death |

## 8. KRIBES implementation reference

### 8.1 Design decision

Build **Team Rabbit Lite** first. It copies TR2's goal-plus-jackpot loop but keeps KRIBES's existing death and respawn model.

- Two teams, one neutral flag at center, goals at each base (reuse CTF stands).
- Carrier hold timer: 12 to 15 seconds. Must throw to a teammate before it expires.
- Completed pass adds to a shared jackpot. Goal cashes it if the pot is at least 40.
- Enemy can intercept the pass.
- Normal kills and respawns. No knockdown, auto-roles, or ten-axis bonus matrix in V1.
- HUD: jackpot, hold timer, pass streak, and pass/intercept/goal callouts.

Rationale: the goal-plus-jackpot loop gives a clear objective and prevents pass farming, while reusing existing CTF bases and flag physics keeps the scope sane.

### 8.2 Mode spec

In `shared/teams.ts`, add `teamrabbit` to `ModeId` and `MODES`:

```ts
teamrabbit: {
  label: 'TEAM RABBIT', teams: true, ffa: false, flags: true, gems: false,
  winAt: 500, timeLimitS: 900, ptsPlayerKill: 0, ptsCreatureKill: 0,
},
```

Notes:

- `winAt = 500` means a match needs two full 250-point goals, or more smaller ones.
- `ptsPlayerKill = 0` keeps kills from distracting from the jackpot. Kills still create respawn pressure.
- `flags = true` so `RoomFlags` is constructed.

Also update `shared/mapSpec.ts` defaults and per-map `modes` whitelists so CTF maps can host it.

### 8.3 State model

Keep the flag physics in `RoomFlags`. Add a mode module for jackpot and bot objectives.

```ts
interface TeamRabbitState {
  carrierId: string | null;
  carrySinceSimMs: number | null;   // for the hold timer
  pass: { from: string; pos: Vec3; vel: Vec3; at: number } | null;
  jackpot: number;
  lastPass: { by: string; to: string; points: number; at: number } | null;
  goals: { alpha: Vec3; bravo: Vec3 };
}
```

### 8.4 `RoomFlags` changes

Files: `server_bun/src/RoomFlags.ts`, `server_bun/src/Room.ts`.

- Add a `teamRabbit` getter and include it in the existing `neutral` (single-flag) path.
- Constructor: for `teamrabbit`, start the flag `home` at center instead of `unspawned`. Pass both bases so goal rings are known.
- `tickCarried`: if `teamrabbit`, update `pos` to the carrier, compute hold elapsed from `carriedAt`, and drop the flag with no score when it reaches 15 seconds. Emit a `holdExpired` flag event.
- `tickDropped`: if the thrown flag enters the enemy goal ring, emit a `goal` flag event. Otherwise normal ballistic and pickup.
- `tickTouch`: if `teamrabbit`, anyone can grab a loose flag. If the flag is airborne and the toucher is on the passer's team, emit `catch`. If the toucher is on the other team, emit `intercept`. Clear `airborneBy` on any grab.
- `throwFor`: reuse the existing aim-based arc. Consider raising `FLAG_THROW_SPEED` from 20 to roughly 28 for longer passes; tune in soak.
- `magnet`: keep it disabled for `teamrabbit`. The magnet is a base-Rabbit feel aid and would fight pass reads.

### 8.5 Mode module

Files: `server_bun/src/modeModules.ts`, new `server_bun/src/modeTeamRabbit.ts`.

Register:

```ts
teamrabbit: (room): ModeModule => new RoomTeamRabbit(room),
```

Add an optional hook to `ModeModule`:

```ts
onFlagEvent?(e: FlagEvent): void;
```

`RoomFlags` calls `this.room.modeModule?.onFlagEvent?.(e)` at grab, throw, catch, intercept, goal, and hold expiry. This keeps `RoomFlags` as flag physics and the module as rules/scoring.

`RoomTeamRabbit` responsibilities:

- Track `jackpot`, starting at 0.
- On `catch`: `jackpot = min(250, jackpot + passValue)`. Send a `teamRabbitUpdate` edge. Store `lastPass`.
- On `intercept`: send a `teamRabbitUpdate` edge. No pot change; the interceptor's team can now cash it.
- On `goal`: if `jackpot >= 40`, `room.score(team, jackpot)`, then reset `jackpot = 0`. If below 40, reject the goal and drop the flag at the goal line. Send the update either way.
- On `reset`: `jackpot = 0`.
- `sims()`: one sim whose `worldState()` returns the current `teamRabbitUpdate` for joiners and resync.
- `objectiveFor(p)`: carrier runs to the enemy goal; teammates spread and support; opponents chase or intercept.

Pass value for V1 (design choice, not sourced):

- Base 8 points.
- +1 per 10 meters of pass distance, capped at +10.
- +1 per 0.5 seconds of hang time, capped at +5.

Two good passes should reach the 40-point minimum.

### 8.6 Wire and client

Files: `shared/protocol.ts`, `shared/worldModel.ts`, `client/src/networking/NetworkManager.ts`, `client/src/networking/wireIn.ts`, `client/src/game/net/world.ts`, `client/src/game/net/flags.ts`, `client/src/game/remotes.ts`, `client/src/ui/hud/*`.

- Add `carrySince` (sim ms) to the `flagUpdate` row so clients can compute the hold timer locally without a per-tick stream.
- Add a `teamRabbitUpdate` edge: `{ type: 'teamRabbitUpdate'; jackpot: number; lastPass?: ...; goal?: ... }`.
- `sendWorldState` and the module's `worldState()` replay both so joiners and resynced clients get the pot.
- Client callouts: reuse `rabbitCallout` as a template but add pass, intercept, and goal beats.
- Render goal rings at each base. The server is authoritative for goal detection; the client ring is a visual aid.
- HUD: jackpot meter, hold timer, pass streak, and a warning under 3 seconds.

Wire rule: jackpot and hold timer are rare-changing state. They ride JSON edges, not the binary tick frame.

### 8.7 Bots

Files: `server_bun/src/botRouting.ts` or a new `server_bun/src/botTeamRabbit.ts`, `client/src/game/bots/botRabbit.ts` for local bots.

- Carrier: run to the enemy goal; pass when pressured or when the timer drops under 3 seconds.
- Teammates: spread upfield, offer a passing lane, and move to catch.
- Opponents: chase the carrier or cut passing lanes.
- V1 pass selection: nearest teammate with forward progress and separation from enemies. Do not try to reproduce the ten-axis matrix for bots.
- V2: role assignment by distance from own goal (goalie, defense, offense) and knockdown instead of death.

Bots are the hardest part of this mode. If they cannot pass and catch, ship the mode as human-only first.

### 8.8 Maps

- Reuse CTF maps. The center flag spawn can use `FlagPlacer.rabbitFlagHome()` or the midpoint of the two bases.
- Goal rings sit at each base.
- No new map pipeline is needed for V1.
- Later sport maps can use two goals and tighter arenas, like TR2's eight shipped maps.

### 8.9 Tests

New file: `server_bun/tests/scenarios/teamRabbit.test.ts`.

- Flag starts home at center.
- Alpha grabs; carrier is alpha.
- Hold reaches 15 seconds: flag drops, no score.
- Alpha throws to an alpha teammate inside catch radius: catch succeeds, jackpot increases, carrier changes.
- Enemy touch on an airborne pass: interception, carrier becomes enemy, jackpot unchanged.
- Goal with jackpot below 40: no score, flag resets to center or drops at the goal line.
- Goal with jackpot at least 40: scoring team gains the jackpot, pot resets to 0, flag returns home.
- Jackpot caps at 250.
- Death drops the flag and clears pass state.
- Joiner receives flag state and current jackpot.
- Match reset clears jackpot and flag.
- `bun test tests/scenarios/` stays green.
- `bash _tools/check.sh` exits 0.

Also update `server_bun/tests/worldModel.test.ts` pinned field sets when new protocol fields are added.

### 8.10 Phased plan

- P0: this document.
- P1: server flag/pass/jackpot logic and scenario tests. No client.
- P2: wire edges and client HUD, callouts, and goal rings.
- P3: bot pass/catch/spacing.
- P4: polish, announcer, and V2 knockdown/roles/matrix/physics.

Cost estimate (order of magnitude, not measured): server 500-800 lines, client 300-500, tests 300-500, bots 300-600.

### 8.11 Traps to avoid

- Do not call the current `rabbit` mode Team Rabbit. It is FFA Rabbit.
- Do not implement Team Rabbit as `teams: true` on the existing flag. Passing is the mode.
- Do not add a second flag. Use one neutral flag.
- Do not let the client claim catches or goals. The server sim owns them.
- Do not stream jackpot or hold timer in the binary tick frame. Use JSON edges.
- Do not copy TR2's total conversion wholesale. Roles, knockdown, and the matrix are V2.
- Do not access `room.flags` in a `ModeModule` constructor. The module is created before `RoomFlags` is built.
- Do not reuse `RoomFlags` CTF cap logic for `teamrabbit`. The cap ring does not apply.

## 9. Open questions

- Pass input: aim-based throw (server-derived, hard to spoof) versus targeted pass (needs a client intent and validation).
- 15-second penalty: drop the flag (V1) or knock down (V2)?
- Goal below 40: reject and drop, or allow a minimum 40 payout?
- Win condition: jackpot points (proposed) or goal count?
- Should interception award personal points?
- Should V1 keep kills, or disable them to match TR2?
- Bot pass skill and catch radius tuning.

## 10. Sources and confidence

Source-verified:

- Base Rabbit script behavior and the "Team Rabbit script" header note: Tribes 2 modding handbook, "29 - Rabbit".
- TR2 header, jackpot constants, roles, pass matrix, physics, maps: Tribes 2 modding handbook, "30 - Team Rabbit 2", quoting `TR2Game.cs`.
- KRIBES current Rabbit behavior: `shared/teams.ts`, `server_bun/src/RoomFlags.ts`, `client/src/game/net/flags.ts`.

Medium confidence:

- 2001 Team Rabbit exact timer, penalty, and win condition: creator's page only.
- TR2 15-second expiry behavior and exact win condition: header plus community interpretation.

Secondary source:

- Legions: Overdrive Team Rabbit: community description only.

KRIBES source references:

- `shared/teams.ts`
- `shared/mapSpec.ts`
- `shared/protocol.ts`
- `shared/worldModel.ts`
- `server_bun/src/RoomFlags.ts`
- `server_bun/src/Room.ts`
- `server_bun/src/modeModules.ts`
- `client/src/game/net/flags.ts`
- `client/src/game/bots/botRabbit.ts`
- `_docs/2026-10-18_ADDING_MODES_AND_PICKUPS.md`

External sources:

- Mike Johnston, "Team Rabbit 2001-2002": http://mikejohnstn.com/projects/indie.html
- Tribes 2 Mod Development Handbook, "29 - Rabbit": https://modding.tribes2wiki.com/29-rabbit
- Tribes 2 Mod Development Handbook, "30 - Team Rabbit 2": https://modding.tribes2wiki.com/30-team-rabbit-2
- Handbook source mirror: https://github.com/GeekOfWires/tribes2-mod-doc/blob/main/30-team-rabbit-2/README.md
- Legions: Overdrive: https://www.legionsoverdrive.com/
