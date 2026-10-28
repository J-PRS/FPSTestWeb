# Cheat Surface Analysis (2026-10-28)

Q: "Since we can connect netbots as players from outside the server, does that mean our game is trivially easy to cheat? As far as input faking." — the audit this doc records.

## Verdict

Not trivial — the authority model holds on *outcomes* — but the standard
FPS cheat classes are real, and two soft surfaces are ours specifically.

## What a netbot-grade client can do

A netbot (`server_bun/tools/netbot*`) is a cheat harness *by design* — it
exercises the same wire surface a modified client would, which is exactly
why the gates get tested. It is NOT shipped: it lives server-side, never
in the client bundle.

The protocol itself IS shipped — `shared/` compiles into every client
bundle (encoders, decoders, join handshake, `shotFired` intent shape,
`inputMove` claim format). Writing a fake client = read the bundled JS or
watch live ws frames in devtools, then replay `join` + scripted inputs.
Call it a day of work, not an afternoon, not weeks. Browser games are
easier still: a userscript hooking page JS is a cheat, not a binary patch.

## Blocked — server authority holds

- **Fabricate damage/hits** — combat claims refused on dedicated
  (`claimsAccepted=false`); `shotFired` is an intent, the server sims the
  shell and adjudicates the outcome itself. You cannot say "I hit X."
- **Teleport/speed beyond tolerance** — `moveClaims`/`moveJudge` rewinds
  and replays claims through the shadow sim; implausible reports reject
  and the client gets corrected.
- **Forge identity / spam** — session tokens, rate limiter, `ws.pause`
  flood control.

## Real today — the cheat classes that work

- **Aimbotting** — `shotFired` intents carry origin+direction. A bot can
  send a *perfectly legal* intent aimed at a victim's head every tick.
  The server can't distinguish perfect aim from cheating — same as every
  FPS; only behavioral analytics (snap detection, timing entropy) would,
  and we don't have any.
- **ESP / wallhack** — interest management culls by distance tier ONLY,
  never occlusion. Every remote within ~600m rides the wire regardless of
  walls. A modified client reads every remote position the server ships;
  in the browser, `remotePlayers` positions are a `tampermonkey` script.
- **Sub-tolerance movement exploits** — `moveJudge`'s plausibility band
  admits small speed/airtime boosts below the reject threshold. Bounded,
  not zero.

## Effort reality check

| Attack | Effort | Mitigatable? |
|---|---|---|
| Fake client / netbot | ~1 day protocol reading | No — join is intentionally open (public rooms) |
| ESP (read remote positions) | ~1 hour (devtools/userscript) | Yes — occlusion culling on records |
| Aimbot (perfect intents) | ~hours (script the intent sender) | Partially — aim-anomaly analytics |
| Speed exploit (sub-tolerance) | ~hours | Tunable judge tolerances |
| Fabricate damage / teleport | N/A — refused server-side | Already dead |

## What hardening actually looks like

1. **Occlusion culling on tick records** — distance+vis gates for record
   fanout. The most fixable real hole: kills ESP at the wire level, not
   just the render. Cost: vis edges per (conn, remote) on the server —
   the interest machinery already runs per-recipient; needs a visibility
   verdict alongside the distance tier.
2. **Aim-anomaly detection** — snap-rate / tracking-entropy telemetry on
   `shotFired` intents. Same problem every FPS has; flag-not-ban policy.
3. **Tolerance tuning** — tighten `moveJudge` bands where the wiggle is
   measured to be exploitable.
4. **Protocol obscurity** — bundling/minification buys ~nothing; ws frames
   are inspectable live. Not a defense, don't count it.
5. **Join attestation** — nothing proves "real browser client"; a bot's
   join is indistinguishable by design. Web attestation is weak; don't
   rely on it.

## Field evidence — the Tribes precedent (community history check)

The genre's own history says aim-math cheats are weak here by DESIGN:

- **"Workable aimbots don't exist in Tribes"** — long-standing T2
  community consensus. The mechanism: projectiles inherit player
  momentum AND travel slow, so a lead solution needs the victim's live
  velocity AND their future trajectory — a ski-turn invalidates both.
  Shadowex3's formulation: "even on a stationary target you'd need the
  player's exact speed and direction at all times — aimbots exist in
  hitscan games; Tribes isn't one." Our own chain matches: splash
  forgives humans and punishes bots equally.
