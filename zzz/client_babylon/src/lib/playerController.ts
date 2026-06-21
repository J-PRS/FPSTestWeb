import * as BABYLON from '@babylonjs/core';
import { getTerrainHeight } from './scene';
import { type InputState } from './core';
import { CustomPhysics, type RigidBody } from './customPhysics';
import { JetpackSystem } from './JetpackSystem';
import { TribesPhysics } from './tribesPhysics';
import type { ISystem } from './core/ISystem';
import { eventBus, GameEvents } from './core/EventBus';

export interface PlayerState {
  position: BABYLON.Vector3;
  rotation: BABYLON.Vector3;
}

export class PlayerController implements ISystem {
  private camera: BABYLON.UniversalCamera;
  private scene: BABYLON.Scene;
  private heightmapData: Float32Array;
  private playerMesh: BABYLON.Mesh | null = null;
  private physics: CustomPhysics | null = null;
  private playerBody: RigidBody | null = null;
  private jetpackSystem: JetpackSystem | null = null;
  private tribesPhysics: TribesPhysics | null = null;
  private moveSpeed = 0.15;
  private jumpForce = 5.0; // Physics-based jump velocity
  private jumpGracePeriod = 0.5; // Allow jump if vertical velocity is below this threshold
  private verticalVelocity = 0;
  private lookSensitivity: number;
  private invertY: boolean;
  private isThirdPerson = false;
  private thirdPersonDistance = 3;
  private thirdPersonHeight = 1.5;
  private playerPosition: BABYLON.Vector3; // Actual player position (camera is offset from this)
  private cameraYaw = 0; // Horizontal camera angle for third person
  private cameraPitch = 0; // Vertical camera angle for third person
  private currentInput: InputState | null = null; // Current input from EventBus
  public readonly updateOrder = 40; // Player controller after weapons

  constructor(
    camera: BABYLON.UniversalCamera,
    scene: BABYLON.Scene,
    heightmapData: Float32Array,
    lookSensitivity: number,
    invertY: boolean,
    physics?: CustomPhysics,
    playerMesh?: BABYLON.Mesh,
    groundMesh?: BABYLON.Mesh
  ) {
    this.camera = camera;
    this.scene = scene;
    this.heightmapData = heightmapData;
    this.physics = physics || null;
    this.lookSensitivity = lookSensitivity;
    this.invertY = invertY;
    this.playerMesh = playerMesh || null;
    this.playerPosition = camera.position.clone();
    
    // Initialize Tribes physics if ground mesh is provided
    if (groundMesh) {
      this.tribesPhysics = new TribesPhysics(scene, groundMesh, this.playerPosition);
    }
    
    // Ensure player starts above terrain (aggressive check)
    const terrainHeight = getTerrainHeight(this.heightmapData, this.playerPosition.x, this.playerPosition.z);
    const safeHeight = Math.max(terrainHeight + 10, 20);
    if (this.playerPosition.y < safeHeight) {
      this.playerPosition.y = safeHeight;
    }
    
    // Use Babylon.js physics body if player mesh has one
    if (this.playerMesh && this.playerMesh.physicsBody) {
      // The player mesh already has a proper Babylon.js physics body
    } else if (this.physics) {
      // Fallback to custom physics body
      this.playerBody = this.physics.createBody({
        position: this.playerPosition.clone(),
        velocity: BABYLON.Vector3.Zero(),
        mass: 1,
        radius: 0.5, // Player collision radius
        restitution: 0.1, // Low bounciness
        friction: 0.8, // High friction for stable movement
        gravityScale: 1,
        isKinematic: false,
        entityId: 'player'
      });
    }
  }

  setJetpackSystem(jetpackSystem: JetpackSystem): void {
    this.jetpackSystem = jetpackSystem;
    if (this.playerBody) {
      this.jetpackSystem.setPlayerBody(this.playerBody);
    }
  }

  setPlayerMesh(mesh: BABYLON.Mesh) {
    this.playerMesh = mesh;
  }

