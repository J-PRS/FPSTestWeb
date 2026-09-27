# KRIBES → Tribes 2 scale: expansion plan

What T2 actually is: 32–128 players, huge outdoor maps, vehicles (Scout/Shrike/Tank/Transport),
deployables (turrets, sensors, mines, inventory stations), bases powered by generators
(kill the gen → the base goes dark), inventory stations (buy armor/loadout mid-field),
roles (ski / flag-runner / turret-farmer / assassin), and objective modes on top of CTF.
We already have: the engine, weapons (13+), skills (cloak etc.), modes (DM/CTF/nuggets),
instanced creatures at scale, bots, P2P, compact netcode.

## Gap analysis (T2 vs. what we have)

| T2 pillar | Us | Gap |
|---|---|---|
| Big terrain | One heightfield, ~1km | Terrain streaming / larger map |
| Vehicles | none | Everything — physics, enter/exit, HUD, weapons, netcode |
| Deployables | Mine entity exists | Deployable turret, sensor, deployable station |
| Inventory stations | none | Energy/ammo refill + loadout swap on a pad |
| Power grid | none | Generator entity; base systems keyed to it |
| Player scale | bots + 2-player MP verified | 20+ player scale, interest management |
| Roles/teamplay | teams + bots | Team scorin done; named roles optional |
| Objective modes | CTF/nuggets/dm | Siege / gen-defend / escort later |
| Persistent economy | none | Credits → buy loadout/upgrades |
| Command/Tac map | minimap exists | Full-screen map w/ teammate overview |

## Execution slices (each independently commitable)

1. **Deployables framework** — `game/deployables.ts`: a Deployable entity interface
   (owner, place(ray), tick, destroy) + item: deployable mini-turret (reuse Turretter
   visuals/instancing), deployable sensor ping, trip mine polish. Gives us the
   entity-lifecycle pattern every later system needs.
2. **Inventory station + energy economy** — stationary pad entity, walk-in →
   refill energy + ammo + loadout swap UI; credits balance (kills/nuggets → credits).
3. **Generator & powered grid** — base objects (stations, door/forcefield later)
   consume power; generator entity that dies → grid offline. First real objective
   unit; makes modes structurally richer.
4. **Vehicle layer** — driveable hoverbike (beachhead on ski physics),
   enter/exit, vehicle cam, HP, player eject/damage.
   Slice 4a: single-seater speeder. Slice 4b: armed flyer. Slice 4c: transport.
5. **Interest management + 16+ player netcode** — relevance culling on the server
   tick, remote player LOD, sized for dozens of entities not 5.
6. **Objective modes on the grid** — "siege": attacker's spawn moves up as they
   kill generators; nugget-war already exists, extend to multi-stage.
7. **Tac map** — fullscreen map overlay with teammates, deployables, vehicles.

Order rationale: deployables+station+gen establish the "base economy" that makes
all T2 modes meaningful; vehicles are the biggest lift and land best once there's
something to fight over.

## Status
- [ ] Slice 1 — deployables framework (IN PROGRESS)
- [ ] Slice 2 — inventory station + credits
- [ ] Slice 3 — generator / powered grid
- [ ] Slice 4 — vehicles
- [ ] Slice 5 — netcode scale
- [ ] Slice 6 — objective modes
- [ ] Slice 7 — tac map
