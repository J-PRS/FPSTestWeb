// Server-owned pickup bodies — the four powerups get real silhouettes +
// glow so a heal/armor/regen/dd is readable at distance without a color
// legend. Idle motion rides onBeforeRender (per rendered frame, zero
// plumbing); collect feedback is a kind-tinted spark burst.

import * as THREE from 'three';
import type { PickupKind } from '../../../shared/pickups.js';
import { blastBurst } from '../effects/vfx.js';

export interface PickupModel {
  root: THREE.Group;
  dispose(): void;
}

interface PickupSpec {
  accent: number;   // emissive/glow color
  base: number;     // body material color
  bob: number;      // bob amplitude m
  spin: number;     // rad/s yaw
}

const SPECS: Record<PickupKind, PickupSpec> = {
  gem:   { accent: 0xffcc44, base: 0x664422, bob: 0.14, spin: 1.6 },
  tag:   { accent: 0xff3355, base: 0x442222, bob: 0.10, spin: 0.9 },
  heal:  { accent: 0x44ff66, base: 0xe8e8e8, bob: 0.16, spin: 0.8 },
  armor: { accent: 0xffaa22, base: 0x334455, bob: 0.12, spin: 0.7 },
  regen: { accent: 0x66ffee, base: 0x113a3a, bob: 0.18, spin: 1.2 },
  dd:    { accent: 0xff4422, base: 0x2a0a08, bob: 0.15, spin: 2.0 },
};

// One shared radial-gradient sprite for every pickup halo.
let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}

function mat(color: number, emissive = 0, rough = 0.6): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: emissive ? 0.55 : 0, roughness: rough, metalness: 0.25 });
}

function addMesh(root: THREE.Group, g: THREE.BufferGeometry, m: THREE.Material,
    opts: { pos?: [number, number, number]; rot?: [number, number, number]; s?: number } = {}): THREE.Mesh {
  const mesh = new THREE.Mesh(g, m);
  if (opts.pos) mesh.position.set(...opts.pos);
  if (opts.rot) mesh.rotation.set(...opts.rot);
  if (opts.s !== undefined) mesh.scale.setScalar(opts.s);
  root.add(mesh);
  return mesh;
}

/** The recognizable body per kind — primitives only, no asset fetch. */
function buildBody(kind: PickupKind, spec: PickupSpec): THREE.Group {
  const body = new THREE.Group();
  const base = mat(spec.base);
  const accent = mat(0x0a0a0a, spec.accent);
  const accentMat = mat(spec.accent, spec.accent, 0.4);
  switch (kind) {
    case 'heal': {
      // Medkit — white case + green cross (red-cross-on-white is a
      // protected ICRC emblem, games get told off for using it).
      addMesh(body, geo('healBox', () => new THREE.BoxGeometry(0.6, 0.45, 0.4)), mat(0xe8e8e8));
      const cross = mat(0x22aa44, 0x22aa44);
      addMesh(body, geo('crossV', () => new THREE.BoxGeometry(0.12, 0.34, 0.06)), cross, { pos: [0, 0, 0.2] });
      addMesh(body, geo('crossH', () => new THREE.BoxGeometry(0.34, 0.12, 0.06)), cross, { pos: [0, 0, 0.2] });
      addMesh(body, geo('healCap', () => new THREE.BoxGeometry(0.64, 0.1, 0.44)), mat(0x22aa44), { pos: [0, 0.24, 0] });
      break;
    }
    case 'armor': {
      // Shield plate — hex disc on edge with a glowing core boss.
      addMesh(body, geo('shield', () => new THREE.CylinderGeometry(0.42, 0.5, 0.1, 6)), base, { rot: [Math.PI / 2, 0, 0] });
      addMesh(body, geo('boss', () => new THREE.SphereGeometry(0.14, 10, 8)), accentMat, { pos: [0, 0, 0.08] });
      addMesh(body, geo('shieldRim', () => new THREE.TorusGeometry(0.46, 0.05, 8, 6)), mat(0x556677, 0x223344));
      break;
    }
    case 'regen': {
      // Halo cell — luminous orb inside a tilted ring.
      addMesh(body, geo('cell', () => new THREE.IcosahedronGeometry(0.26, 1)), accentMat);
      addMesh(body, geo('cellRing', () => new THREE.TorusGeometry(0.42, 0.05, 8, 24)), mat(0x224444, 0x33aaaa), { rot: [1.2, 0, 0] });
      addMesh(body, geo('cellRing2', () => new THREE.TorusGeometry(0.36, 0.04, 8, 24)), mat(0x224444, 0x33aaaa), { rot: [-0.7, 0.8, 0] });
      break;
    }
    case 'dd': {
      // Overcharge core — stretched octahedron + spike crown.
      addMesh(body, geo('ddCore', () => new THREE.OctahedronGeometry(0.34)), accentMat);
      body.children[0]!.scale.set(0.8, 1.35, 0.8);
      const spike = geo('ddSpike', () => new THREE.ConeGeometry(0.07, 0.3, 5));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        addMesh(body, spike, accent, { pos: [Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42], rot: [0, 0, -a - Math.PI / 2] });
      }
      break;
    }
    case 'gem': {
      addMesh(body, geo('gemO', () => new THREE.OctahedronGeometry(0.5)), accentMat);
      break;
    }
    case 'tag': {
      addMesh(body, geo('tagP', () => new THREE.BoxGeometry(0.7, 0.14, 0.45)), accentMat);
      addMesh(body, geo('tagHole', () => new THREE.CylinderGeometry(0.06, 0.06, 0.16, 8)), base, { pos: [-0.26, 0, 0] });
      break;
    }
  }
  return body;
}

