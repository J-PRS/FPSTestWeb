import * as THREE from 'three';

export class DamageNumber {
  private sprite: THREE.Sprite;
  private material: THREE.SpriteMaterial;
  private age = 0;
  private dead = false;
  private readonly duration = 1.0; // seconds
  private readonly floatHeight = 2.0; // units to float upward
  private readonly startY: number;
  private readonly popScale: number; // Initial pop scale
  private readonly baseScale: number; // Base scale for distance calculation
  private readonly distScale: number; // Distance-based scale factor

  constructor(scene: THREE.Scene, pos: THREE.Vector3, damage: number, color: string = '#ffffff', camera?: THREE.Camera) {
    this.startY = pos.y + 1.0; // Offset upward to appear above target
    this.popScale = 0.1; // Start small for pop effect
    this.baseScale = 8; // Base scale factor

    // Random horizontal spread to prevent stacking
    const spreadX = (Math.random() - 0.5) * 1.5;
    const spreadZ = (Math.random() - 0.5) * 1.5;

    // Calculate distance-based scale (UI-like scaling with sqrt)
    let distScale = 1.0;
    if (camera) {
      const dist = camera.position.distanceTo(pos);
      // Scale with sqrt(distance): closer = larger, farther = smaller
      // At 10 units: scale 1.0, at 100 units: scale ~0.4
      distScale = Math.max(0.4, Math.min(1.5, 2.5 / Math.sqrt(dist)));
    }
    this.distScale = distScale;

    // Create canvas for text
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const fontSize = 48;
    canvas.width = 192;
    canvas.height = 96;

    // Draw text
    ctx.font = `bold ${fontSize}px "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.strokeText(Math.round(damage).toString(), canvas.width / 2, canvas.height / 2);
    ctx.fillText(Math.round(damage).toString(), canvas.width / 2, canvas.height / 2);

    // Create texture from canvas
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    // Create sprite material
    this.material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false, // Always visible
      depthWrite: false,
      opacity: 1.0 // Explicitly set full opacity
    });

    // Create sprite
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.position.set(pos.x + spreadX, this.startY, pos.z + spreadZ);
    this.sprite.scale.set(this.baseScale * distScale * this.popScale, (this.baseScale / 2) * distScale * this.popScale, (this.baseScale / 2) * distScale * this.popScale);
    scene.add(this.sprite);
  }

  update(dt: number): void {
    this.age += dt;
    if (this.age >= this.duration) {
      this.dead = true;
      return;
    }

    const t = this.age / this.duration;

    // Pop animation: quick scale up in first 0.1s
    if (t < 0.125) {
      const popT = t / 0.125;
      const popScale = this.popScale + (1 - this.popScale) * popT;
      this.sprite.scale.set(this.baseScale * this.distScale * popScale, (this.baseScale / 2) * this.distScale * popScale, (this.baseScale / 2) * this.distScale * popScale);
    }

    // Float upward
    this.sprite.position.y = this.startY + t * this.floatHeight;

    // Fade out (stay visible longer, fade quickly at end)
    if (t > 0.6) {
      this.material.opacity = 1 - ((t - 0.6) / 0.4);
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.sprite);
    this.material.map?.dispose();
    this.material.dispose();
  }

  get isDead(): boolean {
    return this.dead;
  }
}

export class DamageNumberManager {
  private numbers: DamageNumber[] = [];
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  spawn(pos: THREE.Vector3, damage: number, color?: string, camera?: THREE.Camera): void {
    this.numbers.push(new DamageNumber(this.scene, pos, damage, color, camera));
  }

  update(dt: number): void {
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const num = this.numbers[i];
      num.update(dt);
      if (num.isDead) {
        num.dispose(this.scene);
        this.numbers.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const num of this.numbers) {
      num.dispose(this.scene);
    }
    this.numbers = [];
  }
}
