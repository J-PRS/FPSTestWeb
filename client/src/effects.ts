import * as THREE from 'three';
import { GRAVITY } from './config.js';

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  mat: THREE.MeshBasicMaterial;
  noGravity?: boolean;
}

export class EffectsManager {
  private scene: THREE.Scene;
  private particles: Particle[] = [];
  private sharedGeo: THREE.SphereGeometry;
  private sharedDiscGeo: THREE.CircleGeometry;
  private terrain: any = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.sharedGeo = new THREE.SphereGeometry(0.15, 8, 8);
    this.sharedDiscGeo = new THREE.CircleGeometry(0.5, 8);
  }

  setTerrain(terrain: any): void {
    this.terrain = terrain;
  }

  spawnExplosion(pos: THREE.Vector3, radius: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(0.05 + Math.random() * 0.08, 1, 0.5 + Math.random() * 0.3),
        transparent: true,
      });
      const mesh = new THREE.Mesh(this.sharedGeo, mat);
      mesh.position.copy(pos);
      const spd = radius * (2 + Math.random() * 3);
      const dir = new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        Math.random(),
        (Math.random() - 0.5) * 2
      ).normalize().multiplyScalar(spd);
      const life = 0.4 + Math.random() * 0.5;
      this.scene.add(mesh);
      this.particles.push({ mesh, vel: dir, life, maxLife: life, mat });
    }

    // Flash sphere
    const flashGeo = new THREE.SphereGeometry(radius * 0.8, 8, 8);
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.9 });
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.copy(pos);
    this.scene.add(flash);
    this.particles.push({ mesh: flash, vel: new THREE.Vector3(), life: 0.12, maxLife: 0.12, mat: flashMat });
  }

  spawnJetpack(pos: THREE.Vector3): void {
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.2, 0.6 + Math.random() * 0.4, 1.0),
        transparent: true, opacity: 0.7,
      });
      const mesh = new THREE.Mesh(this.sharedGeo, mat);
      mesh.position.copy(pos).addScaledVector(new THREE.Vector3(0, -1, 0), 1.2);
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 3,
        -(2 + Math.random() * 4),
        (Math.random() - 0.5) * 3
      );
      const life = 0.2 + Math.random() * 0.15;
      this.scene.add(mesh);
      this.particles.push({ mesh, vel, life, maxLife: life, mat });
    }
  }

  spawnJumpDust(pos: THREE.Vector3): void {
    // Spawn at ground level for better visual
    const groundY = this.terrain ? this.terrain.getHeight(pos.x, pos.z) : 0;
    const spawnY = groundY + 0.2;

    // Ring burst effect - more particles, more dramatic
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.7, 0.6, 0.45),
        transparent: true, opacity: 0.7,
      });
      const mesh = new THREE.Mesh(this.sharedGeo, mat);
      mesh.position.set(pos.x, spawnY, pos.z);
      
      // Ring pattern with outward burst
      const ang = (i / 16) * Math.PI * 2;
      const spd = 3 + Math.random() * 4;
      const vel = new THREE.Vector3(
        Math.cos(ang) * spd,
        1.5 + Math.random() * 2.5,
        Math.sin(ang) * spd
      );
      
      // Larger initial scale for impact
      const scale = 1.2 + Math.random() * 0.8;
      mesh.scale.setScalar(scale);
      
      const life = 0.35 + Math.random() * 0.25;
      this.scene.add(mesh);
      this.particles.push({ mesh, vel, life, maxLife: life, mat });
    }

    // Add a few center particles for the "poof" effect
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.8, 0.7, 0.5),
        transparent: true, opacity: 0.8,
      });
      const mesh = new THREE.Mesh(this.sharedGeo, mat);
      mesh.position.set(pos.x, spawnY, pos.z);
      
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        2 + Math.random() * 3,
        (Math.random() - 0.5) * 2
      );
      
      mesh.scale.setScalar(1.5 + Math.random());
      const life = 0.3 + Math.random() * 0.2;
      this.scene.add(mesh);
      this.particles.push({ mesh, vel, life, maxLife: life, mat });
    }
  }

  spawnSkiDust(pos: THREE.Vector3, velocity: THREE.Vector3): void {
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.7, 0.65, 0.55),
        transparent: true, opacity: 0.3,
      });
      const mesh = new THREE.Mesh(this.sharedGeo, mat);
      // Spawn at ground level using terrain height, with random offset
      const groundY = this.terrain ? this.terrain.getHeight(pos.x, pos.z) : 0;
      const offsetX = (Math.random() - 0.5) * 1.0;
      const offsetZ = (Math.random() - 0.5) * 1.0;
      mesh.position.set(pos.x + offsetX, groundY + 0.3, pos.z + offsetZ);
      // Random scale for variety
      const scale = 1.5 + Math.random() * 2.0;
      mesh.scale.setScalar(scale);
      // Particles drift gently opposite to player movement
      const vel = new THREE.Vector3(
        -velocity.x * 0.05 + (Math.random() - 0.5) * 0.3,
        0.1 + Math.random() * 0.1, // Slight upward drift
        -velocity.z * 0.05 + (Math.random() - 0.5) * 0.3
      );
      const life = 0.3 + Math.random() * 0.3;
      this.scene.add(mesh);
      this.particles.push({ mesh, vel, life, maxLife: life, mat, noGravity: true });
    }
  }

  update(dt: number): void {
    const gravity = GRAVITY;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mat.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      const t = p.life / p.maxLife;
      p.mat.opacity = t * 0.6;
      if (!p.noGravity) {
        p.vel.y += gravity * dt;
      }
      p.mesh.position.addScaledVector(p.vel, dt);
      const s = 0.3 + t * 1.4;
      p.mesh.scale.setScalar(s);
    }
  }
}
