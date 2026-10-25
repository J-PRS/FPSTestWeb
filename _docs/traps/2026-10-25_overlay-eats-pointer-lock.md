# Trap: invisible full-screen overlay swallows the pointer-lock click

## The symptom that misleads

After spawning, clicking into the game did nothing. Pressing Esc first
(which opens the menu) and then clicking worked. Reads like a pointer-lock
timing or browser cooldown bug. It was neither.

## The mechanism

Pointer lock is requested from the canvas `click` handler
(`ui/overlayInput.ts`, `rendererCanvas.addEventListener('click', ...)`) or
from the overlay click when the overlay itself is the target. A click only
reaches the canvas if nothing above it catches the event.

The damage feedback layers were moved to `document.body` (`ui/hud/dom.ts`,
`document.body.append(dmgVignette, dmgEdge, dmgDir)`) so that no HUD
ancestor could anchor them to the wrong box. That put them after the canvas
in the DOM, as top-level siblings. Their CSS had no `pointer-events: none`:

- `#dmg-vignette` is `position: fixed; inset: 0`. Full screen, opacity 0.
- `#dmg-dir` is a 110px box at screen center.

An element at `opacity: 0` still hit-tests. Both caught the click, so the
canvas never got it and the lock was never requested.

Esc works because it is a keydown handled on `document`; it never depends on
a click reaching the canvas.

## Why it was hard to see

- `pointer-events` is not a visual property. Nothing looks wrong on screen.
- The layers were invisible at rest (opacity 0), so the cause wasn't obvious.
- The bug appeared only after the reparent, not in the code that handles
  clicks, which was the first place to look.

## Fix

`pointer-events: none` on `#dmg-vignette` and `#dmg-dir` (`ui/hud/hud.css`).
`#dmg-edge` already had it.

## Rules of thumb

- Any element appended to `document.body` above the canvas must be
  `pointer-events: none` unless it is meant to take clicks. Opacity 0 and
  `visibility` do not make it click-through. Only `pointer-events: none` or
  `display: none` does.
- When a click handler "stops working" after a DOM or CSS move, check what is
  under the pointer first (`document.elementFromPoint(x, y)`) before touching
  the handler or pointer-lock logic.
- Pointer-lock failures that go away with Esc-first point to the click
  target, not to the lock API.