- **What actually hurt T2** — not aimbots: `hm2` (a hack menu — mostly
  outcome/rate exploits, and community consensus was it got *less*
  effective outside Ultra/Renegades), texture replacements, fog-free
  patches, bright-skin mods, and QoL scripts (autopoints). The damage
  classes were visibility and rate exploits — exactly the layer our
  server already owns.
- **T:A's real cheats were outcome hacks** — the reported aimbot was a
  sniper (hitscan — the one class where aim math DOES work) bundled with
  rate exploits (60/s melee swings, 950,000 kph knockback). Those are
  clamp-verdict bugs on rates/effects — our `moveJudge`, `forceSend`
  windows, and `claimsAccepted=false` gates cover the same classes.
- **Community enforcement worked** — T2 comp used demo review +
  anti-cheat mods because the game was small and community-run. Our
  `dualcheck` demo oracle is the same mechanism automated.

So the honest rank stays: the strongest structural anti-cheat is the
*genre choice itself* — slow inheriting projectiles + splash + skiing
movement make perfect aim low-value. The two real remaining cheat
surfaces (un-marked intel, sub-tolerance movement) are the ones the
server-side gates already own.

## Web transparency — wider access surface, smaller payoff surface

Counterpoint: our inspection surface is wider-open than any native game —
protocol, sim, decoders, predicted-movement math all ship as inspectable
JS; devtools IS the cheat IDE. A userscript + ws sniff is hours, not
weeks. BUT cheat *value* is bounded independently of cheat *access*:

- CS2's closed binary doesn't stop cheats (below) because the payoff is
  huge: hitscan aim = the outcome.
- Ours: perfect aim = parity (projectile + momentum + splash), outcomes =
  server-owned, ESP = IFF-diminished. Trivially-easy write, low-value win.
- Krunker is the real cautionary axis — web AND hitscan = worst
  combination. We're web AND projectile — only one of those. Genre choice
  does more work than a closed binary would.
- Net effect: cheat *prevalence* may be higher (anyone can write one);
  cheat *impact* stays bounded by authority + physics. ESP is the one
  class where openness converts directly into advantage.

## CS2 field data — "nigh-infinite budget" doesn't close the gap

- STYKO's 30-match Premier experiment at 25k+ (Mar 2025): **26/30 had a
  cheater**, 17 consecutive. Vince Hill: 20k+ "unbearable", 25k+ "out of
  control."
- CheckMATE '24 ranked Valve's AC below Valorant/Fortnite/R6/OW. Valve
  refuses kernel-level AC (privacy + Linux/Steam Deck) — VACnet loses to
  anything kernel-resident. A cheat dev claimed sub-tick floods detection
  (16 sub-ticks/tick overwhelms the server-side sample).
- FACEIT (kernel AC) reports ~0.4% cheat rate vs Premier's ~80%
  community-measured — players migrated BECAUSE of this.
- July 2026: rage-hack wave → VACnet update + ~8k ban wave; cheat dev
  quoted "might be the end for ragehacking in Premier" — for now, and
  only the blatant class.
- Lesson: hitscan + reaction-time combat is the exact shape where aim IS
  the outcome; no budget fixes the structural payoff asymmetry.

## Behavioral ML — we have the data; the trap is the false-positive tail

- **Data surface is rich**: every moveIntent/shotFired/moveClaim + the
  demo oracle pairing "what the client saw" vs "what it did."
- **FP asymmetry**: ban a legit = catastrophic; miss = status quo. Best
  legit players are outliers in the same direction as cheaters — tails
  overlap, always. Humanization adapts the moment a detector exists.
- **The real discriminator is information leakage, not aim smoothness**:
  a cheater reacts to enemies it shouldn't know (shoots the un-marked
  flanker it read off the wire). Reaction-to-visibility correlation can't
  be faked — they can't un-know what they saw. Second: lead-error vs
  target-juking correlation — human lead error tracks target evasion; a
  bot's stays flat.
