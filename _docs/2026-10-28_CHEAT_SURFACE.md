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
