# Game Audio — best practices applied in KRIBES

## Architecture
Raw Web Audio API, zero libs. `audio.ts` owns: master → compressor → ui/sfx/world buses; `worldInput(pos)` = StereoPanner + distance gain `1/(1+d/8)` + distance lowpass `max(800, 20000/(1+d/60))`; 24-voice cap; >220m culled. Unlock on first pointer-lock (browser requirement). No THREE.PositionalAudio (HRTF overkill for a twitch shooter) and no Howler (we already built the parts it provides, tuned to us).

## The secret technique: layering + jitter
Every big sound is 2-4 stacked samples, each with independent pitch (rate) jitter ±6% and gain. `layer(dest, [[name, gain, rate, lpfHz, cutSec], ...])`:
- **rate**: playbackRate — below 1 = lower pitch (bass body), above = brighter. Deep-pitch a copy of the main hit for "substance".
- **lpf**: per-layer lowpass — lets a bright ringy sample serve as pure low-end body without its ring bleeding through.
- **cutSec**: early fade-out — kills long sample tails so only the transient survives. THE fix for "painful empty ring": cut before the sustain.

## Punchy vs painful (learned from spectrograms)
- Punchy = high crest factor (peak/rms), fast attack, sustain < ~0.6s, energy concentrated in low/mid bands, no sustained narrow high-freq lines.
- Painful/thin = long horizontal bright bands on the spectrogram (resonant ring), low crest, all mid-high energy.
- Verify with `_tools/sfxdump/render.js` (headless WAV per sound) + `analyze.py` (band split, crest, sustain, spectrogram PNG). Never ship a sound un-measured.

## Synth vs samples
Hybrid is the right answer: real WAVs for organic sources (explosions, shots, foley) where synthesis hits a quality ceiling; synth for UI blips/loops where it modulates per-frame. Every `sfx.*` call tries `sample()` first, falls back to the synth version — nothing is ever silent and swaps are non-breaking.

## Per-weapon identity
- `SHOT_SAMPLES` per-weapon fire map; disc is a layered twang recipe.
- `BOOM_SAMPLES` per-weapon explosion voice (mortar deep rumble, flak crack, plasma sizzle, railgun zap).
- Positional ricochet on bounces; `implosionAt` for pull-mode weapons.

## Source libraries (licensing-safe, on JP's drive)
- AUDIOGEN outputs (One_shots + Batch1-5) — JP's own, cleanest.
- KICKERS (Antisample) — usable in shipped game, don't commit raw files publicly.
- Quetoo bundle, Legions/Tribes rips — check licenses per-file.
- Drive audit: `_tools/audioaudit/scan.py` → audit.csv (2598 files) + spectrogram sheets.
