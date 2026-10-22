# Animation blending — research + concrete plan for remotes/bots

Context: `PlayerModel` currently plays one clip at a time via `playAnimation`
(switch-and-fade). Remote players look passable on the mannequin rig, but the
real Tribes-style reads (aim pitch while skiing, flinch without losing stride,
smooth speed transitions) need layering, not switching.

## Techniques worth using (all native three.js, no new deps)

### 1. Track-name masking = free bone masks (Unity AvatarMask equivalent)

`AnimationClip.tracks` are just `NodeName.property` strings — filtering them by
bone name produces a partial-body clip:

```ts
const legsOnly = new THREE.AnimationClip(clip.name + '.legs', clip.duration,
  clip.tracks.filter(t => /thigh|shin|foot|toe|hips/.test(t.name)));
const armsOnly = new THREE.AnimationClip(clip.name + '.arms', clip.duration,
  clip.tracks.filter(t => /shoulder|upper_arm|forearm|hand|spine|neck|head/.test(t.name)));
```

This is the single highest-value trick for us:

- **`Pistol_Aim_Up/Neutral/Down` as an arm+spine layer over any locomotion.**
  Remote fires while sprinting/skiing and the aim reads — the exact "small
  target tracking" signal we're missing. ~30 lines: build masked variants of
  the three aim clips once at load, drive `setEffectiveWeight` + pick by
  `pitch` each frame, on top of whatever locomotion clip is playing.
- The mannequin's DEF-* names make the filter trivial (`defthigh|defshin|…`
  vs `defupper_arm|defforearm|defhand|defspine003|defneck|defhead`).

### 2. 1D speed blend (barycentric anchors)

Discrete `walk`/`run` switches pop. The standard fix: anchor clips on a speed
axis, pick the two nearest anchors, distribute weight linearly:

```
speed 0 ─ Idle_Loop; speed ~3 ─ Walk_Loop; ~6 ─ Jog_Fwd_Loop; ~9+ ─ Sprint_Loop
weight(v) per anchor, sum=1, everything else gets weight 0.
```

Each frame: `action.setEffectiveWeight(w)` + `action.play()` if w>0.
~35 lines, no library needed (`animouse` does this but our axis set is small).

**Foot-skate caveat**: when blending locomotion, match stride rate —
`action.timeScale = speed / clipStrideSpeed`, or call
`action.syncWith(previous)` during transitions so feet don't scissor.
`crossFadeTo(next, dur, warp=true)` warps timeScale automatically — the built-
in "keep foot phase" flag we should be using instead of plain fadeIn/fadeOut.

### 3. Additive clips for reactions (makeClipAdditive)

`THREE.AnimationUtils.makeClipAdditive(clip, 0, referenceClip)` converts a clip
to "delta from a reference pose", so it *rides on top* of the current base
action instead of replacing it. Use cases:

- `Hit_Chest`/`Hit_Head` as additive flinches — the runner keeps running.
- A procedural recoil kick as an additive layer (replaces the fake
  `shootT` codepath).

**Gotchas found in the forums**: call `makeClipAdditive` on the CLIP (don't
flip `action.blendMode`), and pass an explicit `referenceClip` (e.g.
`Idle_Loop`) — the default reference is the clip's own frame 0, which for
hit reactions mid-pose is wrong.

### 4. One-shot hygiene

`LoopOnce` + `clampWhenFinished = true` freezes the last frame instead of
releasing to bind pose — fixes the gap I flagged earlier between a one-shot
ending and the caller's state revert. Then listen for the mixer's `finished`
event to hand control back cleanly.

## What to skip

- Full blend-tree libs (`animouse`, `anima`) — our action set is ~8 states;
  a bespoke 100-line controller is easier to tune and has no dep cost.
- 2D strafe blends — worth doing later (UAL ships strafe clips), but remote
  strafing is rare vs. the aim-layer win.
- CCD IK for the aim layer — masked clips already do 90% of it.

## Suggested order

1. Aim layer via masked `Pistol_Aim_*` clips over locomotion (biggest read win)
2. `clampWhenFinished` + `finished`-event handoff for one-shots (kills the
   bind-pose flicker)
3. `warp=true` crossfades between locomotion states (kills foot pops)
4. 1D speed blend idle↔walk↔jog↔sprint on remote vel.xz (kills state pops)

## Second pass — perf scaling + net-sync findings

### Animation LOD / mixer throttling

Bones hold their last-written local transforms when `mixer.update()` is
skipped — the pose freezes, it doesn't break (skinning follows the bone
matrices, not the mixer). So distance-based throttle is safe:

- Near remotes (<30m): mixer every frame.
- Mid (30–80m): accumulate dt, update every 2–3 frames (~20–30Hz).
- Far (>80m or offscreen): every 4–8 frames, or skip entirely — at that range
  the character is a few px and the interpolation of the entity itself
  dominates. Used by Roblox/Nintendo per the forums.

Big caveat from three.js issue #25518: **the mixer caches interpolant values
and skips writes when a track's evaluated value hasn't changed.** Two
consequences for us:

- A held/paused single-frame pose writes once then stops owning the bone —
  external mutation is safe there, BUT if we externally mutate a bone the
  mixer *does* own, our write is silently overwritten next update. Order
  matters: mixer.update() first, then procedural writes (foot snap, aim
  pitch) — which is what we do. Keep it that way.
- Never call `skeleton.pose()` to "reset" mid-clip — untracked bones won't
  be rewritten and the model stays reset.

### Action binding trimming (LOD without extra mixers)

From the `instanced-mesh` examples: `action._propertyBindings` /
`action._interpolants` arrays can be filtered post-`clipAction()` to drop
low-value bones for distant LODs (fingers, pole targets, toes). One mixer,
one action — you just point it at a shorter binding list. For us: finger and
pole tracks are ~30% of UAL track count and invisible past 10m. Cheap win if
remote count climbs.

### Skeleton sharing (if bot counts grow)

DolphinIQ's pattern: one mixer + one skeleton per *animation state*, shared
by all skinned meshes in that state (bind each mesh to the shared skeleton).
N characters in "Sprint_Loop" cost 1 mixer update + N bone-texture uploads.
Only worth it at 50+ same-state characters — we're at <16 remotes today, so
mixer throttling alone covers us.

### Render-accurate vs tick-accurate (Photon/Unity nomenclature)

Industry consensus for non-lag-compensated shooters: **render-accurate** —
derive anim state client-side from replicated movement data (vel, grounded,
pitch), never sync animation state itself. That's what we already do; the
docs confirm it's the recommended default and tick-accurate poses are only
needed for lag-compensated limb hitboxes (we don't have those — hit detection
is capsule-based).

Two refinements from that research:

- **Derive from the interpolated velocity, not the raw snapshot vel** — a
  remote's anim input should come from the smoothed position deltas we
  already compute, else anim state flickers on packet jitter.
- **Send only intent bits** — our existing ski/jet flag bits in the tick
  byte are exactly right. Resist adding anim-state fields to the wire.

### Miscellaneous mechanics worth stealing

- `mixer.setTime(t)` scrubs the whole graph — used by instanced rendering to
  phase-offset shared clips; could give bots varied gait phases for free.
- `action.getMixer().addEventListener('loop', ...)` — footstep/dust triggers
  on gait loop boundaries instead of distance heuristics.
- Idle-phase desync: set `action.time = Math.random() * clip.duration` when
  spawning a remote so N idling mannequins don't animate in lockstep —
  instantly reads as "alive" instead of "cloned".
