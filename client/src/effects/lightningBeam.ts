import * as THREE from 'three';
import { buildBeam } from './beamBuild.js';
import { SEGS, SPARKS, makeGlowTexture } from './beamShared.js';
// Re-exported for callers that referenced them on LightningBeam / lightningBeam.
export { SEGS, SPARKS, makeGlowTexture };

// Quake-style lightning gun beam — juicy version.
// Lines are 1px forever, so the beam is TWO camera-facing triangle-strip
// ribbons (thin white core inside a wide blue corona) with a re-rolled
// midpoint jag every ~35ms. On top: an additive hit-glow sprite + a
// particle fountain boiling continuously at the contact point — the
// "damage is being dealt HERE" read that actually sells the beam.
const JITTER_TIME = 0.03;
const FADE_TIME = 0.09;
const JAG = 0.45;            // sideways jag amplitude
const CORE_W = 0.07;
const GLOW_W = 0.3;

// SPARKS moved to beamShared.ts
const SPARK_LIFE = 0.28;
const SPARK_SPEED = 7;

const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _segDir = new THREE.Vector3();
const _bendDir = new THREE.Vector3();

// Perpendicular basis for a direction — picks the world axis LEAST aligned
// with dir so the cross product can't degenerate (vertical beams included).
function perpBasis(dir: THREE.Vector3, side: THREE.Vector3, up: THREE.Vector3): void {
  up.set(0, 1, 0);
  if (Math.abs(dir.y) > Math.abs(dir.x) && Math.abs(dir.y) > Math.abs(dir.z)) {up.set(1, 0, 0);}
  side.crossVectors(dir, up).normalize();
  up.crossVectors(side, dir).normalize();
}

export class LightningBeam {
  readonly group = new THREE.Group();
  core!: THREE.Mesh;
  glow!: THREE.Mesh;
  arc!: THREE.Mesh;      // damage sub-beam — wilder jag, only while the tip bites
  arcPts!: THREE.Vector3[];
  chainCore!: THREE.Mesh;  // hop bolt: first target → chained enemy
  chainPts!: THREE.Vector3[];
  private chainFrom = new THREE.Vector3();
  private chainTo = new THREE.Vector3();
  private chainLive = false;
  // Contact FX sit OFF the hit surface — pulled toward the camera along
  // the view vector so the additive glow sprite never half-buries in a
  // slope (the decal-normal-offset trick, with the viewer ray as the
  // normal — always correct for the shooter, zero trace plumbing).
  private hitFx = new THREE.Vector3();
  hitGlow!: THREE.Sprite;
  sparkPoints!: THREE.Points;
  sparkPos!: Float32Array;
  sparkVel!: Float32Array;
  sparkAge!: Float32Array;
  beamPts!: THREE.Vector3[]; // last rolled skeleton (core + glow share it)
  // Lateral jag factors rolled at the 30ms cadence — re-applied onto the
  // CURRENT muzzle→tip line every frame, so the whole bolt follows a fast
  // sweep rigidly instead of kinking the last segment onto the new tip.
  private jagSide = new Float32Array(SEGS + 1);
  private jagUp = new Float32Array(SEGS + 1);
  private arcJagSide = new Float32Array(SEGS + 1);
  private arcJagUp = new Float32Array(SEGS + 1);
  private chainJagSide = new Float32Array(SEGS + 1);
  private chainJagUp = new Float32Array(SEGS + 1);
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();
  private bend = new THREE.Vector3();  // terrain-bounce corner (hasBend)
  private hasBend = false;
  private camPos = new THREE.Vector3();
  private jagT = 0;
  private fade = 0;
  /** 0..1 banked pop charge on the current victim — thickens the bolt and
   *  overclocks the spark fountain as the bomb loads. */
  private charge = 0;
  /** 1 while the tip is on a damageable thing — drives the arc sub-beam
   *  and the core swell, the "this is HURTING them" read. */
  private contact = 0;
  /** Per-instance violence knobs — a one-shot discharge (shocklance) wants
   *  fat wild strands and a longer burn; the LG keeps the defaults. */
  girth = 1;
  jagMul = 1;
  fadeTime = FADE_TIME;

  constructor(scene: THREE.Scene, tint?: { glow: number; core: number; chain: number; hit: number; sparkTop: number }) {
    buildBeam(this, scene, tint);
  }

