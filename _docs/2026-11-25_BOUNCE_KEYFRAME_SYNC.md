# Bounce keyframe sync — IMPLEMENTED + VERIFIED (JP-approved design 2026-11-25)

## Outcome (verified live 2026-11-25, `_scratch` probes + testing-agent botmatch)
Implemented in `67447f26`/`d235ca2b`/`325715e0`/`a289f7e1`/`94896322` (+`97480d7d` lint).
Live verification (real-GPU headless botmatch, mortar/GL/MRV forced, recording
`C:/TEMP/_WEB/bounce_mrv_session_share.mp4`):
- The prod 27-127m `parity-dmg-echo` bounce-weapon population DID NOT reproduce.
  shell-traj divergence: n=64 p50=1.3m p95=3.1m max=3.6m, >8m=0.
- 418 keyframes in 160s, 159 on own shells; mortar 45/17 shells, GL 89/75, MRV 20/15.
- First-bounce corrections remain 3-6m visible snaps (the keyframe corrects the
  first chaotic segment — bounded, not invisible); later-bounce corrections
  collapse to p50 ~1m. Shrinking the first-segment further = bit-exact spawn
  sync (the full-lockstep direction), a bigger parked change.
- 5/418 keyframes arrived after the shell replica was already gone (noise).
- zero `parity-kb-echo`/`kb-unpredicted`, zero handler throws, no visual artifacts.

Design validation: JP's call — keyframes AT the amplification points (bounces)
bound chaos to one inter-bounce segment instead of full lockstep or dropped
prediction. Cheaper than lockstep, prediction stays snappy, and it measurably
killed the entire bounce-weapon divergence class.

## Original plan (kept for the record)

## Verdicts that got here
- dmg-echo offM 27-127m rows = shell blast-center divergence, NOT victim error.
  srvAt = server shell detonation pos vs client painted blast center.
- Server ALREADY bounces fully: projContact.ts terrainContact implements
  terrainBounce/maxBounces/lodgeBounce/firstBounceVelScale/fuseAfterBounce,
  mirroring client projCollide.ts. RoomProjectiles.ts header comment
  "no terrain bounce" is STALE — fix it in passing.
- Divergence root: chaotic amplification of small initial-condition noise
  across bounces (pos cm-level + wire quantization + pre-echo flight).
- "Ghost hit X m behind live body" = lag comp working as designed (noise).
- JP's chosen fix: keep local sim, sync at keyframes — keyframes AT BOUNCES,
  where amplification happens. NOT full lockstep, NOT dropping prediction.

## The change (4 parts)
1. shared/worldModel.ts projectile verbs: add `bounce: 'projectileBounced'`
   with fields projectileId(str), position(vec3), velocity(vec3), age(num),
   t(num server wall-ms like spawn echo). Update the stale "no update verb"
   comment.
2. shared/wire.ts: encodeProjBounce + decode, mirroring encodeProjGone shape.
   Binary reliable lane, same as spawn/gone.
3. server projContact.ts terrainContact: after bounceOffField (and after
   firstBounceVelScale/fuseAfterBounce adjustments), broadcast the keyframe
   with post-bounce pos/vel, p.age, server wall time. RoomProjectiles needs
   the broadcast access (same bin.broadcastBinaryReliable as encodeProjGone
   at line 355) — pass a hook or emit from RoomProjectiles tick layer.
   NOTE: skip when bounces exceed some cap noise-wise; each shell emits at
   most maxBounces events, fine.
4. client: net decode dispatch → remote projectile replica reseat:
   set pos/vel exactly, adjust age clock so subsequent replay is exact.
   Look at how projectileCreated reseats (net/projectiles.ts ~596 area)
   — same reseat primitive mid-flight. Own-shell replicas: reseat too —
   the stamp/echo center must live in server-truth space (blastForce.ts:999
   documents the phantom-center kb-echo miss class this fixes).

## Tests
- scenario: grenade/multi-bounce weapon across a real socket pair — assert
  client replica blast center within 1m of server srvAt after 3+ bounces.
- wireFuzz: new message type joins the chaos surface (expect rng-stream
  shift — failures there are timeline, not regression; see decisions.md).

## Expected effect
dmg-echo/kb-echo large-offM population collapses to noise floor; blast
centers agree to cm. Parity channels then measure only real bugs.
