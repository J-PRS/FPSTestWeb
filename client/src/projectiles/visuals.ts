// Projectile visuals: shared geometry/material caches, mesh + glow + ribbon
// construction, and the per-frame mesh update (orientation/ramp-in/glow scale).
// Kept out of Projectile.ts so the class file is flight+collision only.
import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import type { ProjectileConfig } from './types.js';
import { RibbonTrail } from './RibbonTrail.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const MESH_GEO_CACHE = new Map<string, THREE.BufferGeometry>();
// Projectile materials are never mutated after construction — share per color
// so rapid fire doesn't create/dispose a material every shot
const BODY_MAT_CACHE = new Map<number, THREE.MeshBasicMaterial>();
const GLOW_MAT_CACHE = new Map<string, THREE.MeshBasicMaterial>();
const GLOW_GEO = new THREE.SphereGeometry(1.0, 12, 12);

function getBodyMat(color: number): THREE.MeshBasicMaterial {
  let m = BODY_MAT_CACHE.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(EMIT_GAIN) });
    BODY_MAT_CACHE.set(color, m);
  }
  return m;
}

function getGlowMat(color: number, opacity: number): THREE.MeshBasicMaterial {
  const key = `${color}|${opacity}`;
  let m = GLOW_MAT_CACHE.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(EMIT_GAIN), transparent: true, opacity, depthWrite: false });
    GLOW_MAT_CACHE.set(key, m);
  }
  return m;
}
function getMeshGeo(meshType: string, bodyRadius: number): THREE.BufferGeometry {
  const key = `${meshType}:${bodyRadius}`;
  let geo = MESH_GEO_CACHE.get(key);
  if (!geo) {
    if (meshType === 'disc') {
      geo = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16);
    } else if (meshType === 'ball') {
      // Thrown grenade — faceted icosphere reads as a ball at any angle,
      // unlike the oriented tube meant for rocket shells
      geo = new THREE.IcosahedronGeometry(bodyRadius, 1);
    } else if (meshType === 'javelin') {
      // Thrown spear, ~2m, tip apex AT the origin (body trailing -Z) —
      // pos is the head, so trail/ribbon emission lines up with the
      // visual point instead of the mid-shaft.
      const shaft = new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6);
      shaft.rotateX(Math.PI / 2); shaft.translate(0, 0, -1.25);
      const tip = new THREE.ConeGeometry(0.09, 0.5, 6);
      tip.rotateX(Math.PI / 2); tip.translate(0, 0, -0.25);
      geo = mergeGeometries([shaft, tip])!;
      shaft.dispose(); tip.dispose();
    } else {
      geo = new THREE.CylinderGeometry(0.08, bodyRadius, 0.7, 6);
      geo.rotateX(Math.PI / 2);
    }
    MESH_GEO_CACHE.set(key, geo);
  }
  return geo;
}

export interface ProjectileMeshes {
  mesh: THREE.Mesh;
  glowMesh: THREE.Mesh | null;
  ribbons: RibbonTrail[];
}

// ---- Instanced projectile shells ----
// A live scene carries ~30-40 projectiles mid-fight; each used to own a
// Mesh (+glow Mesh) = 2 draw calls + 2 material state changes apiece.
// Now all shells of a kind share one InstancedMesh: the returned Mesh
// is a state object (position/quaternion/scale) that never enters the
// scene — instanceSync() copies its transform into the slot each frame.
const INST_CAP = 64;
interface InstPool { mesh: THREE.InstancedMesh; free: number[] }
const instPools = new Map<string, InstPool>();
const _instMat = new THREE.Matrix4();
const _zeroScale = new THREE.Vector3(0, 0, 0);

interface SlotTag { __inst?: { pool: InstPool; slot: number } }

function instPoolFor(scene: THREE.Scene, kind: string, geo: THREE.BufferGeometry, mat: THREE.Material): InstPool {
  const key = scene.uuid + '|' + kind; // pools die with their scene — no cross-scene reuse
  let p = instPools.get(key);
  if (!p) {
    const mesh = new THREE.InstancedMesh(geo, mat, INST_CAP);
    mesh.frustumCulled = false; // shells scatter; per-instance bounds don't exist
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.layers.enable(BLOOM_LAYER);
    scene.add(mesh);
    p = { mesh, free: [] };
    instPools.set(key, p);
  }
  return p;
}

function instAlloc(pool: InstPool): number {
  return pool.free.length ? pool.free.pop()! : pool.mesh.count++;
}

export function syncProjectileInstance(m: THREE.Mesh | null): void {
  const t = (m as SlotTag | null)?.__inst;
  if (!t) return;
  _instMat.compose(m!.position, m!.quaternion, m!.scale);
  t.pool.mesh.setMatrixAt(t.slot, _instMat);
  t.pool.mesh.instanceMatrix.needsUpdate = true;
}

export function releaseProjectileInstance(m: THREE.Mesh | null): void {
  const t = (m as SlotTag | null)?.__inst;
  if (!t) return;
  _instMat.compose(m!.position, m!.quaternion, _zeroScale);
  t.pool.mesh.setMatrixAt(t.slot, _instMat);
  t.pool.mesh.instanceMatrix.needsUpdate = true;
  t.pool.free.push(t.slot);
  delete (m as SlotTag).__inst;
}

