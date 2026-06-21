import * as BABYLON from '@babylonjs/core';
import type { ISystem } from '../core/ISystem';

/**
 * VFX System - Centralized visual effects management
 * Handles all particle effects, explosions, and visual feedback
 * Separated from game logic for clean architecture
 */
export class VFXSystem implements ISystem {
  private scene: BABYLON.Scene;
  private particleTexture: BABYLON.Texture | null = null;
  public readonly updateOrder = 50; // VFX should update early

  constructor(scene: BABYLON.Scene) {
    this.scene = scene;
  }

  /**
   * Initialize the VFX system (load shared resources)
   */
  public initialize(): void {
    this.particleTexture = this.createParticleTexture();
  }

  /**
   * Update the VFX system (particle systems update automatically via Babylon.js)
   */
  public update(dt: number): void {
    // Babylon.js particle systems update automatically
    // This method is kept for ISystem compliance
  }

  /**
   * Create a particle texture for the VFX system
   */
  private createParticleTexture(): BABYLON.Texture {
    // Use a proper particle texture for better visual quality
    return new BABYLON.Texture('https://assets.babylonjs.com/textures/flare.png', this.scene);
  }

  /**
   * Spawn an explosion at the given position
   */
  public spawnExplosion(position: BABYLON.Vector3): void {
    if (!this.particleTexture) {
      return;
    }

    this.createExplosionLayers(position, this.particleTexture);
  }

  /**
   * Create all explosion layers
   */
  private createExplosionLayers(position: BABYLON.Vector3, texture: BABYLON.Texture): void {
    // --- BURST: white-hot core flash (very short, very large) ---
    const flash = new BABYLON.ParticleSystem('flash', 80, this.scene);
    flash.particleTexture = texture;
    flash.emitter = position.clone() as BABYLON.Vector3;
    flash.createPointEmitter(BABYLON.Vector3.Zero(), BABYLON.Vector3.Zero());
    flash.minSize = 6; flash.maxSize = 10;
    flash.minLifeTime = 0.08; flash.maxLifeTime = 0.12;
    flash.emitRate = 80;
    flash.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    flash.color1 = new BABYLON.Color4(1, 1, 0.9, 1);
    flash.color2 = new BABYLON.Color4(1, 0.9, 0.6, 1);
    flash.colorDead = new BABYLON.Color4(1, 0.5, 0, 0);
    flash.minEmitPower = 0; flash.maxEmitPower = 0;
    flash.targetStopDuration = 0.05;
    flash.disposeOnStop = true;
    flash.start();

    // --- FIREBALL: main orange/red expanding ball ---
    const fireball = new BABYLON.ParticleSystem('fireball', 300, this.scene);
    fireball.particleTexture = texture;
    fireball.emitter = position.clone() as BABYLON.Vector3;
    fireball.createSphereEmitter(0.5);
    fireball.minSize = 2; fireball.maxSize = 6;
    fireball.minLifeTime = 0.4; fireball.maxLifeTime = 0.8;
    fireball.emitRate = 300;
    fireball.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    fireball.gravity = new BABYLON.Vector3(0, 3, 0);
    fireball.direction1 = new BABYLON.Vector3(-4, -2, -4);
    fireball.direction2 = new BABYLON.Vector3(4, 6, 4);
    fireball.minEmitPower = 4; fireball.maxEmitPower = 12;
    fireball.minAngularSpeed = 0; fireball.maxAngularSpeed = Math.PI;
    fireball.addColorGradient(0,   new BABYLON.Color4(1,   1,   0.8, 1));
    fireball.addColorGradient(0.2, new BABYLON.Color4(1,   0.7, 0.1, 1));
    fireball.addColorGradient(0.5, new BABYLON.Color4(1,   0.3, 0,   0.8));
    fireball.addColorGradient(0.8, new BABYLON.Color4(0.5, 0.1, 0,   0.4));
    fireball.addColorGradient(1,   new BABYLON.Color4(0.1, 0,   0,   0));
    fireball.addSizeGradient(0, 2); fireball.addSizeGradient(0.3, 5);
    fireball.addSizeGradient(0.7, 4); fireball.addSizeGradient(1, 0.5);
    fireball.targetStopDuration = 0.25;
    fireball.disposeOnStop = true;
    fireball.start();

    // --- SMOKE: dark billowing puffs, big, slow ---
    const smoke = new BABYLON.ParticleSystem('smoke', 60, this.scene);
    smoke.particleTexture = texture;
    smoke.emitter = position.clone() as BABYLON.Vector3;
    smoke.createSphereEmitter(1);
    smoke.minSize = 3; smoke.maxSize = 7;
    smoke.minLifeTime = 1.5; smoke.maxLifeTime = 3.5;
    smoke.emitRate = 60;
    smoke.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    smoke.gravity = new BABYLON.Vector3(0, 1.5, 0);
    smoke.direction1 = new BABYLON.Vector3(-1, 2, -1);
    smoke.direction2 = new BABYLON.Vector3(1, 5, 1);
    smoke.minEmitPower = 1; smoke.maxEmitPower = 3;
    smoke.minAngularSpeed = -1; smoke.maxAngularSpeed = 1;
    smoke.addColorGradient(0,   new BABYLON.Color4(0.4,  0.25, 0.1, 0));
    smoke.addColorGradient(0.1, new BABYLON.Color4(0.35, 0.2,  0.1, 0.5));
    smoke.addColorGradient(0.5, new BABYLON.Color4(0.2,  0.15, 0.1, 0.25));
    smoke.addColorGradient(1,   new BABYLON.Color4(0.08, 0.06, 0.05, 0));
    smoke.addSizeGradient(0, 3); smoke.addSizeGradient(0.5, 6); smoke.addSizeGradient(1, 9);
    smoke.targetStopDuration = 0.4;
    smoke.disposeOnStop = true;
    smoke.start();

    // --- SPARKS: tiny fast bright streaks flying outward ---
    const sparks = new BABYLON.ParticleSystem('sparks', 150, this.scene);
    sparks.particleTexture = texture;
    sparks.emitter = position.clone() as BABYLON.Vector3;
    sparks.createPointEmitter(new BABYLON.Vector3(-1,-1,-1), new BABYLON.Vector3(1,1,1));
    sparks.minSize = 0.1; sparks.maxSize = 0.3;
    sparks.minLifeTime = 0.5; sparks.maxLifeTime = 1.2;
    sparks.emitRate = 150;
    sparks.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    sparks.gravity = new BABYLON.Vector3(0, -15, 0);
    sparks.minEmitPower = 15; sparks.maxEmitPower = 35;
    sparks.color1 = new BABYLON.Color4(1, 0.9, 0.4, 1);
    sparks.color2 = new BABYLON.Color4(1, 0.6, 0.1, 1);
    sparks.colorDead = new BABYLON.Color4(0.5, 0.1, 0, 0);
    sparks.targetStopDuration = 0.1;
    sparks.disposeOnStop = true;
    sparks.start();

    // --- SHOCKWAVE RING: particle ring expanding outward on ground plane ---
    this.createShockwaveRing(position);

    // --- LIGHT FLASH ---
    this.createLightFlash(position);
  }

