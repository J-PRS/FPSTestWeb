// Physics worker - runs at fixed timestep even when tab is hidden
// Handles player physics, collision detection, and terrain checks

interface PhysicsState {
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  onGround: boolean;
  energy: number;
  health: number;
  isDead: boolean;
}

interface InputState {
  forward: number;
  right: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
  skiHeld: boolean;
  firePressed: boolean;
  jetHeld: boolean;
  discHeld: boolean;
}

// Physics constants (matching config.ts)
const GRAVITY = 25.0;
const PLAYER_RADIUS = 0.8;
const PLAYER_HEIGHT = 2.0;
const JET_FORCE_UP = 35.0;
const JET_FORCE_DIR = 10.0;
const MAX_ENERGY = 60.0;
const JET_DRAIN = 12.0;
const JET_CHARGE = 8.0;
const MOVE_SPEED = 15.0;
const JUMP_FORCE = 8.0;
const FRICTION_GROUND = 6.0;
const FRICTION_AIR = 0.5;
const MAX_SPEED = 40.0;

// Worker state
let physicsState: PhysicsState = {
  pos: { x: 0, y: 10, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  onGround: false,
  energy: MAX_ENERGY,
  health: 100,
  isDead: false
};

let inputState: InputState = {
  forward: 0,
  right: 0,
  jumpPressed: false,
  jumpHeld: false,
  skiHeld: false,
  firePressed: false,
  jetHeld: false,
  discHeld: false
};

// Terrain data - updated from main thread
let currentTerrainHeight = 0;
let currentTerrainNormal = { x: 0, y: 1, z: 0 };

let lastTime = 0;
const FIXED_TIMESTEP = 1 / 60; // 60Hz physics

function updatePhysics(dt: number): void {
  if (physicsState.isDead) return;

  // Calculate movement direction
  const fwdX = Math.sin(physicsState.yaw);
  const fwdZ = Math.cos(physicsState.yaw);
  const rgtX = -Math.cos(physicsState.yaw);
  const rgtZ = Math.sin(physicsState.yaw);

  // Convert input to world space
  const moveX = fwdX * inputState.forward + rgtX * inputState.right;
  const moveZ = fwdZ * inputState.forward + rgtZ * inputState.right;

  // Apply movement force
  if (physicsState.onGround) {
    physicsState.vel.x += moveX * MOVE_SPEED * dt;
    physicsState.vel.z += moveZ * MOVE_SPEED * dt;
  } else {
    physicsState.vel.x += moveX * MOVE_SPEED * 0.3 * dt; // Less air control
    physicsState.vel.z += moveZ * MOVE_SPEED * 0.3 * dt;
  }

  // Jump
  if (inputState.jumpPressed && physicsState.onGround) {
    physicsState.vel.y = JUMP_FORCE;
    physicsState.onGround = false;
  }

  // Jetpack
  if (inputState.jetHeld && physicsState.energy > 0) {
    physicsState.vel.y += JET_FORCE_UP * dt;
    physicsState.vel.x += moveX * JET_FORCE_DIR * dt;
    physicsState.vel.z += moveZ * JET_FORCE_DIR * dt;
    physicsState.energy -= JET_DRAIN * dt;
  } else if (physicsState.energy < MAX_ENERGY) {
    physicsState.energy += JET_CHARGE * dt;
  }

  // Gravity
  physicsState.vel.y -= GRAVITY * dt;

  // Ski (reduce friction when holding space)
  const friction = inputState.skiHeld ? FRICTION_AIR : (physicsState.onGround ? FRICTION_GROUND : FRICTION_AIR);
  physicsState.vel.x *= (1 - friction * dt);
  physicsState.vel.z *= (1 - friction * dt);

  // Clamp speed
  const speed = Math.sqrt(physicsState.vel.x ** 2 + physicsState.vel.z ** 2);
  if (speed > MAX_SPEED) {
    physicsState.vel.x *= MAX_SPEED / speed;
    physicsState.vel.z *= MAX_SPEED / speed;
  }

  // Update position
  physicsState.pos.x += physicsState.vel.x * dt;
  physicsState.pos.y += physicsState.vel.y * dt;
  physicsState.pos.z += physicsState.vel.z * dt;

  // Terrain collision
  const groundHeight = currentTerrainHeight;
  if (physicsState.pos.y < groundHeight + PLAYER_HEIGHT / 2) {
    physicsState.pos.y = groundHeight + PLAYER_HEIGHT / 2;
    if (physicsState.vel.y < 0) {
      physicsState.vel.y = 0;
      physicsState.onGround = true;
    }
  } else {
    physicsState.onGround = false;
  }
}

function gameLoop(timestamp: number): void {
  if (lastTime === 0) {
    lastTime = timestamp;
  }

  const deltaTime = (timestamp - lastTime) / 1000;
  lastTime = timestamp;

  // Fixed timestep accumulation
  let accumulator = deltaTime;
  while (accumulator >= FIXED_TIMESTEP) {
    updatePhysics(FIXED_TIMESTEP);
    accumulator -= FIXED_TIMESTEP;
  }

  // Send state back to main thread
  self.postMessage({
    type: 'physicsUpdate',
    state: { ...physicsState }
  });

  // Continue loop
  setTimeout(() => self.requestAnimationFrame(gameLoop), 0);
}

// Handle messages from main thread
self.onmessage = (e: MessageEvent): void => {
  const data = e.data;

  switch (data.type) {
    case 'init':
      physicsState = data.initialState || physicsState;
      lastTime = 0;
      self.requestAnimationFrame(gameLoop);
      break;

    case 'input':
      inputState = data.input;
      break;

    case 'terrain':
      currentTerrainHeight = data.height;
      currentTerrainNormal = data.normal;
      break;

    case 'setState':
      physicsState = { ...physicsState, ...data.state };
      break;

    case 'setHealth':
      physicsState.health = data.health;
      physicsState.isDead = data.health <= 0;
      break;
  }
};

// Export empty object for TypeScript
export {};
