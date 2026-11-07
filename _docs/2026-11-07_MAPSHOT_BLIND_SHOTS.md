# 2026-11-07 — check.sh screenshot step runs blind (SwiftShader), plus mapshot correction storm

Two findings from a routine `bash _tools/check.sh` run (exit 0, all suites green).

## Finding 1: the gate's visual checkpoint captures black JOINING screens

`check.sh` calls `bun _tools/e2e/mapshot.ts` when scene code changed
(`_tools/check.sh:117`). It does **not** set `E2E_GPU`, so `browser.ts`
falls back to SwiftShader (`_tools/e2e/browser.ts:72-75`). Under
SwiftShader the captured PNGs are ~4KB black frames showing only the
JOINING overlay — the client never reached a rendered frame before the
shot. The gate still exits 0 and prints "READ THE SHOT", so the visual
checkpoint *looks* performed but verified nothing.

Evidence: `_tools/e2e/shots/map_escalade*.png` at 2026-11-05 20:38 —
all ~3.9-4.0KB black JOINING screens. The real-render baselines from
2026-10-23 (`map_escalade_test*.webp`) are 24-31KB.

Rerun with `E2E_GPU=1 bun _tools/e2e/mapshot.ts` produced correct
renders (terrain, sky, interiors, player model, HUD) in ~15s.

**Fix option (not applied):** have `check.sh` export `E2E_GPU=1` for
the mapshot call so the checkpoint cannot silently degrade. AGENTS.md
already mandates `E2E_GPU=1` for every e2e/soak/screenshot run; the
gate script is the one place that doesn't follow it. A cheap guard:
fail (or warn loudly) when the newest shot is under ~8KB, since real
frames are 24KB+ and black screens compress to ~4KB.

## Finding 2: persistent ~123m correction storm during mapshot staging

During the GPU mapshot run, the client log showed repeated SNAP
corrections every 5 input seqs:

```
[NetProbe] corr#85 err=123.59m journal=0 vel=0.0m/s ping=0ms SNAP
[Wire] Server correction at seq 85: pos=(125.9,16.4,39.8)
POS JUMP ... → (126.0,140.0,40.0) dead=false
```

Server shadow holds the player at y=16.4 while the client holds
y=140.0 — identical x/z, y diverged by 123.6m, `journal=0` (no input
journal to replay). Interpretation: mapshot warps the player/camera to
photo vantages; the authority movement shadow has no inputs explaining
the warp, so it keeps correcting back to its last truth. The client
re-asserts the staged position, so the loop persists for the whole
sweep. The shots still render correctly because the client renders its
own claimed position.

**Resolved (same-day):** Finding 1 fixed in `check.sh` — the mapshot
call now runs `E2E_GPU=1` and fails when the newest shot is under ~8KB
(blind-shot signature). Finding 2 is **cosmetic harness noise by
design**: `mapshot.ts` already calls `p.markTeleport()` on the client,
but no wire path exists to tell the *server shadow* the reposition is
tool-driven — the authority correctly rejects an impossible move every
seq. That's the anti-teleport system working, not a defect; the shots
render from the client's claimed position regardless. Building a
tool-side teleport wire path would be machinery for a test tool's
convenience — skipped deliberately.

## Provenance

- Gate run: `bash _tools/check.sh` via Git Bash, exit 0.
- Blind shots: `_tools/e2e/shots/map_escalade*.png` (2026-11-05 20:38, ~4KB).
- Real shots + correction log: `E2E_GPU=1 bun _tools/e2e/mapshot.ts` (2026-11-05 20:39).