/** Ground ring — a soft pool of light marking the pickup's footprint. */
function groundRing(accent: number): THREE.Mesh {
  const m = new THREE.Mesh(
    geo('ring', () => new THREE.RingGeometry(0.45, 0.75, 28)),
    new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

// Hover height — pickup bodies float just over their ground ring; at
// 0.75 the models read as ballooning well above the terrain.
const HOVER_Y = 0.45;

export function buildPickupModel(kind: PickupKind, y0: number): PickupModel {
  const spec = SPECS[kind];
  const root = new THREE.Group();
  const body = buildBody(kind, spec);
  const born = performance.now() / 1000 + Math.random(); // phase-spread spins
  body.position.y = HOVER_Y;
  root.add(body);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: spec.accent, transparent: true, opacity: 0.4,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(1.8);
  halo.position.y = HOVER_Y;
  root.add(halo);

  const ring = groundRing(spec.accent);
  ring.position.y = 0.06 - y0; // ring sits on the pickup's own floor level
  root.add(ring);

  root.position.y = y0;
  root.onBeforeRender = () => {
    const t = performance.now() / 1000 - born;
    body.rotation.y = t * spec.spin;
    body.position.y = HOVER_Y + Math.sin(t * 2.1) * spec.bob;
    const pulse = 1 + Math.sin(t * 3.2) * 0.12;
    halo.scale.setScalar(1.8 * pulse);
    (halo.material as THREE.SpriteMaterial).opacity = 0.3 + Math.sin(t * 3.2) * 0.1;
    ring.scale.setScalar(pulse);
  };

  return {
    root,
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh && !geoCache.has(o.geometry.uuid)) {
          const m = o.material as THREE.Material;
          m?.dispose?.();
        }
      });
      (halo.material as THREE.SpriteMaterial).dispose();
      (ring.material as THREE.Material).dispose();
    },
  };
}

/** Kind-tinted collect burst — rising sparks in the pickup's accent. */
export function pickupBurst(pos: THREE.Vector3, kind: PickupKind): void {
  const c = new THREE.Color(SPECS[kind].accent);
  blastBurst(pos, {
    count: 22, elvBase: 0.15, elvSpan: Math.PI / 2,
    spdMin: 3, spdMax: 8, vy: 2.5,
    lifeMin: 0.35, lifeMax: 0.7, sizeMin: 0.1, sizeMax: 0.22,
    gravity: -4,
    c1: [c.r, c.g, c.b], c2: [1, 1, 1],
    opacity: 0.8, stagger: 0.08, spin: 4,
  }, true);
}