  // makeGlowTexture moved to beamShared.ts.
  /** Every frame while held. from = muzzle, to = tip, camPos for
   *  billboarding, hasContact = the tip actually landed on something —
   *  the glow sprite + spark fountain are CONTACT VFX and must not float
   *  at the end of a max-range air shot. */
  fire(from: THREE.Vector3, to: THREE.Vector3, camPos: THREE.Vector3, hasContact = true, damaging = false, bend?: THREE.Vector3 | null): void {
    this.from.copy(from);
    this.to.copy(to);
    this.camPos.copy(camPos);
    this.hasBend = bend != null;
    if (bend) {this.bend.copy(bend);}
    // Revive from hidden: update() early-returns while faded, so jagT
    // froze mid-clock and the skeleton still holds the PREVIOUS shot's
    // curve — endpoints weld to the new shot but the interior arcs
    // through the old contact. Force a re-roll on THIS revive only;
    // continuous fire keeps the 30ms throttle.
    if (this.fade <= 0) { this.jagT = 0; }
    this.fade = 1;
    this.group.visible = true;
    _dir.copy(camPos).sub(to).normalize();
    this.hitFx.copy(to).addScaledVector(_dir, 0.22);
    this.hitGlow.position.copy(this.hitFx);
    this.hitGlow.visible = hasContact;
    this.sparkPoints.visible = hasContact;
    this.contact = damaging ? 1 : 0; // re-armed each frame the tip bites
    // fire() runs AFTER update() in the frame (updateBeamVisual is post-
    // viewModel) — rebuild here too or the rendered skeleton is one frame
    // stale at BOTH ends: the fast-flick "beam detaches from gun AND
    // crosshair" artifact.
    this.buildSkeleton(this.contact);
  }

  get visible(): boolean { return this.group.visible; }

  /** Post-release fade weld — endpoints keep riding the gun + live trace
   *  while the bolt fades, so it shrinks in place instead of freezing
   *  mid-air for 90ms while the camera moves on. */
  weld(from: THREE.Vector3, to: THREE.Vector3, camPos: THREE.Vector3, bend?: THREE.Vector3 | null): void {
    this.from.copy(from);
    this.to.copy(to);
    this.camPos.copy(camPos);
    this.hasBend = bend != null;
    if (bend) {this.bend.copy(bend);}
    _dir.copy(camPos).sub(to);
    if (_dir.lengthSq() > 0.0001) {this.hitFx.copy(to).addScaledVector(_dir.normalize(), 0.22);}
    this.hitGlow.position.copy(this.hitFx);
    // Same frame-order fix as fire(): update() already ran this frame —
    // rebuild now or the fading bolt renders one frame stale at both ends.
    this.buildSkeleton(this.contact);
  }

  /** Optional second hop: beam forks from the hit enemy to a chained one. */
  fireChain(from: THREE.Vector3, to: THREE.Vector3): void {
    this.chainFrom.copy(from);
    this.chainTo.copy(to);
    this.chainLive = true;
    this.chainCore.visible = true;
  }

  /** Banked charge level of the struck victim, 0..1. */
  setCharge(c: number): void { this.charge = Math.min(Math.max(c, 0), 1); }

  /** No fork this frame — hide the hop ribbon until the next fireChain. */
  clearChain(): void {
    this.chainLive = false;
    this.chainCore.visible = false;
  }

