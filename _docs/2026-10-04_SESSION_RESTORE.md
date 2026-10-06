# Session restore — boot order, the veil, and what runs underneath

## Symptom

On F5 with a live room session, the client showed **RESTORING SESSION**
while gunfire, bot chatter, and sheep spam continued underneath — clicks
even discharged weapons. The veil looked like a polite loading screen;
underneath it a full offline match was running.

## What was actually behind the curtain

Not a temp mode and not a leak — the client's always-on local world.
`main.ts` boots terrain, Player, entities, wave director, bots, and the
whole sim before networking resolves, because the same binary is the
offline game. Until `gameState` arrived and reseeded everything, that
world simulated a match destined to be discarded: audible, clickable,
wasted.

## Boot order now

```
stored fps-session-token + online intent (?room/?p2p/?mode)
        │
        ▼
   pingServer(/rooms, 1.2s)          ← same gate probeBootMap uses for terrain
        │
   ┌────┴────────┐
   live          dead
   │              │
   veil + connect no veil — offline world owns the
   │              first frames immediately
   ▼
loop frozen under veil (no sim/fx/HUD/render/input/audio)
   │
   ▼
gameState → dropSessionVeil → normal play
```

- `main.ts` `connectPhase` — veil arms only after `pingServer` answers.
- `game/net/world.ts` — `isSessionVeiled()` exposes the flag.
- `gameLoop.ts` — early-out right after the frame watchdog while veiled.
  Safe because `gameState` is socket-event driven, not tick-polled, so
  the freeze can never deadlock the restore it's waiting on.

## Why freeze instead of mute+gate

The user's framing was correct: *before connect there is no game*, so
the honest state is "nothing", not "a muted game you can't see". Freezing
the loop also skips the wave director, bot ticks, and ambient audio loops
(jet/wind/ski stay at zero gain — nothing calls `set()`), kills weapon
input (it lives inside `player.update`), and saves the render pass. Only
rAF, stats, and the watchdog keep breathing so the frame stays alive.

## Failure edges

- Ping succeeds but ws/gameState never lands → 8s veil timeout drops the
  curtain into the offline world (unchanged escape hatch).
- Connect succeeds before a gameState → the veil drop happens inside
  `onGameState`, which already purges volatile world state first.
- Classic/solo/no-token boots never touch the ping or the veil.

## Related fixes in the same pass

- Lobby thumb probe is `fetch`-gated (`lobbyPanel.ts`) — a missing
  `maps/thumbs/<name>.png` (trident) hides silently instead of 404ing.
- `sfx.powerup('gem'|'tag')` bypass the generic `powerup.ogg` fallback so
  nuggets play the authored chime+swell, not the stock powerup clip.
- Jet loop rate follows armor class on both local and remote loops
  (`JET_RATE` in `sfx/world.ts`).