// Spawn-scale so a 0.4s shotgun pellet still snaps to size fast.
const RAMP_IN_START = 0.2;
const RAMP_IN_DUR = 0.2;

export function rampInStartScale(config: ProjectileConfig): number {
  if (config.meshRampIn === false) return 1.0;
  return config.meshStartScale ?? RAMP_IN_START;
}

export function rampInScale(config: ProjectileConfig, age: number): number {
  if (config.meshRampIn === false) return 1.0;
  const start = rampInStartScale(config);
  const maxLife = config.maxLifetime ?? 0;
  const dur = Math.min(
    config.meshRampInDuration ?? RAMP_IN_DUR,
    maxLife > 0 ? maxLife * 0.4 : RAMP_IN_DUR,
  );
  return start + (1.0 - start) * Math.min(age / dur, 1.0);
}

export function buildProjectileMeshes(
  scene: THREE.Scene, config: ProjectileConfig, pos: THREE.Vector3,
): ProjectileMeshes {
  const geo = getMeshGeo(config.meshType, config.bodyRadius);
  const mat = getBodyMat(config.meshColor); // shared — never mutated
  const mesh = new THREE.Mesh(geo, mat); // state only — rendered via the instanced pool
  mesh.position.copy(pos);
  // Spawn at the ramp-in start scale — prevents a one-frame full-size
  // flash before the first update shrinks it
  mesh.scale.setScalar(rampInStartScale(config));
  mesh.layers.enable(BLOOM_LAYER);
  const bpool = instPoolFor(scene, `body|${config.meshType}|${config.bodyRadius}|${config.meshColor}`, geo, mat);
  (mesh as SlotTag).__inst = { pool: bpool, slot: instAlloc(bpool) };

  let glowMesh: THREE.Mesh | null = null;
  if (config.glowShell) {
    const glowMat = getGlowMat(config.glowColor, config.glowOpacity); // shared
    glowMesh = new THREE.Mesh(GLOW_GEO, glowMat);
    glowMesh.position.copy(pos);
    glowMesh.layers.enable(BLOOM_LAYER);
    const gpool = instPoolFor(scene, `glow|${config.glowColor}|${config.glowOpacity}`, GLOW_GEO, glowMat);
    (glowMesh as SlotTag).__inst = { pool: gpool, slot: instAlloc(gpool) };
  }

  let ribbons: RibbonTrail[] = [];
  if (config.ribbonTrail) {
    const color = config.ribbonColor ?? config.trailColors[0].getHex();
    const width = config.ribbonWidth ?? 0.5;
    const life = config.ribbonLife ?? 0.3;
    // 3 lanes: wide outer band + thin bright core pair offset above/below —
    // reads as a glowing energy streak with depth instead of a flat line
    const coreColor = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.6).getHex();
    if (config.ribbonLanes === 1) {
      ribbons = [RibbonTrail.acquire(scene, color, width, life)];
    } else {
      ribbons = [
        RibbonTrail.acquire(scene, color, width, life),
        RibbonTrail.acquire(scene, coreColor, width * 0.35, life * 0.8, width * 0.07),
        RibbonTrail.acquire(scene, coreColor, width * 0.35, life * 0.8, -width * 0.07),
      ];
    }
  }
  return { mesh, glowMesh, ribbons };
}

const _velDir = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _FORWARD = new THREE.Vector3(0, 0, 1);
const _tumbleAxis = new THREE.Vector3();

export function updateProjectileMesh(
  mesh: THREE.Mesh, glowMesh: THREE.Mesh | null,
  pos: THREE.Vector3, vel: THREE.Vector3, config: ProjectileConfig,
  ...rest: [age: number, hitRadius: number, tumble: { x: number; y: number; z: number }, dt: number]
): void {
  const [age, hitRadius, tumble, dt] = rest;
  mesh.position.copy(pos);
  if (glowMesh) {
    glowMesh.position.copy(pos);
    // Glow scales with hitRadius (wake hitbox) so they always match
    const glowMultiplier = config.glowScale ?? 1.0;
    glowMesh.scale.setScalar(hitRadius * glowMultiplier);
  }

  mesh.scale.setScalar(rampInScale(config, age));

  if (vel.lengthSq() > 0.01) {
    _velDir.copy(vel).normalize();
    if (config.meshType === 'disc') {
      _lookTarget.copy(pos).add(_velDir);
      mesh.lookAt(_lookTarget);
    } else if (config.meshType === 'ball') {
      // Spheres don't orient — they tumble. Spin around a fixed random
      // axis, rate proportional to speed so a lobbed ball visibly rotates
      _tumbleAxis.set(tumble.x, tumble.y, tumble.z).normalize();
      mesh.rotateOnAxis(_tumbleAxis, vel.length() * dt * 3.0);
    } else {
      mesh.quaternion.setFromUnitVectors(_FORWARD, _velDir);
    }
  }

  syncProjectileInstance(mesh);
  syncProjectileInstance(glowMesh);
}
