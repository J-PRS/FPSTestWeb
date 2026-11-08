Researched the current state of the art. Here's what the literature/practice says, mapped against what this repo already has.

## The consensus architecture (late-2026 SOTA)

Everyone converged on the same **latency-layered gate stack** — checks placed where their cost fits:

| Layer | Budget | Repo equivalent | Status |
|---|---|---|---|
| Per-edit hook | ms | none (agent CLIs vary) | n/a here |
| Pre-commit | seconds | `.githooks/pre-commit` + lintratchet | ✅ strong |
| Pre-push / local gate | minutes | `check.sh` | ✅ strong |
| CI / PR | minutes | none (no remote CI!) | ⚠️ gap |
| Scheduled | hours | `health.mjs` sweep, shotwebp | ⚠️ partial |

## Practices worth stealing

**1. Machine-readable verdicts for agent self-correction** — the biggest trend. Tools like `hyperfixer`/`gatecheck`/`pi-green-loop` emit `verdict.json` + a one-line `hint` (`[gate] file:line, message`) that the agent feeds back to itself in a fix loop. Strict exit codes matter: `1`=code wrong, `2`=config wrong, `3`=infra failed — a hung tool must never masquerade as a test failure. *Our `check.sh` prints prose; a `--json` verdict mode would let agents self-repair without parsing logs.*

**2. Affected-test scoping** — run only tests impacted by changed files (vitest related / pytest --lf style), full suite on schedule. Keeps the loop fast on big repos; falls back to full when scoping is uncertain (never report green on zero tests).

**3. Positive controls for every guard** — from the tim-schipper writeup: *"a guard that pins the mistake is worse than none."* Every new gate needs a planted-violation test proving it actually fires. *Cheap win: add a `--selftest` mode to lintratchet that plants a warning and asserts exit 1.*

**4. LLM review ≠ gate** — CR-Bench-v2 (Nov 2026): best review agents catch only ~33% of known defects; deterministic checks catch what they miss. Use LLM review as *complement*, never the gate. *We already do this right — `review.sh` fresh-context verifier + deterministic gates. Also: don't let the same model write code AND its tests ("verification paradox") — spec-derived oracles only.*

**5. Mutation testing as scheduled audit** — for AI-generated tests, flip a comparison and check a test fails; survivors get fed back. Scoped to changed files with cached verdicts. *We have `stryker.config.mjs` already (it showed up as an unlisted dep in knip) — wiring a weekly/diff-scoped stryker run would be the highest-value scheduled lane we don't have.*

**6. Flake discipline** — flaky E2E erodes gate trust; track flake rate, quarantine. *Relevant given our `E2E_GPU=1` requirement — SwiftShader flakes are a known hazard.*

**7. Session-state gates** (Alyria) — cheap in-memory rules like "after web fetch, deny push" or "agent can't approve its own PR." *We have the spirit of this in AGENTS.md rules; the enforceable version is hooks, which agent CLIs support variably.*

## Gap analysis for this repo

| Have | Missing |
|---|---|
| pre-commit fast lane, check.sh, watch-gates (size/dash/perks), lintratchet, headless E2E, fresh-context review.sh, daily health census, measurement-provenance rule | **No CI at all** — 4,492 unpushed commits means gates only run locally; a remote CI running `check.sh` on push/PR is the biggest hole |
| | `check.sh --json` verdict + hint for agent self-repair |
| | lintratechet positive-control selftest |
| | Scheduled mutation testing (stryker config exists, unused) |
| | Flake-rate tracking on E2E |

**My recommended order** (cheap→valuable): lintratchet `--selftest` → `check.sh --json` verdict → push to remote + minimal CI running check.sh → scheduled stryker on changed files.

Want me to implement the first two now?