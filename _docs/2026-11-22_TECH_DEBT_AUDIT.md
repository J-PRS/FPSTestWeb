# 2026-11-22 — Tech-debt audit (whole repo)

Read audit, no code run. Sources: direct file reads + `wc -l` census,
`node _tools/health.mjs` output (`_tools/health/latest.md`, 2026-11-15),
jscpd report (`_tools/health/jscpd/jscpd-report.json`), changelog.txt
bug-class survey, `git log`. Load assumed: ~64-player rooms on the OCI
box (play.jprice.app), per profload/soak tooling.

Census: shared 21k lines / 70 files, server_bun/src 32k / 103 files,
client/src 133k / 570 files, 512 test files, jscpd duplication 0.03%
(2 clones), 2 `shortcut:` markers, 0 TODO/FIXME, 49 `as any`/ts-escape
(45 in client).

Verdict up front: **healthy overall; the debt is concentrated.** Nearly
every recurring bug class traces to one root cause — multi-lane
transport semantics. The rest is ordinary scale debt.

---

## Must fix

### 1. The transport matrix is the bug factory

- **Where:** `client/src/networking/*` (NetworkManager 1522L, tiers 461L,
  tiersWebTransport 320L, p2p/ ~650L, claimLedger 203L),
  `server_bun/src/{WtServer 328L, RtcServer 262L, RtcRelay 89L,
  UdpLane 136L, ConnectionManager}.ts`, dispatch in
  `GameServer.ts:335-535`.
- **What:** Four inbound lanes — WS JSON, ws binary frames, WT
  datagrams, UDP shim — plus a dev-gated P2P/RTC host path, each with
  different ordering guarantees. Combat claims have a second
  adjudication path (`claimLedger`) kept alive only for P2P hosts.
- **Evidence this is THE bug class:** changelog 2026-11-15..21 is ~60%
  lane-semantics fixes — corpse/drop out-of-order across wireCast vs
  JSON (fd18e772 + two follow-ups), binary-vs-JSON duplicate ingest,
  UDP-shim local-network probe, RTC adapter close-race on reclaim,
  WT join-timeout churn, seat-gen stale-close flapping. Every feature
  must be correct on N lanes; nobody can hold the matrix.
- **Fix:** WS+binary and WT are the production ladder. Decide on
  RTC/P2P (dev-gated, ~1.7k client + ~350L server) — delete it or
  formally accept it as permanent parity surface. Structural cheap win:
  finish the half-built canonical ingest — `handleBinaryFrame` repeats
  the same decode→try→onFatal block per frame kind; normalize all
  lanes to one ordered stream before dispatch.
- **Skip cost:** every transport-adjacent feature keeps paying the
  N-lane tax; parity bugs keep landing one lane at a time.

## Should fix

### 2. Biggest files sit exactly where parity bugs live

- **Where:** `PlayerModel.ts` 90KB/1755L, `NetworkManager.ts`
  81KB/1522L, `main.ts` 79KB/1566L, `gameLoop.ts` 66KB/1269L,
  `wireIn.ts` 51KB/853L (client); `Room.ts` 1933L, `CombatHandler.ts`
  1159L, `tickRecords.ts` 1117L (server).
- **What:** The most-edited, most-bug-prone files are the largest.
  Churn concentrates there (changelog confirms).
- **Fix:** Never split for size. On the next fix in each file, extract
  the touched job (NetworkManager: reconnect/tier race; PlayerModel:
  anim state machine; Room: the respawn/score bookkeeping tail) into a
  sibling module. Opportunistic, near-zero risk.
- **Skip cost:** nothing breaks; fixes stay slow and risky forever.

### 3. Lint ratchet is losing: 1152 oxlint warnings, +182 in a week

- **Source:** `_tools/health/latest.md` (2026-11-15 census,
  `node _tools/health.mjs`).
- **What:** ~19% growth in six days. At this volume the linter is
  noise; real warnings drown (e.g. the `raw!` init-declarations
  disable in `GameServer.ts:478`).
- **Fix:** one burn-down pass on the top 2-3 rule categories only, or
  honestly drop the rules nobody enforces from config.

### 4. Two bot armies: offline client bots vs server bots

- **Where:** `client/src/game/bots/` ~3.9k lines (solo mode) vs
  `server_bun/src/{ServerBots 1010L, botArsenal 1166L, botRouting
  1079L, botMpcSearch, ...}` ~6k+ lines. Shared sims exist
  (`shared/botBrain`, `botMoves`, `botHunt`, `botTuning`) but
  orchestration is twice-implemented.
