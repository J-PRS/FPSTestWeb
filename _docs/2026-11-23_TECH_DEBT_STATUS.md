# 2026-11-23 — Tech-debt status: is the 11-22 audit still true?

Freshness check on `2026-11-22_TECH_DEBT_AUDIT.md` against the current
tree (master `9b350691` + the uncommitted Room-split work). Read-only
verification: `wc -l` census + targeted greps — no test runs.

**Short answer: yes, current — with two items already moving.**

## Changed since the audit

- **Item 2 (big files):** `Room.ts` is now **1627L** (was 1933L) — the
  opportunistic split the audit prescribed is in flight in the dirty
  tree: `roomUnbury.ts` 85L, `roomGunGame.ts` 112L, `roomInfo.ts` 291L,
  `botSelfBlast.ts` 224L, `botTrackAim.ts` 122L. `NetworkManager.ts`
  actually grew to 1552L; `wireIn.ts` 854L. The advice stands for the
  remaining whales.
- **Item 6 (8/IP join cap):** already fixed in the same dirty batch —
  `GameServer.ts:306-329` now keeps `provenByIp` (completed joins per
  egress IP) and raises the pending cap to `min(8 + proven, 64)`. This
  was the audit's exact suggested fix; once committed, school-NAT join
  spikes stop tripping the guard. Move it off the list when it lands.

## Still true

- **1. Transport matrix = bug factory.** Unchanged — 4 inbound lanes +
  dev-gated RTC/P2P still all present (`RtcServer` 262L, `RtcRelay`
  89L, `UdpLane` 136L, `WtServer` 328L; client `p2p/` + `tiers*.ts` +
  `claimLedger` ~1k lines). The delete-vs-accept decision is still the
  open one. Half-built unified ingest in `handleBinaryFrame` likewise
  untouched.
- **3. Lint ratchet.** No burn-down pass observed; ~1150-warning noise
  floor stands (audit census, `node _tools/health.mjs` 2026-11-15).
- **4. Two bot armies.** Untouched — but note the split just added two
  more bot files server-side (`botSelfBlast`, `botTrackAim`), so the
  army keeps growing on the server side only; the drift risk the audit
  named is worsening slightly, not improving.
- **5. Leaderboard signing dead weight.** `resultSigner.ts` 86L +
  `leaderboard.ts` 167L still present, `KRIBES_SIGN_KEY` still unset on
  prod (health endpoint still reports the disabled reason). Still
  carrying the dead codename in the env var too.
- **7. hitLedger debug probes.** Still live in the prod damage path —
  `selfKillImpactDist/Pos/Prey/FoeDist/Trades` at `hitLedger.ts:13-25`.
- **8-9. Stray dist files / vite.config.** `native/_tail.ts` is
  deleted in the dirty tree (one down); `wtmin.html` still ships and
  now carries a noindex band-aid instead of a build exclusion.

## Updated ranking (what I'd attack first)

1. Transport matrix decision (unchanged — biggest parity surface,
   ~3.5k-line lean delta still on the table).
2. Land the dirty Room-split + proven-IP batch — two audit items
   completed for free once committed.
3. Shared `botTuning` funnel for the two armies (item 4, worsening).
4. Lint burn-down on top 2-3 rules (item 3).
5. Sign-or-delete leaderboard decision (item 5).

## 2026-11-24 burn-down

- **3. Lint ratchet.** ~1150 -> 527 warnings. Passes: oxlint --fix
  (safe tier only, commit 2e2af3d2), unused-vars sweep (14 sites,
  43cc8574), propSims namespace import (-86 in one line). Rules
  retired as false-positive classes: no-void (9f6690f9 - void expr
  is the deliberate fire-and-forget convention; --fix-suggestions
  gutted ~20 real call sites to bare `undefined`), prefer-math-trunc
  (43cc8574 - all remaining hits are deliberate uint32/int32 wraps
  in PRNG/hash code). NOTE: never run `oxlint --fix-suggestions` -
  it rewrites `void fetch/import/clipboard` to `undefined;` and
  deletes the side effect. Remaining warnings are the structural
  tier: complexity 125, no-conditional-in-test 41, nested ternary 40,
  max-lines-per-function 30 - real refactors, not lint.
- **7. hitLedger probes.** LANDED 9eca5a1c - selfKill* arrays,
  preyNear lookup, foe sweep and recentKills upkeep gated behind
  enableHitProbes(); soak tests opt in, prod skips the work.
- **8-9.** wtmin.html unshipped - moved to _tools/wtmin/ (still
  available manually); dead noindex rule removed from _headers.
- **5. Leaderboard.** Narrowed: getStats() is LIVE (reads
  matches.jsonl); only the signed-submit path (resultSigner +
  leaderboard submit) is dormant on KRIBES_SIGN_KEY. Decision is
  set-the-key vs delete the signer - owner call, not debt.
