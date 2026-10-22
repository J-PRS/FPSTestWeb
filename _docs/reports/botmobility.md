# Bot mobility review — 2026-10-03

Source: `Bot mobility` INFO lines harvested from a 95s live run
(crossfire CTF, 8 server bots, spectate-held room). The watchdog still
logs `Bot sheeping` / `Bot stuck` WARN lines — this file is the standing
review of whether the ski/air fix actually held.

## Verdict

**Sheep behavior is gone.** Every one of 87 sampled windows (8 bots ×
~10s) reports `skiAirPct: 100`. Zero `Bot sheeping`, zero `Bot stuck`
warnings for the entire run.

## Numbers

| metric | min | median | max |
|---|---|---|---|
| skiAir % | 100 | 100 | 100 |
| avgSpeed m/s | 7.3 | 12.1 | 77.9 |
| covered per 10s window, m | 29.2 | 84.8 | 479.2 |

Slow windows (~7-15 m/s, 30-90m covered) are bots anchored on defense or
fighting near a stand — still skiing/airborne the whole time, just
low-displacement. Fast windows (45-78 m/s, 300-480m) are ski traversals.
Both are legal Tribes movement — no sheep-tiptoeing anywhere.

## How to refresh

Spectate a bot room for ~90s, then grep:

    bun _tools/pvptest/spec.ts &            # holds the room alive
    grep "Bot mobility" server_bun/logs/server.log

(`GET /join?bots=N` alone disposes the room instantly — a room with no
live member is reaped; the spectate socket keeps it running.)
