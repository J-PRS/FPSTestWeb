# Remote-player warping — audit & fix plan (2026-10-24)

## Symptom

On rimrock headhunt (WT, 2-4ms ping, 0-19% loss), remote bodies visibly
rubber-band and warp. Alt+Q consistently shows most remotes `sim:true`
with `renderΔ` 7-50m, and `dbgghost-jump` storms of per-push `adj`
7-30m with periodic `model` pops of 40-77m.

## What the dump already proved

- `dbgwire-jump` (added today, logs impossible wire-to-wire moves):
  **zero fires**. Wire records do not teleport. The truth stream is clean.
- `wire:` column on ghost-jump lines is ~0 on most rows — the cyan
  ghost stands still while `model:` steps 40-77m in one frame.
  → The warping is **inside the client's own render path**, not the wire.
- `delayMs` converges to the measured cadence (~150-390ms) — the
  wall-clock slew fix works. `atCap` still flaps because records arrive
  ~300-400ms apart (distance-tier + 19% loss) and renderTime rides the
  newest snapshot's edge.

## Root-cause candidates, ranked

1. **`predict()` blast/knockback arcs (prime suspect).**
   `remoteInterp.predict()` — remote mortar/bombard impulse prediction —
   calls `net.clear()`, sets `_simulating=true`, `predictionTimer =
   ping+200ms` (≈0.2-0.6s). During the window the model flies a
   *predicted ballistic arc* off a stale seed; on expiry it resamples the
   (freshly-refilled) buffer and **hard-jumps to truth**. Rimrock combat
   is constant mortar spam → near-continuous predicted arcs → the exact
   40-70m single-frame `model:` pops. Matches: pops cluster on
   bravo-side bots eating bombard volleys; no wire jumps; `wire:0` while
   `model` flies.

2. **AtCap flap → per-push converge pops (secondary).**
   renderTime rides the newest-snapshot edge (delay ≈ cadence, +40ms
   margin eaten by jitter), so `atExtCap` flaps each gap; every push
   re-arms converge ~10-20m → constant visible correction churn
   (the `adj` storm). Aggravates #1 but isn't the snap itself.

3. **Coalesce drops** — fixed this session (>3-frame guard). `coal` still
   ticks during real stalls but is no longer the dominant starvation.

## Research (what everyone else does)

Source/SnapNet/Unity Netcode all converge on the same answer for
non-predicted remote entities: **pure interpolation, no extrapolation
for rendering** — run renderTime one record-interval behind the newest
snapshot so the buffer *always* brackets, and when a record overshoots,
**blend toward the new truth over ~one record interval** rather than
snap. Extrapolation/DR is acceptable only as a last-resort fallback,
capped well under one travel-time, and never for cosmetic effects.
SnapNet: interpolated entities "no warping or misprediction artifacts —
they only travel through known-good states."

Our `predict()` violates that: it *fabricates* remote motion from a
cosmetic impulse estimate, clears the buffer, then snaps. That is the
architectural error — client-side prediction applied to **other**
players.

## Plan

### Step 1 — instrument the snap (cheap, decisive)

Add a `GLITCH:dbgmodel-snap` at `RemotePlayer` `position.set`/`teleportTo`
and at the `predictionTimer` expiry resample, logging `dM`, `sim`,
`predictionTimer` state. One dump confirms which writer produces the
40-70m steps before touching behavior.

### Step 2 — stop fabricating remote motion

Kill or fence `predict()` for remotes:

- **Preferred (principled):** delete `net.clear()` + `_simulating` from
  `predict()`; keep it as *visual impulse FX only* (trail/shake at the
  hit point). The arriving wire record carries the real knockback ~1
  interval later — at 300ms cadence the wire is nearly as fast as the
  prediction anyway. Converge handles the delta smoothly.
- Fallback if feel is wanted: cap predicted displacement to a fraction
  of the impulse and **slerp back** over the window rather than snap —
  but this is the heuristic path; prefer the deletion.

### Step 3 — bracket renderTime, don't ride the edge

Set delay target = `p90gap + arrivalInterval/2` (mid-buffer), not
`max(interval,p90)+40ms` (edge). Cost: ~half an interval more render lag
(≈150-200ms on suppressed streams) — SnapNet's tradeoff, correct vs
permanent atCap churn.

### Step 4 — converge as a blend, not a chase

When a push lands during DR, converge over exactly one measured record
interval toward the *interpolated* sample at renderTime, not the
extrapolated newest — prevents the chase-the-moving-target pop cycle.

### Step 5 — verdict

- `dbgghost-jump` storm collapses: `adj` <= a few m per push.
- `renderΔ` in Alt+Q <= ~interval×speed (~15-20m worst at 5Hz/50m/s —
  unavoidable on suppressed streams) but **no `model` pops** — motion
  stays continuous.
- Human dump: `sim:false` the norm; `sim:true` only during real gaps.
- Re-run botpilot 120s + humanplay soak; gate on zero `model:` >20m.

## Risks

- Removing remote `predict()` makes knockback land ~0.3s "late" — a
  subtle but real feel change on mortar hits; evaluate in humanplay.
- Larger render delay increases perceived remote lag vs 2ms LAN — still
  far below what players tolerate (~150-400ms is standard).
