# UI / HUD review — 2026-10-19

Code-level review of `client/src/ui` (hud.ts, hud/dom.ts, hud.css, scoreboard.ts,
indicators.ts, minimap.ts, commandmap.ts, hudStats.ts) plus the menu files.
No code changes — findings only. Prioritized P1–P3.

## P1 — high leverage

### Information density (hudStats, ~15 spans/frame)
`HudStats` paints health, energy, armor, speed×3, kills, state, ping, loss,
jitter, fps, slots every frame. Telemetry competes with the crosshair.
- Add a "minimal HUD" setting (persisted) that hides the telemetry row.
- Collapse speed×3 to one primary number; show vertical component only
  while airborne.

### Crosshair / hit feedback
- `hitMarker`, `dmgDir`, `dmgDirArc`, `dmgVignette` split damage feedback
  across 4 elements. Unify into one radial indicator, opacity ∝ damage.
- Hit marker: scale/color by damage and distinguish body/head/kill.
- Crosshair gap should widen while moving/firing to convey inaccuracy.

### Match strip
Score, timer, team scores, held-count, classic-score live in separate
corners. Consolidate into one top-center "match strip" to reduce eye travel.

## P2 — medium

### Health / energy
- `HealthBarSystem` (15KB): verify smooth lerp on damage + low-health pulse
  gated so chip damage doesn't trigger it.
- Energy: consider segmented readout so "jets remaining" is legible.

### Minimap / command map
- Two map systems can double-draw; ensure only one active at a time.
- Minimap should be heading-up by default with a north-up toggle; verify the
  player arrow rotates.
- Command map: team-color-code spawn pools / flags, not just shapes.

### Scoreboard
- Pause pointer lock cleanly on open; ESC closes without leaving a "menu"
  state.
- Highlight local player, sort by score, team grouping, ping column color-coded.

### Loadout / menus
- `loadoutMenu.ts` (16KB): keyboard nav (arrows+Enter), distinct selected
  weapon, quick-switch reminder in HUD.
- `keysMenu.ts` + `overlayInput.ts`: rebinding without reload, inline conflict.

### Accessibility
- Colorblind palette swap (team colors red/blue) affecting minimap + names.
- UI scale setting (root font-size multiplier) instead of fixed px in hud.css.
- Respect `prefers-reduced-motion` for vignette/shake.
- `onboarding.ts` dismissable, not blocking on subsequent loads.

### Performance
- Throttle scoreboard DOM updates to ~4 Hz, batch writes.
- `indicators.ts` (10KB): avoid per-frame `getBoundingClientRect`; use transforms.

## P3 — low

### Frag / kill feed
- `FragMessages.ts` + `shotFeed.ts`: fade + slide, stack without overlap,
  multi-kill banner (double/triple).

## Already done this session (maplab)
- Terrain picker dropdown (custom + /maps roster), drop-height slider, honest
  ball hues (NormalBlending, toneMapped:false, sRGB HSL), first-person ski
  toggle. Play button is a full-width toggle; a "playing" badge would help
  when the rail is scrolled.

## Suggested next steps
1. HUD settings panel (scale, minimal mode, colorblind palette, minimap rotation).
2. Unify damage feedback into a single radial indicator.
3. Throttle scoreboard/indicator DOM updates.
4. Audit overlayInput for keyboard-only navigation.