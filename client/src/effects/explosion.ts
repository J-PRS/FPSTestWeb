import * as THREE from 'three';

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

interface Shockwave {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  elapsed: number;
  maxRadius: number;
}

interface Spark {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  elapsed: number;
  trail: THREE.Vector3[];
  maxTrailLength: number;
  color: THREE.Color;
  line: THREE.Line;
  lineGeometry: THREE.BufferGeometry;
}

export class Explosion {
  dead = false;
  private particles: EP[] = [];
  private shockwaves: Shockwave[] = [];
  private sparks: Spark[] = [];
  private scene: THREE.Scene;
  private elapsed = 0;
  private ox: number; private oy: number; private oz: number;


  constructor(scene: THREE.Scene, pos: THREE.Vector3, directHit: boolean = false, age: number = 0) {
    this.scene = scene;
    this.ox = pos.x; this.oy = pos.y; this.oz = pos.z;

    // Scale factor based on projectile flight time: 50% at 0s, 100% at 1s (linear, clamped)
    const timeScale = directHit ? Math.min(0.5 + age * 0.5, 1.0) : 1.0;
    // Multipliers for direct hit enhancement (base 1.8, scaled by time)
    const mult = directHit ? 1.8 * timeScale : 1.0;

    // Layer 1: Flash — white-yellow, very short
    for (let i = 0; i < Math.floor(20 * mult); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.4) * Math.PI * 0.5;
      const spd = (3 + Math.random() * 8) * (directHit ? 1.3 : 1.0);
      this.spawn(pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+3, spd*Math.cos(elv)*Math.cos(ang),
        (0.16 + Math.random()*0.08) * (directHit ? 1.4 : 1.0), (1.8 + Math.random()*1.4) * (directHit ? 1.2 : 1.0), -3,
        1, 1, 0.85,  1, 0.6, 0, true);
    }