- **Pragmatic shape**: score-and-flag + demo review on flagged segments,
  not auto-ban. Capture machinery already exists (dualcheck/demos/
  journals); the scorer is feature work on data we have, days not months.

## Shadow-pools — ban nobody, quarantine behavior

- Titanfall "cheaters paradise"/GTA precedent: flagged players get
  identical-looking lobbies populated by bots/other flagged players. The
  win: no false-positive PR disaster — a flagged legit just has a weird
  game, not a ban.
- **Mechanics are already ours**: `/join?room=X` resolves server-side —
  the room NAME the player clicked is cosmetic; the matchmaker can mint a
  same-named shadow room on a flagged worker and land them there. Server
  browser does NOT block this: friends clicking the same name land real,
  flagged sessions land shadow — party-join with flagged accounts is
  broken (arguably a feature). Tells: roster diff if they compare notes;
  bots with human-ish names cover casual inspection.
- **The real blocker is identity persistence**: joins are
  anonymous-by-design — a flagged player rejoins clean. But that may be
  FINE: shadow-pooling doesn't need permanent flags, it needs
  re-detection within a session — a continuous re-sort, not a ban hammer.
  They get A clean game, re-flag, land back in the pool.

## Input biometrics — probabilistic re-admission signal

- Real field, commercial products (BioCatch, BehavioSec); reCAPTCHA's
  mouse analysis is the same idea. Two flavors: keystroke dynamics (weak
  here — bursty FPS inputs, not text) and mouse/input dynamics (aim-flick
  signature, ski-jump cadence, key-press micro-timing, weapon-switch
  habits).
- **Fits our data surface**: every input frame is already on the wire —
  the journal/demo data IS the biometric surface. A "resembles flagged
  session X" scorer is feature work on data we have.
- **Limits**: it's a signal, not an ID — same person drifts, hardware
  swaps shift it, two players collide. Cold-start asymmetry — a one-shot
  cheater has no fingerprint to re-match.
- **The honest role**: a shadow-pool re-admission gate — "this new
  session's inputs match a flagged fingerprint closely enough to
  re-route" — not a ban-grade identifier.

## Community tools + the cheap fingerprint stack

- **Vote-flag, not vote-kick**: anonymous joins make ejection cosmetic —
  a kicked player rejoins clean. The useful version is votes feeding the
  shadow-pool score: flag-weight over vote-count (one vote = noise;
  repeated flags across sessions = signal), ideally corroborated by the
  behavioral scorer so "is just good" doesn't outvote reality. CS's
  failure mode (kick-the-good-player, cooldowns for kicking cheaters) is
  the documented abuse to design against.
- **Fingerprint = cheap signals only**: first-party localStorage device
  token (server-minted at join — catches everyone who doesn't clear
  storage), IP (`srv.requestIP` is already there), and client-reported
  fields in the join frame (WebGL renderer string, UA, screen res — the
  client knows them; no fingerprinting code, just report-what's-there).
- **Skip**: canvas/audio-context fingerprinting (real code, easy to
  noise-spoof), JA3/TLS (proxy-incompatible), accounts (kills the
  no-auth join). The stack is a weighted "probably-same-operator" — all a
  soft quarantine needs; a false positive costs a weird game, not a ban.
- **Framing**: not proof-grade — a determined cheater cycles incognito +
  VPN + spoofing and beats it. The job is raising rejoin cost from "F5"
  to "clear everything + rotate VPN"; friction-grade is what a
  shadow-pool needs to hold people.

## The rule

The defenses live server-side — authority over outcomes, plausibility
gates, occlusion culling — not in protocol secrecy. "Someone can write a
fake client" is a given; "their fake client can't fabricate outcomes" is
the invariant that matters, and it holds today.

## Gates

- `server_bun/src/moveClaims.ts`, `moveJudge.ts`, `rewind.ts` — claim adjudication
- `server_bun/src/MessageHandler.ts` (`acceptClaims`, rate limits)
- `server_bun/src/tickRecords.ts` — interest tiers (no occlusion yet)
- `server_bun/tools/netbot/` — the test harness this surface exercises
