# Automated Audits & Checkups

Reference for every automated quality gate in the repo — what each one
catches, how to run it, what it costs, and where its false positives
live. Goal: the checks that exist get run deliberately, and nobody
re-discovers a config.

## The gate (must stay green before commit)

```bash
cd server_bun && bun test                        # all server tests
cd server_bun && bun test tests/scenarios/       # staged gameplay sims
cd server_bun && bunx tsc --noEmit
cd client && ./node_modules/.bin/tsc --noEmit
cd client && ./node_modules/.bin/vitest run
cd client && npx oxlint src                      # or npm run check for all three
```

`client/package.json` `check` = tsc + oxlint + vitest in one command.

## Layers

### 1. oxlint — fast lint, every edit

`.oxlintrc.json` (repo root). ~160ms for the whole tree.

- **Categories**: `correctness` = error (CI-blocking), `suspicious`/`perf` = warn.
- **Plugins**: typescript, unicorn, oxc, import, promise, vitest.
- **Hand-picked rules** (~70): size/complexity budgets (`max-lines` 1000,
  `max-lines-per-function` 120, `complexity` 15, `max-depth` 4,
  `max-params` 6), style hygiene (curly, eqeqeq, no-plusplus, no-void,
  no-non-null-assertion, consistent-type-imports…), the project-specific
  bans (`oxc/no-async-await` — promise chains only; `oxc/no-rest-spread-
  properties` — hidden allocations), import hygiene (`import/no-cycle`,
  `no-duplicates`, `first`, `no-self-import`), promise-chain discipline
  (`promise/always-return`, `catch-or-return`, `no-nesting`), slop
  detectors (`no-warning-comments`, `no-restricted-globals`,
  `guard-for-in`, `no-self-compare`, `no-template-curly-in-string`,
  `no-useless-assignment`…).
- **Exceptions**: `class-methods-use-this` excepts `getVolume`/`freeInput`
  (deliberate instance-API delegators); `unicorn/prefer-query-selector`
  off (template code queries by id); vitest table-test rules (`valid-title`,
  `no-conditional-expect`, `require-to-throw-message`) demoted to warn —
  data-driven expects are deliberate.
- `Logger.ts`, dump tools, `gunlab.ts`, `vertexAO.ts`, tests: `no-console` off.

### 2. oxlint type-aware audit — deliberate pass, not the loop

`.oxlintrc.audit.json` extends the base + `options.typeAware: true` —
runs tsgolint (`oxlint-tsgolint` devDep), so ~2s not 160ms.

```bash
cd client && npm run lint:audit   # client/src + server_bun/src + shared
```

Adds the type-program rules the fast pass can't see:
`no-floating-promises`, `no-misused-promises`, `no-unsafe-*`
(assignment/member/call/argument/return — the real `any` leak detectors),
`no-unnecessary-condition`, `no-unnecessary-type-assertion`,
`switch-exhaustiveness-check`, `await-thenable`, `unbound-method`,
`restrict-template-expressions`, `no-implied-eval`.

First sweep baseline: ~11k warnings, dominated by
`no-unnecessary-type-assertion` (735 — asserts what the compiler already
knows), `no-unsafe-type-assertion` (596 — `as` that lies),
`no-unnecessary-condition` (395). Drain order: unsafe-* and
switch-exhaustiveness first — those are bug-shaped, not style-shaped.

### 3. knip — dead code / deps / exports

`client/knip.json`. `npx knip` from `client/`.

- `entry`: `index.html` + the dump-tool scripts — knip does NOT follow
  `<script src>` in html, so every html page's script must be named.
- `ignore`: `debugGlobals.ts` (ambient `Window` augments — no imports by
  design); `ignoreDependencies`: `puppeteer-core` (vite.config resolves
  it from `../_tools` via createRequire on purpose).
- Report shape: unused files (should stay 0), unused deps, unlisted deps,
  unused exports/types/namespace members, duplicate exports.
- **False-positive shape to know**: an `export` on a symbol used only
  inside its own file is reported — the function is alive, the keyword
  is dead. Trimming it shrinks API surface; don't delete the symbol.

### 4. sizeWatch — file bloat alarm

`server_bun/tests/sizeWatch.test.ts` (runs inside `bun test`).

- New files fail outright over **900 lines**; grandfathered giants are
  pinned at their measured size + 15% — a real blow-up trips the test
  before the file needs a burn-down. Current pins: NetworkManager 1183,
  PlayerModel 1127, gunlab 1015, lab/scenarios 999, serverSenses 1039,
  Room 909, vertexAO 901.
- Adding a line to a pinned file is allowed up to the cap; shrinking it
  permanently should lower the pin, not leave headroom.

### 5. Tests

