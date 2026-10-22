# NOTES — JP's world

Everything is local to this repo: git log, test suites, `_docs/`,
`changelog.txt`. No Slack/email/issue tracker in the loops.

## Canonical terms

- **Robustify round** — one "Robustify skill" message = one round:
  pick a lane, ship ONE fix/pin/hardening, verify (client tsc + vitest,
  server bun test), append §2.x to `_docs/ROBUSTIFY/ROBUSTIFICATION.md`
  (ends `### 2.x - end`), prepend a dated line to `changelog.txt`,
  commit per concern, never push.
- **Verify loop** — the gate before any commit: `cd client &&
  ./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/vitest run`;
  `cd server_bun && ~/.bun/bin/bun test`, `bun x tsc --noEmit`.
- **Beta launch** — taking the game public on a real domain behind
  Cloudflare; deploy path exists (`FPS_PUBLIC_BETA=1`,
  `_clean_deploy.bat`, `Dockerfile`, `_docs/2026-10-07_DEPLOY_BETA.md`).
- **Room** — one named game instance in the lobby; multi-room by design,
  empty rooms hibernate.
- **Claims** — every client→server interaction is a claim the authority
  validates; server owns every outcome.
- **Soak** — deterministic netcode test on the sim-clock bridge harness
  (`server_bun/tests/net/`), not wall-clock.

## Cadence

- Robustify rounds: driven by JP, historically rapid-fire.
- Continuous-improvement review: per `C:.devin/rules/continuous-improvement.md`.
