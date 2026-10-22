# Frontend audit — vanilla DOM layer vs published best practice

2026-10-22. Scope: `client/src/ui/` (~5.4k lines — HUD, scoreboard,
lobby, menus, minimap, indicators, feeds). Question: how does the
hand-rolled DOM layer compare to what "optimal vanilla" looks like
per the people who ship game UIs at scale?

## Verdict

Already at or near the published optimum. The codebase independently
implements every rule the literature names — several more carefully
than the literature describes. Remaining gaps are small and mostly
deliberate.

## The published rules vs what's here

| Source rule | Status here |
|---|---|
| **Mojang ore-ui**: DOM property writes are the enemy — never write a value that didn't change | Every setter in `hud.ts`/`hudStats`/`scoreboard` guards on a `last*` key (`lastTimerSec`, `lastCountsKey`, packed `v*4+mode*2+team` composite keys). A static HUD does ~zero DOM work. |
| **Riot (LoL client)**: animate on the compositor only — transform, never layout | `PlayerIndicators.setPos` writes `translate(-50%,-50%) translate(x,y)` — compositor-only — and quantizes to 0.1px so unchanged writes skip entirely. `width/height` writes only fire on size *change*. |
| **Taos engine ch.15**: DOM for screen-space UI, render pass for world-anchored content; create once, write per frame | Exactly the split: minimap/commandmap are canvas (per-frame blits, world-anchored data), indicators are pooled per-player DOM divs created once and reused. |
| **Pointer-events hygiene**: passive overlays must not eat input | `pointer-events:none` on HUD/indicators/clipfeed; only real controls opt back in (`pointer-events:auto` on menu chips). |
| **textContent for user strings** (stored-XSS) | Explicit comment + implementation in `sbRowEl`: "display names will be player-chosen strings; interpolating them raw is a stored-XSS hole." Zero `innerHTML` interpolations found in ui/. |
| **Dirty-check, don't re-render** | Scoreboard rebuilds at 4Hz *while open only*, `replaceChildren` — the comment already explains why diffing isn't worth it at that cadence. |
| **Camera work caching** | Indicator projection memoizes the camera matrix decompose — 16-float compare beats N×2 decomposes/frame. |

## What's genuinely good beyond the baseline

- **Quantized write-elision**: the `Math.round(x*10)` packed position key
  is a trick production HUDs rarely bother with — most settle for "if
  changed" per axis; this skips sub-pixel churn entirely.
- **The discipline is documented**: nearly every optimization carries a
  WHY comment ("layout isn't touched at 60Hz", "a rate-limited dot
  slides behind a panning camera"). That's the difference between an
  optimization and an institutional memory.
- **Timers only for lifecycle fades**, never for polling — feeds kill
  rows via `setTimeout(remove)`; nothing polls state that the frame
  loop already owns.

## Gaps / candidates

1. **Full-screen `backdrop-filter` on the death overlay**
   (`grayscale(0.7) brightness(0.85)` + lobby/menu `blur(3px)`).
   Bounded to dead/menu states so it's defensible — but on weak GPUs a
   full-screen backdrop filter is one of the priciest CSS ops. Cheap
   insurance: gate it behind the same auto-quality tier that already
   sheds shadows (`cpuLevel 2` → flat `background: rgba(…)` fallback).

2. **CSS var discipline is lopsided** — `hud.css` uses 29 `var(--)`
   reads; `chrome.css` uses 1. Theming a second skin means touching
   every literal. Not urgent; flag it before the next reskin.

3. **`setInterval` in CoolShotsPanel** — one interval for panel refresh.
   Harmless (menu-bound, not in the frame path) but it's the only
   polling loop in ui/; the codebase's own pattern would be a `tick(dt)`
   off the game loop or an event-driven invalidation.

4. **Layout reads are already rare and correct** — `logPanel` reads
   `scrollTop/clientHeight/scrollHeight` only around append (write→read
   once, no thrash); `overlapAudit` reads `getBoundingClientRect` but is
   explicitly a debug tool. No action.

5. **No `contain:` hints on HUD subtrees** — `contain: layout paint` on
   `#scoreboard`/`#killfeed` would bound style recalc when rows churn.
   Marginal gain at current node counts (~hundreds); worth a line if
   the DOM ever sprawls.

## Footgun sweep (second pass)

Dug for leaks, listener orphans, timer-vs-teardown races, layout
writes in hot paths, and unbounded growth. The discipline mostly
holds — findings are minor:

1. **Ghost health bar writes layout every frame while draining**
   (`hudStats.tickVitals`): `left`+`width` updates at 60Hz for ~1s
   after each hit. It's one absolutely-positioned div so the cost is a
   local layout, not a page reflow — but `transform: scaleX()` would
   make it compositor-free like the indicators already are. Same for
   the energy/armor bars, though those only write on change.

2. **Comment lies in `shieldDamage`**: "damage() resets it" — `damage()`
   never touches `boxShadow`; only the 300ms `shieldVignetteReset`
   timeout does. A real hit landing inside that window briefly shows
   the cyan shield shadow on red damage. Cosmetic, but the invariant
   the comment claims doesn't exist.

3. **Fixed-size canvases ignore `devicePixelRatio`** — `minimap`
   (160×160) and `commandmap` draw at CSS-px backing store; on dpr≥2
   displays they upscale soft. `canvas.width = SIZE * dpr` +
   `ctx.scale(dpr, dpr)` is the standard fix; ~4 lines each.

4. **`CoolShotsPanel.renderCoolShots` rebuilds 20 rows + listeners every
   1s while open** (`innerHTML=''` + `createElement` + `addEventListener`
   per row). Bounded and menu-only, but it re-parses layout per refresh
   and the comment already apologizes for the context-menu interplay.
   A row pool keyed by shot id would kill the churn.

5. **Listener hygiene is clean where it counts** — `CoolShotsPanel`'s
   document-level dismiss/keydown listeners are added on open and
   removed on close (paired, capture-phase consistent). Menu/document
   listeners that persist are singletons in an SPA — correct.
   `PlayerIndicators.remove/clear` is reached from remote-leave,
   bot-death, disconnect, and flag-despawn paths — no orphan divs.

6. **Bounded everywhere** — kill feed caps at 6, shot feed 5, log
   panel 150, indicators keyed by playerId. `paintFlagChip` writes
   `textContent` twice per call (LOOSE then conditional) — harmless
   nit, not worth a branch.

7. **`esc()` in FragMessages covers `&`/`<` only** — correct for
   element-content interpolation (quotes can't break out of text
   context). Just don't reuse it inside attributes later.

## Would a framework beat this?

Measured against the same literature: no. Mojang's own conclusion was
that the *optimal* layer is direct DOM manipulation — frameworks were
adopted only for DX, and their React-facet exists to claw back the
performance direct DOM gives free. Svelte/Lit would buy ergonomics on
the menu surfaces (scoreboard, lobby) at the cost of a build plugin,
a file type, and a reactive layer between the loop and the DOM in the
hot path. The current layer already does the one thing frameworks are
for — declarative diffing — manually, at 4Hz where it matters.

Adopt one only if menus grow past ~3 screens; the per-frame HUD should
stay hand-rolled regardless.

## Sources

- Mojang ore-ui — game UI performance notes (direct DOM optimal;
  reconciliation most expensive feature)
- Riot Games tech — LoL client animation (layout → paint → composite;
  composite-only animation)
- Taos engine book ch.15 — DOM-vs-render-pass decision table
- web.dev canvas performance — draw-diffs / dirty-region guidance
- abratabia game-UI series — hybrid overlay architecture, dirty-checking
