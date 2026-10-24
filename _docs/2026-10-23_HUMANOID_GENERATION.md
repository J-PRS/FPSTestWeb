# Agentic humanoid generation — deep dive

Research survey (2026-10-23) of every viable way to get rigged, game-ready
humanoids produced by an agent rather than a hand-modeler — ranked by fit
for this project (browser FPS, low-poly flat-shaded, brute skeleton + clips,
must run headless and cheap).

## The landscape at a glance

There are six fundamentally different routes:

1. **Authored-primitive generators (what we do)** — an agent writes a small
   DSL list of primitives + bones; a builder script meshes and skins them.
2. **Headless-DCC scripting (Blender agent loop)** — an LLM writes `bpy`
   Python; Blender `--background` executes and exports GLB.
3. **Parametric human generators** — slider-space body morphers
   (MakeHuman/MPFB, SMPL, VRoid/Hamr, MetaHuman, Character Creator).
4. **Sketch/metaball implicit modelers** — Dust3D-style: draw a node-edge
   skeleton, inflate a mesh around it, auto-rig from the same graph.
5. **AI text/image-to-3D services** — Meshy, Tripo, Rodin, Hunyuan3D;
   mesh out, auto-rig bolted on.
6. **Auto-rigging as a separable stage** — take any mesh, fit a skeleton
   to it: Pinocchio, Mixamo, AccuRIG, RigNet, HumanRig, Make-It-Animatable.
   This is not a generation method by itself but the unlock that makes
   methods 2 and 5 viable end-to-end.

---

## 1. Authored-primitive generators (current approach)

`_tools/models/build_juggernaut.mjs`: a JS list of
cone/box/ellipsoid primitives, each tagged with a bone and material;
tessellated analytically, rigid-skinned to the brute skeleton, GLB
written by re-skinning `class_brute.glb`'s nodes/clips.

**Why it's winning for us**

- Skeleton reuse is exact — no retarget, no rest-pose conversion, all
  baked clips work on day one. This is the single biggest cost in every
  other approach and we pay zero.
- The agent's artifact is a 40-line coordinate table — diffable,
  tweakable, regenerable in 200 ms, no dependencies, no GPU, no API.
- Armor-plate semantics are free: rigid binding to one bone per part is
  *correct* for hard armor (and it's how the OG SDF version went wrong —
  it skinned a continuous sheet).
- Failure modes are visible and fixable in the same file (position,
  radius, chamfer), never "the model hallucinated".

**Costs**: style ceiling is chunky-plate (great for juggernaut/dreadnought,
wrong for a lithe scout); anatomy lives in the agent's head, so proportions
need the posedump screenshot loop to catch.

**Agentic fit**: already proven — this whole loop (author → build →
`_juggshot` → critique → iterate) is the workflow.

## 2. Headless-DCC agent loops (Blender-as-tool)

The LLM writes Blender Python; `blender --background --python` executes;
GLB out. This is the most flexible agentic method — full BMesh, modifiers,
geometry nodes, shader nodes, any topology, any style.

Evidence it's real and working:

- **LL3M** (threedle/ll3m, paper) — multi-agent system: planner, retriever
  (BlenderRAG docs RAG), coder, debug/refine agents. Produces code as the
  *interpretable* asset — humans can edit the generated script. Server now
  offline (Sonnet 3.7 retired) but the pattern stands.
- **SCRIPT3D** — same idea with persistent asset metadata so each object is
  reproducible/traceable rather than a one-shot mesh.
- **balloon** (hackathon) — single prompt → Claude writes a constrained
  bpy script (primitives only, ~2 m, Y-up) → GLB into a WebXR scene. Shows
  the minimal viable loop: one tool, one constraint sheet.
- **blender-agent-studio** — Codex/Claude plugin driving local Blender:
  scaffold, screenshot from N angles, self-check renders, repair loop.
  The "agent renders its own work and critiques it" pattern — exactly our
  `_juggshot` step, generalized.
- **Hamr** — parametric anime/VRM forge built entirely as headless-Blender
  Python driven by YAML + agent commands; 2200+ tests. Proof a
  spec→bpy→rigged-avatar pipeline can be fully tested and non-interactive.
- **blender-cli** — thin JSON-in/JSON-out wrapper making Blender a
  deterministic tool boundary for an agent.

