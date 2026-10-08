# Tribes: Ascend - Server-Side Lag Compensation

> **Retroactively correct projectile hits for all players, at all pings, without touching a single client.**

A Win32 DLL that injects into the Tribes: Ascend dedicated server process and adds full, server-authoritative lag compensation. It hooks into the Unreal Engine 3 (UE3) tick loop, maintains a rolling per-player position history, and rewinds every player backwards in time - by exactly their network round-trip latency - before the engine evaluates projectile collisions. After evaluation, all players are silently restored to their real positions. The entire operation is transparent to clients; the only client requirement is enabling the game's built-in **Simulated Projectiles** setting.

![Language](https://img.shields.io/badge/language-C%2B%2B20-blue)
![Platform](https://img.shields.io/badge/platform-Win32%20%28x86%29-lightgrey)

---

## Table of Contents

- [Tribes: Ascend - Server-Side Lag Compensation](#tribes-ascend---server-side-lag-compensation)
	- [Table of Contents](#table-of-contents)
	- [Overview](#overview)
		- [The problem](#the-problem)
		- [The solution](#the-solution)
	- [Demo](#demo)
	- [Features](#features)
	- [Architecture](#architecture)
		- [Circular buffer position history](#circular-buffer-position-history)
		- [Rewind algorithm (sub-tick interpolation)](#rewind-algorithm-sub-tick-interpolation)
		- [Metadata pointer piggyback](#metadata-pointer-piggyback)
		- [Hook layers](#hook-layers)
	- [Configuration](#configuration)
		- [Lag compensation constants](#lag-compensation-constants)
	- [Usage](#usage)
		- [DLL injection](#dll-injection)
		- [Client configuration](#client-configuration)
	- [Performance](#performance)
		- [Design optimisations](#design-optimisations)
		- [Benchmark](#benchmark)
	- [Roadmap](#roadmap)
	- [License](#license)

---

## Overview

### The problem

Tribes: Ascend is a fast-paced, projectile-based shooter where players ski and jetpack at high speeds. Even at moderate network latencies the gap between where a shooter *sees* an enemy and where the server *currently* believes them to be is large enough to make direct-fire weapons feel noticeably unresponsive. Without lag compensation a player must lead their aim by a distance proportional to their ping - counter-intuitive, skill-punishing, and frustrating.

### The solution

This project is a server-side DLL that adds **backward-in-time lag compensation** to the Tribes: Ascend dedicated server (the `TribesAscend.exe` process, running natively on Windows or under Wine on Linux). Every game tick the server:

1. Snapshots every live player's position and velocity into a fixed-size circular buffer.
2. When a projectile spawns, records the shooter's ping and associates it with that projectile.
3. Before the engine ticks projectile physics, rewinds all players to the positions they occupied `ping` milliseconds ago.
4. Lets the engine evaluate collision against the rewound positions.
5. Immediately restores all players to their real positions.

## Demo

The video below demonstrates lag compensation active on a live server - notice that shots that visually connect on the client side now register as hits regardless of ping:

<a href="https://youtu.be/L-lhFHvdRc8"><img src="https://img.youtube.com/vi/L-lhFHvdRc8/maxresdefault.jpg" width="640" height="360" alt="Tribes: Ascend Server Lag Compensation Demo"/></a>

---

## Features

| Feature                                 | Detail                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Full projectile lag compensation**    | All projectile weapons - including arcing, gravity-influenced, and bounce projectiles - are compensated.                                                                                                                             |
| **Radial (splash) damage compensation** | The `TrProjectile.HurtRadius_Internal` UFunction is absorbed and re-executed against rewound player positions.                                                                                                                       |
| **Ping-sorted projectile grouping**     | Projectiles are bucketed by ping value so all projectiles belonging to players at the same ping are ticked together in one rewind/restore cycle - minimising redundant rewinds.                                                      |
| **Sub-tick linear interpolation**       | Player rewind interpolates between the two surrounding circular buffer entries using the fractional millisecond remainder for sub-tick-accurate position reconstruction.                                                             |
| **Configurable compensation window**    | Default: 4 ms minimum threshold to 400 ms maximum. Any projectile outside this window is not lag compensated.                                                                                                                        |
| **In-memory pointer piggyback**         | Per-actor metadata (`PlayerInformation`, `ProjectileInformation`, `ControllerInformation`) is stored by writing a heap pointer into the unused `EditorIconColor` field of each `AActor`, requiring zero engine struct modifications. |
| **Singleton `LagCompensation` class**   | All state is owned by a single, lazily-initialised singleton. No globals, no static mutables outside the class.                                                                                                                      |

---

## Architecture

### Circular buffer position history

Each `PlayerInformation` object owns a `CircularBuffer<PlayerTickInformation>` whose capacity is computed from the compensation window and the server tick rate:

```
buffer_size = (window_in_ms / tick_delta_in_ms) + 2
            = (400 / 33.33) + 2
            = 14 entries  (at default 30 Hz)
```

Each entry stores `FVector location_` and `FVector velocity_` (currently unused). The buffer is a fixed-size ring; oldest entries are silently overwritten. Access is O(1).

### Rewind algorithm (sub-tick interpolation)

```
tick_index     = floor(ping_ms / tick_delta_ms)
prev_index     = tick_index + 1
ms_remainder   = ping_ms % tick_delta_ms
interpolated   = tick_location + (prev_location - tick_location) × (ms_remainder / tick_delta_ms)
```

### Metadata pointer piggyback

The engine's `AActor::EditorIconColor` field (a `FColor`, 4 bytes on 32-bit) is an editor-only field unused at server runtime. The DLL repurposes those 4 bytes as a raw pointer to a heap-allocated `ActorInformation` subclass:

```cpp
// Write
memcpy(&actor->EditorIconColor, &information_ptr, sizeof(size_t));
// Read
ActorInformation* ptr = *reinterpret_cast<ActorInformation**>(&actor->EditorIconColor);
```

This avoids map lookups and reduces metadata access to a single pointer dereference. The `actor_id_` discriminator field on the base class enables safe runtime downcasting.

### Hook layers

| Layer                       | Mechanism                                           | Hooked symbols                                                                                            |
| --------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Native hooks** (Detours)  | `DetourAttach` on raw function addresses            | `TickActorsPreAsyncWork`, `ActorTick`                                                                     |
| **UFunction hooks** (uhook) | `ProcessInternal` intercept keyed by UFunction name | `TrProjectile.PostBeginPlay`, `UTProjectile.Destroyed`, `TrProjectile.HurtRadius_Internal`, `TrPawn.Died` |

---

## Configuration

All compile-time configuration is in `lag_compensation.hpp`. There is no runtime config file.

### Lag compensation constants

| Constant                | Default  | Description                                                                   |
| ----------------------- | -------- | ----------------------------------------------------------------------------- |
| `tick_rate_`            | `30.0f`  | Server tick rate in Hz. Updated at runtime via `UpdateTickRateVariables()`.   |
| `window_in_ms_`         | `400.0f` | Maximum ping (ms) to lag compensate.                                          |
| `kMinimumPingThreshold` | `4.0f`   | Pings at or below this value are not compensated.                             |
| `kMaxPingDelta`         | `4.0f`   | Max ping change between ticks before a fresh ping read is forced.             |
| `buffer_size_`          | Derived  | `(window_in_ms_ / tick_delta_in_ms_) + 2` - circular buffer depth per player. |

---

## Usage

### DLL injection

On successful injection the DLL spawns a worker thread (`OnDLLProcessAttach`) that:
1. Initialises the plog logger.
2. Resolves all UFunction pointers via `SetupUFunctionHooks`.
3. Attaches all Detours inside a `DetourTransactionBegin / Commit` block.
4. Registers all UFunction hooks via `PerformUFunctionHooks`.
5. Calls `LagCompensation::GetInstance().UpdateTickRateVariables()`.

### Client configuration

Each player must enable **Simulated Projectiles** in their game settings. Projectiles fired without this setting are not intercepted by `TrProjectile.PostBeginPlay` and are therefore not lag compensated. This is by design - the game's projectile code path differs between the two modes.

---

## Performance

### Design optimisations

The project currently uses crude optimisations.
Some techniques keep the per-tick overhead to a minimum:

- **Ping bucket grouping** - Players are rewound at most once per unique ping value per tick. In practice most players on the same server cluster into a small number of distinct ping buckets, so the rewind/restore pair executes far fewer times than the raw projectile count.
- **Ping delta gate** - A per-controller cached ping value is used when `|new_ping − last_ping| ≤ kMaxPingDelta` (4 ms).
- **Direct class pointer comparison** - All hot-path actor type checks compare `actor->Class == kPlayerClass` directly. The `IsA()` virtual dispatch is explicitly avoided as documented in the codebase.
- **Fixed-size circular buffer** - No heap allocations after initial `PlayerInformation` construction. `PushBack` is O(1) with no dynamic resizing.

### Benchmark

<img width="900" height="750" alt="Image" src="https://github.com/user-attachments/assets/9294534b-82b7-40bb-ab09-828cf5161748" />

---

## Roadmap

> Items marked **(inferred)** are proposed improvements based on code analysis; they are not committed features.

- [ ] **(inferred)** Directly patch `UFunction::Func` for registered UFunction hooks rather than intercepting `ProcessInternal` globally, reducing per-tick hook overhead.
- [ ] **(inferred)** Runtime-configurable compensation window and tick rate via a JSON/INI config file loaded on DLL attach, removing the need to recompile for parameter changes.

---

## License

This project does not currently include a `LICENSE` file. All rights are reserved by the author unless otherwise stated. If you wish to use or distribute this project, please open an issue to discuss licensing.