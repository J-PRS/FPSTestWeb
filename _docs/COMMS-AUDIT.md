# Comms audit — VGS + text chat vs. 30 years of lobby culture

Verdict up front: **we fare surprisingly well on *vocabulary* — the
single biggest gap is that comms don't *do* anything.** Players can
radio "Defend our flag!" and a bot replies "roger" — then doesn't move.
That dissonance is the most un-Tribes thing in the stack, and fixing it
is also the biggest believability lever left.

## What we already nail (better than most shipped games)

- **Real VGS tree** — canon chord tree (vgsTree.ts), bots speak chords,
  not just text; ~40-45% of gated lines come out as VGS + canon text.
- **VGS combos** — the splice-culture hack is actually modeled:
  "I am the— SHAZBOT!" cut chords via comboTailFor/comboCutDelayMs.
  Even most Tribes players' nostalgia doesn't include that level.
- **Era-fluent vocabulary** — LPB/HPB, llama, HoF, MA/MAMD, e-grab,
  PunkBuster, net_graph, ASE, qq, qft, "teh", blue plate. ~40
  situation pools keyed to real events (fear/hero/belt/deploy/bored/
  flag lifecycle/tilt/revenge/streak-end/witness/props/mald/question/
  lag/bye/ack/mention/wholesome…).
- **Reply classifier** — chatKindFor maps human text → a situation
  kind (gg/ez/shazbot/praise/snark/hello/thanks/sorry/mald/lag/
  question/bye) with specific-beats-generic ordering; 'lol' is
  deliberately unclassified so bots don't reflex-bark.
- **Per-pool no-repeat rings** — a line can't recur until ~14 siblings
  have aired, so chat doesn't loop.
- **Mention awareness** — nameIn() pings a bot when you type its name.
- **Side-aware reactions** — flag caps cheer the capping side and groan
  the other; alerts only fire on the defending team.
- **Cooldown + speak-chance + match-muted post-horn** — bots don't
  flood; the gg beat is a once-per-match participation, not a gate.

## What the classics did that we don't

### 1. Commands actually commanded (the big one)

Every era system was *usable*, not just chatty:
- **Tribes/UT/CS radio** carried intent — "Cover me," "Defend the
  flag," "Go go go," "Need backup." The social contract was that a
  teammate hearing it might actually come. Urban Terror/TFC/CS binds
  wired the call to the player who needed it ("medic i'm $health").
- **Us:** `vgsCommandFor` exists — every V[ADFNRTUW] command gets an
  'ack' ("roger / on it") — **but the brain never sees the order.** A
  bot that radios "Defend our flag!" doesn't defend it, and a bot that
  hears a human's "Get the enemy flag!" doesn't go.

  **Fix sketch:** same-team command chords push a ~10s utility nudge
  into the brain ctx — `ctx.radio = { verb: 'defend' | 'attack' |
  'cover' | 'cap', from: actorId }`. In pick(), the matching candidate
  gets +0.4 weighted by `duty` and scaled by `social` — so a dutiful
  bot actually rotates to the flag on V-D-F while a loner ignores a
  "cover me" it doesn't feel like taking. Sender's own notice is
  already excluded (actor never gets their own notice). This is THE
  "wait, it listened to me" feature — cheap, entirely legal senses.

### 2. Locations in callouts ("where" sells intelligence)

Era binds printed *place*: Q3's `$l` target_location, TFC "Enemy in
SNIPER NEST," "Incoming MAIN entrance," Urban Terror "Spotted $e near
$o." Our fills are `{t}`/`{v}` names only — every callout is placeless,
which quietly reads generic ("contact" vs "contact, west ridge").

**Fix sketch:** a `{d}` fill — 8-way compass bearing from the bot's pos
to the stimulus. "thief heading west," "contact NE," "flag outbound
south side." No named-map-data needed; cheap and honest.

### 3. Numeric state macros ($h / $k style)

Era binds embedded live state: `medic i'm $health`, "last killed by $k."
A bot saying "im at 23hp, falling back" is dramatically more human than
"im hurt." We have the numbers — healthFrac, lastHitBy/foeScore for
the nemesis name.

**Fix sketch:** `{h}` = rounded HP for fear/underfire lines, `{n}` =
nemesis id for revenge/tilt pools. Add a few lines that *use* them —
"down to {h}hp", "{n} again??" — no new plumbing, just template fills.

### 4. Carrier calls for help

In Tribes, the carrier VGS'd "Cover me!" / "Defend the flag carrier!"
and escorts actually materialized. We have flaggrab/flagcap lines but
no *request* — and we have an escort system that nobody can summon.

**Fix sketch:** a carrier in contested ground rolls a `help`/escort
chatter kind (canon chords: VDM "Cover me!" / VFF already used for
"I have the flag" — add VDC "Defend the flag carrier!" for teammates).
Teammates in earshot get a small escort-goal weight bump — same
mechanism as item 1, triggered by a *bot* rather than a human.

### 5. Push-commit "GO GO GO"

The wave marshal already times the flood — but nobody says go. Era
culture is *loud* at commit ("RUSH," "GO GO GO," "NOW"). A wave-release
chatter beat (VAV?/VGTG or text "go go go") on the push trigger, then
a beat later the ack chorus from wave members — makes the CTF machinery
legible and reads as coordinated humans.

## Parity hole found (independent of culture)

**Offline chat is deaf.** `chatKindFor` + `vgsCommandFor` + `nameIn`
only run inside `Room.ts` (server). In solo/offline rooms, typing "gg",
"thanks", "shazbot" or pressing VGS produces **zero** bot replies —
there's no notice path from the local player's chat into TeamBots.
The reply pools exist; the wire doesn't. Routing local chat through
the same classifier into `TeamBots.notice` is one hook + ~10 lines.

## Culture-notes scorecard

| Culture artifact | Status |
|---|---|
| VGS chords + canon text | shipped, combos included |
| shazbot as the universal curse | shipped (own pool entry + reply) |
| llama / HoF / MA / e-grab jargon | shipped |
| Quake LPB/HPB/ping-griefing | shipped (lag pool) |
| UT announcer spree self-report | shipped |
| CS radio acks ("roger", "on it") | shipped (ack pool) |
| Numeric binds ($h/$k/$l) | missing — add {h}/{d}/{n} fills |
| Location calls | missing — compass {d} |
| Commands that command | missing — ctx.radio nudge |
| Offline chat replies | missing — parity bug |
| Corpse-bob/nemesis humiliation | pending (deepdive item 7) |

## Recommended order

1. **ctx.radio VGS obedience** — gameplay-visible, "it listened" factor.
2. **{d}/{h}/{n} fills + compass callouts** — pure text, huge flavor.
3. **Offline chat parity** — correctness, not culture.
4. **Carrier cover-me + wave GO** — comms wired to real objectives.
5. Nemesis corpse-bob + targeted banter — clip-able revenge loop.

All deterministic, all on existing senses/chatter bus. No new wire types,
no unseeded randomness (tauntRand is already seeded).
