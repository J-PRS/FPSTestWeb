import * as THREE from 'three';

// Quake-style lightning gun beam — juicy version.
// Lines are 1px forever, so the beam is TWO camera-facing triangle-strip
// ribbons (thin white core inside a wide blue corona) with a re-rolled
// midpoint jag every ~35ms. On top: an additive hit-glow sprite + a
// particle fountain boiling continuously at the contact point — the
// "damage is being dealt HERE" read that actually sells the beam.
const SEGS = 16;
const JITTER_TIME = 0.03;
const FADE_TIME = 0.09;
const JAG = 0.45;            // sideways jag amplitude
const CORE_W = 0.07;
const GLOW_W = 0.3;

const SPARKS = 26;           // hitpoint fountain particles
const SPARK_LIFE = 0.28;
const SPARK_SPEED = 7;

const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _p = new THREE.Vector3();
const _segDir = new THREE.Vector3();

// Perpendicular basis for a direction — picks the world axis LEAST aligned
// with dir so the cross product can't degenerate (vertical beams included).
function perpBasis(dir: THREE.Vector3, side: THREE.Vector3, up: THREE.Vector3): void {
  up.set(0, 1, 0);
  if (Math.abs(dir.y) > Math.abs(dir.x) && Math.abs(dir.y) > Math.abs(dir.z)) up.set(1, 0, 0);
  side.crossVectors(dir, up).normalize();
  up.crossVectors(side, dir).normalize();
}

export class LightningBeam {
  readonly group = new THREE.Group();
  private core: THREE.Mesh;
  private glow: THREE.Mesh;
  private chainCore: THREE.Mesh;  // hop bolt: first target → chained enemy
  private chainPts: THREE.Vector3[];
  private chainFrom = new THREE.Vector3();
  private chainTo = new THREE.Vector3();
  private chainLive = false;
  private hitGlow: THREE.Sprite;
  private sparkPoints: THREE.Points;
  private sparkPos: Float32Array;
  private sparkVel: Float32Array;
  private sparkAge: Float32Array;
  private beamPts: THREE.Vector3[]; // last rolled skeleton (core + glow share it)
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private jagT = 0;
  private fade = 0;

