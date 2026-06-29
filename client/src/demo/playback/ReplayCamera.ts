import * as THREE from 'three';

/**
 * Camera modes for replay.
 */
export enum ReplayCameraMode {
  /** Free camera - full control */
  Free,
  /** Follow camera - follows player ghost */
  Follow,
  /** Orbit camera - orbits around player */
  Orbit,
  /** Cinematic camera - automatic cinematic movement */
  Cinematic,
}

/**
 * Replay camera controls for demo playback.
 * Provides multiple camera modes for viewing replays.
 */
export class ReplayCamera {
  private camera: THREE.PerspectiveCamera;
  private mode: ReplayCameraMode = ReplayCameraMode.Free;
  private target: THREE.Object3D | null = null;
  private orbitAngle: number = 0;
  private orbitDistance: number = 10;
  private orbitHeight: number = 5;
  private cinematicTime: number = 0;

  // Input state
  private moveSpeed: number = 10;
  private lookSpeed: number = 0.002;
  private keys: Map<string, boolean> = new Map();
  private mouseDelta: THREE.Vector2 = new THREE.Vector2();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.setupInputListeners();
  }

  /**
   * Setup keyboard and mouse input listeners.
   */
  private setupInputListeners(): void {
    document.addEventListener('keydown', (e) => this.keys.set(e.code, true));
    document.addEventListener('keyup', (e) => this.keys.set(e.code, false));
    document.addEventListener('mousemove', (e) => {
      this.mouseDelta.x = e.movementX;
      this.mouseDelta.y = e.movementY;
    });
  }

  /**
   * Update camera based on mode and input.
   * @param deltaTime - Time since last frame
   */
  update(deltaTime: number): void {
    switch (this.mode) {
      case ReplayCameraMode.Free:
        this.updateFreeCamera(deltaTime);
        break;
      case ReplayCameraMode.Follow:
        this.updateFollowCamera(deltaTime);
        break;
      case ReplayCameraMode.Orbit:
        this.updateOrbitCamera(deltaTime);
        break;
      case ReplayCameraMode.Cinematic:
        this.updateCinematicCamera(deltaTime);
        break;
    }
  }

  /**
   * Update free camera (WASD + mouse look).
   */
  private updateFreeCamera(deltaTime: number): void {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, this.camera.up).normalize();

    // Movement
    const moveSpeed = this.moveSpeed * deltaTime;
    if (this.keys.get('KeyW')) {
      this.camera.position.addScaledVector(forward, moveSpeed);
    }
    if (this.keys.get('KeyS')) {
      this.camera.position.addScaledVector(forward, -moveSpeed);
    }
    if (this.keys.get('KeyA')) {
      this.camera.position.addScaledVector(right, -moveSpeed);
    }
    if (this.keys.get('KeyD')) {
      this.camera.position.addScaledVector(right, moveSpeed);
    }
    if (this.keys.get('Space')) {
      this.camera.position.y += moveSpeed;
    }
    if (this.keys.get('ShiftLeft')) {
      this.camera.position.y -= moveSpeed;
    }

    // Mouse look
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    euler.y -= this.mouseDelta.x * this.lookSpeed;
    euler.x -= this.mouseDelta.y * this.lookSpeed;
    euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
    this.camera.quaternion.setFromEuler(euler);

    // Reset mouse delta
    this.mouseDelta.set(0, 0);
  }

  /**
   * Update follow camera (follows target).
   */
  private updateFollowCamera(deltaTime: number): void {
    if (!this.target) {
      return;
    }

    const targetPos = this.target.position.clone();
    targetPos.y += 2; // Eye level

    // Smooth follow
    const offset = new THREE.Vector3(0, 2, 5);
    offset.applyQuaternion(this.target.quaternion);
    const desiredPosition = targetPos.clone().add(offset);

    this.camera.position.lerp(desiredPosition, 5 * deltaTime);
    this.camera.lookAt(targetPos);
  }

  /**
   * Update orbit camera (orbits around target).
   */
  private updateOrbitCamera(deltaTime: number): void {
    if (!this.target) {
      return;
    }

    // Auto-rotate orbit
    this.orbitAngle += deltaTime * 0.5;

    const targetPos = this.target.position.clone();
    const x = Math.cos(this.orbitAngle) * this.orbitDistance;
    const z = Math.sin(this.orbitAngle) * this.orbitDistance;

    this.camera.position.set(
      targetPos.x + x,
      targetPos.y + this.orbitHeight,
      targetPos.z + z
    );

    this.camera.lookAt(targetPos);
  }

  /**
   * Update cinematic camera (automatic movement).
   */
  private updateCinematicCamera(deltaTime: number): void {
    if (!this.target) {
      return;
    }

    this.cinematicTime += deltaTime;

    // Smooth sine wave movement
    const t = this.cinematicTime * 0.3;
    const x = Math.sin(t) * 8;
    const z = Math.cos(t * 0.7) * 8;
    const y = Math.sin(t * 0.5) * 3 + 5;

    const targetPos = this.target.position.clone();
    this.camera.position.set(
      targetPos.x + x,
      targetPos.y + y,
      targetPos.z + z
    );

    this.camera.lookAt(targetPos);
  }

  /**
   * Set camera mode.
   */
  setMode(mode: ReplayCameraMode): void {
    this.mode = mode;
  }

  /**
   * Get current camera mode.
   */
  getMode(): ReplayCameraMode {
    return this.mode;
  }

  /**
   * Set target for follow/orbit/cinematic modes.
   */
  setTarget(target: THREE.Object3D | null): void {
    this.target = target;
  }

  /**
   * Set orbit parameters.
   */
  setOrbitParameters(distance: number, height: number): void {
    this.orbitDistance = distance;
    this.orbitHeight = height;
  }

  /**
   * Set movement speed.
   */
  setMoveSpeed(speed: number): void {
    this.moveSpeed = speed;
  }

  /**
   * Set look sensitivity.
   */
  setLookSpeed(speed: number): void {
    this.lookSpeed = speed;
  }

  /**
   * Get the camera.
   */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /**
   * Reset camera to default position.
   */
  reset(): void {
    this.camera.position.set(0, 5, 10);
    this.camera.lookAt(0, 2, 0);
    this.orbitAngle = 0;
    this.cinematicTime = 0;
  }

  /**
   * Destroy camera controls.
   */
  destroy(): void {
    // Remove event listeners
    document.removeEventListener('keydown', () => {});
    document.removeEventListener('keyup', () => {});
    document.removeEventListener('mousemove', () => {});
  }
}
