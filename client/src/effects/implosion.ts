import * as THREE from 'three';

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
  private shockwaves: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; elapsed: number; maxRadius: number }[] = [];
  private coreMesh: THREE.Mesh | null = null;
  private coreMat: THREE.MeshBasicMaterial | null = null;
  private arcs: { line: THREE.Line; life: number; elapsed: number; points: THREE.Vector3[] }[] = [];

  constructor(scene: THREE.Scene, pos: THREE.Vector3, age: number = 0) {
    this.scene = scene;
    this.ox = pos.x; this.oy = pos.y; this.oz = pos.z;

    // Scale factor based on projectile flight time: 50% at 0s, 100% at 1s (linear, clamped)
    const timeScale = Math.min(0.5 + age * 0.5, 1.0);

    // Layer 1: Outer ring - bright cyan, fast inward with spiral
    for (let i = 0; i < Math.floor(80 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 4 + Math.random() * 3;
      const spd = 25 + Math.random() * 15;
      this.spawn(pos, dist, ang, elv, spd,
        0.25 + Math.random()*0.15, 1.0 + Math.random()*0.4, 0.5,
        0.8, 1.0, 1.0,  0.0, 0.5, 1.0, true, true);
    }

    // Layer 2: Inner ring - bright blue, medium inward with spiral
    for (let i = 0; i < Math.floor(60 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 2.5 + Math.random() * 2;
      const spd = 18 + Math.random() * 10;
      this.spawn(pos, dist, ang, elv, spd,
        0.30 + Math.random()*0.20, 0.9 + Math.random()*0.4, 0.5,
        0.5, 0.8, 1.0,  0.0, 0.4, 0.8, true, true);
    }

    // Layer 3: Core flash - white, very fast inward with spiral
    for (let i = 0; i < Math.floor(30 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 1.5 + Math.random() * 1;
      const spd = 35 + Math.random() * 20;
      this.spawn(pos, dist, ang, elv, spd,
        0.12 + Math.random()*0.08, 0.8 + Math.random()*0.3, 0.5,
        1.0, 1.0, 1.0,  0.8, 0.9, 1.0, true, true);
    }

    // Layer 4: Debris - solid chunks, inward
    for (let i = 0; i < Math.floor(40 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 3 + Math.random() * 2.5;
      const spd = 15 + Math.random() * 12;
      this.spawn(pos, dist, ang, elv, spd,
        0.20 + Math.random()*0.15, 0.6 + Math.random()*0.2, 0.3,
        0.3, 0.6, 0.5,  0.0, 0.2, 0.3, false);
    }

    // Layer 5: Shockwave - expanding cyan sphere
    const shockGeo = new THREE.SphereGeometry(0.3, 16, 16);
    const shockMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.8,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const shockMesh = new THREE.Mesh(shockGeo, shockMat);
    shockMesh.position.copy(pos);
    this.scene.add(shockMesh);
    this.shockwaves.push({
      mesh: shockMesh,
      mat: shockMat,
      life: 0.4,
      elapsed: 0,
      maxRadius: 8.0 * timeScale
    });

    // Layer 6: Collapsing core - bright white sphere that shrinks
    const coreGeo = new THREE.SphereGeometry(0.5, 16, 16);
    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.coreMesh = new THREE.Mesh(coreGeo, this.coreMat);
    this.coreMesh.position.copy(pos);
    this.scene.add(this.coreMesh);

    // Layer 7: Electric arcs - lightning lines spiraling inward
    const arcCount = Math.floor(8 * timeScale);
    for (let i = 0; i < arcCount; i++) {
      const arcPoints: THREE.Vector3[] = [];
      const segments = 8;
      const startRadius = 3 + Math.random() * 2;
      for (let j = 0; j <= segments; j++) {
        const t = j / segments;
        const radius = startRadius * (1 - t);
        const angle = (Math.PI * 2 * i / arcCount) + t * Math.PI * 2 + Math.random() * 0.5;
        const elv = (Math.random() - 0.5) * 0.5;
        arcPoints.push(new THREE.Vector3(
          pos.x + radius * Math.cos(elv) * Math.sin(angle),
          pos.y + radius * Math.sin(elv),
          pos.z + radius * Math.cos(elv) * Math.cos(angle)
        ));
      }
      const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPoints);
      const arcMat = new THREE.LineBasicMaterial({
        color: 0x88ffff,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending
      });
      const arcLine = new THREE.Line(arcGeo, arcMat);
      this.scene.add(arcLine);
      this.arcs.push({
        line: arcLine,
        life: 0.3,
        elapsed: 0,
        points: arcPoints
      });
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
    additive: boolean,
    spiral: boolean = false
  ): void {
    // Start at outer radius
    const sx = pos.x + startDist * Math.cos(elv) * Math.sin(ang);
    const sy = pos.y + startDist * Math.sin(elv);
    const zpos = pos.z + startDist * Math.cos(elv) * Math.cos(ang);

    // Velocity points toward center
    let vx = -speed * Math.cos(elv) * Math.sin(ang);
    let vy = -speed * Math.sin(elv);
    let vz = -speed * Math.cos(elv) * Math.cos(ang);

    // Add spiral motion (tangential velocity)
    if (spiral) {
      const spiralSpeed = speed * 0.8;
      const tanX = Math.cos(elv) * Math.cos(ang);
      const tanY = 0;
      const tanZ = -Math.cos(elv) * Math.sin(ang);
      vx += tanX * spiralSpeed;
      vz += tanZ * spiralSpeed;
    }

    const geo = new THREE.SphereGeometry(size, 5, 5);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(r1, g1, b1),
      transparent: true,
      opacity: additive ? 0.5 : 1.0,
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
      p.mat.opacity = ft * (p.mat.depthWrite ? 1.0 : 0.5);
    }

    // Update core collapse
    if (this.coreMesh && this.coreMat) {
      const coreLife = 0.25;
      if (this.elapsed < coreLife) {
        const t = this.elapsed / coreLife;
        const scale = 1.0 - t;
        this.coreMesh.scale.setScalar(scale);
        this.coreMat.opacity = 1.0 - t * 0.5;
        alive++;
      } else {
        this.scene.remove(this.coreMesh);
        this.coreMesh.geometry.dispose();
        this.coreMat.dispose();
        this.coreMesh = null;
        this.coreMat = null;
      }
    }

    // Update shockwaves
    for (const sw of this.shockwaves) {
      sw.elapsed += dt;
      if (sw.elapsed >= sw.life) {
        this.scene.remove(sw.mesh);
        sw.mesh.geometry.dispose();
        sw.mat.dispose();
        continue;
      }
      alive++;
      const t = sw.elapsed / sw.life;
      const ft = 1 - t;
      const currentRadius = sw.maxRadius * t;
      sw.mesh.scale.setScalar(currentRadius / 0.3);
      sw.mat.opacity = ft * 0.8;
    }

    // Update electric arcs
    for (const arc of this.arcs) {
      arc.elapsed += dt;
      if (arc.elapsed >= arc.life) {
        this.scene.remove(arc.line);
        arc.line.geometry.dispose();
        (arc.line.material as THREE.Material).dispose();
        continue;
      }
      alive++;
      const t = arc.elapsed / arc.life;
      const ft = 1 - t;
      
      // Shrink arc points toward center
      const positions = new Float32Array(arc.points.length * 3);
      for (let i = 0; i < arc.points.length; i++) {
        const shrinkFactor = ft;
        positions[i * 3] = this.ox + (arc.points[i].x - this.ox) * shrinkFactor;
        positions[i * 3 + 1] = this.oy + (arc.points[i].y - this.oy) * shrinkFactor;
        positions[i * 3 + 2] = this.oz + (arc.points[i].z - this.oz) * shrinkFactor;
      }
      arc.line.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      (arc.line.material as THREE.LineBasicMaterial).opacity = ft * 0.8;
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
    for (const sw of this.shockwaves) {
      this.scene.remove(sw.mesh);
      sw.mesh.geometry.dispose();
      sw.mat.dispose();
    }
    if (this.coreMesh && this.coreMat) {
      this.scene.remove(this.coreMesh);
      this.coreMesh.geometry.dispose();
      this.coreMat.dispose();
    }
    for (const arc of this.arcs) {
      this.scene.remove(arc.line);
      arc.line.geometry.dispose();
      (arc.line.material as THREE.Material).dispose();
    }
    this.shockwaves = [];
    this.arcs = [];
    this.coreMesh = null;
    this.coreMat = null;
  }
}
