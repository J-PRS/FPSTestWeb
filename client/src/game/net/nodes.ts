// Server-owned conquest lattice — dumb renderers: a ground ring +
// light pillar per node recolored by owner, plus link lines between
// same-owner 4-neighbors. All rules live in modeConquest.ts server-side;
// this file only paints nodeUpdate rosters (same pattern as net/flags).

import * as THREE from 'three';
import type { NetCtx } from './ctx.js';
import { reconcileReplicas } from '../replicas.js';
import { TEAM_COLORS, type TeamId } from '../../../../shared/teams.js';
import { conquestN4 } from '../../../../shared/conquest.js';

type NodeOwner = 'alpha' | 'bravo' | 'neutral';
interface NodeRow {
  id: number; gx: number; gz: number;
  pos: { x: number; y: number; z: number };
  owner: NodeOwner; hp: number; maxHp: number; build: number; core: boolean;
}

const NEUTRAL_COLOR = 0x6A_70_78;
const colorFor = (owner: NodeOwner): number => (owner === 'neutral' ? NEUTRAL_COLOR : TEAM_COLORS[owner as TeamId]);

// Shared geometry — every node reuses these; materials are per-node
// (owner recolor is a material tint, not a rebuild).
const RING_GEO = new THREE.RingGeometry(4.5, 6.5, 28);
const CORE_RING_GEO = new THREE.RingGeometry(6.5, 9, 36);
const BEAM_GEO = new THREE.CylinderGeometry(1.1, 1.7, 1, 10, 1, true);
const CORE_BEAM_GEO = new THREE.CylinderGeometry(1.9, 2.8, 1, 12, 1, true);
const BEAM_H = 46;
const CORE_BEAM_H = 70;

interface NodeVis {
  g: THREE.Group;
  ring: THREE.Mesh;
  beam: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  beamMat: THREE.MeshBasicMaterial;
  core: boolean;
}

function buildVis(row: NodeRow): NodeVis {
  const g = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({
    color: colorFor(row.owner), transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const beamMat = new THREE.MeshBasicMaterial({
    color: colorFor(row.owner), transparent: true, opacity: row.core ? 0.42 : 0.3,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(row.core ? CORE_RING_GEO : RING_GEO, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.35;
  const beam = new THREE.Mesh(row.core ? CORE_BEAM_GEO : BEAM_GEO, beamMat);
  const h = row.core ? CORE_BEAM_H : BEAM_H;
  beam.position.y = h / 2;
  beam.scale.y = h; // unit cylinder stretched to full height
  g.add(ring, beam);
  g.position.set(row.pos.x, row.pos.y, row.pos.z);
  return { g, ring, beam, ringMat, beamMat, core: row.core };
}

export function wireNodes(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;
  const vis = new Map<number, NodeVis>();
  const prevOwner = new Map<number, NodeOwner>();
  const prevCoreHp = new Map<number, number>();
  // One LineSegments for the whole territory web — rebuilt per update
  // (≤40 edges), so link colors always match live ownership.
  const links = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45 }),
  );
  links.frustumCulled = false;
  let linksAdded = false;

  const rebuildLinks = (rows: NodeRow[]): void => {
    const n = Math.round(Math.sqrt(rows.length)) || 1;
    const byCell = new Map(rows.map((r) => [`${r.gx},${r.gz}`, r]));
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    for (const r of rows) {
      if (r.owner === 'neutral') {continue;}
      for (const nb of conquestN4(r.gx, r.gz, n)) {
        const other = byCell.get(`${nb.gx},${nb.gz}`);
        // Canonical order so each edge emits once.
        if (!other || other.owner !== r.owner || nb.gx * n + nb.gz < r.gx * n + r.gz) {continue;}
        c.setHex(TEAM_COLORS[r.owner as TeamId]);
        pos.push(r.pos.x, r.pos.y + 2.5, r.pos.z, other.pos.x, other.pos.y + 2.5, other.pos.z);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    links.geometry.dispose();
    links.geometry = geo;
  };

  const callouts = (r: NodeRow): void => {
    // Ownership edge → callout. Cores never flip (they die), so team
    // transitions here are always neutral↔team.
    const prev = prevOwner.get(r.id);
    if (prev !== undefined && prev !== r.owner) {
      const mine = r.owner === deps.world.localTeam || prev === deps.world.localTeam;
      const captured = r.owner !== 'neutral';
      deps.lazyHud().logEvent(
        captured ? `Node ${mine ? 'captured' : 'lost'} (${r.gx},${r.gz})` : `Node razed (${r.gx},${r.gz})`,
        mine ? 'mine' : 'foe');
      if (captured) {deps.fragMessages.show(mine ? 'NODE CAPTURED' : 'NODE LOST');}
    }
    prevOwner.set(r.id, r.owner);
    // Core damage — the loudest callout in the mode.
    if (r.core) {
      const prevHp = prevCoreHp.get(r.id);
      if (prevHp !== undefined && r.hp < prevHp) {
        deps.fragMessages.show(r.owner === deps.world.localTeam ? 'OUR CORE UNDER ATTACK!' : 'ENEMY CORE UNDER ATTACK!');
      }
      prevCoreHp.set(r.id, r.hp);
    }
  };

  networkManager.onNodeUpdate = (nodes: NodeRow[]): void => {
    if (!linksAdded) {deps.lazyScene().add(links); linksAdded = true;}
    reconcileReplicas(vis, nodes, {
      rowId: (r): number => r.id,
      ensure: (r): NodeVis => {
        const v = buildVis(r);
        deps.lazyScene().add(v.g);
        vis.set(r.id, v);
        return v;
      },
      apply: (v, r): void => {
        callouts(r);
        const color = colorFor(r.owner);
        v.ringMat.color.setHex(color);
        v.beamMat.color.setHex(color);
        // Beam reads lattice state at a glance: neutral unbuilt = stub,
        // building = growing toward full, owned/core = full height.
        const h = v.core ? CORE_BEAM_H : BEAM_H;
        const frac = r.owner === 'neutral' ? Math.max(0.08, r.build) : 1;
        v.beam.scale.y = h * frac;
        v.beam.position.y = (h * frac) / 2;
      },
      reap: (v, id): void => {
        deps.lazyScene().remove(v.g);
        v.ringMat.dispose();
        v.beamMat.dispose();
        prevOwner.delete(id);
        prevCoreHp.delete(id);
      },
    });
    rebuildLinks(nodes);
  };
}