**The rigging question**: Blender scripting gets you mesh + materials but
NOT a rig that matches our brute skeleton/clips. Two ways out: (a) script
the mesh to be *worn* by our skeleton — author parts around known joint
positions, rigid/skin-transfer weights (Auto-Rig Pro, or bpy weight
transfer from a proxy); (b) export the mesh and send it through stage 6
(auto-rig), then retarget clips — expensive and lossy.

**Fit**: high ceiling, high iteration cost (Blender startup ~seconds,
still fine), needs a local Blender install (agent-driven). Best used as
the *sculptor* for hero pieces — e.g. author the dreadnought's helm shape
in bpy, export, then bind to our skeleton via method 1's GLB writer
(import mesh, skin to bones, reuse clips). A hybrid: **agent writes bpy
for silhouette → we auto-skin to brute rig** gives artistic freedom our
primitive DSL can't reach (curved surfaces, real topology).

## 3. Parametric human generators

A rigged base mesh + morph-target slider space. Agents don't write
geometry; they set parameters.

- **MakeHuman / MPFB2** — 20-year-old OSS base mesh (hm08), morph targets
  (.target files), rigify + Mixamo-ready rigs, clothes library (MHCLO),
  CC0 assets. MPFB2 runs inside Blender (scriptable; script_samples exist)
  and MakeHuman standalone exports MHX/DAE/FBX/OBJ. Output is realistic
  human topology — heavy for our style, but the *idea* transfers directly.
- **SMPL / SMPL-X** — the research-standard parametric body: mesh =
  function of shape β + pose θ. All avatar-gen research builds on it
  (DreamHuman, TADA — text → upsampled SMPL-X + displacement + texture via
  diffusion SDS). License is research-flavored; mesh is realistic human
  only.
- **MetaHuman / Character Creator / VRoid** — productized slider spaces
  with shipping-quality rigs. MetaHuman = photoreal + UE-locked;
  CC5 = 10k-poly game base + AccuRIG; VRoid = anime, VRM export.
