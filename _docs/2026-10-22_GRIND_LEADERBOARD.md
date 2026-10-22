# Grind leaderboard — design report

2026-10-22. Context: "watch legends" spectate feature — the discovery feed
needs a ranked list of players worth watching. Researched how STRAFTAT
(free 1v1 arena FPS, same casual drop-in profile as KRIBES) does it.

## What STRAFTAT did

- Backend: Steam Leaderboards API — nothing custom.
- Score formula: `GamesWon * 4 + RoundsWon` — cumulative, monotonic.
- Community verdict (their own forum + the lobbyRank mod):
  - It rewards playtime, not skill — top of board = "played most".
  - No integrity gates → cheaters polluted the top-10; the community
    built a whitelist offset mod to filter known cheaters.
  - It still works: every session pays out, feels like progression.

## The key property

**Monotonic grind score = never-wasted-time contract.** Elo-style ratings
are zero-sum — a bad session can leave you lower than you started, which
is the feeling that makes casual players abandon ranked ladders. A grind
board banks every kill/win/cap forever; even a losing night pays out.
For a drop-in browser FPS this is the right contract. STRAFTAT's sin
wasn't the model — it was letting the board imply "best".

## Proposed shape

- **One board, monotonic points.** Per persistent player id. Score only
  ever increases — no decay, no subtract, no seasons wiping grind.
- **Events pay, presence doesn't.** Points per event (kill, match win,
  cap/objective), not per match joined — presence-based points get farmed
  by parking.
- **Integrity gate** (their missing piece): points only count in rooms
  with ≥N humans (e.g. 4+), and bot kills pay a fraction (0.25×) — a
  bot-farm lobby should yield ~nothing. Server already adjudicates every
  kill/win, so the ledger writes through the authoritative path — the
  client can't inflate it.
- **Storage:** `bun:sqlite` profile table in `server_bun` — playerId,
  display name (last seen), points, event counters. Server-side only.
- **Skill reads implicitly.** The monotonic ladder's top IS mostly good
  players + active grinders — a fine filter for "watch legends" (watchable
  players are high-activity by definition). If a true "best" list is
  wanted later, add a display-only column (recent win-rate, K/D window)
  — never a rating that can drop.

## Feeds the spectate feature

- The grind leaderboard IS the discovery feed: "top players online now"
  = leaderboard ids ∩ active room seats — same query the fleet lobby
  already runs for human counts.
- Live-match list ranks by the best grind score present in each room —
  viewers land on the room with the legends, exactly the TikTok-scroll
  analog.

## Explicitly skipped

- Elo/Glicko skill rating — zero-sum ladders contradict the grind
  contract; skill stays implicit for now.
- Seasons / resets / prestige — monotonic-only until the board proves
  itself; a "career + season" split is a later addition if veterans
  lock the top forever.
- Cheater whitelist — build the integrity gate first; only if farming
  still tops the board do we need the community-whitelist path.
