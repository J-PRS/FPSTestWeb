import * as THREE from 'three';
import { LightningBeam, SEGS, SPARKS } from './lightningBeam.js';
import { markProbe } from '../core/fxDiag.js';

// Scene-graph assembly: crossed-ribbon core+glow+arc+chain meshes
// (frustum-cull off — vertices rewrite every jag), the contact sprite,
// and the per-spark color-jittered fountain points.

function mkRibbon(color: number, opacity: number): THREE.Mesh {
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
}

export function buildBeam(b: LightningBeam, scene: THREE.Scene, tint?: { glow: number; core: number; chain: number; hit: number; sparkTop: number }) {
    b.beamPts = Array.from({ length: SEGS + 1 }, () => new THREE.Vector3());

    // Two crossed ribbons in ONE geometry (X cross-section) — volumetric
    // from every angle, and it can't degenerate into a screen-filling fan
    // when the beam points at/away from the camera like a billboard does.

    b.glow = mkRibbon(tint?.glow ?? 0x22_66_FF, 0.35);
    b.core = mkRibbon(tint?.core ?? 0xEA_F6_FF, 0.95);
    // Chain hop: same ribbon machinery, slightly dimmer — it reads as a
    // fork off the main bolt
    b.chainCore = mkRibbon(tint?.chain ?? 0x9F_D4_FF, 0.7);
    b.chainCore.visible = false;
    b.chainPts = Array.from({ length: SEGS + 1 }, () => new THREE.Vector3());
    // Damage arc: same ribbon machinery at the core color — a second,
    // jaggier bolt riding the main shaft while the tip bites
    b.arc = mkRibbon(tint?.core ?? 0xEA_F6_FF, 0.9);
    b.arc.visible = false;
    b.arcPts = Array.from({ length: SEGS + 1 }, () => new THREE.Vector3());
    b.group.add(b.glow, b.core, b.chainCore, b.arc);
    // Aim-probe tags — a stuck lightning bolt was indistinguishable from a
    // ribbon streak on screen before these names existed.
    markProbe(b.glow, { kind: 'beam', label: 'lightning:glow' });
    markProbe(b.core, { kind: 'beam', label: 'lightning:core' });
    markProbe(b.chainCore, { kind: 'beam', label: 'lightning:chain' });
    markProbe(b.arc, { kind: 'beam', label: 'lightning:arc' });

    // Contact glow — bright ball pinned at the hit point
    const glowTex = LightningBeam.makeGlowTexture();
    b.hitGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: tint?.hit ?? 0xAA_DD_FF, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    b.hitGlow.scale.setScalar(2.2);
    b.group.add(b.hitGlow);

    // Spark fountain — plain Points, respawned at the contact while firing
    b.sparkPos = new Float32Array(SPARKS * 3);
    b.sparkVel = new Float32Array(SPARKS * 3);
    b.sparkAge = new Float32Array(SPARKS);
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(b.sparkPos, 3));
    // Per-spark color jitter — white core to deep blue edge, no two alike
    const sCol = new Float32Array(SPARKS * 3);
    const sparkTop = new THREE.Color(tint?.sparkTop ?? 0xFF_FF_FF);
    for (let i = 0; i < SPARKS; i++) {
      const t = Math.random();
      if (tint) {
        sCol[i * 3] = sparkTop.r * (0.55 + t * 0.45);
        sCol[i * 3 + 1] = sparkTop.g * (0.75 + t * 0.25);
        sCol[i * 3 + 2] = sparkTop.b;
      } else {
        sCol[i * 3] = 0.55 + t * 0.45;
        sCol[i * 3 + 1] = 0.75 + t * 0.25;
        sCol[i * 3 + 2] = 1;
      }
    }
    sGeo.setAttribute('color', new THREE.BufferAttribute(sCol, 3));
    b.sparkPoints = new THREE.Points(sGeo, new THREE.PointsMaterial({
      map: glowTex,           // soft radial blob — kills the square-quad look
      vertexColors: true,
      size: 0.55, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    b.sparkPoints.frustumCulled = false;
    b.group.add(b.sparkPoints);
    markProbe(b.hitGlow, { kind: 'beam', label: 'lightning:hitGlow' });
    markProbe(b.sparkPoints, { kind: 'beam', label: 'lightning:sparks' });

    b.group.visible = false;
    scene.add(b.group);
  }

