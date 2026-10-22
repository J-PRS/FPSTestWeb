# _tools — what's pipeline, what's scratch

Directories that feed the live game or the test suite. Everything at
`_tools/` ROOT level (loose *.py, *.png, *.blend, *.log, *.txt, *.patch)
is one-off archaeology from past investigations — keep for reference,
never wire into builds.

## Canonical (changes here change shipped artifacts)

- `reap.mjs` - stale dev-process reaper (dry-run by default; `--kill` 6h,
  `--auto` 24h; never touches LSP/MCP). Called by root `devup.bat`.
- `e2e/` - headless puppeteer E2E + perf harness (`all.ts` suite driver,
  `baseline.json` perf reference). The `bun _tools/e2e/all.ts` gate.
- `animbake/` — offline clip bake -> `shared/ANIM_TABLE` (bake.ts + run.mjs).
- `mapbake/` — map spec -> heightfield/field generation (genfield.js,
  png2bin.js).
- `glbsimplify/` — GLB asset optimizer (safeopt.mjs) that produced the
  shipped quantized models.
- `pvptest/` — live-server soak + probe harness (apisoak/fleet/replay,
  shot/chat/deploy probes, net.ts tier tests).
- `sweeps/` — bot attribute sweep harness (capperSweep.ts -> AI tuning).
- `dif2glb.py` + `dif2glb_in/` + `dif_test/` + `io_dif/` + `difcol.py` —
  T2 .dif interior/hull port pipeline (interiors + colliders both come
  out of this).
- `ter2bin/` — terrain heightmap -> .bin encoder.
- `edgebake/` — weapon edge/wear mask baker (bake3.py).
- `audioaudit/` — sfx spectrum audit (scan.py + sheet renders).
- `vmdump/` — viewmodel weapon dump -> baked GLB sources.
- `demorender/` — demo clip -> video renderer.
- `poseshot/` — headless PlayerModel pose/rig screenshot harness
  (gitignored output; the 3P verification loop).
- `nettest/` — WebTransport/datagram transport probes.
- `sfxdump/` — audio asset analysis.
- `lint/` — eslint config for the _tools tree itself.
- `package.json` / `tsconfig.json` — e2e deps (puppeteer-core) + TS
  settings for the tool scripts.

## Reference archives (kept, not pipeline)

- `ualgrab/` — T2/Unity UAL anim extraction notes+assets. Read-only
  reference now that the anim bake is standalone.

## Scratch (archaeology — do not build on)

Root-level loose files: `dump_*.py`, `list_*.py`, `render_*.py`,
`bake_*.py` singletons, `*.png` renders, `*.blend` sources,
`tools.txt`/`tools_p.txt` (Unity MCP dumps), `unitymcp*.log`,
`server*.log`, `sid.txt`, `um-eval.js`, `gl_fog.patch`, `w14_baked.glb`,
`aoshot.mjs`, `glbnodediff.mjs`, `rebase/`, `tmp/`, `bake_test*`,
`check_glb.py`, `inspect_blend.py`, `dae_convert.py`, `bolt_*`, `gun02*`,
`launcher*.blend`, `sidebyside*`, `gen_*`, `recreated_*`, `w0_*`,
`side_*`, `tex-03.jpg`, `bolt_real*` — per-investigation one-offs.
Folded into a subdir only if it becomes a repeatable pipeline.
