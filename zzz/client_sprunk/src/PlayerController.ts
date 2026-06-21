import { Scene, Camera, Input, Vector3 } from './sprunk-engine';

export class PlayerController {
  private camera: Camera;
  private input: Input;
  private speed: number = 10;
  private sensitivity: number = 0.002;
  private velocity: Vector3 = new Vector3(0, 0, 0);
  private gravity: number = -9.81;
  private jumpForce: number = 5;
  private isGrounded: boolean = true;

  constructor(scene: Scene, engine: any) {
    this.camera = new Camera(scene);
    this.camera.position.set(0, 2, 5);
    this.input = new Input(engine);
    
    // Handle pointer lock change
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== document.body) {
        console.log('Pointer unlocked - click to relock');
      }
    });
  }

  lockPointer(): void {
    this.input.lockPointer();
  }

  update(deltaTime: number): void {
    // Mouse look
    const mouseDelta = this.input.getMouseDelta();
    this.camera.rotation.y -= mouseDelta.x * this.sensitivity;
    this.camera.rotation.x -= mouseDelta.y * this.sensitivity;
    
    // Clamp vertical look
    this.camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.camera.rotation.x));

    // Movement
    const forward = this.getForward();
    const right = this.getRight();
    
    let moveX = 0;
    let moveZ = 0;

    if (this.input.isKeyDown('KeyW')) moveZ += 1;
    if (this.input.isKeyDown('KeyS')) moveZ -= 1;
    if (this.input.isKeyDown('KeyA')) moveX -= 1;
    if (this.input.isKeyDown('KeyD')) moveX += 1;

    const moveDir = forward.clone().multiplyScalar(moveZ).add(right.clone().multiplyScalar(moveX));
    if (moveDir.length() > 0) {
      moveDir.normalize();
      this.velocity.x = moveDir.x * this.speed;
      this.velocity.z = moveDir.z * this.speed;
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    // Apply gravity
    this.velocity.y += this.gravity * deltaTime;

    // Jump
    if (this.input.isKeyDown('Space') && this.isGrounded) {
      this.velocity.y = this.jumpForce;
      this.isGrounded = false;
    }

    // Update position
    this.camera.position.x += this.velocity.x * deltaTime;
    this.camera.position.y += this.velocity.y * deltaTime;
    this.camera.position.z += this.velocity.z * deltaTime;

    // Simple ground collision
    if (this.camera.position.y < 2) {
      this.camera.position.y = 2;
      this.velocity.y = 0;
      this.isGrounded = true;
    }
  }

  private getForward(): Vector3 {
    const forward = new Vector3(0, 0, -1);
    forward.applyAxisAngle(new Vector3(0, 1, 0), this.camera.rotation.y);
    return forward;
  }

  private getRight(): Vector3 {
    const right = new Vector3(1, 0, 0);
    right.applyAxisAngle(new Vector3(0, 1, 0), this.camera.rotation.y);
    return right;
  }

  getPosition(): Vector3 {
    return this.camera.position.clone();
  }

  getCamera(): Camera {
    return this.camera;
  }
}
