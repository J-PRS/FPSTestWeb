// Projectile visuals: shared geometry/material caches, mesh + glow + ribbon
// construction, and the per-frame mesh update (orientation/ramp-in/glow scale).
// Kept out of Projectile.ts so the class file is flight+collision only.
import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import type { ProjectileConfig } from '../projectiles/types.js';
import { RibbonTrail } from './RibbonTrail.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { registerDiag, markProbe } from '../core/fxDiag.js';
import { acquireBatch, retireBatch, type BatchMap } from '../core/batchPool.js';

const MESH_GEO_CACHE = new Map<string, THREE.BufferGeometry>();
// Projectile materials are never mutated after construction — share per color
// so rapid fire doesn't create/dispose a material every shot
const BODY_MAT_CACHE = new Map<number, THREE.MeshBasicMaterial>();
const GLOW_MAT_CACHE = new Map<string, THREE.MeshBasicMaterial>();
const GLOW_GEO = new THREE.SphereGeometry(1, 12, 12);
// Vapor-cone silhouette: unit cone TRAILING the shell — apex rooted at
// the body, skirt flaring backward along -Z. (A forward spearhead read
// wrong; the wake belongs behind the shell. Own-shell camera overlap is
// accepted — the proxy hitbox match is a separate problem.)
const CONE_GEO = (() => {
  const g = new THREE.ConeGeometry(1, 1, 24, 1, true);
  g.rotateX(Math.PI / 2);   // cone axis +Y → +Z (apex forward)
  g.translate(0, 0, -0.5);  // apex at the shell, base 1 unit behind
  return g;
})();
// Spearhead length as a multiple of its collar radius.
const CONE_LEN = 1.4;

// Energy filaments for the cone skirt — apex-hot alpha that fades to
// nothing at the base, streaked around the circumference so the surface
// reads as braided light, not a solid sail. Shared by all cone pools.
let _coneAlphaTex: THREE.Texture | null = null;
function getConeAlphaTex(): THREE.Texture {
  if (_coneAlphaTex) {return _coneAlphaTex;}
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S; // v: 0 apex → 1 base (cone UVs)
      // Bright collar near the apex, soft falloff to the skirt edge.
      // map-mode (not alphaMap): the texture IS the additive color, so
      // texels must sit high — a mostly-dark map renders ~invisible.
      let a = Math.max(0, 1 - v * 1.35);
      a = a * a * 0.7 + 0.3 * a; // gentle shoulder, base keeps ~0.15
      // Braided filaments: subtle rope breakup over the lit veil.
      const fil = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(u * Math.PI * 14 + v * 9))
        * (0.5 + 0.5 * Math.sin(u * Math.PI * 6 - v * 13));
      a *= fil;
      // alphaMap samples the GREEN channel — the pattern must live in
      // RGB, not the image's own alpha byte.
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = a * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.RepeatWrapping;
  _coneAlphaTex = t;
  return t;
}

function getBodyMat(color: number): THREE.MeshBasicMaterial {
  let m = BODY_MAT_CACHE.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(EMIT_GAIN) });
    BODY_MAT_CACHE.set(color, m);
  }
  return m;
}

const _white = new THREE.Color(0xFF_FF_FF);

