# Generated-voice licensing (TTS output rights)

Covers audio rendered by speech synthesizers — e.g. the VGS/announcer
galleries under `_tools/vgs_gallery/` and `_tools/announcer_gallery/`.
Canonical asset list lives in `../LICENSES.md`; this file is the
per-generator rights reference for deciding what may ship.

| Generator | Ship rendered audio commercially? | Basis |
|---|---|---|
| **sam-js** (SAM, C64 synth) | **Yes** — cleanest option. | MIT library; output is pure synthesized PCM — no voice likeness, no training data. No attribution required (crediting the tool is still good hygiene). |
| **Kokoro** (local ONNX, `kokoro-en-v0_19`) | **Yes.** | Apache-2.0 model; generated audio is ours to ship. |
| **Windows SAPI** (David/Zira/Hazel desktops) | **Gray** — don't ship without checking. | Desktop voices licensed for use *within* Windows apps; bundling rendered WAVs as redistributable game assets is not clearly granted. |
| **edge-tts** (unofficial Azure/Edge voices) | **No** — reference only. | Unofficial client; output rights murky and access itself is ToS-adjacent. Fine for comparison listening, never ship. |
| **Piper** (not yet rendered) | **Yes, mostly.** | MIT code; voices typically permissive — verify per-voice file if used. |

## Rule of thumb

- **Ship:** SAM and Kokoro renders, raw or FX-processed — zero attribution
  needed. If one ships, add a line in `LICENSES.md` noting the generator
  (for provenance, not obligation).
- **Don't ship:** edge-tts output ever; SAPI output without confirming
  Microsoft's redistribution terms.
- If an Edge/SAPI voice's *performance* is the one to beat, reproduce the
  vibe with Kokoro/SAM + FX chains (`_tools/announcer_gallery`) or a
  licensed recording — not the file itself.

Recorded/licensed packs are a different lane — see `LICENSES.md`
(e.g. WARLORD announcer: CC BY-SA 4.0, attribution required).
