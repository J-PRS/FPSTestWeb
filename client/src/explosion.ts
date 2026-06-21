import * as THREE from 'three';

const SHOCK_LIFE = 0.25;
const FLASH_LIFE = 0.09;

interface EP {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vx: number; vy: number; vz: number;
  life: number; elapsed: number;
  baseScale: number;
  gravity: number;
  r1: number; g1: number; b1: number;
  r2: number; g2: number; b2: number;
  dead: boolean;
}

export class Explosion {
  dead = false;
  private particles: EP[] = [];
  private scene: THREE.Scene;
  private elapsed = 0;
  private ox: number; private oy: number; private oz: number;


  constructor(scene: THREE.Scene, pos: THREE.Vector3) {
    this.scene = scene;
    this.ox = pos.x; this.oy = pos.y; this.oz = pos.z;

    // Layer 1: Flash — white-yellow, very short
    for (let i = 0; i < 20; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.4) * Math.PI * 0.5;
      const spd = 3 + Math.random() * 8;
      this.spawn(pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+3, spd*Math.cos(elv)*Math.cos(ang),
        0.16 + Math.random()*0.08, 1.8 + Math.random()*1.4, -3,
        1, 1, 0.85,  1, 0.6, 0, true);
    }

    // Layer 2: Fireball core — orange, additive
    for (let i = 0; i < 65; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.25) * Math.PI;
      const spd = 7 + Math.random() * 28;
      this.spawn(pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+8, spd*Math.cos(elv)*Math.cos(ang),
        0.40 + Math.random()*0.30, 0.35 + Math.random()*0.65, -18,
        1, 0.4+Math.random()*0.35, 0,  0.55, 0.02, 0, true);
    }

    // Layer 3: Debris — fast chunks, orange→brown, solid
    for (let i = 0; i < 32; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.2) * Math.PI * 0.75;
      const spd = 16 + Math.random() * 40;
      this.spawn(pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+14, spd*Math.cos(elv)*Math.cos(ang),
        0.30 + Math.random()*0.35, 0.09 + Math.random()*0.15, -32,
        1, 0.3+Math.random()*0.2, 0,  0.12, 0.05, 0.01, false);
    }

    // Layer 4: Embers — tiny, long life
    for (let i = 0; i < 80; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.3) * Math.PI;
      const spd = 8 + Math.random() * 35;
      this.spawn(pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+6, spd*Math.cos(elv)*Math.cos(ang),
        0.7 + Math.random()*0.8, 0.05 + Math.random()*0.10, -14,
        1, 0.5+Math.random()*0.3, 0,  0.2, 0, 0, true);
    }

    // Layer 5: Smoke — slow rising grey
    for (let i = 0; i < 6; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 1 + Math.random() * 4;
      this.spawn(pos,
        spd*Math.sin(ang)+(Math.random()-0.5), 2.5+Math.random()*4, spd*Math.cos(ang)+(Math.random()-0.5),
        0.7 + Math.random()*0.4, 0.28 + Math.random()*0.35, -1,
        0.22, 0.20, 0.18,  0.06, 0.06, 0.06, false);
    }

  }

  private spawn(
    pos: THREE.Vector3,
    vx: number, vy: number, vz: number,
    life: number, sz: number, gravity: number,
    r1: number, g1: number, b1: number,
    r2: number, g2: number, b2: number,
    additive: boolean
  ): void {
    const geo = new THREE.SphereGeometry(sz, 5, 5);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(r1, g1, b1),
      transparent: true,
      opacity: additive ? 0.85 : 1.0,
      depthWrite: !additive,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      pos.x + (Math.random()-0.5)*0.5,
      pos.y + (Math.random()-0.5)*0.5,
      pos.z + (Math.random()-0.5)*0.5,
    );
    this.scene.add(mesh);
    this.particles.push({ mesh, mat, vx, vy, vz, life, elapsed: 0, baseScale: sz, gravity, r1, g1, b1, r2, g2, b2, dead: false });
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
      const t  = p.elapsed / p.life;
      const ft = 1 - t;
      p.vy += p.gravity * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      // grow briefly then shrink
      const scl = p.baseScale * (t < 0.12 ? t / 0.12 : ft);
      p.mesh.scale.setScalar(Math.max(scl, 0.01));
      p.mat.color.setRGB(
        p.r1 + (p.r2 - p.r1) * t,
        p.g1 + (p.g2 - p.g1) * t,
        p.b1 + (p.b2 - p.b1) * t,
      );
      p.mat.opacity = ft * (p.mat.depthWrite ? 1.0 : 0.85);
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