  /**
   * Shockwave as a fast-expanding ring of additive particles — no mesh geometry
   */
  private createShockwaveRing(position: BABYLON.Vector3): void {
    const count = 80;
    const duration = 0.5;
    const maxRadius = 10;

    const ring = new BABYLON.ParticleSystem('shockRing', count, this.scene);
    ring.particleTexture = new BABYLON.Texture('https://assets.babylonjs.com/textures/flare.png', this.scene);
    ring.emitter = position.clone() as BABYLON.Vector3;
    ring.createConeEmitter(0.1, Math.PI / 2); // Flat cone = ring on XZ plane
    ring.minSize = 0.8; ring.maxSize = 1.5;
    ring.minLifeTime = duration; ring.maxLifeTime = duration;
    ring.emitRate = count;
    ring.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    ring.gravity = BABYLON.Vector3.Zero();
    ring.minEmitPower = maxRadius / duration;
    ring.maxEmitPower = maxRadius / duration;
    ring.color1 = new BABYLON.Color4(1, 0.8, 0.4, 1);
    ring.color2 = new BABYLON.Color4(1, 0.6, 0.2, 0.8);
    ring.colorDead = new BABYLON.Color4(0.8, 0.3, 0, 0);
    ring.addSizeGradient(0, 1.5); ring.addSizeGradient(0.5, 1.0); ring.addSizeGradient(1, 0.1);
    ring.targetStopDuration = 0.05;
    ring.disposeOnStop = true;
    ring.start();
  }

  /**
   * Create a light flash effect
   */
  private createLightFlash(position: BABYLON.Vector3): void {
    const explosionLight = new BABYLON.PointLight('explosionLight', position.clone(), this.scene);
    explosionLight.intensity = 100;
    explosionLight.diffuse = new BABYLON.Color3(1, 0.9, 0.7);
    explosionLight.specular = new BABYLON.Color3(1, 0.8, 0.5);
    explosionLight.range = 30;
    
    const startTime = Date.now();
    const duration = 300;
    
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = elapsed / duration;
      
      if (progress >= 1) {
        explosionLight.dispose();
        return;
      }
      
      const intensity = 100 * Math.exp(-progress * 5);
      explosionLight.intensity = intensity;
      explosionLight.range = 30 * (1 - progress * 0.5);
      
      requestAnimationFrame(animate);
    };
    
    animate();
  }

  /**
   * Cleanup all VFX resources
   */
  public dispose(): void {
    if (this.particleTexture) {
      this.particleTexture.dispose();
      this.particleTexture = null;
    }
  }
}
