import * as THREE from 'three';
import { BASE_SPEED, EXTRA_SPEED } from '../core/config.js';

// Shard spawn family — geometry pick (real body part, fragment geo, or
// a primitive by kind) + the three launch modes (posed part pops off
// along its own offset, shell-sampled burst rides the impact normal,
// plain cone). Debris.spawnShard calls both.
export interface DebrisOptions {
  count: number;
  spreadX: number;
  spreadY: number;
  spreadZ: number;
  /** Shatter-from-shell: shard origins sit on this radius so frame 0's
   *  silhouette is the original body, not a box of chunks. */
  shellRadius?: number;
  /** Projectile direction — shards bias along it so force reads as
   *  traveling THROUGH the body. */
  impulseDir?: THREE.Vector3;
  /** The dead body's velocity — debris inherits momentum. */
  inheritVel?: THREE.Vector3;
  /** 'brush' = thin sticks that flutter; 'goo' = organic splat blobs that
   *  hit the ground and STICK. */
  kind?: 'rock' | 'brush' | 'goo';
  /** Real fragments of the dying body (tumbleweed twigs) — shards use
   *  these geometries so the burst is made of the thing that died. */
  shardGeos?: THREE.BufferGeometry[];
  /** Posed body parts — one shard per part, spawned AT its world
   *  centroid (pos is absolute, px/py/pz only seed the outward burst
   *  direction). Owned geometries: disposed when the shard dies. */
  parts?: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[];
  /** Goo shards that land fire this once — the splat-on-touch model:
   *  the spray is only a promise, the stain lives where a droplet
   *  actually hits dirt. */
  onDropletLand?: (x: number, z: number, dropletR: number, dx: number, dz: number) => void;
  /** Max droplets per burst that paint (the rest just splat visually) —
   *  bounds decal churn under chaingun-rate hits. */
  paintBudget?: number;
  /** Airborne shards shed a dark smoke wisp on a slow cadence (player
   *  gib bursts). Cheap: pooled fxPuff, pressure-throttled. */
  smoke?: boolean;
}

export type DebrisPart = NonNullable<DebrisOptions['parts']>[number];

// Smoke cadence — slower than the sparkle trail: puffs live ~0.6s so
// ~7Hz per shard still keeps a continuous wake. Lives here (leaf
// module) because debris.ts and debrisStep.ts both need it.
export const SMOKE_INTERVAL = 0.14;

/** Primitive family index for the instanced path — same shapes as the
 *  random branch below, but as a bucket id so shards can share one
 *  InstancedMesh per family (14-20 shards per kill were 14-20 draws). */
export function pickShardPrim(opts: DebrisOptions): number {
  if (opts.kind === 'brush') return 3;
  if (opts.kind === 'goo') return 4;
  const t = Math.random();
  return t < 0.4 ? 0 : t < 0.7 ? 1 : 2;
}

export function pickShardGeo(part: DebrisPart | undefined, opts: DebrisOptions, sw: number, sh: number, sd: number): THREE.BufferGeometry {
  if (part) return part.geo;
  if (opts.shardGeos?.length) {
    return opts.shardGeos[Math.floor(Math.random() * opts.shardGeos.length)]!;
  }
  if (opts.kind === 'brush') {
    // Splintered twig — thin tapered stick, random length
    return new THREE.CylinderGeometry(0.008, 0.014, 0.2 + Math.random() * 0.35, 3);
  }
  if (opts.kind === 'goo') {
    // Lumpy glob — squashed icosahedron reads as tissue, not a marble
    const g = new THREE.IcosahedronGeometry(0.05 + Math.random() * 0.08, 0);
    g.scale(1, 0.5 + Math.random() * 0.4, 0.8 + Math.random() * 0.4);
    return g;
  }
  const geoType = Math.random();
  const m = Math.max(sw, sh, sd);
  const geo = geoType < 0.4 ? new THREE.TetrahedronGeometry(m, 0)
    : geoType < 0.7 ? new THREE.DodecahedronGeometry(m, 0)
    : new THREE.IcosahedronGeometry(m, 0);
  geo.scale(sw / m, sh / m, sd / m);
  return geo;
}

