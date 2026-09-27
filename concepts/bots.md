Let me research the actual bot implementations:

Dug through both. Honest picture:

## Tribes 1 (1998): no built-in bots at all

All bot AI was community-made. The famous one, **Spoonbot**, was pure script (Tribes' TorqueScript `.cs` files) and its navigation was entirely manual: it required hand-placed waypoint files ("Treefiles") per map, with bots walking line-of-sight between treepoints. Roaming, attacking, and CTF logic were all just scripted behaviors bolted onto the waypoint graph. Impressive for 1999 modders, but the engine gave them *nothing* — no navmesh, no pathfinding.

## Tribes 2 (2001): absolutely massive

The Dynamix source tree has **~35 engine files** just under `ai/` — and the breakdown shows where the effort went:

- `graphBuildLOS.cc`, `graphFloorPlan.cc`, `graphIndoors.cc`, `graphOutdoors.cc`, `graphBridge.cc`, `graphIsland.cc`, `graphPartition.cc`, `graphSmooth.cc`, `graphJetting.cc`, `graphVolume.cc`... — that's an **offline nav-graph *generator*** that parses interior geometry, floor plans, bridges, and outdoor terrain into a pathing graph, including jet routes
- `aiNavJetting.cc`, `aiNavStep.cc` — runtime navigation *on* that graph
- `aiObjective.cc`, `aiTask.cc` + a pile of `ai*.cs` scripts — the task/objective layer (attack flag, defend, escort)

So the bulk of T2's bot code was **navigating bases and terrain with jetpacks** — the thing your game simply doesn't need, because:

- You have zero interiors — the world is a smooth heightfield, so `terrain.getHeight` + "aim at player" is the entire navigation problem
- Your movement physics (`MovementController`) already exists and accepts synthetic input — a bot is just a Player driven by code instead of keys
- You don't need CTF/objectives — it's a sparring partner

## Verdict

T2-scale bot: not doable, don't. **Your mirror bot: very doable** — roughly:

- ~350 lines: drive `MovementController` with strafe-orbit patterns, occasional jet hops, weapon fire with lead
- No navmesh, no waypoints — heightfield IS the nav graph
- The risk isn't code volume, it's **feel**: does a scripted strafe-fighter read as a person or a drone? That's tuning, not architecture.

The honest caveat: it'll be a worse-player-shaped enemy, not a believable human. Spoonbot-tier, not T2-tier — which for an aim-warmup dummy is probably exactly right. Want me to build it?