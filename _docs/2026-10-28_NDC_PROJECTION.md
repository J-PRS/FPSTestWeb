# NDC → screen mapping / overscan crop (2026-10-28)

Status: reference doc. The head-marker drift fix, the why, and what to watch
for if more HUD surfaces project later.

## The bug

Every projected HUD element — player dots/arrows (`indicators.ts`), health
bars (`HealthBarSystem.ts`), beacon reticle (`hud.ts`) — mapped NDC to
`window.innerWidth/innerHeight`. The GL canvas is deliberately **oversized to
a canonical 16:9 and center-cropped** (`core/renderer.ts:628`), so window ≠
canvas by design. Markers were offset by the cropped margin, an error that
grew with aspect divergence and read as "markers drift at edge angles and
weird windows".

## The fix

`client/src/ui/ndcScreen.ts` — `ndcToClient(x, y)` maps NDC through
`canvas#gl`'s `getBoundingClientRect` (falls back to window if `#gl` absent).
All three call sites now project through it. Edge clamps stayed in window
space — the visible screen edge is what the clamp describes, so that's
still correct.

## Why this is the right contract

- The renderer owns the crop. The canvas client rect is the ONLY shape that
  knows where the image sits on screen. Reading `window.*` guesses it.
- Industry practice (Source/UE HUD projection): project world→NDC, map NDC
  to the **viewport's** client rect, clamp to the **window's** visible edge.
  Two different frames — don't conflate them.
- `getBoundingClientRect` per frame per system is cheap (~3 calls/frame
  total across indicators, bars, beacon). Cacheable on resize if it ever
  shows up in profiles; hasn't.

## What else lives on this path

- **Flag diamonds** (`game/remotes.ts:265`) — the same projection class.
  Verified now through the same helper; watch for it if it diverges.
- **`minimap.ts` / `commandmap.ts`** — own canvas elements, own coordinate
  space, unaffected by overscan.
- **Damage numbers** — if they ever project world→screen, use `ndcToClient`
  not `window.*`. Don't re-introduce the pattern.

## Related

- `renderer.ts` overscan comment — the source of the crop contract.
- `_docs/2026-10-28_LAG_COMP_WYSIWYG.md` — the other "view vs truth" doc.
