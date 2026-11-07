# Announcer callout density — classics survey + our set

_2026-11-04. Sources: generator inventory in `_tools/announcer_gallery/`,
historical callout sets from the named games' shipped audio. Rationale:
the announcer gallery generated 40 callout candidates; this doc decides
how many may actually fire in-game._

## The classics, by spoken-line count

| Game | ~Lines | Composition | Feel |
|---|---|---|---|
| Quake III Arena | 6–10 | `FIGHT!`, `Impressive`, `Excellent`, `Perfect`, `Humiliation`, `Denial` | Sparsest. A handful of lines, each one lands. |
| UT99 | ~15 | 7-rung kill ladder (Double→Monster/`Holy Shit`), `First Blood`, headshot, flag taken/returned | The template everyone copies. |
| UT2004 | 40+ | Longest ladder ever (`M-M-M-Monster Kill`, `Holy Shit`), combo names, spree alerts, flag lines | Maximalist list — but apex lines gate on 8+ streaks, so `Godlike` is once-a-session. |
| Halo (Steitzer) | ~15 | `Double Kill`→`Kilimanjaro` + flag calls | ~8 lines almost never fire; that rarity IS the design. |
| CS (1.6→CS2) | ~5 | `bomb planted`, `hostage rescued`, round-end | Purely functional, zero flair. |
| LoL | ~10 | first blood → penta, `Ace`, `Legendary` | MOBA rhythm; streaks only. |
| Valorant | ~8 | double → ace + clutch | Modern sparse. |

## What the numbers say

- **Daily rotation is always ~8–12 lines.** Nobody exceeds that without
  a rarity ladder underneath.
- **Apex lines exist to be rare.** UT2004's 40-line list worked because
  the top rungs fire maybe once per session. Halo's `Kilimanjaro` is
  famous precisely because nobody hears it.
- **Density kills announcers.** A voice that talks on every flag touch
  becomes noise players mute. CS survives on 5 lines; Q3 on ~8, and both
  are fondly remembered.
- **The kill ladder is the only place volume is earned** — and even
  there, UT's middle rungs (dominating/unstoppable) are the filler
  nobody quotes.

## Our inventory (generated, not all shippable)

40 callout texts × ~20 generator/chain columns in
`_tools/announcer_gallery/` (audition at the sound gallery,
`serve.py :8791`). Groups:

- **Killstreak** (12): firstblood, double, triple, killshot, rampage,
  dominating, unstoppable, godlike, wickedsick, annihilation, precision,
  hattrick
- **Kills/duels** (5): headshot, revenge, payback, denied, humiliation
- **Flag** (6): flagtaken, flagdropped, flagreturned, flagsecure,
  capflag, carrierdown
- **Match state** (7): newleader, matchpoint, overtime, victory, defeat,
  roundwin, gameover
- **Objective/military** (6): eliminate, tango, targetlock, lastman,
  objective, finalstand
- **Pregame/flavor** (4): prepare, fight, nugget, shazbot
- Reference column: `ref-warlord` (VoiceBosch, CC BY-SA 4.0 — the
  original 12-clip set this whole exercise compares against)

## Recommended shipping set (~10 + 3 apex)

Regular rotation:

| Chord | Fires on |
|---|---|
| firstblood | first kill of match |
| rampage | 5-kill streak |
| flagtaken | enemy grabs our flag |
| flagreturned | our flag returns |
| carrierdown | enemy flag carrier dies |
| overtime | match hits OT |
| victory | match end win |
| defeat | match end loss |
| prepare | pre-round countdown |
| shazbot | flavor slot (rare/random — or cut) |

Apex (gate on 8+ streak or match-defining plays; should feel rare):

| Chord | Fires on |
|---|---|
| godlike | 10-kill streak |
| wickedsick | 8-kill streak |
| annihilation | team wipe |

Explicitly cut despite being generated: double/triple/killshot (feed
already shows), dominating/unstoppable (ladder filler), all flagsecure/
capflag/dropped variants, newleader/roundwin/gameover (match UX covers),
denied/payback/headshot (too frequent to feel special), the military set
(eliminate/tango/targetlock/lastman/objective/finalstand), fight/nugget.

## Playback gating (as important as the list)

Voice budget rules for `speakAnnounce` (`client/src/core/tts.ts`):

- **Serial only** — one clip at a time; queue max 1 pending.
- **Priority preempts** — flag/match-state > killstreak > flavor.
  `flagreturned` cuts `rampage`, never stacks.
- **Per-clip cooldown ~30–60s** — same line can't re-fire inside it.
- **Global rate cap ~1/8s** — dense fights get ONE callout, not five.
- **No mid-fire duplicates** — two kills in one feed batch = one line.
- VGS/chat channels must not duck or overlap the announcer (separate
  WebAudio chain already; keep it that way).

## Licensing recap

WARLORD = CC BY-SA 4.0, credit VoiceBosch (in `LICENSES.md` +
`ATTRIBUTION.txt`). Generated columns: ship SAM/Kokoro/Chatterbox
renders freely; edge-tts output is reference-only; SAPI is gray.
Per-generator rights: `licensing/generated-voices.md`.

## Open picks

- Winning generator still TBD by ear (current favorite:
  `kokoro-af_bella-pa`). Once picked: bake chosen clips →
  `client/public/sfx/announce_<name>.ogg`, add row to `LICENSES.md`,
  wire the ~13-chord table + gating into `tts.ts`.
