# Health Bar Damage Ghosting — Research & Implementation Report

## Overview

The "white damage trail" visible on our enemy health bars is an established UI pattern known as **damage ghosting** (also called "health bar ghost", "damage trail", or "health chunking"). The core idea: when an entity takes damage, the health bar drops instantly, but a visual "ghost" of the lost health remains briefly as a lighter-colored segment before animating away. This gives the player's brain time to register how much damage was dealt before the bar settles to its new state.

## How It Works

### Timeline
1. **Damage lands** — health portion (red) shrinks instantly to new value
2. **Delay phase** (0.3s) — white "ghost" segment stays at full damage width, frozen
3. **Flash/shrink phase** (0.12s) — white segment animates from full width down to zero
4. **Bar lifetime** (1.5s) — entire bar remains visible, then disappears

### Visual Layers (bottom to top)
| Layer | Color | Purpose |
|-------|-------|---------|
| Background | Dark red, 20% opacity | Full bar outline (max health reference) |
| Health | Red, 90% opacity | Current health (left-aligned) |
| Ghost | White, 100% opacity | Damage just dealt (shrinks after delay) |

## Games Using This Pattern

### MOBAs
- **League of Legends** — Grey/white ghost trail on champion health bars, nearly identical mechanic
- **Dota 2** — Lighter-colored damage portion that fades after ~0.25s
- **Heroes of the Storm** — Similar ghost trail on hero bars

### RPGs / Action
- **World of Warcraft** — Health bars show damage as a trailing lighter segment
- **Genshin Impact** — Enemy HP bars show damage as a fading lighter portion
- **Diablo III** — Damage appears as a trailing chunk on enemy bars
- **Borderlands** — RPG-style enemy bars with visible damage chunks

### Shooters
- **Destiny 2** — Enemy bars show damage as a brighter segment that fades
- **Overwatch 2** — Brief white flash on health bar when damage lands (simpler version)
- **Halo Infinite** — Shield bar shows damage as a trailing segment before recharge

### Strategy / Card
- **Hearthstone** — Card health changes show a brief trailing animation
- **StarCraft II** — Unit health bars show damage as a lighter trail

## Our Implementation

### File: `client/src/HealthBarSystem.ts`

```
Constants:
  FLASH_DURATION = 0.12   // shrink animation duration
  DELAY_DURATION = 0.3    // ghost stays frozen before shrinking
  BAR_LIFETIME   = 1.5    // total bar visibility duration
  BAR_WIDTH      = 60px
  BAR_HEIGHT     = 5px
```

### Key Design Decisions

1. **No opacity fade** — Bar stays fully visible then pops out (matches OG Heaps implementation). Most AAA games fade out, which could be added as a 0.2s fade for polish.

2. **Ghost = damage dealt** (not previous health) — The white segment represents the damage amount, positioned right after the current health. This is the same visual result as "previous health ghost" but framed from the damage side.

3. **Accumulating damage** — If the entity takes multiple hits during the delay phase, damage accumulates (bar grows). After delay ends, new hits replace the ghost and reset timers.

4. **Screen-space positioning** — Bar is projected from 3D world position (above player head) to 2D screen coordinates using camera projection. Hidden when behind camera or off-screen.

5. **Follows RemotePlayer position** — Uses locally simulated RemotePlayer position (not server position) so the bar tracks knockback/pull effects in real-time.

### Integration Points

- **Spawn**: `networkManager.onPlayerHit` callback → `healthBarSystem.spawn(targetId, damage, health)`
- **Update**: Main game loop → `healthBarSystem.update(dt, networkManager.getPlayers(), remotePlayers)`
- **Cleanup**: `onPlayerKill` handler and player removal loops → `healthBarSystem.removeBar(playerId)`

## Comparison to Industry

| Feature | Ours | LoL | Dota 2 | Destiny 2 | Overwatch 2 |
|---------|------|-----|--------|-----------|-------------|
| Ghost trail | Yes | Yes | Yes | Yes | Brief flash |
| Delay before shrink | 0.3s | ~0.25s | ~0.25s | ~0.2s | N/A |
| Shrink duration | 0.12s | ~0.1s | ~0.15s | ~0.3s | N/A |
| Bar appears | On damage | Always visible | Always visible | On damage | On aim/damage |
| Bar disappears | 1.5s after hit | Always visible | Always visible | ~3s after combat | 5s after damage |
| Opacity fade | None (pop) | N/A (always on) | N/A | Fade out | Fade out |
| Segmented/chunked | No | Per-100 HP | No | Yes | Per-25 HP |

## Potential Improvements

1. **Opacity fade on disappear** — Add a 0.2s fade-out at end of lifetime for smoother visual exit
2. **Segmented bars** — Divide into chunks (e.g., per-25 HP) for easier reading at a glance
3. **Color coding** — White for health, blue for shields, yellow for armor (if systems are added)
4. **Low HP threshold** — Only show bar when enemy is below 30% HP (Overwatch 2 style cleanup tool)
5. **Damage numbers** — Floating numbers near the bar showing exact damage per hit
6. **Critical hit flash** — Bar flashes brighter/bigger on headshot or critical hit

## References

- Original implementation: `HEAPS_HAXE/src/ui/HealthBar.hx` and `HealthBarSystem.hx`
- Current implementation: `client/src/HealthBarSystem.ts`
- Integration: `client/src/main.ts` (onPlayerHit, update loop, cleanup handlers)
- Config: `client/src/config.ts` (`MAX_HEALTH = 100`, `PLAYER_HEIGHT = 2.0`)
