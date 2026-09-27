# Footprint conforming — seating objects on terrain

Problem: a wide object placed on a heightfield by its center height leaves
air gaps — the downhill edge floats, the uphill edge clips. Tilt alone
doesn't fix it; a flat base can't match a curved surface.

## The technique

1. **Sample the footprint, not the point.** N heights around the object's
   base ring (we use 8 at radius ~1.35m) plus the center.
2. **Seat to the lowest sample.** Sink the visual until the base bottom is
   `BURROW` below the lowest dirt under the footprint. Every edge is then
   at-or-below ground — no gap is geometrically possible on sampled relief.
3. **Tilt to the average normal**, not per-sample — the body is rigid.
4. **Decouple visual from simulation.** `pos` keeps the honest gameplay
   height (projectiles, blast checks, health bars reference it); only the
   rendered mesh sinks via `meshYOffset`. Physics never inherits a visual
   hack.

Provenance: this is what shipped games do — Cities: Skylines 2 building
lots store sampled heights per edge for placement leveling; RTS building
placement seats to lowest footprint sample; Unity placement tools ship
"terrain conform" as exactly this.

## Failure modes and escalations

- **Crest landing** — object spans a bump, lowest-sample seats it deep and
  it looks half-buried instead of floating. Fix is a skirt, not less burial.
- **Terrain skirt** — a ring/apron mesh draped onto the terrain around the
  base edge hides any residual gap and connects the object to ground
  visually (RTS foundations, dirt mounds). **Shipped on Turretter**: a
  3-ring annulus (`SKIRT_RINGS`) conformed per-vertex in `conformSkirt()` —
  the hem vertex IS terrain height, so ground contact is a geometric
  guarantee rather than a tuned constant. Works on slopes, crests, and
  depressions with no special cases.
- **Terrain deformation** (Valheim/ARK) — flatten/raise under the object.
  Only when the object is meant to modify terrain; overkill for a hopper.

## Where it lives

`Turretter.seat()` — `client/src/entities/Turretter.ts`. Reusable pattern
for anything that plants on terrain: base classes, deployables, props.
