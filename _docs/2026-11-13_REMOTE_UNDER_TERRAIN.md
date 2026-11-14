# Remote players rendering under terrain — investigation report

Date: 2026-11-13. Trigger: 1v1 igunffa match — fast downhill skiing through a
bowl, remote visibly read as *below the ground surface*, reportedly at close
range (not just distance). Companion symptoms in the same session: "invisible
ceiling" feel while jetting, one 42°/frame camera spinout (traced separately to
a phantom mouse delta that slipped the input.ts:467 isolated-delta gate during
a tab-hide/resync window).

## Evidence from the session

`logs/OLD/client_warning_2026_11_13-19_24_08.log` and
`client_error_2026_11_13-19_24_56.log` (18:28–19:24 session):

- `GLITCH:dbgwire-jump` ×6 — remote wire positions jumping 14m inside a 50ms
  span (BOT-DUNE-04, BOT-HALO-13; headhunt room, not the 1v1, but same code
  path — the detector at `remoteInterp.ts:204` fires on any >8m/speed-implausible
  snapshot jump).
- `POS JUMP 45.5m / 40.8m / 46.0m in one frame — dead=false` (19:19:10–19:19:20)
  — three local-player corrections in 10s, bracketed by `[Resync] hidden Ns
  offline` warns (tab hidden/shown repeatedly around then).
- `phantom delta dropped (-839,-173)` + `Camera spinout 42.1deg/frame` in the
  same window — the input-side half of the same hiccup burst.
- No log exists for the under-terrain render state itself — it is silent by
  design. `dbgwire-jump` records *wire* jumps only, not render-vs-field
  divergence.

## How remote placement actually works

`client/src/entities/remoteInterp.ts`, per frame (`step()`, :252):

1. **Snapshot buffer** (`remoteSnapshots.ts`) — wire records pushed on arrival;
   render samples a delayed point on the *straight-line* path between the two
   bracketing records (`interp()` → `p.copy(sampledPos)`, :587).
2. **Dead reckoning** (`simStep()`, :786) — on a silent stretch (~2.5× the
   measured arrival interval, :257) the ghost integrates gravity (+ held-jet
   thrust from `wireJet`) and clamps feet to the authoritative ground (:830).
3. **Converge** (`convergeStep()`) — mid-size gaps steer toward the newest
   record under an accel cap instead of snapping.
4. **Ground floors** — three separate clamps, all against `groundY()` (:622)
   which is `max(smooth heightfield, hmChord L0)` — deliberately **not**
   `getRenderedHeight` (:614–621 comment: the drawn clipmap level coarsens to
   ~40m cells with viewer distance, and a floor the server can't reconstruct
   was proven to float bodies ~5m above their validated capsule — the "pure-Y
   rg tail" in the ghost soaks).

## Root causes, ranked

### A. Interp chord through terrain, gated open by the airborne-wire skip — primary, works at ANY range

`floorToGround()` (:636) only lifts the rendered position when **wire feet**
are at/below the smooth field + 0.5m:

```ts
if (feet > this.h.terrain.getHeight(p.x, p.z) + 0.5) {return;}  // :640
```

A skier at speed through a bowl is *airborne most of the time* (lip launches,
gully exits). For an airborne wire the floor is skipped entirely — so the
rendered position follows the raw snapshot chord, which is a straight line
between two records while the true path went over a rise. The chord shortcuts
*through* the terrain and the body renders inside the hill until the next
record lifts it. At 60m/s a 100ms render delay = a 6m chord; through a bowl
lip that's meters of burial. **This is the close-range mechanism the user
saw** — no LOD involved, and it matches the code's own measurement note
("burial measured ~97% chord-shortcut vs ~3% wire dips", :740).

The same gate sits in the converge path (:744–747): `wireBuried` is checked
against `getRenderedHeight` of the *wire* position, and only floors when the
wire isn't buried — correct instinct, but it means airborne chords render
unchecked there too.

### B. Coarse-clipmap LOD divergence — persistent, distance only

The drawn surface at range uses cells up to ~40m; bilinear-averaged heights
bridge gullies, so the *drawn* triangle can sit meters above the sim field the
remote is clamped to. Render pos = wire pos = hittable pos, but visually
buried. Can't explain the close-range sighting; explains distance burial.
Deliberate trade-off documented at :614–621.

### C. Extrapolation in a vacuum — bounded, partial contributor

Classic DR ignores the world (packet-loss bursts → "objects sink or pass
through geometry until the next update"). Ours isn't fully naive — `simStep`
does gravity + authoritative ground clamp, so it can't sink *below* the sim
field — but its clamp can't protect against the drawn-vs-field gap (cause B)
or a wrong heading into a hill face. Mostly ruled out as the close-range
cause; the interp path already owns those frames.

### D. Packet loss / arrival gaps widen A

Dropped records → longer spans → longer chords through terrain. The session
had resync/hidden churn right before the anomalies; consistent amplifier, not
an independent cause.

## Why the obvious fix is off the table

A visual-only lift (render the mesh at the drawn surface while the capsule
stays at wire truth — the FishNet `graphicalTransform` / PurrNet `Graphics`
pattern) violates WYSIWYG: here the *rendered body is the shootable truth* —
rewind validation keys off the wire capsule the client drew. A lifted visual
would show blood the server never pays. The code comments say the same
decision was already made once: "invisible but consistent — you can't aim at
it and the server can't pay the hit either way" (:620).

## Candidate fixes

**F1 — Airborne-aware floor (recommended).** Extend `floorToGround`'s gate:
when the *wire* is provably above the drawn surface but the *rendered* chord
point sits below it, clamp the render up to the drawn surface. Lifting a
render that's under terrain toward a wire that's above it only ever *reduces*
render-vs-truth error — it can never hover a body above its validated
capsule, which is the failure the current skip was built to prevent. Kills
cause A at any range; does nothing for B (nothing should — B keeps render ==
wire).

**F2 — Min-filtered clipmap LOD (the class-killer for B).** Downsample coarse
cells with `min(child heights)` instead of averaging: the drawn surface
becomes provably a lower bound of the sim surface, so *nothing* — remotes,
pickups, corpses — can ever render under terrain. Residual: bodies may read
slightly *above* the drawn dip at distance; still shootable-honest. Doesn't
touch A (chords cut through L0-resolution ridges too).

**F3 — Denser path data.** Send sub-tick position segments for fast movers
(Gambetta's suggestion) — shorter chords, smaller dips. Bandwidth cost; treats
the symptom.

**F4 — Reject invalid interp waypoints** (BEPU forum advice): gate the
*sample*, not the render — discard sampled points under the drawn surface
when both bracketing records are above it. Nearly the same as F1, one layer
deeper.

## Recommendation

F1 now — it's ~5 lines in `floorToGround`'s gate and self-correcting by
construction. F2 as a follow-up if distance burial keeps annoying; it's a
terrain-generation property that retires the whole class rather than patching
placement.

## Gaps / what I did not verify

- No live repro of the close-range burial — the mechanism is argued from the
  interp math + the code's own soak measurements, not a captured frame.
- Whether the igunffa-1 session's burial was A or a real *wire* dip (the 3%
  case — a server-side "unbury" rescue path exists for those). If it was a
  wire dip, F1 won't lift it, by design.
- The "invisible ceiling" complaint is unrelated to this path — candidates
  are the `jetMaxFwdAccel` (50 m/s) forward-thrust ceiling and tank-empty jet
  cutoff. Not investigated further here.