  update(dt: number): void {
    if (this.fade <= 0) { this.group.visible = false; this.chainLive = false; return; }
    this.fade = Math.max(0, this.fade - dt / this.fadeTime);
    const f = this.fade;
    const c = this.charge;
    const k = this.contact;
    (this.core.material as THREE.MeshBasicMaterial).opacity = 0.95 * f;
    (this.glow.material as THREE.MeshBasicMaterial).opacity = (0.35 + c * 0.4) * f;
    (this.arc.material as THREE.MeshBasicMaterial).opacity = 0.9 * f;
    this.arc.visible = k > 0;
    (this.hitGlow.material as THREE.SpriteMaterial).opacity = 0.9 * f;
    (this.sparkPoints.material as THREE.PointsMaterial).opacity = 0.9 * f;
    (this.chainCore.material as THREE.MeshBasicMaterial).opacity = 0.7 * f;
    if (this.fade <= 0) { this.group.visible = false; this.chainLive = false; return; }

    // Re-roll the jag OFFSETS at the flicker cadence — positions are
    // rebuilt every frame so the skeleton never lags a fast sweep.
    this.jagT -= dt;
    if (this.jagT <= 0) {
      this.jagT = JITTER_TIME;
      for (let i = 0; i <= SEGS; i += 1) {
        this.jagSide[i] = Math.random() - 0.5;
        this.jagUp[i] = Math.random() - 0.5;
        this.arcJagSide[i] = Math.random() - 0.5;
        this.arcJagUp[i] = Math.random() - 0.5;
        this.chainJagSide[i] = Math.random() - 0.5;
        this.chainJagUp[i] = Math.random() - 0.5;
      }
    }
    this.buildSkeleton(k);

    // Hit glow throbs
    const pulse = (1.9 + Math.sin(performance.now() * 0.04) * 0.5) * (1 + k * 0.35);
    this.hitGlow.scale.setScalar(pulse * f);

    // Spark fountain: integrate + respawn dead sparks at the contact
    for (let i = 0; i < SPARKS; i += 1) {
      this.sparkAge[i]! -= dt;
      // Respawn only while the trigger is held (fade===1 means a fire()
      // landed this frame; <1 is the post-release decay) — otherwise the
      // fountain keeps feeding itself at the STALE point through the fade,
      // visible as sparks still spawning at the old hit spot.
      if (this.sparkAge[i]! <= 0 && this.fade >= 1 && this.sparkPoints.visible) {
        // Respawn: burst outward from the hit point + slight gravity bounce;
        // charged victims boil faster and fling harder.
        this.sparkAge[i] = SPARK_LIFE * (0.5 + Math.random() * 0.5) * (1 + c * 0.6);
        this.sparkPos[i * 3] = this.hitFx.x; this.sparkPos[i * 3 + 1] = this.hitFx.y; this.sparkPos[i * 3 + 2] = this.hitFx.z;
        const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2;
        const s = SPARK_SPEED * (0.4 + Math.random() * 0.6) * (1 + c * 1.2);
        this.sparkVel[i * 3] = Math.cos(a) * Math.cos(e) * s;
        this.sparkVel[i * 3 + 1] = Math.abs(Math.sin(e)) * s * 0.7 + 2; // biased up
        this.sparkVel[i * 3 + 2] = Math.sin(a) * Math.cos(e) * s;
      } else {
        this.sparkVel[i * 3 + 1] -= 14 * dt;
        this.sparkPos[i * 3] += this.sparkVel[i * 3]! * dt;
        this.sparkPos[i * 3 + 1] += this.sparkVel[i * 3 + 1]! * dt;
        this.sparkPos[i * 3 + 2] += this.sparkVel[i * 3 + 2]! * dt;
      }
    }
    (this.sparkPoints.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  // Rebuild skeleton + ribbons on CURRENT endpoints — a frozen interior
  // plus a welded tip was the "last segment detaches" artifact; rolling
  // only the offsets keeps the 30ms flicker while the bolt stays welded.
  private buildSkeleton(k: number): void {
    const c = this.charge;
    _dir.copy(this.to).sub(this.from); // straight-line delta (also the basis)
    // Bounced bolt: skeleton rides the two-leg polyline from→bend→to.
    // Leg vectors stay RAW deltas — params t·legLen fraction-of-leg.
    let bendT = 0;
    const legB = _bendDir.copy(this.to).sub(this.bend); // raw delta when bent
    const useBend = this.hasBend && legB.lengthSq() > 0.002;
    const len = useBend ? this.bend.distanceTo(this.from) + legB.length() : _dir.length();
    if (useBend) {bendT = this.bend.distanceTo(this.from) / len;}
    // Degenerate (point-blank) beam: any basis works, just don't NaN
    if (len < 0.05) { _side.set(1, 0, 0); _up.set(0, 1, 0); }
    else {perpBasis(_dir, _side, _up);}
    const jagAmp = JAG * this.jagMul * Math.min(1, len / 30);
    const pointAt = (t: number, p: THREE.Vector3): THREE.Vector3 => {
      if (useBend && t > bendT) {return p.copy(this.bend).addScaledVector(legB, (t - bendT) / (1 - bendT));}
      if (useBend) {return p.copy(this.from).addScaledVector(_segDir.copy(this.bend).sub(this.from), t / bendT);}
      return p.copy(this.from).addScaledVector(_dir, t);
    };
    for (let i = 0; i <= SEGS; i += 1) {
      const t = i / SEGS;
      const amp = Math.sin(t * Math.PI) * jagAmp;
      pointAt(t, this.beamPts[i]!)
        .addScaledVector(_side, this.jagSide[i]! * amp)
        .addScaledVector(_up, this.jagUp[i]! * amp);
    }
    this.writeRibbon(this.core, CORE_W * this.girth * (1 + c * 1.6 + k * 0.8));
    this.writeRibbon(this.glow, GLOW_W * this.girth * (1 + c * 1.4));
    // Damage arc: same shaft, nearly double the jag — it reads as the
    // bolt tearing INTO the contact, not just reaching it
    if (k > 0) {
      for (let i = 0; i <= SEGS; i += 1) {
        const t = i / SEGS;
        const amp = Math.sin(t * Math.PI) * jagAmp * 1.9;
        pointAt(t, this.arcPts[i]!)
          .addScaledVector(_side, this.arcJagSide[i]! * amp)
          .addScaledVector(_up, this.arcJagUp[i]! * amp);
      }
      this.writeRibbonPts(this.arc, this.arcPts, CORE_W * 1.3);
    }
    // Chain hop — tighter jag, it's a short fork
    if (this.chainLive) {
      _segDir.copy(this.chainTo).sub(this.chainFrom);
      perpBasis(_segDir, _side, _up);
      for (let i = 0; i <= SEGS; i += 1) {
        const t = i / SEGS;
        const amp = Math.sin(t * Math.PI) * JAG * 0.6;
        this.chainPts[i]!.copy(this.chainFrom).addScaledVector(_segDir, t)
          .addScaledVector(_side, this.chainJagSide[i]! * amp)
          .addScaledVector(_up, this.chainJagUp[i]! * amp);
      }
      this.writeRibbonPts(this.chainCore, this.chainPts, CORE_W * 0.9);
    }
  }

  // Fixed-basis crossed ribbons: offsets along the beam's own side/up axes.
  // NOT camera-facing — the X cross-section supplies volume, so the bolt
  // has real thickness from every angle and never fans out at the camera.
  // Width TAPER toward the camera: world-constant width is a giant white
  // wall when the first segment sits ~0.5m from the near plane. Scaling by
  // camera distance keeps it a thin bolt at the muzzle, full-width far out.
  private writeRibbon(mesh: THREE.Mesh, halfW: number): void {
    this.writeRibbonPts(mesh, this.beamPts, halfW);
  }
  private writeRibbonPts(mesh: THREE.Mesh, pts: THREE.Vector3[], halfW: number): void {
    const verts = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    // Short-beam tail taper: below ~6m the bolt is a stub and the fat
    // termination reads wider than the muzzle - pinch the tail toward a
    // point. Past ~6m the full width applies (normal usage unchanged).
    const beamLen = pts[SEGS]!.distanceTo(pts[0]!);
    const tail = Math.min(1, beamLen / 6);
    for (let i = 0; i <= SEGS; i += 1) {
      const p = pts[i]!;
      const dCam = (
        (p.x - this.camPos.x) ** 2 + (p.y - this.camPos.y) ** 2 + (p.z - this.camPos.z) ** 2
      ) ** 0.5;
      const t = i / SEGS;
      const w = halfW * Math.min(1, Math.max(0.45, dCam / 2)) * (0.15 + 0.85 * Math.min(1, tail + (1 - tail) * Math.max(0, 1 - t * 1.6)));
      const prev = pts[Math.max(0, i - 1)]!;
      const next = pts[Math.min(SEGS, i + 1)]!;
      _segDir.copy(next).sub(prev).normalize();
      // Stable side/up from the segment dir (never degenerate)
      _side.set(-_segDir.z, 0, _segDir.x);
      if (_side.lengthSq() < 0.01) {_side.set(1, 0, 0);}
      _side.normalize();
      _up.crossVectors(_segDir, _side).normalize();
      // Strip A: ±side
      verts.setXYZ(i * 4, p.x + _side.x * w, p.y + _side.y * w, p.z + _side.z * w);
      verts.setXYZ(i * 4 + 1, p.x - _side.x * w, p.y - _side.y * w, p.z - _side.z * w);
      // Strip B: ±up (the cross)
      verts.setXYZ(i * 4 + 2, p.x + _up.x * w, p.y + _up.y * w, p.z + _up.z * w);
      verts.setXYZ(i * 4 + 3, p.x - _up.x * w, p.y - _up.y * w, p.z - _up.z * w);
    }
    verts.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of [this.core, this.glow, this.arc, this.chainCore]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    (this.hitGlow.material as THREE.Material).dispose();
    this.sparkPoints.geometry.dispose();
    (this.sparkPoints.material as THREE.Material).dispose();
  }
}