- **Client** `vitest run` — unit + integration; `src/__tests__/`.
- **Server** `bun test` — plus `tests/scenarios/` harness-driven staged
  interactions (one file per scenario, `step(dt)` sim-time).
- **Wire parity** — `harness.ts` `replica(room)` mounts a headless
  spectator eating real wire output (wireIds + binary tick frames),
  re-hashes vs room truth — the production StateHash comparator, minus
  the browser.

### 6. Headless E2E

```bash
bun _tools/e2e/all.ts            # smoke/duo/duo_p2p/lobby/reconnect/vgs/overlap/perf
bun _tools/e2e/perf.ts --compare _tools/e2e/baseline.json
```

39 spec files; each boots its own stack (env.ts probes free ports) and
runs sequentially — concurrent headless Chromes flake under SwiftShader.
See `.agents/skills/headless-game-testing` for the pointer-lock stub and
slow-game-time caveats.

### 7. Runtime diagnostics (in-client, not CI)

- **Alt+Q** — `diagDump` copies the full census: net tier/ping, remote
  render deltas, swarm species counts, ribbon/pool stats, balls.
- **`registerDiag`** — modules self-register census providers
  (`swarm`, render, trails…); the dump is only as good as the providers.
- **Logger buffer** — console.warn/error route into it;
  `exportClientLogs()`/`takeClientSnapshot()`/`requestServerSnapshot()`/
  `compareState()` on window for live desync hunting.
- **Warn-level detectors** that fire in production (treat as audit
  output, not noise): `ball rubberbands`, `melee whiff beyond reach`,
  `rate-limited: <type> dropped`, `[StateHash] Hash mismatch`,
  `POS JUMP`, `Handler threw for <type>`.

## Measured audits (baseline collected 2026-10-05)

All optional — run from `client/`, none are in `check`.

### jscpd — duplication (`npm run audit:dup`)

jscpd@4 over `client/src server_bun/src shared`, `--min-lines 20
--min-tokens 60`. **Baseline: 0.02% duplicated** (1 clone in ~99k lines):
`DeployShield`/`DeployStation` share a 20-line panel block — cosmetic,
fine to leave. The "parallel pipelines" (ball vs crawler, bake paths)
are structurally similar but token-divergent — NOT copy-paste. Any new
clone above the bar is worth a look; treat <0.5% as healthy.

### type-coverage (`npm run audit:types`)

`type-coverage` (devDep). **Baseline: 99.76%** (181,748/182,180
expressions typed). Needs the `type-coverage-core` → `typescript6`
override in `client/package.json` (TS7 lacks `ts.createProgram`).
`--detail` lists every untyped expression — clusters: `Logger.ts`
(error/reason args), `vertexAO.ts` debug fields, glTF parser locals in
tests, `weaponsGeoBallistic.ts`. Suggested threshold if ever gated:
99.5 — leaves headroom, still catches an `any` flood.

### Bundle size (`npm run audit:bundle`)

`vite build` + `_tools/bundleSize.cjs`. **Baseline: `game.js` 2.24 MB
minified / 709 KB gzip; total `dist/` 15.24 MB** (120 files — assets
lazy-load). Budgets in the script: game.js warn >2.6MB, fail >3.2MB.
Known wart: `server_bun/src/weaponStats.ts` imports `node:fs/path/url`,
which vite externalizes — harmless today, fix if it ever ships server
code into the bundle.

### Stryker — mutation testing (`npm run audit:mutate`)

