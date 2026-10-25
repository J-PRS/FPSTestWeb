# Phantom mouse deltas — detection done right

Written 2026-10-25. Sources: w3c/pointerlock issue #42 (movementX
coordinate space), wasm-bindgen #3862, three.js #27040, MDN Pointer
Lock / unadjustedMovement docs, web.dev "Disable mouse acceleration".

## The bug

Chromium pointer-lock occasionally emits ONE huge `movementX/movementY`
spike (hundreds to thousands of px) bracketed by stillness — the
"cursor teleport" bug. Hits every Chromium pointer-lock app including
Krunker and the three.js examples; worse at high mouse polling rates
and while streaming. Absent in Firefox.

## Why magnitude clamping fails

`movementX` counts *mouse counts* — scales linearly with device DPI.
A fast human swipe is ~4-6m/s peak:

| Swipe | 400 DPI | 800 DPI | 1600 DPI | 3200 DPI |
|---|---|---|---|---|
| 4 m/s @125Hz | 504 | 1008 | 2016 | 4031 |

A hard px threshold that catches the bug also eats legit flicks at
high DPI / low polling — the user-visible "camera stops mid-swipe"
freeze that triggered this. Original clamp was >250px drop; real
flicks at 125Hz+800dpi exceed that.

## The layered fix (input.ts)

1. **`requestPointerLock({unadjustedMovement: true})`** — the documented
   workaround (Chrome ≥88). The bug lives in the OS-adjusted path;
   raw input bypasses it AND kills the EPP accel curve so cm/360 is
   honest. Falls back to plain lock on rejection.
2. **Neighbor-isolation guard** — drop only when `|d|>500` AND the
   previous event was near-still (`<50px`). Phantom spikes are
   isolated; any real flick — at any DPI — has ramp-up neighbors.
   Magnitude can't separate swipe-speed×DPI from the bug; topology can.
3. **Dev-visible drop log** — `logger.warn` rides the dev-gated
   complaint feed into the conn-banner so the filter firing is visible
   during swipe tests.

## Remaining edge

A phantom spike that lands *inside* an active flick (previous event
already large) sails through — untestable rarity; the WARN banner will
say if real drops still happen.

## Also in this change

- `fps-sens` default 1.0 → 0.8 (menu "8") ≈ 12.5cm/360 @800dpi —
  casual flick default inside the real Tribes/Quake player band
  (64% of QL pros: 20-32cm; TA forum players: 13.8-27cm).
- SENS field got a live cm/360 readout + synced dual inputs
  (`≈12.5cm` field editable both ways) — see
  `_docs/2026-10-25_MOUSE_SENS.md` for the survey table.
