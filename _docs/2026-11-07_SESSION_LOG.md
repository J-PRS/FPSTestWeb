# Session Log — 2026-11-07

Consolidated record of this working session: what shipped, what's
verified, what's open. Per-item detail lives in the linked docs +
changelog entries; this is the map.

## Shipped (all committed)

| Commit | What | Verified |
|---|---|---|
| `3da8d95f` | Katabatic capper — MPC beam accumulates predicted T1 fall damage, hard-vetoes plans past 45% of a bar; passFlag refuses backward handoffs | capRun all 3 maps cap, `bun test` 1573/0 |
| `22097df1` | Blaster contact pop + shell death shrink-out (code matching the 2026-11-02 changelog) | tsc + targeted vitest |
| `2c0cc13b` | UAS post-strip clip wiring + offset canary bound | 100/100 touched tests |
| `c0d5d137` | Retro palette-quantize post pass | end-to-end wired |
| `6278bc85` | Licensing artifacts, audit docs, gallery tool sources, gunlab freeze, PSNR floor | sources only, generated ignored |
| `44e00bb0` | P2P tab presented as LAN | tsc |
| `0cbf6705` | P2P tree-shaken out of prod bundles (`P2P_ENABLED`) | zero authority strings in `dist/game.js` |
| `d02159b2` | `_docs/2026-11-07_MOAT_AUDIT.md` | — |
| `4cf322be` | dev/lab tooling statically gated + `utils/_moatcheck.mjs` ratchet | -37 kB, devTools absent from dist |
| `2e0faecc` | Offline brain ctx fills (flagPos/markDeath/pickupVal/moveSkill/desperate/convoy/spillSoon) | tsc clean; solo smoke test NOT run |
| `8b37d40c` | Changelog backfill + memory lessons | — |

## State now

- `bun test` 1573/0 — fully green first time in weeks.
- Prod bundle carries: `shared/` prediction sims + the deliberate
  `shared/botBrain` seam. Absent: adjudication, orchestration
  (botRouting/botMpc/ServerBots/serverSenses), dev/lab tooling, sourcemaps.
- Offline bots: no longer provably wrong (dead ctx channels closed);
  still warmup-grade — routing/MPC/commander stays hosted by design.

## Open items

1. **Solo smoke test** of the ctx fills — contract-shaped + tsc clean,
   not watched live yet (`flagScrim` harness or a manual solo match).
2. **Solo product answer** — warmup vs real mode decides the deferred
   tier (commander/SpotBoard/medic+bombardier/light routing ports).
3. **WAN soak** — the only live-verification debt left (ghost offset,
   death-desync, headhunt tokens, MPC pricing under real conditions).
4. **Provisioning** — CDN path, env checklist (`FPS_ADMIN_TOKEN` et al.),
   UDP volatile-lane re-verify. TURN dropped: pointless for
   server-anchored RTC; LAN/P2P covered by rename + exclusion.
5. **Push/backup** — 4,400+ commits unpushed; single-disk risk.
6. **Old-bundle exposure** — if the `:5500` preview ever served P2P
   publicly, the authority is extractable from cached bundles (can't
   claw back; worth checking preview URL reachability).

## Lessons recorded (`.agents/memory/`)

- Dead shared-ctx channels = wrong bot, not simpler bot.
- Runtime gates (`isDevHost()`) hide code but still ship it; only
  `import.meta.env.*` static gates remove chunks from prod.
- Capper transit in scenario rooms is MPC-driven — `botMoves.hints`
  edits are advisory; price inside the beam.
- Linear damage pricing slowed every map — price only predicted-lethal
  (hard veto), not wear.
