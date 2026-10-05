// Crosshair probe for the Alt+Q dump — raycasts the center of the screen
// against every object carrying a `userData.dbg` tag and names what's
// actually under the reticle: ribbon slot + owner, pooled shell instance,
// swarm entity, quarks system, beam. Frozen VFX bugs need "what IS that
// thing" more than another census number.
import * as THREE from 'three';
import { RibbonTrail, RIBBON_TRIS_PER_SLOT, type TrailBatch } from '../effects/RibbonTrail.js';
import type { SpeciesSwarm, InstancedBlobShadows, SwarmSlotOwner } from '../entities/swarm.js';
import type { ParticleSystem } from 'three.quarks';
import type { DbgTag } from './fxDiag.js';

const _ray = new THREE.Raycaster();
// Points/Lines only hit when the ray passes within this world-space
// radius — a crosshair over a small sparkle still registers.
_ray.params.Points = { threshold: 1.5 };
_ray.params.Line = { threshold: 1.5 };
const _ndc = new THREE.Vector2(0, 0);
const MAX_HITS = 5;

/** Best-first list of tagged objects under the crosshair, e.g.
 *  `42m ribbon {"slot":20,"owner":true,...}`. Empty when nothing tags. */
export function aimProbe(scene: THREE.Scene, camera: THREE.Camera): string[] {
  const objs: THREE.Object3D[] = [];
  scene.traverse(o => { if (o.userData.dbg) {objs.push(o);} });
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects(objs, false);
  if (hits.length) {return hits.slice(0, MAX_HITS).map(h => `${h.distance.toFixed(0)}m ${describeHit(h)}`);}
  // Nothing tagged under the reticle — blind spot report. Raycast the
  // whole scene and describe what IS there by type/parent/material, so a
  // frozen thing made by an untagged system still names itself (that's
  // the signal to give it a markProbe).
  return _ray.intersectObjects(scene.children, true)
    .filter(h => h.object.visible && !h.object.userData.dbg)
    .slice(0, MAX_HITS)
    .map(h => `${h.distance.toFixed(0)}m untagged ${describeRaw(h.object)}`);
}

/** Type + parent chain + name — enough to find which subsystem owns an
 *  untagged render object without guessing. */
function describeRaw(o: THREE.Object3D): string {
  const chain: string[] = [];
  for (let p: THREE.Object3D | null = o; p && chain.length < 3; p = p.parent)
    {chain.push(`${p.type}${p.name ? `(${p.name})` : ''}`);}
  return chain.join(' < ');
}

function describeHit(h: THREE.Intersection): string {
  const d = h.object.userData.dbg as DbgTag;
  if (d.kind === 'trailBatch') {
    const slot = Math.floor((h.faceIndex ?? 0) / RIBBON_TRIS_PER_SLOT);
    return `ribbon ${JSON.stringify(RibbonTrail.identify(d.batch as TrailBatch, slot))}`;
  }
  if (d.kind === 'species') {
    const owner = (d.swarm as SpeciesSwarm).ownerAt(d.part!, h.instanceId ?? -1);
    return `species:${d.species} owner=${describeOwner(owner)}`;
  }
  return describePooled(d, h);
}

// Instance-backed pools — one describe for anything with a slot index +
// a free list, since the leak signature is the same for all of them:
// a visible instance already back in the free stack.
function describePooled(d: DbgTag, h: THREE.Intersection): string {
  const iid = h.instanceId ?? -1;
  switch (d.kind) {
    case 'instPool': {
      const leaked = d.pool!.free.includes(iid) ? ' LEAKED(lit-free-slot)' : '';
      return `shell ${d.label} inst=${iid}${leaked}`;
    }
    case 'gib': {
      const g = d.gib as { live: number; cap: number; freeIdx: number[] };
      const leaked = g.freeIdx.includes(iid) ? ' LEAKED(lit-free-slot)' : '';
      return `gib ${d.label} inst=${iid} live=${g.live}/${g.cap}${leaked}`;
    }
    case 'blobShadows': {
      const owner = (d.swarm as InstancedBlobShadows).ownerAt(iid);
      return `blobShadow inst=${iid} owner=${describeOwner(owner)}`;
    }
    case 'quarks': {
      const ps = d.ps as ParticleSystem;
      return `quarks paused=${ps.paused} particles=${ps.particleNum ?? '?'}`;
    }
    case 'beam': return `beam(${d.label ?? 'hitscan flash'})`;
    case 'fxMesh': return `fx(${d.label ?? 'mesh'})`;
    default: return `dbg:${d.kind}`;
  }
}

// SwarmSlotOwner carries no name — best-effort identity from whatever
// the concrete owner exposes (Ball has pos/netId, RemotePlayer has id).
function describeOwner(owner: SwarmSlotOwner | undefined): string {
  if (!owner) {return 'none';}
  const o = owner as SwarmSlotOwner & {
    pos?: { x: number; y: number; z: number };
    netId?: number; playerId?: string; dead?: boolean;
  };
  const pos = o.pos ? ` @${o.pos.x.toFixed(0)},${o.pos.y.toFixed(0)},${o.pos.z.toFixed(0)}` : '';
  const id = o.playerId ?? (o.netId !== undefined ? `net${o.netId}` : '');
  return `${o.constructor.name}${id ? `(${id})` : ''}${o.dead ? ' DEAD' : ''}${pos}`;
}
