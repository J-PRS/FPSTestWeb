import * as BABYLON from '@babylonjs/core';
import { getTerrainHeight } from './scene';
import { CustomPhysics, type RigidBody } from './customPhysics';
import type { Enemy } from './enemySystem';
import { VFXSystem } from './vfx/vfxSystem';
import type { ISystem } from './core/ISystem';
import { eventBus, GameEvents } from './core/EventBus';

export interface Rocket {
  id: string;
  mesh: BABYLON.Mesh;
  body: RigidBody;
  trail: BABYLON.ParticleSystem;
  trailMesh: BABYLON.TrailMesh | null;
  hitboxMesh: BABYLON.Mesh;
  createdAt: number;
  previousPosition: BABYLON.Vector3;
  pairedId?: string; // ghost links to real, real links to ghost
  isGhost: boolean;
}

export class WeaponSystem implements ISystem {
  private scene: BABYLON.Scene;
  private camera: BABYLON.UniversalCamera | null = null;
  private physics: CustomPhysics;
  private vfxSystem: VFXSystem;
  private rockets: Rocket[] = [];
  private isFiring = false;
  private lastFireTime = 0;
  private fireRate = 1000; // 1 shot per second (in ms)
  private getEnemies: () => Enemy[] = () => [];
  private groundMesh: BABYLON.Mesh | undefined = undefined;
  private onEnemyHit: (enemyId: string, position: BABYLON.Vector3) => void = () => {};
  private playerVelocity: BABYLON.Vector3 = BABYLON.Vector3.Zero();
  public readonly updateOrder = 30; // Weapons update after enemies

  constructor(scene: BABYLON.Scene, physics: CustomPhysics, vfxSystem: VFXSystem) {
    this.scene = scene;
    this.physics = physics;
    this.vfxSystem = vfxSystem;
  }

  public initialize(): void {
    // Weapon system doesn't need initialization
  }

  public dispose(): void {
    this.rockets.forEach(rocket => {
      rocket.trail.dispose();
      if (rocket.trailMesh) {
        rocket.trailMesh.dispose();
      }
      this.physics.removeBody(rocket.body);
      rocket.mesh.dispose();
    });
    this.rockets = [];
  }

  setCamera(camera: BABYLON.UniversalCamera): void {
    this.camera = camera;
  }

  setFiring(isFiring: boolean): void {
    this.isFiring = isFiring;
  }

  setEnemyCallbacks(getEnemies: () => Enemy[], onEnemyHit: (enemyId: string, position: BABYLON.Vector3) => void): void {
    this.getEnemies = getEnemies;
    this.onEnemyHit = onEnemyHit;
  }

  setPlayerVelocity(velocity: BABYLON.Vector3): void {
    this.playerVelocity = velocity.clone();
  }

  setGroundMesh(groundMesh: BABYLON.Mesh): void {
    this.groundMesh = groundMesh;
  }

  fireRocket(origin: BABYLON.Vector3, direction: BABYLON.Vector3): void {
    // Fire ghost (no inheritance) alongside the real rocket so player can compare
    const pairId = `pair_${Date.now()}`;
    this.spawnRocket(origin, direction, true, pairId);
    this.spawnRocket(origin, direction, false, pairId);
  }

