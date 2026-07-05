





Here's how our implementation compares to common FPS patterns:

## Our Implementation vs. Industry

| Feature | Ours | Far Cry 6 | Overwatch 2 | Apex Legends | Halo |
|---------|------|-----------|-------------|--------------|------|
| **Bar appears** | On damage hit | On damage hit | When aiming at enemy (always visible in reticle) | Not shown for enemies | Not shown for enemies |
| **Bar disappears** | 1.5s after last hit | When enemy dies/out of combat | 5s after last damage | N/A | N/A |
| **White damage trail** | Yes — full for 0.3s, shrinks over 0.12s | No — just chunks | No — instant health drop | N/A | N/A |
| **Bar position** | Above head, screen-space | Above head, screen-space | Above head, reticle-anchored | N/A | N/A |
| **Bar follows entity** | Yes (via RemotePlayer position) | Yes | Yes | N/A | N/A |
| **Opacity fade** | None (pops out) | Fades out | Fades out | N/A | N/A |

## What we got right (matches industry)

- **Floating above head, screen-space projected** — same as Far Cry 6
- **Appears only on damage, disappears after timeout** — standard pattern
- **White damage trail with delay** — this is actually rare and cool. Most games (Far Cry, Overwatch) just instantly drop the health portion. The white trail that lingers then shrinks is a distinctive touch from your Heaps game that gives better damage feedback.

## What could be improved (based on research)

- **Overwatch 2** recently added "low HP threshold" — bar only becomes visible when enemy is below a certain health %, making it a cleanup tool rather than always-on. Could add as option.
- **Far Cry 6** uses segmented bars (chunks) for RPG-style enemies — visually clearer for high-HP targets.
- **Apex/Overwatch** use color-coded segments (white=health, blue=shield, yellow=armor) — useful if we ever add shields/armor.
- **Opacity fade on disappear** — most games fade rather than pop. We intentionally removed it to match OG, but a quick 0.2s fade would feel more polished.
- **Damage numbers** floating near the bar — Borderlands/Overwatch style. We could add this later.

The white damage trail is actually a standout feature — most AAA FPS games don't have it. It gives players a clear visual of "how much damage I just dealt" which is valuable feedback. The implementation is solid and matches the OG behavior well.