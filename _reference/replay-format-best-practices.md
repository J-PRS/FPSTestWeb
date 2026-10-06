# Replay / demo format best practices — reference

Consolidated from industry write-ups + our own v1–v6 format evolution. Context:
the .demo format must produce artifacts usable "50 years from now" — playable
after the game itself is gone, maximally small and performant.

## 1. The fundamental choice: input-replay vs recorded-state

| Approach | Stored | Size | Drift immunity | Maintenance cost |
|---|---|---|---|---|
| **Input replay** (lockstep) | initial state + per-tick inputs | tiny | NONE — any game change desyncs | months, ongoing forever |
| **Recorded state stream** | keyframes + events | larger | immune — the truth is in the file | low |
| **Hybrid** (ours) | recorded truth + local re-sim between keyframes | medium | immune with re-anchors | low-medium |

Consensus: full cross-machine determinism is not worth it. Gaffer on Games'
"Floating Point Determinism" and Unity replay postmortems document months spent
chasing float/RNG/iteration-order desyncs that still break on edge cases.
Shipped systems (Dota 2, Rocket League, Quake/Doom demos) are recorded-state.

**Determinism hygiene still matters at small scope**: seeded RNG, one stream,
no ambient consumers — but as a *harness reproducibility* property (same soak
→ same kill table for diffing), not a replay-format requirement.

## 2. "The file is the contract, not a description of the code"

Fighters Legacy (fighting-game replay format) articulates the key principle:
a durable replay file must be self-describing wherever the code can't be
trusted to be stable.

Applied to .demo:

- **Lane-namespaced ids** (v4): `targetType` is a range discriminator
  (0-63 balls, 64-127 creatures, 128-223 deployables, 224 kill, 225 flag,
  226+ pickups), `targetId` is namespaced inside each lane. Ids from
  different subsystems can never alias — this killed an entire bug class
  (creature netId >0x3fff aliasing flag/pickup lanes).
- **Semantic keyframes instead of opaque snapshots**: a ball's `Spawned`
  carries pos+vel+type; any future implementation can re-derive the
  trajectory. Opaque binary snapshots of object internals would rot.
- **Embedded lookup tables/fingerprints**: values that are indices into
  ordered tables (species, deploy kinds, pickup kinds, ball variants) need
  a content fingerprint in the header — v6 `tableHash` (crc32 of the
  canonical serialization). A table reorder warns instead of silently
  remapping every old clip.
- **HMAP trailer** (v5): an embedded 96² heightmap so a clip replays with
  sane terrain even when the original map file no longer exists.

## 3. Versioning rules that hold up

From the same write-ups:

- **Trailing-field extension**: new fields appended at record end with a
  version-gated read. Older readers read the shorter record and default.
  Used for v4 (weaponType on frames), v6 (targetType on projectile events).
- **Skip-unknown-sections by declared length**: trailer sections carry
  tag+len so a new section type doesn't break old readers. (v5 trailer.)
- **Version history table inside the format doc** — FORMAT.md maintains
  it; every bump documents what changed and the read-side default.

## 4. Structural practices seen in shipped formats

- **u32 count prefixes + fixed record sizes** (Dota 2 uses length-prefixed
  protobuf messages — same shape). Enables vectorized parsing and cheap
  bounds checks.
- **CRC32 over everything after the checksum field** — catches truncation
  and corruption cheaply. (.demo header checksum.)
- **Trailer/index-at-end** (Dota 2, MP4): seekable sections and future
  index blocks live after the payload, located via the header.
- **Keyframe cadence**: Quake III / Iron Curtain snap the authoritative
  truth every ~5-10s (ours: roster remote frames) and let consumers
  interpolate/extrapolate between — bounds drift without recording every
  tick.

## 5. Compression hierarchy

- **Dedup at record time**: dead-reckon dedup on local frames (only store
  when state changes), 20Hz remote samples instead of per-tick.
- **Delta-of-previous + varint** (deferred): remote frames dominate size;
  delta coding typically cuts 40-60%. A format bump — do it only if clip
  size actually hurts.
- **Container compression** (`.demo.gz`): events compress well; cheap win
  if needed.
- Do NOT lossy-quantize positions unless a budget demands it — it
  permanently destroys the "recreate the shot" property.

## 6. Validation layers (what actually catches bugs)

Three distinct layers, none substitutes for another:

1. **File-level** (tools/demovalidate.ts): bytes, ordering, CRC, lane
   membership, lifecycle pairing, roster bounds. Proves the file is
   well-formed. Cannot see playback bugs.
2. **Playback differential** (demoPlaybackAudit.test.ts): replays the file
   through the real lifecycle and asserts the world animates — entities
   move, kicks only from the POV shooter, replicas interpolate. Catches
   runtime key mismatches the file checks can't.
3. **Render-level** (tools/vidcheck.py + frame eyeballs): mean pixel delta
   per second of the rendered MP4 — the "is the video actually alive"
   check that caught the frozen-POV and 1fps bugs.

## 7. Recording coverage

Goal: "anything in the game produces a warning if not recorded." Practice:
the coverage registry maps every actor family to a lane; unrecorded types
warn at record time. Keep lanes self-describing so new actor kinds get a
lane, not a special case.

## 8. Deferred / rejected

- Full lockstep determinism — rejected per §1.
- Recorder-vs-soak RNG isolation — **measured unnecessary** (2026-10-06):
  `midairclip --norec` ×2, `midairclip` (recording), and `midairsoak` at
  identical seed/map/hours produce byte-identical kill tables. All RNG
  consumers are already seeded — `ballSim.rng`/`creatureSim.rng`/`room.rng`
  are per-room lcg streams (spawnRng rides `room.rng`), bot heuristics and
  taunts ride injected streams, and the recorder itself draws no RNG.
  Earlier "kill table shifts" between passes were legitimate code-change
  artifacts (bot aim/behavior edits between runs), not rng leakage.
  Remaining ambient draws (`respawnTick` window) resolve to seeded
  `room.rng`, not `Math.random`.
- Delta codec — deferred until size actually hurts.
- `.demo.gz` — deferred, trivial when needed.

## Sources

- Gaffer on Games, "Floating Point Determinism" (gafferongames.com)
- GameDeveloper.com, "Implementing a replay system in Unity — how I'd do
  it differently" (2014), "Instant Replay: Building a Game Engine with
  Reproducible Behavior" (2001)
- zacksinisi.com, "Deterministic Lockstep Networking Demystified" (2024)
- Fighters Legacy replay format docs (file-is-the-contract,
  skip-unknown-sections, major/minor versioning)
- Dota 2 replay format (protobuf messages, trailer offset)
- Quake III delta snapshots; Iron Curtain mandatory keyframes + seek index
- KRIBES FORMAT.md v1–v6 evolution and the 2026-10 audit fixes
