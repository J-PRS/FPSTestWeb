import * as BABYLON from '@babylonjs/core';
import { CustomPhysics, type RigidBody } from './customPhysics';
import type { ISystem } from './core/ISystem';
import { EntityManager, type Entity } from './core/EntityManager';
import { eventBus, GameEvents } from './core/EventBus';

export interface Enemy {
  id: string;
  mesh: BABYLON.Mesh;
  body: RigidBody;
  trailSystem: BABYLON.ParticleSystem;
  trailMesh: BABYLON.TrailMesh;
}

export class EnemySystem implements ISystem {
  private scene: BABYLON.Scene;
  private physics: CustomPhysics;
  private enemies: Enemy[] = [];
  private entityManager: EntityManager | null = null;
  private spawnInterval: number | null = null;
  private maxEnemies = 10;
  private playerPosition = new BABYLON.Vector3(0, 0, 0);
  private groundMesh: BABYLON.Mesh | undefined = undefined;
  public readonly updateOrder = 20; // Enemies update after physics

  constructor(scene: BABYLON.Scene, physics: CustomPhysics, entityManager?: EntityManager) {
    this.scene = scene;
    this.physics = physics;
    this.entityManager = entityManager || null;
  }

  public initialize(): void {
    // Enemy system doesn't need initialization
  }

  public dispose(): void {
    this.stopSpawning();
    this.enemies.forEach(enemy => {
      enemy.trailSystem.stop();
      enemy.trailSystem.dispose();
      enemy.trailMesh.dispose();
      this.physics.removeBody(enemy.body);
      enemy.mesh.dispose();
    });
    this.enemies = [];
  }

  setGroundMesh(groundMesh: BABYLON.Mesh): void {
    this.groundMesh = groundMesh;
  }

  setPlayerPosition(position: BABYLON.Vector3): void {
    this.playerPosition = position.clone();
  }

  startSpawning(): void {
    // Spawn initial enemies
    for (let i = 0; i < 5; i++) {
      this.spawnEnemy();
    }

    // Spawn new enemy every 3 seconds
    this.spawnInterval = window.setInterval(() => {
      if (this.enemies.length < this.maxEnemies) {
        this.spawnEnemy();
      }
    }, 3000);
  }

  stopSpawning(): void {
    if (this.spawnInterval) {
      clearInterval(this.spawnInterval);
      this.spawnInterval = null;
    }
  }