function getGlowMat(color: number, opacity: number, flash: boolean, cone = false): THREE.MeshBasicMaterial {
  const key = `${color}|${opacity}|${flash ? 'f' : ''}|${cone ? 'c' : ''}`;
  let m = GLOW_MAT_CACHE.get(key);
  if (!m) {
    // Flash variants bake the CREST color (glow lerped toward white) —
    // instanceColor can only darken a material, so each shell tints down
    // to the resting hue and the pulse writes near-white at the crest.
    const c = new THREE.Color(color);
    if (flash) {c.lerp(_white, 0.7);}
    m = new THREE.MeshBasicMaterial({
      color: c.multiplyScalar(EMIT_GAIN), transparent: true, opacity,
      depthWrite: false, side: THREE.DoubleSide,
      // Energy collar: additive so the skirt ADDS light instead of a
      // tinted veil. The filament pattern rides in `map`, NOT alphaMap —
      // additive pixels only add their RGB, so dark texels already read
      // as gaps; going through the alpha channel suppressed the whole
      // cone in this pipeline (verified: invisible with alphaMap, solid
      // with it nulled).
      // fog: false — scene.fog blends fragments toward fog color, but an
      // additive skirt can only ADD: distant texels would add fog-gray
      // and read opaque instead of transparent. Distant shells keep the
      // glow un-fogged so it stays a bright streak, not a gray sail.
      ...(cone ? { blending: THREE.AdditiveBlending, map: getConeAlphaTex(), fog: false } : {}),
    });
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
const INST_CAP = 256; // per InstancedMesh — overflow grows a sibling mesh
interface InstPool { mesh: THREE.InstancedMesh; free: number[]; scene: THREE.Scene; key: string }
// A kind's shells live in a LIST of pools — overflow spawns another
// InstancedMesh (one more draw call) instead of starving; emptied overflow
// meshes shrink back away on release.
const instPools: BatchMap<string, InstPool> = new Map();
const _instMat = new THREE.Matrix4();
const _zeroScale = new THREE.Vector3(0, 0, 0);

interface SlotTag { __inst?: { pool: InstPool; slot: number } }

function instPoolFor(scene: THREE.Scene, kind: string, geo: THREE.BufferGeometry, mat: THREE.Material, colored = false): InstPool {
  const key = `${scene.uuid  }|${  kind}`; // pools die with their scene — no cross-scene reuse
  return acquireBatch(instPools, key, (k) => {
    const mesh = new THREE.InstancedMesh(geo, mat, INST_CAP);
    if (colored) {
      // instanceColor buffer starts at WHITE (multiplicative identity) —
      // unset slots must not render black.
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(INST_CAP * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    mesh.matrixWorldAutoUpdate = false;
    mesh.frustumCulled = false; // shells scatter; per-instance bounds don't exist
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.layers.enable(BLOOM_LAYER);
    scene.add(mesh);
    const p = { mesh, free: [], scene, key: k };
    markProbe(mesh, { kind: 'instPool', label: kind, pool: p });
    return p;
  }, p => p.free.length > 0 || p.mesh.count < INST_CAP);
}

function instAlloc(pool: InstPool): number {
  if (pool.free.length > 0) {return pool.free.pop()!;}
  // instPoolFor only hands out pools with room, so count is always < cap
  return pool.mesh.count++;
}

export function syncProjectileInstance(m: THREE.Mesh | null): void {
  const t = (m as SlotTag | null)?.__inst;
  if (!t || t.slot < 0) {return;}
  _instMat.compose(m!.position, m!.quaternion, m!.scale);
  t.pool.mesh.setMatrixAt(t.slot, _instMat);
  t.pool.mesh.instanceMatrix.needsUpdate = true;
}

const _instColor = new THREE.Color();

/** Per-instance tint for colored pools — multiplies the material color,
 *  so values ≤1 only ever darken toward the resting hue. */
export function syncProjectileInstanceColor(m: THREE.Mesh | null, color: THREE.Color): void {
  const t = (m as SlotTag | null)?.__inst;
  if (!t || t.slot < 0 || !t.pool.mesh.instanceColor) {return;}
  t.pool.mesh.setColorAt(t.slot, color);
  t.pool.mesh.instanceColor.needsUpdate = true;
}

export function releaseProjectileInstance(m: THREE.Mesh | null): void {
  const t = (m as SlotTag | null)?.__inst;
  if (!t || t.slot < 0) {return;}
  _instMat.compose(m!.position, m!.quaternion, _zeroScale);
  t.pool.mesh.setMatrixAt(t.slot, _instMat);
  t.pool.mesh.instanceMatrix.needsUpdate = true;
  t.pool.free.push(t.slot);
  delete (m as SlotTag).__inst;
  // Shrink: an overflow mesh whose slots are ALL free is retired — the
  // first pool per kind is the floor so the common case stays one draw.
  retireBatch(instPools, t.pool.key, t.pool,
    p => p.free.length === p.mesh.count,
    p => { p.scene.remove(p.mesh); p.mesh.dispose(); });
}

/** Instancing census for the Alt+Q dump — pool count per shell kind plus
 *  total allocated/free slots; a count that grows unboundedly or a free
 *  stack that never drains is a release-side leak. */
export function instPoolDump(): Record<string, { pools: number; count: number; free: number }> {
  const out: Record<string, { pools: number; count: number; free: number }> = {};
  for (const [key, list] of instPools) {
    let count = 0, free = 0;
    for (const p of list) { count += p.mesh.count; free += p.free.length; }
    out[key.slice(key.indexOf('|') + 1)] = { pools: list.length, count, free };
  }
  return out;
}

// Spawn-scale so a 0.4s shotgun pellet still snaps to size fast.
const RAMP_IN_START = 0.2;
const RAMP_IN_DUR = 0.2;

export function rampInStartScale(config: ProjectileConfig): number {
  if (config.meshRampIn === false) {return 1;}
  return config.meshStartScale ?? RAMP_IN_START;
}

export function rampInScale(config: ProjectileConfig, age: number): number {
  if (config.meshRampIn === false) {return 1;}
  const start = rampInStartScale(config);
  const maxLife = config.maxLifetime ?? 0;
  const dur = Math.min(
    config.meshRampInDuration ?? RAMP_IN_DUR,
    maxLife > 0 ? maxLife * 0.4 : RAMP_IN_DUR,
  );
  return start + (1 - start) * Math.min(age / dur, 1);
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
    const flash = Boolean(config.glowPulse);
    const cone = config.glowShape === 'wakeCone';
    const glowMat = getGlowMat(config.glowColor, config.glowOpacity, flash, cone); // shared
    const glowGeo = cone ? CONE_GEO : GLOW_GEO;
    glowMesh = new THREE.Mesh(glowGeo, glowMat);
    glowMesh.position.copy(pos);
    glowMesh.layers.enable(BLOOM_LAYER);
    const gpool = instPoolFor(scene, `glow|${cone ? 'wakeCone' : 'sphere'}|${config.glowColor}|${config.glowOpacity}|${flash ? 'f' : ''}`, glowGeo, glowMat, flash);
    (glowMesh as SlotTag).__inst = { pool: gpool, slot: instAlloc(gpool) };
    if (flash) {
      // Resting tint = base color ÷ crest color, so tint×material lands
      // back on the configured hue when the pulse is at its trough.
      const base = new THREE.Color(config.glowColor);
      const crest = new THREE.Color(config.glowColor).lerp(_white, 0.7);
      const rest = new THREE.Color(base.r / crest.r, base.g / crest.g, base.b / crest.b);
      (glowMesh as SlotTag & { __restTint?: THREE.Color }).__restTint = rest;
      syncProjectileInstanceColor(glowMesh, rest);
    }
  }

  let ribbons: RibbonTrail[] = [];
  // Default ON — a config must opt OUT (`ribbonTrail: false`); opt-in
  // left nine shell types flying trail-less (grenades, GL, cannon…).
  if (config.ribbonTrail !== false) {
    const color = config.ribbonColor ?? config.trailColors[0]?.getHex() ?? 0xFF_FF_FF;
    const width = config.ribbonWidth ?? 0.5;
    const life = config.ribbonLife ?? 0.3;
    // 3 lanes: wide outer band + thin bright core pair offset above/below —
    // reads as a glowing energy streak with depth instead of a flat line
    const coreColor = new THREE.Color(color).lerp(new THREE.Color(0xFF_FF_FF), 0.6).getHex();
    // billboard=true: the strip re-sides to face the camera each frame —
    // the fixed-horizontal variant was edge-on to every level shot and
    // rendered as a zero-pixel line (ball ribbons already do this).
    const tag = `proj:${config.name}`;
    if (config.ribbonLanes === 1) {
      ribbons = [RibbonTrail.acquire(scene, { color, width, life, billboard: true, tag })];
    } else {
      ribbons = [
        RibbonTrail.acquire(scene, { color, width, life, billboard: true, tag }),
        RibbonTrail.acquire(scene, { color: coreColor, width: width * 0.35, life: life * 0.8, vOffset: width * 0.07, billboard: true, tag }),
        RibbonTrail.acquire(scene, { color: coreColor, width: width * 0.35, life: life * 0.8, vOffset: -width * 0.07, billboard: true, tag }),
      ];
    }
    if (config.ribbonRampIn) {for (const r of ribbons) {r.rampIn(config.ribbonRampIn);}}
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
  ...rest: [age: number, hitRadius: number, tumble: { x: number; y: number; z: number }, dt: number, fuseAge?: number]
): void {
  const [age, hitRadius, tumble, dt, fuseAge = age] = rest;
  mesh.position.copy(pos);
  if (glowMesh) {
    glowMesh.position.copy(pos);
    // Glow scales with hitRadius (wake hitbox) so they always match
    const glowMultiplier = config.glowScale ?? 1;
    // Glow always ramps in at spawn even when the body opts out — a
    // full-size glow envelope near the muzzle swallows the camera for
    // the first frames (fullscreen color flash).
    const start = config.meshStartScale ?? RAMP_IN_START;
    const maxLife = config.maxLifetime ?? 0;
    const glowRamp = start + (1 - start) * Math.min(
      age / Math.min(config.meshRampInDuration ?? RAMP_IN_DUR, maxLife > 0 ? maxLife * 0.4 : RAMP_IN_DUR), 1);
    let gs = hitRadius * glowMultiplier * glowRamp;
    const restTint = (glowMesh as SlotTag & { __restTint?: THREE.Color }).__restTint;
    if (config.glowPulse) {
      const p = config.glowPulse;
      if (fuseAge >= 0) {
        // fuseRamp: blink quickens as the ARMED fuse dies — flight time
        // doesn't count (sticky shells arm on contact, fuseAge 0 at stick).
        const hz = p.fuseRamp && config.maxLifetime
          ? p.hz * (1 + 3 * (fuseAge / config.maxLifetime) ** 2) : p.hz;
        const s = Math.sin(age * hz * Math.PI * 2);
        gs *= 1 + p.depth * s;
        // Same wave drives a color flash toward the material's crest
        // white — s<0 holds the resting tint so the blink reads OFF/ON.
        const f = Math.max(0, s) ** 2;
        _instColor.copy(restTint!).lerp(_white, f);
        syncProjectileInstanceColor(glowMesh, _instColor);
      } else if (restTint) {
        syncProjectileInstanceColor(glowMesh, restTint);
      }
    }
    // Z-fight guard: a shell whose glow radius crosses its own body
    // surface (sticky: hitMax ≈ bodyRadius, pulsing) shimmers as the
    // two instanced spheres coincide. The floor ramps too — an unscaled
    // floor at spawn pins a body-sized glow right at the muzzle.
    gs = Math.max(gs, (config.bodyRadius * 1.15 + 0.01) * glowRamp);
    if (config.glowShape === 'wakeCone') {
      // Shock collar: apex rides the shell, skirt trails -velocity.
      // Stationary frames keep the last orientation — a parked cone
      // still reads as the wake envelope.
      if (vel.lengthSq() > 0.01) {
        _velDir.copy(vel).normalize();
        glowMesh.quaternion.setFromUnitVectors(_FORWARD, _velDir);
      }
      // The collar radius IS the wake proxy hitbox — not gs (which
      // carries glowScale shrink). Coupled here so the visual can never
      // understate the live hit envelope; glowScale only tunes the
      // skirt's LENGTH for cone shapes.
      const cr = Math.max(hitRadius * glowRamp, (config.bodyRadius * 1.15 + 0.01) * glowRamp);
      glowMesh.scale.set(cr, cr, cr * CONE_LEN * glowMultiplier);
    } else {
      glowMesh.scale.setScalar(gs);
    }
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
      mesh.rotateOnAxis(_tumbleAxis, vel.length() * dt * 3);
    } else {
      mesh.quaternion.setFromUnitVectors(_FORWARD, _velDir);
    }
  }

  syncProjectileInstance(mesh);
  syncProjectileInstance(glowMesh);
}

// Alt+Q census section — instanced shell pools (grow/shrink inventory).
registerDiag('inst', () => ({ inst: instPoolDump() }));
