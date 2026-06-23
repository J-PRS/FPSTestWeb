import * as THREE from 'three';
import { IMPLOSION_LIFE } from './config.js';

interface IP {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vx: number; vy: number; vz: number;
  life: number; elapsed: number;
  baseScale: number;
  gravity: number;
  r1: number; g1: number; b1: number;
  r2: number; g2: number; b2: number;
  dead: boolean;
  startDist: number;
}

export class Implosion {
  dead = false;
  private particles: IP[] = [];
  private scene: THREE.Scene;
  private elapsed = 0;
  private ox: number; private oy: number; private oz: number;

  constructor(scene: THREE.Scene, pos: THREE.Vector3) {
    this.scene = scene;
    this.ox = pos.x; this.oy = pos.y; this.oz = pos.z;

    // Layer 1: Outer ring - cyan, fast inward
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 4 + Math.random() * 3;
      const spd = 25 + Math.random() * 15;
      this.spawn(pos, dist, ang, elv, spd,
        0.25 + Math.random()*0.15, 0.8 + Math.random()*0.6, 0.0,
        0.8, 1.0, 0.0,  0.0, 0.3, 0.8, true);
    }

    // Layer 2: Inner ring - blue, medium inward
    for (let i = 0; i < 30; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 2.5 + Math.random() * 2;
      const spd = 18 + Math.random() * 10;
      this.spawn(pos, dist, ang, elv, spd,
        0.30 + Math.random()*0.20, 0.6 + Math.random()*0.5, 0.0,
        0.5, 0.5, 0.0,  0.0, 0.2, 0.6, true);
    }

    // Layer 3: Core flash - white, very fast inward
    for (let i = 0; i < 15; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 1.5 + Math.random() * 1;
      const spd = 35 + Math.random() * 20;
      this.spawn(pos, dist, ang, elv, spd,
        0.12 + Math.random()*0.08, 0.4 + Math.random()*0.3, 0.0,
        1.0, 1.0, 0.8,  0.8, 0.9, 1.0, true);
    }

    // Layer 4: Debris - solid chunks, inward
    for (let i = 0; i < 20; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 3 + Math.random() * 2.5;
      const spd = 15 + Math.random() * 12;
      this.spawn(pos, dist, ang, elv, spd,
        0.20 + Math.random()*0.15, 0.3 + Math.random()*0.2, 0.0,
        0.3, 0.4, 0.0,  0.0, 0.1, 0.2, false);
    }
  }

  private spawn(
    pos: THREE.Vector3,
    startDist: number,
    ang: number,
    elv: number,
    speed: number,
    life: number,
    size: number,
    gravity: number,
    r1: number, g1: number, b1: number,
    r2: number, g2: number, b2: number,
    additive: boolean
  ): void {
    // Start at outer radius
    const sx = pos.x + startDist * Math.cos(elv) * Math.sin(ang);
    const sy = pos.y + startDist * Math.sin(elv);
    const zpos = pos.z + startDist * Math.cos(elv) * Math.cos(ang);

    // Velocity points toward center
    const vx = -speed * Math.cos(elv) * Math.sin(ang);
    const vy = -speed * Math.sin(elv);
    const vz = -speed * Math.cos(elv) * Math.cos(ang);

    const geo = new THREE.SphereGeometry(size, 5, 5);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(r1, g1, b1),
      transparent: true,
      opacity: additive ? 0.9 : 1.0,
      depthWrite: !additive,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(sx, sy, zpos);
    this.scene.add(mesh);
    this.particles.push({ mesh, mat, vx, vy, vz, life, elapsed: 0, baseScale: size, gravity, r1, g1, b1, r2, g2, b2, dead: false, startDist });
  }

  update(dt: number): void {
    this.elapsed += dt;
    let alive = 0;

    for (const p of this.particles) {
      if (p.dead) continue;
      p.elapsed += dt;
      if (p.elapsed >= p.life) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mat.dispose();
        p.dead = true;
        continue;
      }
      alive++;
      const t = p.elapsed / p.life;
      const ft = 1 - t;
      
      // Move inward
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      
      // Shrink as they approach center
      const scl = p.baseScale * ft;
      p.mesh.scale.setScalar(Math.max(scl, 0.01));
      
      // Color gradient
      p.mat.color.setRGB(
        p.r1 + (p.r2 - p.r1) * t,
        p.g1 + (p.g2 - p.g1) * t,
        p.b1 + (p.b2 - p.b1) * t,
      );
      p.mat.opacity = ft * (p.mat.depthWrite ? 1.0 : 0.9);
    }

    if (alive === 0) this.dead = true;
  }

  dispose(): void {
    for (const p of this.particles) {
      if (!p.dead) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mat.dispose();
      }
    }
  }
}
