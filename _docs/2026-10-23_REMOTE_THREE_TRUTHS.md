# Remote player: the three position truths

2026-10-23. Status: **reference + fixes shipped.** Written after a soak
measured the wireframe-debug trio on networked remotes and asked whether
the numbers relate sanely. They do — modulo one real lag-comp defect.

## The three truths (and what each is FOR)

Every `RemotePlayer` carries three distinct positions; the wireframe
debug draws all three. They are *supposed* to differ:

| Truth | Source | Meaning |
|---|---|---|
| `position` | drawn | what the shooter literally sees |
| ghost | `sampleGhostAt(viewEpochT)` | buffer sample `interpDelay` back — the lag-comp epoch |
| `wirePosition` | `lastServerPosition` | newest wire record — the head |

Designed relationship, verified by `_tools/e2e/_posdump.ts`:

- `pos ≈ ghost` while interpolating (the draw *is* the delayed sample;
  residual = measurement rounding, <2m).
- `ghost` trails `srv` by `interpDelay × speed` (~150–350ms × 20–40m/s
  → 2–10m observed). Not a fixed offset — scales with speed.
- `pos` diverges from `ghost` ONLY during dead-reckon + converge
  episodes (r-g up to ~5m, r-s up to ~14m) — `conv` timer counts down,
  steering rejoins. Legit.

## Fixed 2026-10-23

**`viewLagMs` lied during sim (the real defect).** It derives from the
buffer's sample clock, which `step()` only ticks while interpolating —
frozen during `_simulating`, the value clamped to 0 while converge
dragged the drawn body meters behind the wire head. `renderLag[id]`
(gameLoop statsSource) then told the server to rewind ~0ms: shots were
validated at a wire position ~10m from where the shooter aimed — the
"numbers, no damage" class. Now `RemoteInterp.viewLagMs`, while
simulating, reports `drift/speed` (cap 1500ms) — the rewindable
quantity; the sim path never existed server-side so no literal epoch
exists. Zero only when the drawn body is *ahead* of the wire head
(free-run extrapolation — no past truth to rewind to).

**`ghostPosition` returned a stale ghost during sim.** `viewEpochT` is
stale-*finite* (frozen, not NaN), so the epoch sample returned a pre-sim
position for blastForce / lightningTrace / remote-shell sweeps. Now
early-returns `position` — the drawn body IS the view.

**`sampleAt(NaN)` emitted garbage.** `viewEpochT` is NaN pre-first-
sample; `sampleAt(NaN)` hit the `a=NaN` boundary and wrote NaN coords
(the `0,0,0` ghost in probes). Guarded: `!Number.isFinite(t) → false`.

**Jitter estimator → p90 window.** `arrivalJitter` (EMA of |gap−interval|
×2) breathed ±100ms on WAN noise and converged slowly across tier
changes. Replaced with p90 of the last 32 real gaps (ring + reusable
sorted copy, zero per-packet alloc): `delay = BASE + p90`, floored at
`max(arrivalInterval, p90) + 40`. Same doctrines kept: cadence floor
(below the send interval the buffer is permanently dry — WYSIWYG
inversion) and speed-scaled cap (delay×speed = rendered error).

**DR-entry diagnostics.** `STARTING dead reckoning` log now carries
`underruns` + `atCap` so soaks can separate real starvation from
wall-clock-only entries.

## Caveats / residuals

- Converge drift is often *off-path* (knockback arcs), not behind. The
  "ahead" gate suppresses lag only when >60% of drift is forward
  component — lateral drift still reports, landing the rewind nearer
  drawn truth than the head does.
- `viewLagMs` during sim is a distance→time approximation; a remote
  standing still mid-converge (spd<1) reports 0 — bounded, rare.
- Probe artifacts: `ghost=null` before first sample is the guard
  working, not a bug. `lag` reads raw `rp.viewLagMs`.
- Measured on localhost+headless: delays 160–210ms healthy stream,
  300–400ms only on clumped arrivals. WAN behaviour needs a real-link
  soak before calling the p90 tuning settled.

## Pointers

- Probe: `E2E_GPU=1 bun _tools/e2e/_posdump.ts [--secs 30] [--bots 8]`
  — per remote: `pos ghost srv | r-g r-s g-s lag sim conv snaps`.
- Buffer: `client/src/entities/remoteSnapshots.ts` (sample/sampleAt/
  push adapt), `remoteInterp.ts` (sim/converge, viewLagMs, DR entry),
  `RemotePlayer.ts` (`ghostPosition`, `viewLagMs`, `wirePosition`).
- Server consumption: `gameLoop.ts` statsSource → `renderLag` map →
  lag-comp rewind epoch.
