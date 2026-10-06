# Retired Asset Reference

Notes on things that were replaced — what the old version was and where
it lived, in case we ever want it back.

## Bolt launcher shot voice (retired 2026-10-05)

Old voice: `shot_rocket` — `/sfx/shot_rocket.ogg`, played at rate 1.0,
gain 0.9 via the `SHOT_SAMPLES` table in `client/src/core/sfx/weapons.ts`.
A generic rocket-launch whoosh; serviceable but had no crossbow character.
The sample is still in the bank (other weapons/claims may reference it)
and remains the fallback when the new samples haven't decoded.

New voice: two Audiogen clips stacked, each at random pitch 1.5–2.0 —
ported from the FPS_Test project's bolt launcher:

- `client/public/sfx/g_loud-powerful-ballista-crossbow-shot_2_5865d.ogg`
  — the ballista TWANG, carries the attack/read of a crossbow release.
- `client/public/sfx/g_powerful-deep-scifi-weapon-shot-game-sound_1_2fa9a.ogg`
  — the deep sci-fi body under the twang.

Both transcoded from the source `.flac` to Vorbis q5 (~19KB each) — the
bank's standard format; short percussive transients mask any lossy edge.
Lossless originals live in the source batch if ever needed.

Recipe lives in `SHOT_LAYERS[WeaponType.BoltLauncher]` in
`client/src/core/sfx/weapons.ts` (base rate 1.75, layer jitter 0.29 →
1.5–2.0 per shot). Sources: `D:\[Projects]\FPS_Test\Assets\_Audiogen\Batch1\`.