    // Layer 2: Fireball core — orange, additive
    for (let i = 0; i < Math.floor(65 * mult); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.25) * Math.PI;
      const spd = (7 + Math.random() * 28) * (directHit ? 1.4 : 1.0);
      this.spawn(pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+8, spd*Math.cos(elv)*Math.cos(ang),
        (0.40 + Math.random()*0.30) * (directHit ? 1.5 : 1.0), (0.35 + Math.random()*0.65) * (directHit ? 1.3 : 1.0), -18,
        1, 0.4+Math.random()*0.35, 0,  0.55, 0.02, 0, true);
    }

    // Layer 3: Debris — fast chunks, orange→brown, solid
    for (let i = 0; i < Math.floor(32 * mult); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.2) * Math.PI * 0.75;
      const spd = (16 + Math.random() * 40) * (directHit ? 1.5 : 1.0);
      this.spawn(pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+14, spd*Math.cos(elv)*Math.cos(ang),
        (0.30 + Math.random()*0.35) * (directHit ? 1.6 : 1.0), (0.09 + Math.random()*0.15) * (directHit ? 1.4 : 1.0), -32,
        1, 0.3+Math.random()*0.2, 0,  0.12, 0.05, 0.01, false);
    }

    // Layer 4: Embers — tiny, long life
    for (let i = 0; i < Math.floor(80 * mult); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.3) * Math.PI;
      const spd = (8 + Math.random() * 35) * (directHit ? 1.3 : 1.0);
      this.spawn(pos,
        spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+6, spd*Math.cos(elv)*Math.cos(ang),
        (0.7 + Math.random()*0.8) * (directHit ? 1.4 : 1.0), (0.05 + Math.random()*0.10) * (directHit ? 1.2 : 1.0), -14,
        1, 0.5+Math.random()*0.3, 0,  0.2, 0, 0, true);
    }

    // Layer 5: Smoke — slow rising grey
    for (let i = 0; i < Math.floor(6 * mult); i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 1 + Math.random() * 4;
      this.spawn(pos,
        spd*Math.sin(ang)+(Math.random()-0.5), 2.5+Math.random()*4, spd*Math.cos(ang)+(Math.random()-0.5),
        (0.7 + Math.random()*0.4) * (directHit ? 1.3 : 1.0), (0.28 + Math.random()*0.35) * (directHit ? 1.2 : 1.0), -1,
        0.22, 0.20, 0.18,  0.06, 0.06, 0.06, false);
    }

    // Layer 6: Direct hit bonus — extra bright white core particles
    if (directHit) {
      for (let i = 0; i < Math.floor(60 * timeScale); i++) {
        const ang = Math.random() * Math.PI * 2;
        const elv = (Math.random() - 0.5) * Math.PI;
        const spd = 20 + Math.random() * 50;
        this.spawn(pos,
          spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+10, spd*Math.cos(elv)*Math.cos(ang),
          0.6 + Math.random()*0.4, 0.5 + Math.random()*0.3, -25,
          0.6, 0.8, 1.0,  0.2, 0.4, 0.8, true);
      }

      // Layer 7: Blue energy burst — identifies direct hits by color
      for (let i = 0; i < Math.floor(70 * timeScale); i++) {
        const ang = Math.random() * Math.PI * 2;
        const elv = (Math.random() - 0.5) * Math.PI;
        const spd = 12 + Math.random() * 35;
        this.spawn(pos,
          spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+8, spd*Math.cos(elv)*Math.cos(ang),
          0.5 + Math.random()*0.4, 0.3 + Math.random()*0.25, -10,
          0.0, 0.3, 1.0,  0.0, 0.0, 0.4, true);
      }

      // Layer 8: Shockwave sphere — white expanding 3D sphere
      const sphereGeo = new THREE.SphereGeometry(0.3, 16, 16);
      const sphereMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.6,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
      sphereMesh.position.copy(pos);
      this.scene.add(sphereMesh);
      this.shockwaves.push({
        mesh: sphereMesh,
        mat: sphereMat,
        life: 0.5,
        elapsed: 0,
        maxRadius: 10.0 * timeScale
      });

      // Layer 9: Blue shockwave — second expanding sphere, blue
      const blueGeo = new THREE.SphereGeometry(0.3, 16, 16);
      const blueMat = new THREE.MeshBasicMaterial({
        color: 0x00ccff,
        transparent: true,
        opacity: 0.7,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const blueMesh = new THREE.Mesh(blueGeo, blueMat);
      blueMesh.position.copy(pos);
      this.scene.add(blueMesh);
      this.shockwaves.push({
        mesh: blueMesh,
        mat: blueMat,
        life: 0.4,
        elapsed: 0,
        maxRadius: 12.0 * timeScale
      });

      // Layer 10: Sparks with trails — mix of orange and blue
      for (let i = 0; i < Math.floor(35 * timeScale); i++) {
        const ang = Math.random() * Math.PI * 2;
        const elv = (Math.random() - 0.5) * Math.PI * 0.8;
        const spd = 15 + Math.random() * 30;
        const vel = new THREE.Vector3(
          spd * Math.cos(elv) * Math.sin(ang),
          spd * Math.sin(elv) + 5,
          spd * Math.cos(elv) * Math.cos(ang)
        );
        const isBlue = Math.random() < 0.4;
        const lineGeometry = new THREE.BufferGeometry();
        const lineMaterial = new THREE.LineBasicMaterial({
          color: isBlue
            ? new THREE.Color(0.1, 0.4, 1.0)
            : new THREE.Color(1.0, 0.8 + Math.random() * 0.2, 0.3 + Math.random() * 0.3),
          transparent: true,
          opacity: 0.8,
          blending: THREE.AdditiveBlending
        });
        const line = new THREE.Line(lineGeometry, lineMaterial);
        this.scene.add(line);
        this.sparks.push({
          pos: pos.clone(),
          vel: vel,
          life: 1.5 + Math.random() * 0.5,
          elapsed: 0,
          trail: [],
          maxTrailLength: 8,
          color: lineMaterial.color,
          line: line,
          lineGeometry: lineGeometry
        });
      }
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
      sw.mesh.scale.setScalar(currentRadius / 0.3); // Scale from initial 0.3 radius
      sw.mat.opacity = ft * 0.8;
    }

    // Update sparks with trails
    for (const spark of this.sparks) {
      spark.elapsed += dt;
      if (spark.elapsed >= spark.life) {
        this.scene.remove(spark.line);
        spark.lineGeometry.dispose();
        (spark.line.material as THREE.Material).dispose();
        continue;
      }
      alive++;

      // Apply gravity
      spark.vel.y -= 40 * dt;

      // Update position
      spark.pos.addScaledVector(spark.vel, dt);

      // Add to trail
      spark.trail.push(spark.pos.clone());
      if (spark.trail.length > spark.maxTrailLength) {
        spark.trail.shift();
      }

      // Update line geometry
      if (spark.trail.length >= 2) {
        const positions = new Float32Array(spark.trail.length * 3);
        for (let i = 0; i < spark.trail.length; i++) {
          positions[i * 3] = spark.trail[i].x;
          positions[i * 3 + 1] = spark.trail[i].y;
          positions[i * 3 + 2] = spark.trail[i].z;
        }
        spark.lineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      }

      // Fade out
      const t = spark.elapsed / spark.life;
      (spark.line.material as THREE.LineBasicMaterial).opacity = (1 - t) * 0.8;
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
    for (const spark of this.sparks) {
      this.scene.remove(spark.line);
      spark.lineGeometry.dispose();
      (spark.line.material as THREE.Material).dispose();
    }
    this.shockwaves = [];
    this.sparks = [];
  }
}