  constructor(scene: THREE.Scene) {
    this.beamPts = Array.from({ length: SEGS + 1 }, () => new THREE.Vector3());

    // Two crossed ribbons in ONE geometry (X cross-section) — volumetric
    // from every angle, and it can't degenerate into a screen-filling fan
    // when the beam points at/away from the camera like a billboard does.
    const mkRibbon = (color: number, opacity: number) => {
      const geo = new THREE.BufferGeometry();
      const verts = new Float32Array((SEGS + 1) * 4 * 3); // 4 verts/segment: 2 strips
      const idx: number[] = [];
      for (let i = 0; i < SEGS; i++) {
        const a = i * 4;
        idx.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
        idx.push(a + 2, a + 3, a + 6, a + 3, a + 7, a + 6);
      }
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity,
        blending: THREE.AdditiveBlending, depthWrite: false,
        // depthTest off — the bolt must read over terrain/props; it lives
        // half inside the viewmodel space visually and z-fighting it into
        // hills made it clip under geometry near the muzzle.
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 900; // after opaque + shadows, before late overlays
      // Vertices are rewritten every jag — the static bounding sphere is
      // meaningless (sits at origin) and would cull the beam for half of
      // all view directions. Never frustum-cull ribbon meshes.
      m.frustumCulled = false;
      return m;
    };

    this.glow = mkRibbon(0x2266ff, 0.35);
    this.core = mkRibbon(0xeaf6ff, 0.95);
    // Chain hop: same ribbon machinery, slightly dimmer — it reads as a
    // fork off the main bolt
    this.chainCore = mkRibbon(0x9fd4ff, 0.7);
    this.chainCore.visible = false;
    this.chainPts = Array.from({ length: SEGS + 1 }, () => new THREE.Vector3());
    this.group.add(this.glow, this.core, this.chainCore);

    // Contact glow — bright ball pinned at the hit point
    const glowTex = LightningBeam.makeGlowTexture();
    this.hitGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xaaddff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.hitGlow.scale.setScalar(2.2);
    this.group.add(this.hitGlow);

    // Spark fountain — plain Points, respawned at the contact while firing
    this.sparkPos = new Float32Array(SPARKS * 3);
    this.sparkVel = new Float32Array(SPARKS * 3);
    this.sparkAge = new Float32Array(SPARKS);
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    // Per-spark color jitter — white core to deep blue edge, no two alike
    const sCol = new Float32Array(SPARKS * 3);
    for (let i = 0; i < SPARKS; i++) {
      const t = Math.random();
      sCol[i * 3] = 0.55 + t * 0.45;
      sCol[i * 3 + 1] = 0.75 + t * 0.25;
      sCol[i * 3 + 2] = 1.0;
    }
    sGeo.setAttribute('color', new THREE.BufferAttribute(sCol, 3));
    this.sparkPoints = new THREE.Points(sGeo, new THREE.PointsMaterial({
      map: glowTex,           // soft radial blob — kills the square-quad look
      vertexColors: true,
      size: 0.55, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this.sparkPoints.frustumCulled = false;
    this.group.add(this.sparkPoints);

    this.group.visible = false;
    scene.add(this.group);
  }

  private static _glowTex: THREE.Texture | null = null;
  private static makeGlowTexture(): THREE.Texture {
    if (this._glowTex) return this._glowTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(180,230,255,0.8)');
    g.addColorStop(1, 'rgba(60,140,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this._glowTex = new THREE.CanvasTexture(c);
    return this._glowTex;
  }

  /** Every frame while held. from = muzzle, to = tip, camPos for
   *  billboarding, hasContact = the tip actually landed on something —
   *  the glow sprite + spark fountain are CONTACT VFX and must not float
   *  at the end of a max-range air shot. */
  fire(from: THREE.Vector3, to: THREE.Vector3, camPos: THREE.Vector3, hasContact = true): void {
    this.from.copy(from);
    this.to.copy(to);
    this.camPos.copy(camPos);
    this.fade = 1;
    this.group.visible = true;
    this.hitGlow.position.copy(to);
    this.hitGlow.visible = hasContact;
    this.sparkPoints.visible = hasContact;
  }

  /** Optional second hop: beam forks from the hit enemy to a chained one. */
  fireChain(from: THREE.Vector3, to: THREE.Vector3): void {
    this.chainFrom.copy(from);
    this.chainTo.copy(to);
    this.chainLive = true;
    this.chainCore.visible = true;
  }

  /** No fork this frame — hide the hop ribbon until the next fireChain. */
  clearChain(): void {
    this.chainLive = false;
    this.chainCore.visible = false;
  }

  update(dt: number): void {
    if (this.fade <= 0) { this.group.visible = false; this.chainLive = false; return; }
    this.fade = Math.max(0, this.fade - dt / FADE_TIME);
    const f = this.fade;
    (this.core.material as THREE.MeshBasicMaterial).opacity = 0.95 * f;
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.35 * f;
    (this.hitGlow.material as THREE.SpriteMaterial).opacity = 0.9 * f;
    (this.sparkPoints.material as THREE.PointsMaterial).opacity = 0.9 * f;
    (this.chainCore.material as THREE.MeshBasicMaterial).opacity = 0.7 * f;
    if (this.fade <= 0) { this.group.visible = false; this.chainLive = false; return; }

    // Re-roll the jag skeleton
    this.jagT -= dt;
    if (this.jagT <= 0) {
      this.jagT = JITTER_TIME;
      _dir.copy(this.to).sub(this.from);
      const len = _dir.length();
      // Degenerate (point-blank) beam: any basis works, just don't NaN
      if (len < 0.05) { _side.set(1, 0, 0); _up.set(0, 1, 0); }
      else perpBasis(_dir, _side, _up);
      for (let i = 0; i <= SEGS; i++) {
        const t = i / SEGS;
        const amp = Math.sin(t * Math.PI) * JAG * Math.min(1, len / 30);
        this.beamPts[i]!.copy(this.from).addScaledVector(_dir, t)
          .addScaledVector(_side, (Math.random() - 0.5) * amp)
          .addScaledVector(_up, (Math.random() - 0.5) * amp);
      }
      this.writeRibbon(this.core, CORE_W);
      this.writeRibbon(this.glow, GLOW_W);
      // Roll the chain hop too — tighter jag, it's a short fork
      if (this.chainLive) {
        _dir.copy(this.chainTo).sub(this.chainFrom);
        perpBasis(_dir, _side, _up);
        for (let i = 0; i <= SEGS; i++) {
          const t = i / SEGS;
          const amp = Math.sin(t * Math.PI) * JAG * 0.6;
          this.chainPts[i]!.copy(this.chainFrom).addScaledVector(_dir, t)
            .addScaledVector(_side, (Math.random() - 0.5) * amp)
            .addScaledVector(_up, (Math.random() - 0.5) * amp);
        }
        this.writeRibbonPts(this.chainCore, this.chainPts, CORE_W * 0.9);
      }
    }

    // Endpoints ride the CURRENT from/to every frame — the jag pattern may
    // throttle to 30ms but the weld can't: a stale segment-0 endpoint is
    // exactly the "beam detaches on fast turns" artifact.
    this.beamPts[0]!.copy(this.from);
    this.beamPts[SEGS]!.copy(this.to);
    this.writeRibbon(this.core, CORE_W);
    this.writeRibbon(this.glow, GLOW_W);

    // Hit glow throbs
    const pulse = 1.9 + Math.sin(performance.now() * 0.04) * 0.5;
    this.hitGlow.scale.setScalar(pulse * f);

    // Spark fountain: integrate + respawn dead sparks at the contact
    for (let i = 0; i < SPARKS; i++) {
      this.sparkAge[i]! -= dt;
      if (this.sparkAge[i]! <= 0) {
        // Respawn: burst outward from the hit point + slight gravity bounce
        this.sparkAge[i] = SPARK_LIFE * (0.5 + Math.random() * 0.5);
        this.sparkPos[i * 3] = this.to.x; this.sparkPos[i * 3 + 1] = this.to.y; this.sparkPos[i * 3 + 2] = this.to.z;
        const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2;
        const s = SPARK_SPEED * (0.4 + Math.random() * 0.6);
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
    for (let i = 0; i <= SEGS; i++) {
      const p = pts[i]!;
      const dCam = Math.sqrt(
        (p.x - this.camPos.x) ** 2 + (p.y - this.camPos.y) ** 2 + (p.z - this.camPos.z) ** 2,
      );
      const w = halfW * Math.min(1, Math.max(0.45, dCam / 2.0));
      const prev = pts[Math.max(0, i - 1)]!;
      const next = pts[Math.min(SEGS, i + 1)]!;
      _segDir.copy(next).sub(prev).normalize();
      // Stable side/up from the segment dir (never degenerate)
      _side.set(-_segDir.z, 0, _segDir.x);
      if (_side.lengthSq() < 0.01) _side.set(1, 0, 0);
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
    this.core.geometry.dispose(); this.glow.geometry.dispose();
    (this.core.material as THREE.Material).dispose();
    (this.glow.material as THREE.Material).dispose();
  }
}