  private spawnRocket(origin: BABYLON.Vector3, direction: BABYLON.Vector3, isGhost: boolean, pairId: string): void {
    const rocketId = `rocket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create rocket mesh (fireball sphere)
    const rocketMesh = BABYLON.MeshBuilder.CreateSphere('rocket', { diameter: 0.3 }, this.scene);
    rocketMesh.position = origin.clone();
    
    // Ghost = translucent blue, real = orange fire
    const rocketMat = new BABYLON.StandardMaterial('rocketMat', this.scene);
    if (isGhost) {
      rocketMat.diffuseColor = new BABYLON.Color3(0.3, 0.6, 1);
      rocketMat.emissiveColor = new BABYLON.Color3(0.1, 0.4, 1);
      rocketMat.alpha = 0.45;
    } else {
      rocketMat.diffuseColor = new BABYLON.Color3(1, 0.5, 0);
      rocketMat.emissiveColor = new BABYLON.Color3(1, 0.3, 0);
      rocketMat.specularColor = new BABYLON.Color3(1, 0.8, 0.5);
    }
    rocketMesh.material = rocketMat;

    // Create wireframe hitbox visualization (expands over time)
    const hitboxMesh = BABYLON.MeshBuilder.CreateSphere('hitbox', { diameter: 0.3 }, this.scene);
    hitboxMesh.position = origin.clone();
    const hitboxMat = new BABYLON.StandardMaterial('hitboxMat', this.scene);
    hitboxMat.wireframe = true;
    hitboxMat.emissiveColor = new BABYLON.Color3(0, 1, 0); // Green wireframe
    hitboxMat.alpha = 0.3;
    hitboxMesh.material = hitboxMat;
    hitboxMesh.isPickable = false; // Don't interfere with raycasting

    // Velocity: ghost uses base only, real rocket gets 50% player velocity inheritance
    const normalizedDirection = direction.normalize();
    const baseVelocity = normalizedDirection.scale(120);
    let finalVelocity: BABYLON.Vector3;
    const playerVelocityInFiringDirection = BABYLON.Vector3.Dot(this.playerVelocity, normalizedDirection);
    const inheritedSpeed = playerVelocityInFiringDirection * 0.5;
    if (isGhost) {
      finalVelocity = baseVelocity.clone();
      console.log(`[GHOST]  base=${baseVelocity.length().toFixed(1)} inherited=0.0 final=${finalVelocity.length().toFixed(1)}`);
    } else {
      finalVelocity = baseVelocity.add(normalizedDirection.scale(inheritedSpeed));
      console.log(`[REAL]   base=${baseVelocity.length().toFixed(1)} inherited=${inheritedSpeed.toFixed(1)} final=${finalVelocity.length().toFixed(1)}  playerVel=${this.playerVelocity.length().toFixed(1)}`);
    }

    const rocketBody = this.physics.createBody({
      position: origin.clone(),
      velocity: finalVelocity,
      mass: 1,
      radius: 0.15,
      restitution: 0,
      friction: 0.1,
      gravityScale: 1,
      mesh: rocketMesh,
      entityId: rocketId,
      scene: this.scene,
      groundMesh: this.groundMesh,
      onCollision: (position: BABYLON.Vector3, normal: BABYLON.Vector3) => {
        if (!isGhost) {
          this.createExplosion(position);
          eventBus.emit(GameEvents.VFX_EXPLOSION, { position });
          // Remove paired ghost too
          const ghostIndex = this.rockets.findIndex(r => r.pairedId === pairId && r.isGhost);
          if (ghostIndex !== -1) this.removeRocket(ghostIndex);
        }
        const index = this.rockets.findIndex(r => r.id === rocketId);
        if (index !== -1) this.removeRocket(index);
      }
    });

    eventBus.emit(GameEvents.WEAPON_FIRED, { position: origin, direction });

    // Trail particles
    const trail = new BABYLON.ParticleSystem('trail', isGhost ? 150 : 400, this.scene);
    trail.particleTexture = new BABYLON.Texture('https://assets.babylonjs.com/textures/flare.png', this.scene);
    trail.emitter = rocketMesh;
    trail.minEmitBox = new BABYLON.Vector3(-0.1, -0.1, -0.1);
    trail.maxEmitBox = new BABYLON.Vector3(0.1, 0.1, 0.1);
    if (isGhost) {
      trail.color1 = new BABYLON.Color4(0.3, 0.6, 1, 0.6);
      trail.color2 = new BABYLON.Color4(0.5, 0.8, 1, 0.4);
      trail.colorDead = new BABYLON.Color4(0.1, 0.3, 0.8, 0);
    } else {
      trail.color1 = new BABYLON.Color4(1, 0.6, 0.2, 1);
      trail.color2 = new BABYLON.Color4(1, 0.4, 0, 0.9);
      trail.colorDead = new BABYLON.Color4(0.6, 0, 0, 0);
    }
    trail.minSize = 0.15;
    trail.maxSize = isGhost ? 0.3 : 0.5;
    trail.minLifeTime = 0.3;
    trail.maxLifeTime = 0.7;
    trail.emitRate = isGhost ? 80 : 200;
    trail.gravity = new BABYLON.Vector3(0, 0, 0);
    trail.direction1 = new BABYLON.Vector3(-1, -1, -1);
    trail.direction2 = new BABYLON.Vector3(1, 1, 1);
    trail.minAngularSpeed = 0;
    trail.maxAngularSpeed = Math.PI;
    trail.minEmitPower = 1.5;
    trail.maxEmitPower = 3;
    trail.start();

    // TrailMesh - delay by one frame to avoid origin artifacts
    const rocket = {
      id: rocketId,
      mesh: rocketMesh,
      body: rocketBody,
      trail,
      trailMesh: null as BABYLON.TrailMesh | null,
      hitboxMesh,
      createdAt: Date.now(),
      previousPosition: origin.clone(),
      pairedId: pairId,
      isGhost
    };

    setTimeout(() => {
      const trailMesh = new BABYLON.TrailMesh('rocketTrail', rocketMesh, this.scene, isGhost ? 0.15 : 0.3, 40, true);
      const trailMat = new BABYLON.StandardMaterial('rocketTrailMat', this.scene);
      if (isGhost) {
        trailMat.diffuseColor = new BABYLON.Color3(0.3, 0.6, 1);
        trailMat.emissiveColor = new BABYLON.Color3(0.1, 0.4, 1);
        trailMat.alpha = 0.4;
      } else {
        trailMat.diffuseColor = new BABYLON.Color3(1, 0.6, 0.2);
        trailMat.emissiveColor = new BABYLON.Color3(0.8, 0.3, 0);
        trailMat.alpha = 0.9;
      }
      trailMat.disableLighting = true;
      trailMesh.material = trailMat;
      rocket.trailMesh = trailMesh;
    }, 0);

    this.rockets.push(rocket);
  }

  update(deltaTime: number): void {
    // Handle continuous firing
    if (this.isFiring && this.camera) {
      const now = Date.now();
      if (now - this.lastFireTime >= this.fireRate) {
        this.lastFireTime = now;
        const direction = this.camera.getDirection(BABYLON.Axis.Z);
        const origin = this.camera.position.clone();
        this.fireRocket(origin, direction);
      }
    }

    // Update rockets and check for removal
    const rocketsToRemove: number[] = [];
    const now = Date.now();

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const rocket = this.rockets[i];
      
      // Store current position before updating
      const currentPosition = rocket.body.position.clone();
      
      // Swept collision detection: raycast from previous to current position
      const direction = currentPosition.subtract(rocket.previousPosition);
      const distance = direction.length();
      
      if (distance > 0) {
        // Calculate current hitbox radius based on age (expands over time)
        const age = (now - rocket.createdAt) / 1000; // Age in seconds
        const maxAge = 1.0;
        const expandFactor = Math.min(age / maxAge, 1.0);
        const hitboxRadius = 0.15 + (expandFactor * 4.85); // Expands from 0.15 to 5.0

        // Check enemy collision with shrinking hitbox (terrain handled by physics callback)
        const enemies = this.getEnemies();
        for (const enemy of enemies) {
          const distanceToEnemy = BABYLON.Vector3.Distance(currentPosition, enemy.mesh.position);
          const enemyRadius = 0.75; // Enemy sphere diameter is 1.5, so radius is 0.75

          // Check if enemy is within hitbox range
          if (distanceToEnemy < hitboxRadius + enemyRadius) {
            // Move projectile to enemy position
            rocket.mesh.position = enemy.mesh.position.clone();
            rocket.body.position = enemy.mesh.position.clone();

            if (!rocket.isGhost) {
              this.createExplosion(rocket.mesh.position);
              eventBus.emit(GameEvents.WEAPON_HIT, { enemyId: enemy.id, position: rocket.mesh.position });
              this.onEnemyHit(enemy.id, rocket.mesh.position);
              // Kill paired ghost
              const ghostIdx = this.rockets.findIndex(r => r.pairedId === rocket.pairedId && r.isGhost);
              if (ghostIdx !== -1 && !rocketsToRemove.includes(ghostIdx)) rocketsToRemove.push(ghostIdx);
            }
            rocketsToRemove.push(i);
            break;
          }
        }

        if (rocketsToRemove.includes(i)) continue;
      }
      
      // Update mesh position to match physics body
      rocket.mesh.position = currentPosition;
      rocket.hitboxMesh.position = currentPosition;

      // Expand hitbox over time (starts at 0.3, expands to 10.0 over 1 second)
      // This makes long-range hits easier for casual players
      const age = (now - rocket.createdAt) / 1000; // Age in seconds
      const maxAge = 1.0;
      const expandFactor = Math.min(age / maxAge, 1.0);
      const hitboxScale = 0.3 + (expandFactor * 9.7); // Expands from 0.3 to 10.0
      rocket.hitboxMesh.scaling = new BABYLON.Vector3(hitboxScale, hitboxScale, hitboxScale);

      // Store previous position for next frame
      rocket.previousPosition = currentPosition.clone();

      // Check lifetime
      if (now - rocket.createdAt > 10000) {
        rocketsToRemove.push(i);
        // Kill paired ghost if this is the real rocket
        if (!rocket.isGhost && rocket.pairedId) {
          const ghostIdx = this.rockets.findIndex(r => r.pairedId === rocket.pairedId && r.isGhost);
          if (ghostIdx !== -1 && !rocketsToRemove.includes(ghostIdx)) rocketsToRemove.push(ghostIdx);
        }
      }
    }

    // Remove marked rockets
    rocketsToRemove.forEach(index => {
      this.removeRocket(index);
    });
  }

  private createExplosion(position: BABYLON.Vector3): void {
    this.vfxSystem.spawnExplosion(position);
  }

  private removeRocket(index: number): void {
    const rocket = this.rockets[index];
    
    // Stop trail from emitting new particles, but let existing ones fade out
    rocket.trail.stop();
    
    // Delay all disposal to allow particles to fade out naturally
    // The trail emitter is attached to the rocket mesh, so we must delay mesh disposal too
    setTimeout(() => {
      rocket.trail.dispose();
      if (rocket.trailMesh) {
        rocket.trailMesh.dispose();
      }
      rocket.hitboxMesh.dispose();
      rocket.mesh.dispose();
    }, 1000); // 1 second fade out
    
    // Immediately remove physics body and from array
    this.physics.removeBody(rocket.body);
    this.rockets.splice(index, 1);
  }
}