- **What:** tuning fixes land in one army, not the other; solo feel
  silently drifts from online feel — matters because 6v6 headhunt solo
  is now the first-boot default (2026-11-16 changelog).
- **Fix:** long-term, run `ServerBots` logic in-process for solo (same
  JS). Short-term, force all tuning through `shared/botTuning.ts` and
  audit for constants duplicated in both trees.
- **Skip cost:** new players learn a game that doesn't play like the
  game.

### 5. Leaderboard signing is dead weight on prod

- **Where:** `server_bun/src/resultSigner.ts` (`KRIBES_SIGN_KEY`),
  `serverRoutes.ts:367` (`{disabled: true, reason: 'KRIBES_SIGN_KEY
  unset'}`), `server_bun/src/leaderboard.ts`, `_tools/verify.ts`,
  demo `SECTION_TOKEN`.
- **What:** a security feature that exists, is tested, and is OFF on
  prod — plus the env var still carries the dead codename.
- **Fix:** decide — set the key and ship the leaderboard, or delete
  the signing path and keep `matches.jsonl` (MatchJournal) as the
  plain leaderboard source. Half-alive security machinery is the
  worst state.

### 6. Unseated-join cap of 8/IP will bite on shared egress

- **Where:** `GameServer.ts:302-303` (`PENDING_PER_IP = 8`),
  `unseatAllow`/`onOpen`.
- **What:** flood guard for connected-never-joined sockets. School
  networks (explicitly targeted — `_docs/2026-10-13_SCHOOL_FILTERS.md`)
  put hundreds of students behind one NAT IP; a join spike trips the
  cap and real players can't connect. Window is small (joins complete
  in ms) but WT tier-racing multiplies pending sockets per client.
- **Fix:** cap 8/IP until an IP has N completed joins, then raise it —
  proven-good egress earns a bigger pending budget.
- **Skip cost:** a real outage exactly on the courted audience,
  diagnosed as "server down".

## Nice to have

### 7. Debug probes in the prod damage path

`hitLedger.ts:13-25` — module-global `selfKillImpactDist/Pos/Prey/
FoeDist/Trades` soak-autopsy arrays ship in every dedicated server's
hot path. Capped at 256, so cheap — but gate behind `FPS_DEBUG` or
fold into `weaponStats`.

### 8. Stray dev files shipped in dist

`native/_tail.ts` (leftover console.log probe); `wtmin.html` + other
dump pages (posedump/vmdump/modeldump/gunstats) ship in `dist/`
needing X-Robots `noindex` band-aids (2026-11-21 SEO pass).
Exclude them from the build instead of noindexing them.

### 9. vite.config.js is a small program

419 lines, six custom plugins (gunSheet puppeteer, shotSaver,
mapRelief, distSize, stripOldAssets, pruneLiveUnused, stale-probe,
noreload stale-notify). Works; but `watch.usePolling: true` + the
recursive stale-file watcher pays real CPU all day in dev. The
LIVE_UNUSED prune list (30 GLBs) is a manual graveyard that rots —
generate it from the loadout tables or accept the weight.

## Checked and healthy (don't re-audit)

- Determinism: `botRand`/`strictRng` throws on ambient `Math.random`;
  `shared/env.ts` bans wall-clock in sims; respawn timers are the
  documented known edge.
- Unbounded growth: ledgers/rings capped (MatchJournal 100-ring +
  rotated `matches.jsonl`, hitLedger probes 256, duelStart pruned by
  age, pendingByIp capped, invalidWarn cleared on close).
- Flood/DoS: pre-join 64KB + 16-frame cap, garbageStrike, per-IP
  pending cap, map-catalog negative cache, stats file-size cache.
- Session lifecycle: seat-generation stale-close guard, grace reclaim,
  AFK demote/re-seat — heavily scarred and now correct.
- Duplication: jscpd 0.03% — essentially none.
- Restore path: `exportRestore`/`restoreFrom` validates every field
  incl. NaN guards.
- public/ `.old` graveyard: already cleaned (14MB total, 0 `.old`
  files) and stripOldAssets prunes dist anyway.

## Not checked

`shared/` sim internals (sampled only), `native/` shell, `_tools/`
soaks beyond their outputs, `Room.ts`/`TickLoop.ts` in depth, all test
code, live prod metrics. The gunlab/maplab "bloat" is NOT debt —
`index.html:150-158` ships them as player-facing features by design.

## Ranked lean delta

Deleting RTC/P2P + the claimLedger residual + the signing path +
stray dev files ≈ **-3,500 lines**, 0 dependencies, and kills the
largest single parity surface.