stryker-js + vitest-runner (devDeps). Pilot scope: `shared/wire.ts`.
Config: `client/stryker.config.mjs` + `stryker.vitest.config.ts` at repo
root — stryker must run with cwd=repo-root to reach `shared/`, so the
root vitest shim sets `root: 'client'`. `ignorePatterns` keep the
sandbox copy small (a full-repo copy once filled the disk via `zzz/`
Rust artifacts — don't drop them). Runtime ~75s for one file.

**Baseline: 479 mutants, 1 killed, 412 survived, 66 uncovered —
score ~0.2%.** Verified by hand that the suite genuinely doesn't catch
sample mutations (flag flips, decode offset arithmetic) — `wire.test.ts`
asserts happy-path round-trips, not adversarial decode branches. Also
measured: `tickClock.ts` (P2P worker clock) — 0/8 killed, fully
uncovered. Caveat: with scores this low it's worth re-verifying after
any stryker/vitest upgrade that mutants actually activate (a `return {}`
surviving while tests "ran" is the tell); current evidence says the
gaps are real — thin assertions, not a broken harness. Keep periodic,
never gated; use it to decide where tests lie rather than to score.

## Industry survey — what else is usually automated

Researched 2026-10-05 against standard TS quality-gate pipelines
(quality-gates/code-gates style) and game-QA practice. What we already
cover unusually well: deterministic-sim discipline (the four
nondeterminism sources — clock/frame-pacing/RNG/input — pinned via
strictRng/wallClock/simClock + replica wire parity; most web games do
none of this), file-size budgets (sizeWatch ≈ the "size gate" in
commercial pipelines), custom perf regression over generic page metrics
(perf.ts beats Lighthouse for a canvas game), manual heap soak.

Ranked by value-for-this-project:

1. ~~**CI.**~~ ✅ EXISTS — `.github/workflows/ci.yml` runs on push+PR:
   bun install + `tsc --noEmit` + `bun test` (server), `npm ci` +
   `tsc --noEmit` + `vitest run` + `oxlint src` (client), and
   `bun e2e/all.ts --skip perf` under headless Chrome. Found late —
   a stale audit assumption. The optional battery below is NOT in it.
2. **Dependency security / supply chain.** `npm audit` showed 5 high
   hits. Standard: osv-scanner or audit-in-CI + secret scanning
   (gitleaks — tunnel tokens live in `.bat` files) + license-checker
   (client ships publicly on surge).
3. **dependency-cruiser.** Beyond `import/no-cycle`: declarative layer
   rules — "shared/ may not import client/", "game/ may not import
   networking/" — AGENTS.md's prose layering made enforceable, plus
   orphan detection.
4. **Coverage measurement.** `vitest --coverage` / `bun test --coverage`.
   The robustification doc tracks coverage gaps by hand; a report makes
   it a number. Uncapped reporting is already useful — a threshold is
   optional.
5. **Duplication detection** — ✅ wired: `audit:dup`, baseline 0.02%.
6. **Type coverage** — ✅ wired: `audit:types`, baseline 99.76%.
7. **Bundle size budget** — ✅ wired: `audit:bundle` →
   `_tools/bundleSize.cjs` (game.js warn 2.6MB / fail 3.2MB).
8. **Pre-commit hooks** — `lint-staged` + `simple-git-hooks`: oxlint on
   staged files only (~seconds). Makes "files you touched are yours"
   automatic instead of aspirational.
9. **Mutation testing** — ✅ wired: `audit:mutate`, piloted on
   `shared/wire.ts` (score ~0.2% — tests assert happy paths, not
   adversarial decode branches; see measured section).
10. **Visual regression** — headless screenshots already exist
    (`cloudshot`/`boomshot`); pixel-diff vs baseline is a small step and
    catches "rendered but wrong" where probes catch "rendered but
    broken". This is exactly how three.js itself gates examples —
    Puppeteer + pixelmatch, `maxDiffPixelRatio` ~0.05, freeze-frame
    param for determinism.

Second pass (researched after wiring 5/6/7/9):

11. **Property-based testing — fast-check.** Directly motivated by the
    wire.ts mutation score: one property `decode(encode(x)) === x` over
    generated segments/tick-frames exercises flag-8/targetId/truncation
    branches the hand-written cases miss. Second property for the codec:
    `fc.uint8Array` sliced at random lengths must return null, never
    throw — generalizes `netMalformed.test.ts` from hand-cases to a
    systematic fuzz.
12. **License scan — license-checker.** `dist/` ships publicly on
    surge; one command lists every bundled dep's license. Occasional.
13. **Circular-dep graph — madge or skott.** `import/no-cycle` catches
    cycles oxlint resolves; `madge --circular client/src` draws the
    whole graph incl. dynamic imports + a second orphan opinion to
    cross-check knip. Free baseline, gate optional.
14. **Flaky-test detection — `vitest run --repeat 3 --randomize`,
    `bun test --rerun-each`.** Order-shuffle + repeats catch shared-state
    leaks between tests — real risk here since `__tests__/setup.ts`
    stubs browser globals globally. Zero deps, run occasionally.
15. **Shader readback harness.** vertexAO/grunge injections live in
    `onBeforeCompile` — untestable today except by eye. A puppeteer
    render-to-texture + pixel readback on the existing e2e stack would
    make shader output numerically assertable. (`vitest-browser-three`
    is the off-the-shelf version but targets TSL/WebGPU — wrong fit.)
16. **Invariant guard greps.** Tiny scripts pinning project rules:
    "no `Date.now()`/`Math.random()` under `shared/`", "no `server_bun/`
    imports from `client/`" — the latter would have flagged the
    `weaponStats` node:fs externalization the bundle audit surfaced.
    dependency-cruiser (#3) is the grown-up version; a 10-line script is
    the honest start.

Third pass — code quality & architecture proper (no deps/security):

17. **Executable architecture tests — ts-arch / ArchUnitTS.**
    Architecture rules as vitest cases, not config: `filesIn
    'client/src/game/**' shouldNot dependOn 'networking/**'`,
    `shared/** depends on nothing outside shared/`, cycle detection.
    This is the sizeWatch pattern generalized — the repo already trusts
    tests-as-guards, so rules as test files fit better than another
    config dialect. ts-archunit adds *body* rules ("X must call Y") and
    baselines/diff-awareness, aimed at agent-written code — worth a
    look before hand-rolling.
18. **Rule inference — archprint.** Scans the real import graph and
    *proposes* boundary rules the code already mostly follows (with
    conformance evidence), emitting depcruiser/eslint/ts-arch configs.
    Answers "which layering do we actually have?" before you guess rules
    that instantly fail.
19. **Coupling metrics — afferent/efferent, instability, blast radius.**
    `dependents`/impact queries answer "who breaks if NetworkManager
    changes". Tools: dependency-cruiser (`--metrics`), codebase-
    intelligence, fallow. The god-object detector sizeWatch can't be —
    a file under 900 lines can still sit on 200 in-edges.
20. **Complexity×churn hotspots.** Cyclomatic/cognitive complexity
    alone misleads; complexity × git-change-frequency is the proven
    refactor-ranking signal (CodeScene/code-maat approach). Tools:
    ts-repo-metrics (churn hotspots, refactor rate, commit entropy),
    codebase-intelligence `hotspots`, code-multivitals (cyclomatic +
    cognitive + Halstead + Maintainability Index + health score). Your
    git history is deep enough for real churn data.
21. **Maintainability Index / CRAP score** — per-file composite
    (complexity-weighted-by-uncoverage). Gives `NetworkManager.ts` a
    number to watch drift instead of just a line cap. Same toolset.
22. **Re-export/barrel-cycle audit.** jscpd found token dupes; barrel
    files create *graph* dupes — knip flagged `projectiles/index.ts`,
    and fallow/madge report re-export cycles explicitly.
23. **Public-API surface diff.** Track the exported-symbol set as a
    checked report (api-extractor-style or a `tsc --listFiles`-based
    script) — knip says "unused", this says "surface grew". For shared/
    especially: every export is a wire/sim contract client+server must
    both honor.

**Deliberately skipped:** Lighthouse/a11y (canvas game, not a document —
perf.ts covers the real metric), cross-browser matrix (Chrome-only
headless is honest scope until a Firefox user exists), commit-message
lint (`changelog.txt` discipline covers intent).

## Not automated (yet) — current state

- **CI exists** (`.github/workflows/ci.yml`: server tsc+test, client
  tsc+vitest+oxlint, e2e minus perf) — but only the fast gates run there.
  Everything in "Measured audits" and the optional passes are still
  manual cadence: `audit:*`/`lint:audit`/`knip` weekly-ish or before a
  merge-worthy chunk settles.
- **ESLint** — `client/eslint.config.js` exists (tseslint recommended +
  sonarjs cognitive-complexity) but nothing runs it; oxlint covers most
  of it faster. The sonarjs cognitive-complexity signal oxlint's
  `complexity` approximates. Keep for the occasional deep pass or drop
  the dep — either is honest, both dead-in-tree is not.
- `_tools/lint/eslint.config.mjs` — legacy config, same story.
- **Deprecated artifacts**: `_reports/AUTO/` and `client/reports/analysis/`
  are stale snapshots (Jul/Aug) — knip/eslint/jscpd outputs from old
  runs. Regenerate on demand; don't read as current state.

## False-positive field guide

- **oxlint `no-use-before-define`** on module-level `const` used by a
  function defined earlier — legal hoisting-adjacent order, warn only.
- **knip unused file** for a page's entry script → you forgot to list
  the html in `entry`.
- **knip unused dep** that only a `_tools` script or a `createRequire`
  uses → declare it where it lives or `ignoreDependencies` it, don't
  uninstall blind.
- **`no-unnecessary-condition` on intentional defensive checks** — the
  rule only knows types, not wire contracts. Suppress-with-comment is
  fine when the check guards network input the type lies about.
- **`complexity`/`max-lines-per-function` on a data table disguised as
  a function** — extract the table, don't split the function.

## Drain strategy

Backlogs are warn-level on purpose — 9k style warnings can't gate a
commit. The useful discipline:

1. New code: clean file-level oxlint before commit (warnings on files
   you touched are yours).
2. `lint:audit` findings: triage unsafe-* and exhaustiveness first —
   bug-shaped warnings, rest is slop-shaped.
3. knip: keep `unused files`/`deps` at zero; `unused exports` drain when
   a file is touched anyway.
4. `no-unused-expressions`, `no-new-array`, `no-useless-spread` (the
   current 12-error residue): dead statements and micro-allocs — small,
   real, next-deslop-pass targets.
