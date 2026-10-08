# KRIBES demo file format (.demo)

Byte-level specification of the `.demo` artifact, standalone of the code that
reads it. Everything is little-endian. The goal of the format: a self-contained
recording of player action — positions, velocities, inputs, projectile/target
events — small enough to keep forever and simple enough to re-implement a
reader for decades after the game is gone. No terrain, no meshes, no assets.

## File identification

Byte 0 is the magic byte `0x44` ('D'), followed by a signed int32 format
version. Any file starting `44 xx xx xx xx` where the version is a small
positive int is almost certainly a demo of this game.

## Conventions

- `u8/u16/u32` — unsigned ints, little-endian
- `i16/i32` — signed ints, little-endian
- `f32/f64` — IEEE 754 floats, little-endian
- `str` — u16 byte-length prefix + UTF-8 bytes (no NUL terminator)
- All record arrays are prefixed with a u32 element count

## Header layout (read in order)

| Field              | Type | Notes |
|--------------------|------|-------|
| magic              | u8   | 0x44  |
| formatVersion      | i32  | 1..6  |
| gameVersion        | str  | e.g. "1.0.0" |
| timestamp          | f64  | ms since Unix epoch (recording wall clock) |
| duration           | f32  | seconds |
| totalFrames        | u32  | must equal frames[] count |
| projectileEventCount | u32 | must equal projectileEvents[] count |
| targetEventCount   | u32  | must equal targetEvents[] count |
| checksum           | u32  | CRC32 (IEEE) of every byte AFTER this field |
| description        | str  | |
| startPos           | 3×f32| x,y,z |
| startYaw/Pitch     | 2×f32| radians |
| startVel           | 3×f32| m/s |
| projectileLifetime | f32  | v2+ only; 0 for full recordings |
| room               | str  | v3+ only; lobby/room name |
| mode               | str  | v3+ only; game mode |
| playerName         | str  | v3+ only |
| tableHash          | u32  | v6+ only; CRC32 of the persisted enum tables |

**tableHash (v6+)** — the file's `targetType` values are indices into
ordered tables (species, deploy kinds, pickup kinds, ball variants), not
names. The writer stamps CRC32 of the canonical table serialization at
record time so a later reorder/edit flags the clip (demovalidate WARN)
instead of silently remapping ids. Append new entries only — never
reorder or the hash drift is real, not noise.

CRC32 is the standard IEEE polynomial (0xEDB88320 reflected), init/xor-out
0xFFFFFFFF — the same as zlib/gzip. Coverage: every byte after the checksum
field itself to end of file.

## Sections (in order)

1. `frames[]` — local player, u32 count, records of 48 bytes (v1–3) or
   49 bytes (v4+, trailing u8 weaponType; older files default it to 0):

   | Field        | Type | Notes |
   |--------------|------|-------|
   | frameNumber  | u16  | wraps at 65536; timestamps are authoritative |
   | timestamp    | f32  | seconds since recording start |
   | pos          | 3×f32| x,y,z meters |
   | vel          | 3×f32| m/s |
   | yaw, pitch   | 2×f32| radians |
   | inputFlags   | u8   | bit0 Fwd,1 Back,2 Left,3 Right,4 Jump,5 Ski,6 Fire,7 Disc |
   | mouseDeltaX/Y| 2×i16| per-tick mouse deltas |
   | jetpackFlags | u8   | bit0 Active |
   | jetpackFuel  | f32  | |
   | weaponType   | u8   | v4+; index into the game's weapon table |

   Frames are dead-reckon deduped at record time — playback must linearly
   interpolate between stored timestamps.

2. `projectileEvents[]` — u32 count, 59-byte records (v1–5) or 60-byte
   records (v6+, trailing u8 targetType; older files default it to 0):

   | Field        | Type |
   |--------------|------|
   | eventType    | u8   | 0 Fired,1 Bounce,2 Hit,3 Destroyed |
   | timestamp    | f32  |
   | pos, vel     | 6×f32|
   | projectileId | u16  | local sequence, 1-based |
   | weaponType   | u8   |
   | surfaceNormal| 3×f32|
   | targetId     | u16  |
   | targetType   | u8   | v6+ |
   | hasPeak      | u8   |
   | peakPos      | 3×f32|

   **`targetId` semantics depend on eventType**: on `Fired` it carries
   the shooter roster index **+ 1** (0 = the local/POV player — playback
   kicks the viewmodel only for these). On `Hit` it is the victim's id
   in the lane `targetType` names: ball variant (0–63) → ball map,
   `255` (`HIT_TARGET_NONE`) → terrain or the anonymous 0xFFFF player
   hit. `Bounce`/`Destroyed` carry 0.

