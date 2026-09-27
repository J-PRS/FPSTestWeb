# Demo recording & playback

Full-fidelity session recording — inputs, events, entities — for replay and
automatic "cool shot" clipping.

## Architecture

- **`DemoRecorder`** — samples player state + events per tick into a
  `CircularBuffer`; bounded memory, old footage ages out
- **`DemoSerializer`** — typed event stream (`InputFlags`, `JetpackFlags`,
  projectile fired/destroyed, target hit/died, AOE)
- **`DemoPlayer` + `playbackReconstruction`** — replays by stepping through
  recorded states; the camera is the player frozen (`inputFrozen`), sim
  entities spawned as playback clones (`playbackBallById`,
  `playbackProjectiles`)
- **`demoLifecycle`** — owns teardown: entering/exiting playback disposes
  live entities (balls, crawlers, turretters, rollers, seekers, projectiles,
  debris) and restores them when play resumes. Every new entity type must
  register here or it freezes mid-demo.

## Cool shots

Automatic clip extraction — a notable event (airshot kill, long-range disc)
marks the buffer; the clip saves the surrounding window. `CoolShotsPanel`
lists them. The interesting part is it's *retrospective*: the circular
buffer means you record everything and keep only what turned out cool.

## The trap

Demo playback uses the same entity classes but different lifecycle —
playback balls are ID-keyed clones, projectiles replay from events, real
entities must not update. `gameLoop` gates every `entities.update*` call on
`demoPaused`, and `updateProjectiles`/`updateNuggets` gate on `isPlaying`.
New entity types need both gates or they'll double-sim under playback.
