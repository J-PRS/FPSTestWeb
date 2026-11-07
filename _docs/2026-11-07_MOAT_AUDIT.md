# Moat Audit — 2026-11-07

What ships to every browser visitor vs what stays server-side, after the
P2P exclusion (`0cbf6705`). Verified by grepping the actual `client/dist/`
prod bundle and tracing every `client/src -> server_bun` edge.

## Threat model

Browser bundles are inspectable — assume anything served is extractable.
The moat isn't secrecy of syntax (the bundle is minified, not encrypted);
it's the *working authority* and the *orchestration intelligence* — the
layers where years of adjudication edge cases live (cf. known-issues.md's
scar tissue) and where a cloner would otherwise spend months.

## Sealed this session

- **P2P authority excised.** `P2PHost` imported `PlayerManager`,
  `MessageHandler`, `RateLimiter`, wire validation, `RoomProjectiles`,
  `RoomMoveSim` from `server_bun/` — the adjudication layer, verbatim.
  `P2P_ENABLED` (`client/src/core/params.ts:25`) is a static gate so
  Rollup drops the `host/signalling/transport` chunks in prod; dev
  builds and `VITE_FPS_P2P=1` keep the feature. Verified in `dist/`
  `game.js`: zero `PlayerManager`/`RoomProjectiles`/`MessageHandler`/
  `attachDataChannels` strings.
- **No sourcemaps** in `dist/` — no `.map` files emitted.

## Current exposure inventory

| In the prod bundle | Value | Verdict |
|---|---|---|
| `shared/` sims (movement, weapons, combat, wire codec, heightfield) | Medium — required for prediction | Unavoidable; accept |
| `shared/botBrain` + `botMoves` + `botTuning` | Medium — brain shell | Required for offline bots |
| Bot taunts/chatter/loadout tables | Cosmetic | Accept |
| `server_bun/` adjudication | — | Sealed (P2P was the only real importer; remaining mentions are comments + tests) |
| `botRouting`, `botMpc*`, `ServerBots`, `serverSenses`, `botRoster` | **High** — the orchestration that makes bots good online | **Stays home** — zero client imports |
| `dev/` + `lab/` tooling (devTools, botPilot, scenarios, flagScrim, botAgents) | Low-medium — debug harnesses | **Leaks**: `main.ts:1404` dynamic-imports devTools behind a runtime `isDevHost()` check, so the code still lands in `game.js` — the same pattern P2P had before the static gate |
| Claim adjudication (moveClaims/moveJudge/rewind/claimLedger/validation) | **High** | `server_bun/` only — never imported by client |

## Why the layering is already right

`shared/botBrain` is a *shell* brain — the parts that make bots smart
online (routing, the MPC beam search, role/roster assignment, team
senses) all live in `server_bun/` and have never shipped. The 2026-11-05
MPC arrival-pricing fix (`3da8d95f`) landed in `server_bun/src/botMpcSearch.ts`
— automatically server-only. The split is validated; the risk is only
*future* crossings.

## Plan (in order)

1. **Import-boundary ratchet.** A check that fails on `client/src ->
   server_bun` imports outside an allowlist (the gated `p2p/host.ts`,
   test files). One grep rule in the gate — prevents the P2P leak class
   returning silently as a new feature. Prevents regression, near-zero
   cost.

2. **Statically gate dev/lab tooling.** Wrap `main.ts`'s `devTools`
   dynamic import (and audit for siblings) in `import.meta.env.DEV`
   rather than the runtime `isDevHost()` — runtime gating leaves the
   chunk in the bundle. Dev surfaces stay; prod drops the code.

3. **Keep `shared/botBrain` as the deliberate seam.** Offline bots need
   it; it's a shell without the intelligence layer. Rule going forward:
   anything that makes bots smart *online* (routing, planning, roles,
   senses) lives in `server_bun/`; `shared/` keeps only what a client
   must replicate to predict or play solo.

4. **Accept the residue.** Taunts, loadout tables, tuning constants are
   cosmetic-grade — stripping them costs more than they're worth and
   risks forking the solo experience.

## What this does not cover

- Anything the `:5500` public preview already served is extractable from
  old bundles — exclusion stops future leaks, doesn't claw back history.
- The repo itself (github.com/J-PRS/FPSTestWeb) is the other exposure
  surface; if it ever goes public or leaks, all of this is moot. Keep it
  private; the 4,400+ unpushed commits are also a single-disk risk —
  pushing fixes both.
- Server-side secrets (`FPS_ADMIN_TOKEN`, `KRIBES_SIGN_KEY`) are an ops
  checklist item, unrelated to bundle exposure.