3. `targetEvents[]` — u32 count, 49-byte records:

   | Field        | Type |
   |--------------|------|
   | eventType    | u8   | 0 Spawned,1 Bounce,2 Hit,3 Destroyed,4 StateChanged |
   | timestamp    | f32  |
   | pos, vel     | 6×f32|
   | targetId     | u16  |
   | targetType   | u8   |
   | health       | f32  |
   | hasPeak      | u8   |
   | peakPos      | 3×f32|

   **`targetType` is a lane discriminator**, not a plain type id — the
   entity family is determined by range, and `targetId` is namespaced
   per family so ids from different subsystems can never alias:

   | targetType range | Lane          | targetId encoding |
   |------------------|---------------|-------------------|
   | 0–63             | balls         | `variant` (game ball type); id = server targetIds counter |
   | 64–127           | creatures     | `64 + species idx` (table below); id = `0x8000 \| serverNetId` |
   | 128–223          | deployables   | `128 + deploy-kind idx`; id = `0x4000 \| serverNetId` |
   | 224              | kill marker   | id = **victim roster index** (not an entity id) |
   | 225              | flag          | id = `0xC000 \| teamIdx` (0 alpha, 1 bravo) |
   | 226+             | pickups       | `226 + pickup-kind idx`; id = `0xE000 \| serverNetId` |

   **Marker packing** — lanes that don't fit the plain body-event shape
   repurpose the record fields:

   - **Kill (224)** — one `StateChanged` event per kill. `targetId` =
     victim roster idx, `health` = weaponType, `peakPosX` = shooter
     roster idx **+ 1** (0 = unknown/environment), pos = where the
     victim stood. Kill events are point-in-time edges: they have no
     alive state and are excluded from clip-window spawn recovery.
   - **Flag (225)** — one `Spawned` then `StateChanged` keyframes.
     `health` = state code (0 home, 1 carried, 2 dropped), `peakPosX` =
     carrier roster idx + 1 (0 = nobody), pos = flag base/current pos.
   - **Pickup (226+kind)** — `Spawned` at rest pos, `Destroyed` when
     taken. `health` unused.
   - **Creature (64+idx)** — `Spawned`, `Bounce` = wander edge (pos +
     new heading vel), `Hit` = roster/hp truth (`health` = current hp),
     `Destroyed` = death.
   - **Deployable (128+idx)** — `Spawned` (pos + kind in targetType),
     `Hit` = hp/state update (`health` = current hp; down/up edges
     record as hp 0/1), `Destroyed` = removed/exploded.

   **Ordered tables** (append-only; values are stable indices recorded
   in files):

   - species (64+): `crawler, scarab, rakk, gnat, roller, snake, baneling, totem`
   - deploy kinds (128+): `turret, mine, station, drone, shield, nugget, beacon, generator, sensor, baseturret`
   - pickup kinds (226+): `gem, tag, heal, armor, regen, dd`

   Deployable-fired bolts appear in `projectileEvents` with the sentinel
   `weaponType = 254` (not a real weapon index) — a tracer toward the
   resolved target position at ~80 m/s.

4. `roster` (v3+) — u16 count + `str` names. Remote frames reference entries
   by index (u16) — the table dedupes names out of the hot stream.

5. `remoteFrames[]` (v3+) — u32 count, 39-byte records, ~20Hz, deduped:

   | Field        | Type |
   |--------------|------|
   | timestamp    | f32  |
   | rosterIdx    | u16  | index into roster |
   | pos, vel     | 6×f32|
   | yaw, pitch   | 2×f32|
   | flags        | u8   | bit0 Dead, 1 Ski |

6. `trailer sections` (v5+) — optional tagged blocks after remoteFrames:

   | Field   | Type |
   |---------|------|
   | count   | u8   | number of sections that follow |

   Each section: `u8 tag`, `u32 payloadLen`, then payloadLen bytes.
   A reader must SKIP unknown tags — new sections land without a
   version bump. Defined tag:

   **tag 1 — HMAP** (embedded fallback heightmap):

   | Field        | Type |
   |--------------|------|
   | gridN        | u16  | samples per side (square grid) |
   | heightScale  | f32  | vertical gain (map's spec.heightScale) |
   | worldScale   | f32  | meters per tile wrap |
   | srcHash      | u32  | CRC32 of the source field's full-res bytes |
   | dataLen      | u32  | = gridN² |
   | data         | dataLen × u8 | raw height samples (0–255 → 0–125m × heightScale) |

   The grid IS a Heightfield at gridN resolution: sample it exactly like
   the full map (bilinear, texel-center offset, same wrap semantics).
   Defaults: gridN 96 → ~9.2KB payload, ~1-4m rms error vs the real map.
   Purpose: (a) terrain fallback when the original map file is gone;
   (b) srcHash lets playback verify "map exists and matches the action"
   and swap in the embedded grid when it doesn't.

## Version history

- v1: original (no projectileLifetime)
- v2: + projectileLifetime in header
- v3: + room/mode/playerName, roster, remoteFrames
- v4: + weaponType u8 at end of each local frame record; targetType
  space namespaced into lanes (balls/creatures/deployables/markers)
  covering every actor family — wire format itself unchanged
- v5: + optional trailer sections (u8 count + tag/len/payload each);
  first section is HMAP, an embedded coarse heightmap for terrain
  fallback and map-match validation
- v6: + targetType u8 at end of each projectileEvent record (victim
  lane on Hit events — closes the last raw-id lookup against
  cross-lane id aliasing), + tableHash u32 at end of header (content
  table fingerprint — a species/kind/variant reorder warns instead of
  silently remapping old clips)

## Known limits (for future re-implementers)

- weaponType is an opaque index into the game's weapon table that is NOT
  carried in the file (targetType lanes are self-describing via the
  ranges above; the ordered tables are embedded in this spec). A
  re-implementer needs the weapon table from elsewhere.
- `room` carries the lobby name, not the map/terrain name.
- One corrupted byte fails the whole file (checksum is all-or-nothing).
- `mouseDeltaX/Y` in frames is always 0 — input deltas were never wired
  into the live provider.
- Roster indices only resolve to the ids the recorder saw — players are
  stored by their wire id, not a display name.
- Events are rate-capped at 1000/s during recording; beyond that they
  drop silently.
- Remote (non-local) projectiles record Fired and Destroyed only — no
  bounce/hit edges, no target attribution.
