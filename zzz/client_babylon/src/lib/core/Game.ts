import * as BABYLON from '@babylonjs/core';
import { CustomPhysics } from '../customPhysics';
import { PlayerController } from '../playerController';
import { WeaponSystem } from '../weaponSystem';
import { EnemySystem } from '../enemySystem';
import { JetpackSystem } from '../JetpackSystem';
import { VFXSystem } from '../vfx/vfxSystem';
import { TribesPhysics } from '../tribesPhysics';
import { EntityManager } from './EntityManager';
import { SystemManager } from './SystemManager';
import { eventBus } from './EventBus';
import { createScene } from '../scene';

export interface GameSystems {
  scene: BABYLON.Scene;
  camera: BABYLON.UniversalCamera;
  ground: BABYLON.Mesh;
  heightmapData: Float32Array;
  playerMesh: BABYLON.Mesh;
  playerController: PlayerController;
  weaponSystem: WeaponSystem;
  enemySystem: EnemySystem;
  jetpackSystem: JetpackSystem;
  vfxSystem: VFXSystem;
  physics: CustomPhysics;
  tribesPhysics: TribesPhysics;
  entityManager: EntityManager;
}

export class Game {
  private engine: BABYLON.Engine;
  private systemManager: SystemManager;
  private systems: GameSystems | null = null;
  private isRunning = false;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new BABYLON.Engine(canvas, true);
    this.systemManager = new SystemManager(eventBus);
  }

  async initialize(): Promise<void> {
    // Create scene first
    const sceneSetup = createScene(this.engine);

    // Initialize custom physics
    const physics = new CustomPhysics();

    // Create player mesh (simple capsule without physics body)
    const playerMesh = BABYLON.MeshBuilder.CreateCapsule("player", { height: 2, radius: 0.5 }, sceneSetup.scene);
    playerMesh.position = new BABYLON.Vector3(0, 20, 0);

    // Initialize player controller with proper physics
    const playerController = new PlayerController(
      sceneSetup.camera,
      sceneSetup.scene,
      sceneSetup.heightmapData,
      0.002, // look sensitivity
      false, // invert Y
      physics, // Keep custom physics for now
      playerMesh, // Add player mesh reference
      sceneSetup.ground // Pass ground mesh for Tribes physics
    );
    playerController.setPlayerMesh(sceneSetup.playerMesh);

    // Initialize Tribes physics for player
    const tribesPhysics = new TribesPhysics(
      sceneSetup.scene,
      sceneSetup.ground,
      new BABYLON.Vector3(0, 20, 0)
    );

    // Initialize entity manager
    const entityManager = new EntityManager();

    // Initialize enemy system
    const enemySystem = new EnemySystem(sceneSetup.scene, physics, entityManager);
    enemySystem.setGroundMesh(sceneSetup.ground);
    enemySystem.startSpawning();

    // Initialize VFX system
    const vfxSystem = new VFXSystem(sceneSetup.scene);

    // Initialize weapon system
    const weaponSystem = new WeaponSystem(sceneSetup.scene, physics, vfxSystem);
    weaponSystem.setCamera(sceneSetup.camera);
    weaponSystem.setGroundMesh(sceneSetup.ground);
    weaponSystem.setEnemyCallbacks(
      () => enemySystem.getEnemies(),
      (enemyId: string, position: BABYLON.Vector3) => {
        enemySystem.destroyEnemyById(enemyId);
      }
    );

    // Initialize jetpack system
    const jetpackSystem = new JetpackSystem(sceneSetup.scene, physics);
    
    // Connect player controller to jetpack system
    playerController.setJetpackSystem(jetpackSystem);

    // Register systems with SystemManager
    this.systemManager.register('physics', physics, 10);
    this.systemManager.register('tribesPhysics', tribesPhysics, 15);
    this.systemManager.register('entityManager', entityManager, 25);
    this.systemManager.register('vfx', vfxSystem, 60);
    this.systemManager.register('enemy', enemySystem, 20);
    this.systemManager.register('player', playerController, 30);
    this.systemManager.register('jetpack', jetpackSystem, 35);
    this.systemManager.register('weapon', weaponSystem, 50);

    // Initialize all systems
    await this.systemManager.initializeAll();

    this.systems = {
      ...sceneSetup,
      playerController,
      weaponSystem,
      enemySystem,
      jetpackSystem,
      vfxSystem,
      physics,
      tribesPhysics,
      entityManager
    };
  }

  start(): void {
    if (!this.systems) {
      throw new Error('Game not initialized. Call initialize() first.');
    }

    this.isRunning = true;
    this.engine.runRenderLoop(() => {
      if (!this.isRunning || !this.systems) return;

      // Push last frame's player velocity to weapon system before update
      const playerVelocity = this.systems.playerController.getVelocity();
      this.systems.weaponSystem.setPlayerVelocity(playerVelocity);

      // Update all registered systems via SystemManager (handles update ordering)
      const dt = this.engine.getDeltaTime() / 1000;
      this.systemManager.updateAll(dt);

      // Get player position for enemy targeting (after update)
      const playerPosition = this.systems.playerController.getPosition();
      this.systems.enemySystem.setPlayerPosition(playerPosition);

      // Render scene
      this.systems.scene.render();
    });
  }

  stop(): void {
    this.isRunning = false;
    this.systemManager.disposeAll();
  }

  getSystems(): GameSystems {
    if (!this.systems) {
      throw new Error('Game not initialized. Call initialize() first.');
    }
    return this.systems;
  }

  dispose(): void {
    this.stop();
    
    if (this.systems) {
      this.systems.weaponSystem.dispose();
      this.systems.enemySystem.dispose();
      this.systems.jetpackSystem.dispose();
      this.systems.scene.dispose();
    }
    
    this.engine.dispose();
  }
}