  toggleViewMode() {
    this.isThirdPerson = !this.isThirdPerson;
    if (this.playerMesh) {
      this.playerMesh.setEnabled(this.isThirdPerson);
    }
    
    if (this.isThirdPerson) {
      // Initialize orbit angles from current camera rotation
      this.cameraYaw = this.camera.rotation.y;
      this.cameraPitch = this.camera.rotation.x;
    } else {
      // Reset camera target when switching back to first person
      this.camera.setTarget(BABYLON.Vector3.Zero());
    }
  }

  setLookSensitivity(value: number) {
    this.lookSensitivity = value;
  }

  setInvertY(value: boolean) {
    this.invertY = value;
  }

  getPosition(): BABYLON.Vector3 {
    return this.playerPosition.clone();
  }

  getVelocity(): BABYLON.Vector3 {
    if (this.tribesPhysics) {
      return this.tribesPhysics.getState().velocity.clone();
    }
    if (this.playerBody) {
      return this.playerBody.velocity.clone();
    }
    return BABYLON.Vector3.Zero();
  }

  private updateTribesPhysics(dt: number): PlayerState {
    // Get input from EventBus
    const input = this.currentInput || {
      forward: false,
      backward: false,
      left: false,
      right: false,
      jump: false,
      shoot: false,
      sprint: false,
      crouch: false,
      reload: false,
      menu: false,
      mouseDeltaX: 0,
      mouseDeltaY: 0,
      jetpack: false
    };
    
    // Handle mouse look
    if (input.mouseDeltaX !== 0 || input.mouseDeltaY !== 0) {
      if (this.isThirdPerson) {
        this.cameraYaw += input.mouseDeltaX * this.lookSensitivity;
        const yDelta = this.invertY ? -input.mouseDeltaY : input.mouseDeltaY;
        this.cameraPitch += yDelta * this.lookSensitivity;
        this.cameraPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 6, this.cameraPitch));
      } else {
        this.camera.rotation.y += input.mouseDeltaX * this.lookSensitivity;
        this.camera.rotation.y = ((this.camera.rotation.y + Math.PI) % (2 * Math.PI)) - Math.PI;
        const yDelta = this.invertY ? -input.mouseDeltaY : input.mouseDeltaY;
        this.camera.rotation.x += yDelta * this.lookSensitivity;
        this.camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.camera.rotation.x));
      }
    }
    
    // Update Tribes physics
    this.tribesPhysics!.tick(input, dt);
    
    // Get updated state
    const state = this.tribesPhysics!.getState();
    this.playerPosition = state.position;
    
    // Update camera position
    if (this.isThirdPerson) {
      const cosPitch = Math.cos(this.cameraPitch);
      const sinPitch = Math.sin(this.cameraPitch);
      const cosYaw = Math.cos(this.cameraYaw);
      const sinYaw = Math.sin(this.cameraYaw);
      
      const cameraOffsetX = this.thirdPersonDistance * cosPitch * sinYaw;
      const cameraOffsetY = this.thirdPersonDistance * sinPitch + this.thirdPersonHeight;
      const cameraOffsetZ = this.thirdPersonDistance * cosPitch * cosYaw;
      
      this.camera.position = new BABYLON.Vector3(
        this.playerPosition.x + cameraOffsetX,
        this.playerPosition.y + cameraOffsetY,
        this.playerPosition.z + cameraOffsetZ
      );
      
      const lookTarget = this.playerPosition.clone();
      const playerForward = new BABYLON.Vector3(
        Math.sin(this.cameraYaw),
        0,
        Math.cos(this.cameraYaw)
      );
      lookTarget.addInPlace(playerForward);
      this.camera.setTarget(lookTarget);
    } else {
      this.camera.position = this.playerPosition;
    }
    
    // Sync player mesh
    if (this.playerMesh) {
      this.playerMesh.position = this.playerPosition.clone();
      this.playerMesh.position.y -= 1;
      this.playerMesh.rotation.y = this.isThirdPerson ? this.cameraYaw : this.camera.rotation.y;
    }
    
    return {
      position: this.playerPosition.clone(),
      rotation: new BABYLON.Vector3(this.camera.rotation.x, this.camera.rotation.y, this.camera.rotation.z)
    };
  }

  update(dt: number): PlayerState {
    // Use Tribes physics if available
    if (this.tribesPhysics) {
      return this.updateTribesPhysics(dt);
    }

    const forward = this.camera.getDirection(BABYLON.Axis.Z);
    const right = this.camera.getDirection(BABYLON.Axis.X);
    forward.y = 0;
    right.y = 0;
    forward.normalize();
    right.normalize();

    // Get input from EventBus
    const input = this.currentInput || {
      forward: false,
      backward: false,
      left: false,
      right: false,
      jump: false,
      shoot: false,
      sprint: false,
      crouch: false,
      reload: false,
      menu: false,
      mouseDeltaX: 0,
      mouseDeltaY: 0,
      jetpack: false
    };
    
    // Handle mouse look
    if (input.mouseDeltaX !== 0 || input.mouseDeltaY !== 0) {
      if (this.isThirdPerson) {
        this.cameraYaw += input.mouseDeltaX * this.lookSensitivity;
        const yDelta = this.invertY ? -input.mouseDeltaY : input.mouseDeltaY;
        this.cameraPitch += yDelta * this.lookSensitivity;
        this.cameraPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 6, this.cameraPitch));
      } else {
        this.camera.rotation.y += input.mouseDeltaX * this.lookSensitivity;
        this.camera.rotation.y = ((this.camera.rotation.y + Math.PI) % (2 * Math.PI)) - Math.PI;
        const yDelta = this.invertY ? -input.mouseDeltaY : input.mouseDeltaY;
        this.camera.rotation.x += yDelta * this.lookSensitivity;
        this.camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.camera.rotation.x));
      }
    }

    let moveDir = BABYLON.Vector3.Zero();
    if (input.forward) moveDir.addInPlace(forward);
    if (input.backward) moveDir.addInPlace(forward.scale(-1));
    if (input.left) moveDir.addInPlace(right.scale(-1));
    if (input.right) moveDir.addInPlace(right);

    if (moveDir.length() > 0) {
      moveDir.normalize().scaleInPlace(this.moveSpeed);
      
      if (this.playerBody) {
        // Use physics system for movement
        this.playerBody.velocity.x = moveDir.x;
        this.playerBody.velocity.z = moveDir.z;
      } else {
        // Fallback to old movement system
        // Check terrain height at multiple points to prevent clipping
        const steps = 5;
        const stepSize = 1 / steps;
        let canMove = true;
        
        for (let i = 1; i <= steps; i++) {
          const checkX = this.playerPosition.x + moveDir.x * stepSize * i;
          const checkZ = this.playerPosition.z + moveDir.z * stepSize * i;
          const terrainHeight = getTerrainHeight(this.heightmapData, checkX, checkZ);
          const playerHeight = 2;
          
          if (this.playerPosition.y < terrainHeight + playerHeight - 0.5) {
            canMove = false;
            break;
          }
        }
        
        if (canMove) {
          this.playerPosition.addInPlace(moveDir);
        }
      }
    }

    // Jump
    if (input.jump) {
      if (this.playerBody) {
        // Use physics system for jump
        if (Math.abs(this.playerBody.velocity.y) < this.jumpGracePeriod) {
          this.playerBody.velocity.y = this.jumpForce;
        }
      } else {
        // Fallback to old jump system
        if (this.verticalVelocity === 0) {
          const currentTerrainHeight = getTerrainHeight(this.heightmapData, this.playerPosition.x, this.playerPosition.z);
          if (this.playerPosition.y < currentTerrainHeight + 2.1) {
            this.verticalVelocity = this.jumpForce;
          }
        }
      }
    }

    // Jetpack
    if (this.jetpackSystem) {
      this.jetpackSystem.setActive(input.jetpack);
    }

    // Update position from physics body
    if (this.playerBody) {
      // Get position from physics body (after physics update)
      this.playerPosition = this.playerBody.position.clone();
      
      // Raycast-based terrain collision using actual ground mesh
      const ray = new BABYLON.Ray(this.playerPosition, new BABYLON.Vector3(0, -1, 0), 1000);
      const hit = this.scene.pickWithRay(ray, (mesh) => mesh.name === 'ground');
      
      if (hit && hit.hit) {
        const distance = hit.distance;
        const playerRadius = 0.5;
        const minimumDistance = playerRadius + 0.5; // Keep player 0.5 units above ground
        
        if (distance < minimumDistance) {
          // Player is hitting terrain - only adjust Y, preserve X/Z
          this.playerPosition.y += (minimumDistance - distance);
          this.playerBody.position.y = this.playerPosition.y;
          
          // Stop downward velocity but allow upward jetpack thrust
          if (this.playerBody.velocity.y < 0) {
            this.playerBody.velocity.y = 0;
          }
        }
      }
    } else {
      // Fallback to old gravity system
      this.playerPosition.y += this.verticalVelocity;
      this.verticalVelocity -= 0.015;

      // Ground collision with margin
      const currentTerrainHeight = getTerrainHeight(this.heightmapData, this.playerPosition.x, this.playerPosition.z);
      const playerHeight = 2;
      
      // Force player to stay above terrain
      if (this.playerPosition.y < currentTerrainHeight + playerHeight) {
        this.playerPosition.y = currentTerrainHeight + playerHeight;
        this.verticalVelocity = 0;
      }

      // Aggressive safety teleport - if player is anywhere near or below terrain
      if (this.playerPosition.y < currentTerrainHeight + playerHeight - 1) {
        this.playerPosition.y = currentTerrainHeight + playerHeight + 10;
        this.verticalVelocity = 0;
      }
    }


    // Update player mesh position and rotation
    if (this.playerMesh) {
      this.playerMesh.position = this.playerPosition.clone();
      this.playerMesh.position.y -= 1; // Offset so mesh feet are at ground
      // In third person, use cameraYaw; in first person, use camera rotation
      this.playerMesh.rotation.y = this.isThirdPerson ? this.cameraYaw : this.camera.rotation.y;
    }

    // Set camera position based on view mode
    if (this.isThirdPerson) {
      // Calculate camera position using spherical coordinates (orbit around player)
      const cosPitch = Math.cos(this.cameraPitch);
      const sinPitch = Math.sin(this.cameraPitch);
      const cosYaw = Math.cos(this.cameraYaw);
      const sinYaw = Math.sin(this.cameraYaw);
      
      // Camera position relative to player
      const cameraOffsetX = this.thirdPersonDistance * cosPitch * sinYaw;
      const cameraOffsetY = this.thirdPersonDistance * sinPitch + this.thirdPersonHeight;
      const cameraOffsetZ = this.thirdPersonDistance * cosPitch * cosYaw;
      
      this.camera.position = new BABYLON.Vector3(
        this.playerPosition.x + cameraOffsetX,
        this.playerPosition.y + cameraOffsetY,
        this.playerPosition.z + cameraOffsetZ
      );
      
      // Camera looks at player (plus slight forward offset for crosshair)
      const lookTarget = this.playerPosition.clone();
      const playerForward = new BABYLON.Vector3(
        Math.sin(this.cameraYaw),
        0,
        Math.cos(this.cameraYaw)
      );
      lookTarget.addInPlace(playerForward.scale(10)); // Look ahead
      this.camera.setTarget(lookTarget);
    } else {
      this.camera.position = this.playerPosition.clone();
      // In first person, camera looks where it's facing (controlled by rotation)
    }

    return {
      position: this.playerPosition.clone(),
      rotation: this.camera.rotation.clone()
    };
  }

  public initialize(): void {
    // Subscribe to input events from EventBus
    eventBus.on('player:input', (inputState: InputState) => {
      this.currentInput = inputState;
    });
  }

  public dispose(): void {
    if (this.playerBody && this.physics) {
      this.physics.removeBody(this.playerBody);
    }
  }
}