function partLaunch(part: DebrisPart, opts: DebrisOptions, px: number, py: number, pz: number):
  { o: THREE.Vector3; vel: THREE.Vector3 } {
  // Body part: spawn at its own centroid, fly outward from the
  // burst center along the part's offset (a head pops UP off the
  // neck, an arm goes sideways — dismemberment, not shrapnel).
  const o = new THREE.Vector3(part.pos.x - px, part.pos.y - py, part.pos.z - pz);
  const l = Math.hypot(o.x, o.y, o.z);
  const dx = l > 0.01 ? o.x / l : Math.random() * 2 - 1;
  const dy = l > 0.01 ? o.y / l : Math.random() * 0.5 + 0.5;
  const dz = l > 0.01 ? o.z / l : Math.random() * 2 - 1;
  const spd = (BASE_SPEED * 0.6) + Math.random() * EXTRA_SPEED * 0.6;
  const vel = new THREE.Vector3(dx * spd, dy * spd + 1.5, dz * spd);
  if (opts.impulseDir) vel.addScaledVector(opts.impulseDir, 6);
  if (opts.inheritVel) vel.addScaledVector(opts.inheritVel, 0.7);
  return { o, vel };
}

function shellLaunch(opts: DebrisOptions):
  { o: THREE.Vector3; vel: THREE.Vector3 } {
  // Surface-sampled: random unit direction, shard sits ON the shell
  // (0.55–0.95R so pieces overlap — no gaps in the first frame) and
  // flies along that normal — the body bursts outward, not just apart.
  const dx = Math.random() * 2 - 1;
  const dy = Math.random() * 2 - 1;
  const dz = Math.random() * 2 - 1;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ndx = dx / len, ndy = dy / len, ndz = dz / len;
  const r = opts.shellRadius! * (0.55 + Math.random() * 0.4);
  const o = new THREE.Vector3(ndx * r, ndy * r, ndz * r);
  // Speed gradient: shards on the far side (aligned with the shot)
  // fly fastest — the burst wave travels THROUGH the body.
  let spd = BASE_SPEED + Math.random() * EXTRA_SPEED;
  if (opts.impulseDir) {
    const align = ndx * opts.impulseDir.x + ndy * opts.impulseDir.y + ndz * opts.impulseDir.z;
    spd *= 1 + Math.max(0, align) * 0.9;
  }
  const vel = new THREE.Vector3(ndx * spd, ndy * spd + 1.5, ndz * spd);
  // ~40% of the shot's push carried through the shards
  if (opts.impulseDir) vel.addScaledVector(opts.impulseDir, 6);
  if (opts.inheritVel) vel.addScaledVector(opts.inheritVel, 0.7);
  return { o, vel };
}

// Shard origin offset (o) + launch velocity (vel) for the three spawn
// modes: posed body part, shell-sampled burst, or plain spread cone.
export function shardLaunch(part: DebrisPart | undefined, opts: DebrisOptions, px: number, py: number, pz: number):
  { o: THREE.Vector3; vel: THREE.Vector3 } {
  if (part) return partLaunch(part, opts, px, py, pz);
  if (opts.shellRadius) return shellLaunch(opts);
  const o = new THREE.Vector3(
    (Math.random() - 0.5) * opts.spreadX,
    (Math.random() - 0.5) * opts.spreadY,
    (Math.random() - 0.5) * opts.spreadZ);
  const ang = Math.random() * Math.PI * 2;
  const elv = Math.random() * Math.PI * 0.65;
  const spd = BASE_SPEED + Math.random() * EXTRA_SPEED;
  return {
    o,
    vel: new THREE.Vector3(
      Math.cos(elv) * Math.cos(ang) * spd,
      Math.sin(elv) * spd + 2.0,
      Math.cos(elv) * Math.sin(ang) * spd),
  };
}