- **Blue Sky "Universal Mesh" (SIGGRAPH '21)** — studio-scale version:
  one standardized mesh, rig placement automated from landmarks, data
  separated from assets. The ACM character-scaling pipeline (SIGGRAPH '24)
  does template→variation at <1 min per NPC.

**Fit**: the *pattern* is gold — a single shared rigged body where
"character" = parameter vector — but the instances (realistic humans)
aren't our look. If we ever want body variation (bulky vs lithe armor),
the right move is a **parametric version of our own plate builder**:
body-type sliders (bulk, height, shoulder width) scaling the primitive
table. Same result, our style, zero new deps.

## 4. Sketch/implicit modelers — Dust3D

**Dust3D** (dust3d.org, MIT, C++/Qt): draw nodes+edges on a 2D canvas →
a low-poly mesh inflates around the graph in real time; label edges with
bone names → skeleton + skin weights are *derived from the same graph*;
procedural animation for 7 rig archetypes (biped walk/run/jump/idle/hurt/
die etc.); GLB/FBX export. v1.0 shipped 2026-05.

Why it matters to us specifically: **it is our SDF idea done right.** The
juggernaut's original SDF failed because a smooth-unioned implicit surface
can't carry part identity (materials, plates, bones). Dust3D's trick is
that the graph IS the skeleton — parts are first-class, not blended into a
sheet. If we wanted the organic/welded look back, this is the correct
implicit-model architecture, and its GLB output could be re-skinned to
brute or consumed directly.

Agentic fit: it's a GUI; the headless path would be generating `.ds3`
files or replicating the node-graph→mesh step — which our plate builder
already does by tagging primitives with bones. Verdict: adopt the *idea*
(graph-as-skeleton), not the tool.

## 5. AI text/image-to-3D services

| Service | Output | Rigging | Cost | Notes |
|---|---|---|---|---|
| **Meshy** | textured mesh GLB/FBX | auto-rig humanoid+quadruped, 600+ anim presets | ~$0.30–0.60/gen | Best UX/textures; rougher geometry |
| **Tripo** | textured mesh | auto-rig + Smart LowPoly retopo | ~$0.07–0.17/gen | Cheapest game-ready path; stylized modes (voxel/LEGO/cartoon) |
| **Rodin (Hyper3D)** | clean quad topo + PBR | none (T/A-pose enforcement only) | free gen, pay on download; API $120/mo | Best geometry; rig elsewhere |
| **Hunyuan3D** | mesh | none | OSS/self-host | Tencent; decent quality free |
| **Nilo-style engines** | full pipeline (mesh→rig→weights→texture→anim hooks) | yes | platform | Same 5-stage pipeline; humanoids only, proportion edge cases |

Plus an agent layer already exists: **Muddy Terrain's UE GenAI plugin**
exposes text→3D→auto-rig→retexture→lowpoly as editor/runtime calls with
persistent task IDs — i.e., a game editor calling these services as tools.

Reality check for us: output is high-poly realistic meshes with textures —
the opposite of our flat-shaded 1.5k-tri plate style, and each gen costs
real money + network. Useful for one-off **concept generation** (produce a
reference sculpt, then hand-build a plate version — or feed its render as
the reference image we already use). Not viable as the class-body pipeline.

## 6. Auto-rigging as a separable stage

Take any static mesh → skeleton + skin weights. Chronology of capability:

- **Pinocchio (SIGGRAPH 2007, Baran & Popović)** — the classic: embed a
  template skeleton into a mesh by minimizing penalty functions over the
  discretized volume, then attach surface via heat-diffusion weights.
  <1 min on old hardware, open source (github/jingma-git). Still the
  baseline; struggles with armor/props and loose clothing.
- **Mixamo (Adobe)** — free cloud upload → skeleton + skin weights +
  huge clip library; humanoids only, stalled development, FBX-centric.
- **AccuRIG / AccuRIG 2 (Reallusion)** — free standalone Mixamo
  successor: joint placement + skin weights + finger rigging + joint
  masking (protect accessories/props from deformation!) + ActorCore
  motion previews; exports FBX/USD. Actively developed. The prop-masking
  feature directly addresses our "armor plates shouldn't deform" problem.
- **RigNet (SIGGRAPH 2020)** — learned model predicting skeleton
  topology + joint positions + weights straight from mesh; better than
  Pinocchio on animator-rig benchmarks, handles non-humanoid topology.
- **HumanRig (2024)** — 11,434 T-posed meshes dataset + mutual-attention
  net; built specifically because AI-generated meshes break GNN-based
  riggers. Coarse 2D-prior skeleton → refined 3D joints + weights.
- **Make-It-Animatable (CVPR 2025)** — current SOTA: any humanoid mesh
  OR 3D Gaussian splats, arbitrary pose → bones + blend weights + pose
  reset to canonical, <1 second, non-standard skeletons supported.

The pattern: classical methods (Pinocchio) embed a fixed template;
learned methods (RigNet→HumanRig→MIA) predict the skeleton itself and now
handle arbitrary poses/structures near-instantly. For us the payoff is
conditional: our brute rig is fixed and clips are baked to it, so an
auto-rigger only helps if we adopt a *new* skeleton — which costs a
retarget pipeline. AccuRIG's joint-masking is the one feature with direct
value if we ever import external meshes.

---

## What this means for KRIBES

Our actual constraint isn't "generate a humanoid" — it's "generate a
humanoid **on brute's skeleton, in our flat-shaded plate style, for free,
headless, diffable**". Ranked for this project:

1. **Keep + extend the primitive-plate generator** (method 1). It's the
   only approach with exact skeleton reuse and zero cost. Next step per
   method 3's lesson: turn the primitive table into a **parametric
   space** — `bulk`, `height`, `shoulderW` scale factors + part-swap
   tables — so "light/medium/heavy variants" are parameter vectors, not
   new builders. The dreadnought is already the second instance proving
   the pattern.
2. **Add a Blender-agent tier for hero pieces** (method 2) when plates
   hit their ceiling: agent writes constrained bpy (like balloon's
   constraint sheet — primitives/lathe/boolean only, ~2m, Y-up), exports
   mesh, our existing GLB writer skins it to brute bones (rigid or
   nearest-vertex weights) and keeps all clips. Blender is already the
   assumed DCC for this project; `--background` is agent-friendly.
3. **Borrow Dust3D's insight** if organic parts come back: make the
   primitive list *also* the skeleton graph (it already is — `bone`
   tags), never blend across part boundaries. Our plate rewrite already
   embodies this.
4. **Skip** text-to-3D services for production bodies (wrong style,
   wrong poly budget, per-gen cost) — but they're a fine *concept-art*
   step when a silhouette is hard to picture.
5. **Skip** standalone auto-riggers (Pinocchio/Mixamo/AccuRIG/RigNet) —
   they solve a problem we don't have (our skeleton is fixed and shared).
   Revisit only if we import third-party meshes; then AccuRIG (free,
   joint-masking for armor) is the pick.

### The agent loop that makes any of this work

Every successful system above pairs generation with **visual
self-verification**: blender-agent-studio renders its own work from N
angles and repairs; LL3M has critique agents; we have `_juggshot.ts` →
six-angle posedump → read the PNGs. That loop — author, build, orbit,
look, iterate — is the actual agentic pipeline. The generator choice
only changes what the author step writes.

## The fidelity lens: Quake-3-class bodies (≤~2k tris)

Follow-up pass — the survey above was filtered by poly budget but not
re-ranked for a hard Q3 ceiling (~1–2k tris, segmented rigid parts,
flat shading). At that fidelity the problem *changes shape*: skinning is
mostly rigid, "generation" means part assembly, and the era's own file
formats are directly relevant.

### What Quake 3 actually did (and why it matters)

Q3's MD3 player model is **three separate mesh files** — `head.md3`,
`upper.md3`, `lower.md3` — joined by animated **tag** transforms
(`tag_torso`, `tag_head`, `tag_weapon`). The split is functional, not
cosmetic: legs animate for movement while torso+head track aim, so no
cross-product of leg/torso animation frames is needed. Per the Q3 model
manual, sub-objects *within* a group are consolidated into one mesh for
efficiency — detached parts only for unique textures. Vertex animation
(per-frame baked positions, `animation.cfg` maps frame ranges to states),
~60 units tall, a few hundred tris per part.

Our pipeline is the modern equivalent: one GLB, separate rigid plate
meshes bound to joints instead of tags, baked clips instead of vertex
frames. The correspondence is exact — **rigid segmented parts on a shared
transform hierarchy is the Q3 answer**, and it's why the plate builder
"felt right" and the welded SDF sheet didn't.

### Low-poly-specific tools that exist

- **Dust3D** — covered above; confirmed workflow: draw front+side-view
  node-edge tubes (max 2 neighbours per node → every part is a tube),
  CGAL-based real-time booleans combine them, edge labels name bones,
  skeleton+weights derived from the same graph, procedural anims per
  archetype, GLB/FBX out. It is *purpose-built* for this fidelity tier —
  its whole premise is "artist can't model everything, automate the
  90%". The node≤2-neighbours constraint is the fix for our SDF failure:
  it forbids the blob topology that melted the juggernaut.
- **Rollpoly** (rollpoly.tsuyatt.com, CC0, no signup) — free low-poly
  character+prop generator: seed-based, morph targets, idle/walk clips,
  GLB/FBX/glTF/Unity export, batch download. Proof the "generate a seed →
  a character" model works at this fidelity.
- **lowpolycharacters.com** — prompt→lowpoly character, explicit triangle
  target (up to 20k), optional 37-bone rig + custom-prompted motion clips,
  GLB out. The "AI gen but low-poly-first" niche.
- **Tripo P2.0 low-poly mode** — explicit polygon control (500–50k tris /
  500–25k quads), quad-topology option, and **automatic part segmentation
  into head/torso/limbs/accessories** — literally an MD3-style split
  service — plus rig/anim bolt-on. At 500–2k tris it becomes a real
  sculpt donor rather than a high-poly nuisance.
- **MeshGenie** (beta) — text→concept grid→"inflated" low-poly mesh→auto
  rig+anim→one GLB. Same 5-stage service shape, low-poly-first.
- **Ara 3D Gen** (free/OSS, self-hostable) — MakeHuman-dataset parametric
  generator with a **batch CLI**: script hundreds of NPCs, Mixamo bone
  names, 5k–120k tri detail levels. Low end still exceeds Q3 but its
  agent-facing batch mode is the pattern our builders already match.
- **SpEx** (sprite extruder) — PNG sprite→extruded low-poly mesh with
  silhouette tracing, per-face atlas, mesh slicer into named body parts,
  marker-based rigger. Interesting for props/weapons more than bodies.

### The armor-part problem has its own literature

Rigid armor on a skinned body is a solved pattern, worth knowing since
our classes are all armor:

- **Zone→bone weight transfer** (Mystique addon; Sword Coast Legends
  pipeline): project skeleton landmarks onto the armor surface, assign
  each face/part to the nearest bone zone, weight rigidly or by
  distance-falloff, cut per zone. This is exactly our `bone` tag per
  primitive — automated for *imported* meshes.
- **Armor retargeting** (Sword Coast Legends, "Knight's New Armour"
  procedural tool): author armor on ONE body, morph/retarget it to every
  body shape — 2,000 armor parts across 10 body types without
  re-rigging. The production-proven version of "one part library, many
  bodies".
- **Q3's manual itself**: consolidate sub-objects per group, separate
  only for texture/anim reasons — same tradeoff we hit merging plate
  groups into 3 material meshes.

### Re-ranked for ≤2k tris

1. **Parametric plate builder + part catalog** — unchanged #1. Rigid
   binding is *correct* at this fidelity (armor plates shouldn't share
   weights across bones anyway), so our per-prim `bone` tag beats any
   learned skinning. Next evolution: extract parts into a shared catalog
   (helms/pauldrons/sabatons/chest plates) → a class = catalog picks +
   bulk vector. This is the Q3 head/upper/lower + skin system with better
   granularity.
2. **Dust3D-as-generator** — moves up hard at this fidelity. Two paths:
   use it as a GUI tool for concept sculpts, or adopt its data model
   (node-edge tube graph with bone labels) as a second authoring DSL —
   an agent could emit `.ds3`-style graphs for organic parts the plate
   DSL can't express, meshed by the same analytic tube code we already
   have (meshCone along edges = exactly the Dust3D tube primitive).
3. **AI low-poly tiers as concept donors** — Tripo P2.0 at 500-2k tris
   with part segmentation, or lowpolycharacters.com, for *silhouette
   ideation*; still not the production pipeline (per-gen cost, foreign
   rig, style lottery).
4. **Zone-based auto-weighting** — the one importable algorithm:
   "assign each part to its nearest bone zone" is a 20-line function if
   we ever take an external mesh (Tripo sculpt, Blender-authored piece)
   and need it on brute's rig. Rigid per-part binding, not learned
   weights.
5. **Everything else stays out** — learned skinning (RigNet/MIA),
   parametric realistic bodies (SMPL/MPFB high end), and high-poly AI
   services all optimize for continuous-skin deformation that this
   fidelity neither needs nor can afford.

## Sources

- Pinocchio: dl.acm.org/doi/10.1145/1276377.1276467 · github/jingma-git/Pinocchio
- RigNet: zhan-xu.github.io/rig-net · HumanRig: c8241998.github.io/HumanRig
- Make-It-Animatable: CVPR 2025, jasongzy.github.io/Make-It-Animatable
- LL3M: github.com/threedle/ll3m · SCRIPT3D: github.com/llada60/SCRIPT3D
- blender-agent-studio: github.com/ifBars/blender-agent-studio
- balloon: github.com/alanmaizon/balloon · Hamr: github.com/hrabanazviking/Hamr
- MPFB2: github.com/makehumancommunity/mpfb2 · Dust3D: dust3d.org / github.com/huxingyi/dust3d
- AccuRIG: reallusion.com/auto-rig/accurig · Meshy: meshy.ai · Tripo: tripo3d.ai · Rodin: hyper3d.ai
- SMPL lineage: TADA (arxiv 2308.10899), DreamHuman (arxiv 2306.09329)
- Template pipelines: ACM 3641233.3664339 (infinite NPCs <1min), Blue Sky universal mesh 3450623.3464658
- Q3/MD3: icculus.org gtkradiant Model Manual · clover.moe mm3d MD3 notes · castle-engine.io/md3
- Low-poly tools: Rollpoly rollpoly.tsuyatt.com · lowpolycharacters.com · Tripo P2.0 low-poly (tripo3d.ai) · MeshGenie meshgenie.com · Ara 3D Gen ara3dgen.com · SpEx github.com/surfer8137/SpEx
- Armor pipelines: Mystique github.com/SavageMunk/Mystique · Sword Coast Legends armor retargeting (smallsketch.com) · Modular Armor Baker (Unity Asset Store) · "Knight's New Armour" (doi 10.13140/rg.2.2.22676.36482)