  private spawnEnemy(): void {
    const enemyId = `enemy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Random position closer to player (30-60 units away)
    const angle = Math.random() * Math.PI * 2;
    const distance = 30 + Math.random() * 30; // 30-60 units
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance - 50; // Offset to be in front of spawn
    
    // Spawn high above terrain - gravity will bring them down
    const spawnY = 50 + Math.random() * 20; // 50-70 units above ground

    // Create enemy ball
    const enemyMesh = BABYLON.MeshBuilder.CreateSphere('enemy', { diameter: 1.5 }, this.scene);
    enemyMesh.position = new BABYLON.Vector3(x, spawnY, z);

    // Enemy material (red with glow)
    const enemyMat = new BABYLON.StandardMaterial('enemyMat', this.scene);
    enemyMat.diffuseColor = new BABYLON.Color3(1, 0.2, 0.2);
    enemyMat.emissiveColor = new BABYLON.Color3(0.5, 0, 0);
    enemyMat.specularColor = new BABYLON.Color3(0.8, 0.3, 0.3);
    enemyMesh.material = enemyMat;

    // Create particle trail system
    const trailSystem = new BABYLON.ParticleSystem('trail', 500, this.scene);
    trailSystem.particleTexture = new BABYLON.Texture('https://assets.babylonjs.com/textures/flare.png', this.scene);
    trailSystem.emitter = enemyMesh;
    trailSystem.minEmitBox = new BABYLON.Vector3(-0.5, -0.5, -0.5);
    trailSystem.maxEmitBox = new BABYLON.Vector3(0.5, 0.5, 0.5);
    trailSystem.color1 = new BABYLON.Color4(1, 0.5, 0.2, 1); // Bright orange-red
    trailSystem.color2 = new BABYLON.Color4(1, 0.3, 0, 0.8); // Orange with high opacity
    trailSystem.colorDead = new BABYLON.Color4(0.8, 0.1, 0, 0);
    trailSystem.minSize = 0.3;
    trailSystem.maxSize = 0.6;
    trailSystem.minLifeTime = 0.5;
    trailSystem.maxLifeTime = 1.2;
    trailSystem.emitRate = 150;
    trailSystem.gravity = new BABYLON.Vector3(0, -0.3, 0);
    trailSystem.direction1 = new BABYLON.Vector3(-1, -1, -1);
    trailSystem.direction2 = new BABYLON.Vector3(1, 1, 1);
    trailSystem.minAngularSpeed = 0;
    trailSystem.maxAngularSpeed = Math.PI;
    trailSystem.minEmitPower = 1;
    trailSystem.maxEmitPower = 2;
    trailSystem.updateSpeed = 0.01;
    trailSystem.start();

    // Create wide line trail mesh using TrailMesh class
    const trailMesh = new BABYLON.TrailMesh('trailMesh', enemyMesh, this.scene, 0.5, 30, true);
    const trailMat = new BABYLON.StandardMaterial('trailMat', this.scene);
    trailMat.diffuseColor = new BABYLON.Color3(1, 0.4, 0.2);
    trailMat.emissiveColor = new BABYLON.Color3(0.6, 0.2, 0);
    trailMat.alpha = 0.8;
    trailMat.disableLighting = true;
    trailMesh.material = trailMat;

    // Create custom physics body
    const enemyBody = this.physics.createBody({
      position: new BABYLON.Vector3(x, spawnY, z),
      velocity: new BABYLON.Vector3(
        (Math.random() - 0.5) * 3,  // Less side velocity
        5 + Math.random() * 5,       // More upward velocity
        (Math.random() - 0.5) * 3   // Less side velocity
      ),
      mass: 5,
      radius: 0.75,
      restitution: 1.0, // Perfect elasticity
      friction: 0, // No friction for perfect bounce
      gravityScale: 1,
      mesh: enemyMesh,
      entityId: enemyId,
      scene: this.scene,
      groundMesh: this.groundMesh
    });

    this.enemies.push({
      id: enemyId,
      mesh: enemyMesh,
      body: enemyBody,
      trailSystem,
      trailMesh
    });

    eventBus.emit(GameEvents.ENEMY_SPAWNED, { id: enemyId, position: enemyMesh.position });
  }

  update(dt: number): void {
    // Update mesh positions to match physics bodies
    this.enemies.forEach(enemy => {
      enemy.mesh.position = enemy.body.position.clone();
    });

    // Respawn enemies that fall off the map near the player
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      
      // Check if outside terrain bounds (x or z beyond 250, or too low)
      const outsideBounds = 
        Math.abs(enemy.mesh.position.x) > 250 ||
        Math.abs(enemy.mesh.position.z) > 250 ||
        enemy.mesh.position.y < -50;
      
      if (outsideBounds) {
        // Respawn near player at random position
        const angle = Math.random() * Math.PI * 2;
        const distance = 30 + Math.random() * 50; // 30-80 units from player
        const spawnX = this.playerPosition.x + Math.cos(angle) * distance;
        const spawnZ = this.playerPosition.z + Math.sin(angle) * distance;
        
        // Spawn high above terrain - gravity will bring them down
        const spawnY = 50;
        
        // Reset enemy position and velocity
        enemy.body.position = new BABYLON.Vector3(spawnX, spawnY, spawnZ);
        enemy.body.velocity = new BABYLON.Vector3(
          (Math.random() - 0.5) * 3,  // Less side velocity
          5 + Math.random() * 5,       // More upward velocity
          (Math.random() - 0.5) * 3   // Less side velocity
        );
        enemy.mesh.position = enemy.body.position.clone();
      }
    }
  }

  removeEnemy(index: number): void {
    const enemy = this.enemies[index];
    
    // Stop trail from emitting new particles, but let existing ones fade out
    enemy.trailSystem.stop();
    
    // Delay trail disposal to allow particles to fade out naturally
    setTimeout(() => {
      enemy.trailSystem.dispose();
      enemy.trailMesh.dispose();
    }, 1000); // 1 second fade out
    
    // Immediately dispose other elements
    this.physics.removeBody(enemy.body);
    enemy.mesh.dispose();
    this.enemies.splice(index, 1);
  }

  getEnemies(): Enemy[] {
    return this.enemies;
  }

  destroyEnemyById(enemyId: string): void {
    const index = this.enemies.findIndex(e => e.id === enemyId);
    if (index !== -1) {
      const enemy = this.enemies[index];
      eventBus.emit(GameEvents.ENEMY_DIED, { id: enemyId, position: enemy.mesh.position });
      this.removeEnemy(index);
    }
  }
}
