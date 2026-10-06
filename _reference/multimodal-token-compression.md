# Multimodal Token Compression — validated reference (2026-10-06)

Validated digest of the research dump on how SOTA systems feed
images/video/audio to LLMs. Verified citations below; corrections noted
where the dump overstated. Framed for KRIBES asset workflows at the end.

## Verified claims

- **Core thesis (accurate)**: modern pipelines compress raw pixels/samples
  into a small set of information-dense latent tokens before the LLM
  reasons — never "every patch is a token".
- **NaViT / Patch n' Pack** — arXiv 2307.06304 (Google, 2023). Native
  resolution processing, token budget allocated by content size. Real,
  foundational, widely adopted in document VLMs.
- **EvoComp** — CVPR 2026 (Song et al., OPPO). Encoder-only transformer
  compressor; 99.3% of original accuracy at 3x visual-token compression,
  up to 1.6x speedup on mobile. Verified abstract.
- **PruneVid** — arXiv 2412.16117. Training-free: merges spatial-temporal
  tokens, then prunes via question↔video attention in an intermediate
  LLM layer; >80% tokens pruned at competitive accuracy. Verified.
- **WavTokenizer** — ICLR 2025. 24 kHz audio → single quantizer, 40 or
  75 tokens/sec at SOTA reconstruction (UTMOS). Verified.
- **LLM-Codec** — ACL 2026 Findings (arXiv 2604.17852). Codecs optimized
  for waveform reconstruction raise LM perplexity; adding
  language-model-facing objectives (Medusa-style multi-step heads +
  contrastive semantic alignment) cut perplexity 35x. Verified.
- **dNaViT / DiNA** — real, but it's a component of LongCat-Next
  (arXiv 2603.27538), not a standalone paper. Unified discrete-token
  space across text/vision/audio under one NTP objective. Verified
  with that correction.

## Corrections to the dump

- **"~30% of visual tokens preserves nearly all accuracy"** — EvoComp's
  published number is 99.3% accuracy at 3x compression (~33% retained),
  consistent. Fine.
- **DynaTok, GeoTrace, InfoMerge, EarlyTom, MeToM** — temporal-compression
  names come from the Awesome-Token-Compress list; not individually
  verified here. Treat as pointers, not endorsements.
- **VisionSelector, ADSC, OccamToken, RESTORE, AnchorPrune** — same
  caveat; pruning-family names from survey lists.
- **dNaViT "aims to convert vision and audio"** — it is the vision
  tokenizer inside DiNA; the unified-space claim belongs to the
  LongCat-Next framework around it.

## The field's actual structure (validated)

- **Images**: native/dynamic resolution (NaViT) → vision tokens →
  pruning (keep ~10-30%) or merging (ToMe-style) → LLM. Pruning is
  cheap and training-free options exist; merging preserves slightly
  more accuracy.
- **Video**: three stacked compressions — keyframe selection (scene
  changes/actions), spatial pruning per frame, temporal merging
  ("car moved left→right" as one token instead of per-frame repeats).
  Query-aware pruning (PruneVid) keeps whichever tokens the question
  needs.
- **Audio**: neural codec tokenizers (EnCodec lineage) — discrete
  acoustic tokens; WavTokenizer at 40-75 tok/s is the extreme point.
  Frontier: train codecs for *predictability under an LM*, not just
  reconstruction fidelity (LLM-Codec).
- **Endgame**: one shared discrete token space for all modalities
  (DiNA/LongCat-Next). Same next-token-prediction machinery everywhere.

## Relevance to KRIBES asset workflows

- **Our .demo format is already the right idea** — it IS a semantic
  token stream: quantized state + event edges, not pixels. An hour of
  10v10 ≈ 47 MiB; MP4 of the same ≈ GBs. For any future "AI watches a
  match" workflow, feed the demo event stream, not rendered video —
  that's the video-compression layers (keyframes/spatial/temporal)
  already collapsed into game semantics.
- **Query-aware pruning maps directly**: kill/flag/pickup events are
  the high-value tokens; remote player frames are the prunable
  background. A "describe this match" pipeline could keep targetEvents
  + local frames and downsample remote frames — exactly PruneVid's
  question-driven selection.
- **For screenshots/thumbnails in asset pipelines** (e.g. an AI
  picking the best cool-shot still): a VLM at native resolution with
  token pruning is the standard approach — no need to feed video.
- **If we ever add voice/audio to clips**: codec tokens (~40-75/s)
  are the storable representation, not PCM — same philosophy as the
  demo format itself.
- **Big caveat for "50-year artifacts"**: learned codecs are opaque —
  no codec spec survives like our FORMAT.md does. Keep durable
  artifacts in our explicit semantic encoding; use learned compression
  only for derived/ephemeral views.

## Sources

- NaViT: arxiv.org/abs/2307.06304
- EvoComp: openaccess.thecvf.com (CVPR 2026, Song et al.)
- PruneVid: arxiv.org/abs/2412.16117
- WavTokenizer: proceedings.iclr.cc (ICLR 2025)
- LLM-Codec: aclanthology.org/2026.findings-acl.1308
- LongCat-Next/DiNA/dNaViT: arxiv.org/abs/2603.27538
- Survey lists: github.com/daixiangzi/Awesome-Token-Compress,
  github.com/cokeshao/Awesome-Multimodal-Token-Compression
