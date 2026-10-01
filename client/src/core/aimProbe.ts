// Crosshair probe for the Alt+Q dump — raycasts the center of the screen
// against every object carrying a `userData.dbg` tag and names what's
// actually under the reticle: ribbon slot + owner, pooled shell instance,
// swarm entity, quarks system, beam. Frozen VFX bugs need "what IS that
// thing" more than another census number.
import * as THREE from 'three';
import { RibbonTrail, RIBBON_TRIS_PER_SLOT, type TrailBatch } from '../projectiles/RibbonTrail.js';
import type { SpeciesSwarm, InstancedBlobShadows, SwarmSlotOwner } from '../entities/swarm.js';
import type { ParticleSystem } from 'three.quarks';

interface DbgTag {
  kind: string;
  batch?: TrailBatch;
  label?: string;
  pool?: { free: number[] };
  species?: string;
  swarm?: SpeciesSwarm | InstancedBlobShadows;
  part?: number;
  ps?: ParticleSystem;
}

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
  scene.traverse(o => { if (o.userData.dbg) objs.push(o); });
  if (!objs.length) return [];
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects(objs, false);
  return hits.slice(0, MAX_HITS).map(h => `${h.distance.toFixed(0)}m ${describeHit(h)}`);
}

function describeHit(h: THREE.Intersection): string {
  const d = h.object.userData.dbg as DbgTag;
  switch (d.kind) {
    case 'trailBatch': {
      const slot = Math.floor((h.faceIndex ?? 0) / RIBBON_TRIS_PER_SLOT);
      return `ribbon ${JSON.stringify(RibbonTrail.identify(d.batch!, slot))}`;
    }
    case 'instPool': {
      const iid = h.instanceId ?? -1;
      // A visible instance that's already back in the free stack is the
      // "detached frozen shell" leak signature — call it out explicitly.
      const leaked = d.pool!.free.includes(iid) ? ' LEAKED(lit-free-slot)' : '';
      return `shell ${d.label} inst=${iid}${leaked}`;
    }
    case 'species': {
      const owner = (d.swarm as SpeciesSwarm).ownerAt(d.part!, h.instanceId ?? -1);
      return `species:${d.species} owner=${describeOwner(owner)}`;
    }
    case 'blobShadows': {
      const owner = (d.swarm as InstancedBlobShadows).ownerAt(h.instanceId ?? -1);
      return `blobShadow inst=${h.instanceId} owner=${describeOwner(owner)}`;
    }
    case 'quarks': {
      const ps = d.ps!;
      return `quarks paused=${ps.paused} particles=${ps.particleNum ?? '?'}`;
    }
    case 'beam': return 'beam(hitscan flash)';
    default: return `dbg:${d.kind}`;
  }
}

// SwarmSlotOwner carries no name — best-effort identity from whatever
// the concrete owner exposes (Ball has pos/netId, RemotePlayer has id).
function describeOwner(owner: SwarmSlotOwner | undefined): string {
  if (!owner) return 'none';
  const o = owner as SwarmSlotOwner & {
    pos?: { x: number; y: number; z: number };
    netId?: number; playerId?: string; dead?: boolean;
  };
  const pos = o.pos ? ` @${o.pos.x.toFixed(0)},${o.pos.y.toFixed(0)},${o.pos.z.toFixed(0)}` : '';
  const id = o.playerId ?? (o.netId !== undefined ? `net${o.netId}` : '');
  return `${o.constructor.name}${id ? `(${id})` : ''}${o.dead ? ' DEAD' : ''}${pos}`;
}
