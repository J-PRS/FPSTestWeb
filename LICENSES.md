# Third-party asset licenses

One canonical list: every asset in this repo that isn't ours, what
license covers it, and whether it may ship. Player-facing attribution
ships as `client/public/ATTRIBUTION.txt` (vite copies it into dist) —
keep that file in sync with the "shipped" section below.

## Shipped (tracked, goes into dist)

| Asset | Files | Author / source | License | Obligation |
|-------|-------|-----------------|---------|------------|
| WARLORD announcer pack | `client/public/sfx/announce_*.ogg` | VoiceBosch (SoundBiter) — [opengameart.org/content/warlord-video-game-announcer](https://opengameart.org/content/warlord-video-game-announcer) | CC BY-SA 4.0 | Attribution ("VoiceBosch") + clips stay under BY-SA. Satisfied by `ATTRIBUTION.txt`. |

`.wav` masters of the same pack stay local-only (gitignored); the `.ogg`
encodes are tracked on purpose.

## NOT shippable (local/dev only, gitignored)

These are fine for local playtesting but must never reach a public
bundle or be served to the internet:

- **Unity Asset Store player rigs** — `client/public/assets/models/class_*.glb`
  + anim bakes `assets/anims/{cybersoldier,scifisoldier,vexa,polyart}.glb`.
  UAS EULA forbids serving the raw asset (a fetched GLB *is* the raw
  asset). Stripped by `_clean_deploy.bat`; currently absent from the tree.
- **Extracted Tribes 2 content** — `maps/t2/` (glb/textures/sky ripped
  from the T2 install). Server must run `FPS_PUBLIC_BETA=1` to 404 them.
- **Extracted Tribes 1 content** — `maps/t1/` (albedo/sky/terrain from
  the T1 install). Same `FPS_PUBLIC_BETA` gate; the `*_t1.json` specs are
  tracked but reference the gitignored payloads.
- **WARLORD `.wav` masters** — `client/public/sfx/announce_*.wav`. Same
  license, just redundant weight.

## Rules

- New third-party asset → add a row here BEFORE it ships, plus a line in
  `client/public/ATTRIBUTION.txt` if the license requires credit.
- Generated (TTS/synth) audio rights are per-generator, not per-file —
  see `licensing/generated-voices.md`. Short version: ship SAM/Kokoro
  renders freely, never ship edge-tts output, SAPI is gray.
- When in doubt, the `_clean_deploy.bat` strip list + `FPS_PUBLIC_BETA`
  gate are the enforcement points; this file is the record.
