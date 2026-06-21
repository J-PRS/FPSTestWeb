import * as BABYLON from '@babylonjs/core';
import { CustomPhysics, type RigidBody } from './customPhysics';
import type { ISystem } from './core/ISystem';

export class JetpackSystem implements ISystem {
  private scene: BABYLON.Scene;
  private physics: CustomPhysics;
  private playerBody: RigidBody | null = null;
  private isActive = false;
  private jetpackForce = 8.0; // Upward force when active (VERY strong)
  private maxFuel = 100;
  private currentFuel = 100;
  private fuelConsumptionRate = 20; // Fuel per second
  private fuelRegenerationRate = 10; // Fuel per second when not in use
  private particleSystem: BABYLON.ParticleSystem | null = null;
  private jetpackSound: BABYLON.Sound | null = null;
  public readonly updateOrder = 45; // Jetpack after player controller

  constructor(scene: BABYLON.Scene, physics: CustomPhysics) {
    this.scene = scene;
    this.physics = physics;
  }

  public initialize(): void {
    this.createParticleSystem();
  }

  setPlayerBody(playerBody: RigidBody): void {
    this.playerBody = playerBody;
  }

  setActive(active: boolean): void {
    this.isActive = active;
    // console.log(`Jetpack setActive: ${active}, fuel: ${this.currentFuel}`);
    if (active && this.currentFuel > 0) {
      this.startJetpackEffect();
    } else {
      this.stopJetpackEffect();
    }
  }

  update(deltaTime: number): void {
    // Update fuel
    if (this.isActive && this.currentFuel > 0) {
      this.currentFuel = Math.max(0, this.currentFuel - this.fuelConsumptionRate * deltaTime);
      if (this.currentFuel <= 0) {
        this.stopJetpackEffect();
      }
    } else if (!this.isActive && this.currentFuel < this.maxFuel) {
      this.currentFuel = Math.min(this.maxFuel, this.currentFuel + this.fuelRegenerationRate * deltaTime);
    }

    // Apply jetpack force
    if (this.isActive && this.currentFuel > 0) {
      if (this.playerBody) {
        // Custom physics body
        const force = this.jetpackForce * deltaTime;
        this.playerBody.velocity.y += force;
        
        // console.log(`Jetpack applying force: ${force}, new velocity: ${this.playerBody.velocity.y}`);
        
        // Limit maximum upward velocity
        this.playerBody.velocity.y = Math.min(this.playerBody.velocity.y, 15);
      }
      
      // Update particle system position
      if (this.particleSystem && this.playerBody && this.playerBody.mesh) {
        this.particleSystem.emitter = this.playerBody.mesh;
      }
    }
  }

  private createParticleSystem(): void {
    this.particleSystem = new BABYLON.ParticleSystem('jetpackParticles', 200, this.scene);
    
    // Texture of each particle
    this.particleSystem.particleTexture = new BABYLON.Texture('https://www.babylonjs.com/assets/Flare.png', this.scene);

    // Where the particles come from
    this.particleSystem.emitter = BABYLON.Vector3.Zero();
    this.particleSystem.minEmitBox = new BABYLON.Vector3(-0.2, -0.5, -0.2);
    this.particleSystem.maxEmitBox = new BABYLON.Vector3(0.2, -0.5, 0.2);

    // Colors of all particles
    this.particleSystem.color1 = new BABYLON.Color4(0.7, 0.3, 0.1, 1.0); // Orange
    this.particleSystem.color2 = new BABYLON.Color4(1.0, 0.6, 0.2, 1.0); // Yellow-orange
    this.particleSystem.colorDead = new BABYLON.Color4(0, 0, 0, 0.0);

    // Size of each particle
    this.particleSystem.minSize = 0.1;
    this.particleSystem.maxSize = 0.3;

    // Life time of each particle
    this.particleSystem.minLifeTime = 0.3;
    this.particleSystem.maxLifeTime = 0.8;

    // Emission rate
    this.particleSystem.emitRate = 0;

    // Blend mode
    this.particleSystem.blendMode = BABYLON.ParticleSystem.BLENDMODE_ONEONE;

    // Set the gravity of all particles
    this.particleSystem.gravity = new BABYLON.Vector3(0, -2, 0);

    // Direction of each particle after it has been emitted
    this.particleSystem.direction1 = new BABYLON.Vector3(-0.5, -2, -0.5);
    this.particleSystem.direction2 = new BABYLON.Vector3(0.5, -2, 0.5);

    // Angular speed
    this.particleSystem.minAngularSpeed = 0;
    this.particleSystem.maxAngularSpeed = Math.PI;

    // Speed
    this.particleSystem.minEmitPower = 3;
    this.particleSystem.maxEmitPower = 6;

    // Start the particle system
    this.particleSystem.start();
  }

  private startJetpackEffect(): void {
    if (this.particleSystem) {
      this.particleSystem.emitRate = 150;
    }
  }

  private stopJetpackEffect(): void {
    if (this.particleSystem) {
      this.particleSystem.emitRate = 0;
    }
  }

  getFuelLevel(): number {
    return this.currentFuel;
  }

  getFuelPercentage(): number {
    return this.currentFuel / this.maxFuel;
  }

  isJetpackActive(): boolean {
    return this.isActive && this.currentFuel > 0;
  }

  public dispose(): void {
    if (this.particleSystem) {
      this.particleSystem.dispose();
    }
    if (this.jetpackSound) {
      this.jetpackSound.dispose();
    }
  }
}
