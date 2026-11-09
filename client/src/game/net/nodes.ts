// Server-owned conquest lattice - dumb renderers: a ground ring +
// light pillar per node recolored by owner, plus link lines between
// same-owner 4-neighbors. The physical bases (katastand pedestals /
// gendome cores) aren't drawn here - they arrive as 'kit' structures on
// the wire echo and build/collide through the standard map pipeline.
// All rules live in modeConquest.ts server-side; this file only paints
// nodeUpdate rosters (same pattern as net/flags).

import * as THREE from 'three';
import type { NetCtx } from './ctx.js';
import { reconcileReplicas } from '../replicas.js';
import { TEAM_COLORS, type TeamId } from '../../../../shared/teams.js';
import { CONQUEST, conquestN4, conquestActionable } from '../../../../shared/conquest.js';
import { Explosion } from '../../effects/explosion.js';
import { explosionAt } from '../../core/sfx/explosions.js';
import type { FieldRing } from '../../world/terrain.js';
import type { RepairTarget } from '../../ui/HealthBarSystem.js';

export type NodeOwner = 'alpha' | 'bravo' | 'neutral';
export interface NodeRow {
  id: number; gx: number; gz: number;
  pos: { x: number; y: number; z: number };
  owner: NodeOwner; hp: number; maxHp: number; build: number; buildBy?: string | null; core: boolean;
}

/** What a node layer needs - NetCtx['deps'] satisfies this structurally;
 *  the offline bridge passes the same slots, so hosted and solo paint
 *  identically. */
export interface NodeLayerDeps {
  lazyScene(): THREE.Scene;
  lazyTerrain(): { getHeight(x: number, z: number): number; addFieldRing(x: number, z: number, r: number, tint: readonly [number, number, number]): FieldRing; removeFieldRing(h: FieldRing): void };
  world: { localTeam?: string; nodeMarkers: Map<number, { pos: THREE.Vector3; owner: NodeOwner; core: boolean; gx: number; gz: number; show: boolean; hot: boolean }>; nodeLayer?: { tick(dt: number, now: number): void } | null; explosions: Explosion[] };
  lazyHud(): { logEvent(text: string, cls?: string): void; removePlayerIndicator(id: string): void };
  fragMessages: { show(text: string): void };
  lazyHealthBarSystem(): { showDamage(item: RepairTarget, ally: boolean): void };
  lazyDemoManager?: () => { recordNodeUpdate(r: { id: number; pos: { x: number; y: number; z: number }; owner: string; core: boolean; hp: number; buildBy: string | null; show: boolean; hot: boolean; gx: number; gz: number }): void } | null;
}

const NEUTRAL_COLOR = 0x6A_70_78;
const colorFor = (owner: NodeOwner): number => (owner === 'neutral' ? NEUTRAL_COLOR : TEAM_COLORS[owner as TeamId]);

// The ring is a REAL terrain decal: Terrain.addFieldRing draws the
// annulus into the terrain fragment shader itself, so it conforms to
// the displaced surface exactly — no draped mesh to slice or float.
// The shader's band sits at r*0.9 with a faint interior fill.
const NODE_RING_R = CONQUEST.TOUCH_R / 0.9;
const CORE_RING_R = CONQUEST.TOUCH_R / 0.9 + 2;
const BEAM_GEO = new THREE.CylinderGeometry(1.1, 1.7, 1, 10, 1, true);
const CORE_BEAM_GEO = new THREE.CylinderGeometry(1.9, 2.8, 1, 12, 1, true);
const BEAM_H = 46;
const CORE_BEAM_H = 70;
// The shootable weak point — a glowing shard on the deck. Beams/ring say
// WHO owns it; the crystal says WHAT you damage.
const CRYSTAL_GEO = new THREE.OctahedronGeometry(1, 0);

interface NodeVis {
  g: THREE.Group;
  ring: FieldRing;
  tint: [number, number, number];
  beam: THREE.Mesh;
  beamMat: THREE.MeshBasicMaterial;
  /** Inner 40%-width core beam - visible only on frontier (actionable)
   *  nodes so reachable crystals read as "hot" at a glance. */
  beam2: THREE.Mesh;
  beam2Mat: THREE.MeshBasicMaterial;
  crystal: THREE.Mesh;
  crystalMat: THREE.MeshBasicMaterial;
  /** RepairTarget adapter — vitals bar reads health live off it. */
  target: RepairTarget;
  /** hp as of last apply — a drop is the damage edge that pops the bar. */
  lastHp: number;
  core: boolean;
  /** Y the beam rises from — the kit base's top (katastand deck ~3.4,
   *  gendome cap ~7), so it doesn't sprout through the pedestal. */
  baseTop: number;
  /** Contested/actionable read from the last roster — drives the
   *  crystal's spin rate (a live objective turns, a dead one idles). */
  hot: boolean;
  /** Crystal hover baseline — bobbed per frame around this offset. */
  crystY: number;
}

const _col = new THREE.Color();
function buildVis(row: NodeRow, terrain: ReturnType<NodeLayerDeps['lazyTerrain']>): NodeVis {
  const g = new THREE.Group();
  const col = colorFor(row.owner);
  const beamMat = new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: row.core ? 0.42 : 0.3,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const tint: [number, number, number] = [0, 0, 0];
  _col.setHex(col);
  tint[0] = _col.r; tint[1] = _col.g; tint[2] = _col.b;
  const ring = terrain.addFieldRing(row.pos.x, row.pos.z, row.core ? CORE_RING_R : NODE_RING_R, tint);
  ring.intensity = row.core ? 0.75 : 0.55;
  const baseTop = row.core ? 7 : 3.4;
  const beam = new THREE.Mesh(row.core ? CORE_BEAM_GEO : BEAM_GEO, beamMat);
  const h = row.core ? CORE_BEAM_H : BEAM_H;
  beam.position.y = baseTop + h / 2;
  beam.scale.y = h; // unit cylinder stretched to full height
  g.add(beam);
  const beam2Mat = new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.5,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const beam2 = new THREE.Mesh(row.core ? CORE_BEAM_GEO : BEAM_GEO, beam2Mat);
  beam2.scale.set(0.4, h, 0.4);
  beam2.position.y = baseTop + h / 2;
  beam2.visible = false;
  g.add(beam2);
  const crystalMat = new THREE.MeshBasicMaterial({ color: col });
  const crystal = new THREE.Mesh(CRYSTAL_GEO, crystalMat);
  const cs = row.core ? 1.6 : 1;
  crystal.scale.set(cs, cs * 1.9, cs);
  crystal.position.y = baseTop + cs * 1.2;
  g.add(crystal);
  const target: RepairTarget = {
    pos: new THREE.Vector3(row.pos.x, row.pos.y + baseTop + cs, row.pos.z),
    dead: false,
    v: { health: row.hp, armor: 0, maxHealth: row.maxHp },
  };
  g.position.set(row.pos.x, row.pos.y, row.pos.z);
  return { g, ring, tint, beam, beamMat, beam2, beam2Mat, crystal, crystalMat, target, lastHp: row.hp, core: row.core, baseTop, hot: false, crystY: baseTop + cs * 1.2 };
}

/** One row roster → one lattice paint. The hosted path feeds wire
 *  rosters; the offline bridge feeds its own sim's snapshot — same
 *  reconcile/links/markers/callouts either way. */
export function createNodeLayer(deps: NodeLayerDeps): { applyRows(nodes: NodeRow[]): void; tick(dt: number, now: number): void } {
  const vis = new Map<number, NodeVis>();
  const prevOwner = new Map<number, NodeOwner>();
  const prevCoreHp = new Map<number, number>();
  // One LineSegments for the whole territory web — rebuilt per update
  // (≤40 edges), so link colors always match live ownership.
  const links = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false }),
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
      // Core death gets the mega bloom - a razed node just flips neutral,
      // a dead core is the match ending and should LOOK like it.
      if (prevHp !== undefined && prevHp > 0 && r.hp <= 0) {
        const pos = new THREE.Vector3(r.pos.x, r.pos.y, r.pos.z);
        deps.world.explosions.push(new Explosion(deps.lazyScene(), pos, true, 0, undefined, 3, undefined, 'shellburst'));
        explosionAt(pos, true);
      }
      prevCoreHp.set(r.id, r.hp);
    }
  };

  /** The HUD-meaningful subset: cores always pin (yours = defend, theirs
   *  = the win condition), and whatever the local team can ACT on right
   *  now — linked neutrals to build, linked enemy nodes to raze. Owned
   *  non-frontier nodes stay unmarked (beams carry that read already). */
  const syncMarkers = (rows: NodeRow[]): void => {
    const marks = deps.world.nodeMarkers;
    const me = deps.world.localTeam;
    const nDim = Math.round(Math.sqrt(rows.length)) || 1;
    const seen = new Set<number>();
    for (const r of rows) {
      seen.add(r.id);
      let m = marks.get(r.id);
      if (!m) {m = { pos: new THREE.Vector3(), owner: r.owner, core: r.core, gx: r.gx, gz: r.gz, show: false, hot: false }; marks.set(r.id, m);}
      m.pos.set(r.pos.x, r.pos.y, r.pos.z);
      m.owner = r.owner;
      m.core = r.core;
      // HOT = owned and enemy-actionable — the contested frontier. True
      // for BOTH directions: my node they can raze (defend!) and their
      // node I can raze (attack!). These are the focus centers.
      const enemy = r.owner === 'alpha' ? 'bravo' : r.owner === 'bravo' ? 'alpha' : null;
      m.hot = enemy !== null && conquestActionable(rows, r, enemy, nDim);
      const canAct = me === 'alpha' || me === 'bravo' ? conquestActionable(rows, r, me, nDim) : false;
      m.show = r.core || m.hot || (canAct && r.owner !== me);
      // Demo lane: the marker decision is already computed here — record
      // it verbatim so playback pins the same diamonds without topology.
      deps.lazyDemoManager?.()?.recordNodeUpdate({ id: r.id, pos: r.pos, owner: r.owner, core: r.core, hp: r.hp, buildBy: r.buildBy ?? null, show: m.show, hot: m.hot, gx: r.gx, gz: r.gz });
    }
    for (const [id] of marks) {
      if (!seen.has(id)) {marks.delete(id); deps.lazyHud().removePlayerIndicator(`node:${id}`);}
    }
  };

  const applyRows = (nodes: NodeRow[]): void => {
    if (!linksAdded) {deps.lazyScene().add(links); linksAdded = true;}
    // Nodes the local team can act on right now — they get max ring
    // intensity ("the structure in this ring is your target").
    const me = deps.world.localTeam;
    const nDim = Math.round(Math.sqrt(nodes.length)) || 1;
    const actionable = new Set<number>();
    const hot = new Set<number>();
    if (me === 'alpha' || me === 'bravo') {
      for (const r of nodes) {
        if (r.owner !== me && r.buildBy !== me && conquestActionable(nodes, r, me, nDim)) {actionable.add(r.id);}
        const enemy = r.owner === 'alpha' ? 'bravo' : r.owner === 'bravo' ? 'alpha' : null;
        if (enemy && conquestActionable(nodes, r, enemy, nDim)) {hot.add(r.id);}
      }
    }
    reconcileReplicas(vis, nodes, {
      rowId: (r): number => r.id,
      ensure: (r): NodeVis => {
        const v = buildVis(r, deps.lazyTerrain());
        deps.lazyScene().add(v.g);
        vis.set(r.id, v);
        return v;
      },
      apply: (v, r): void => {
        callouts(r);
        // Diegetic read: a node someone can act on RIGHT NOW spins its
        // crystal faster - motion pulls the eye without a word of text.
        v.hot = actionable.has(r.id) || hot.has(r.id);
        // Three readable states: neutral untouched = dim grey; under
        // construction = the BUILDER's color brightening with progress;
        // owned = team color at full strength. The ring paints the
        // capture zone, so "what do I shoot" reads as the structure
        // inside it — actionable-for-me nodes get max intensity to pull
        // the eye.
        const builder = (r.buildBy === 'alpha' || r.buildBy === 'bravo') ? r.buildBy : null;
        const color = colorFor((builder ?? r.owner) as NodeOwner);
        _col.setHex(color);
        v.tint[0] = _col.r; v.tint[1] = _col.g; v.tint[2] = _col.b;
        v.ring.intensity = r.owner === 'neutral'
          ? (r.build > 0 ? 0.35 + r.build * 0.5 : 0.3)
          : (actionable.has(r.id) || hot.has(r.id) ? 1 : (r.core ? 0.8 : 0.6));
        v.beamMat.color.setHex(color);
        v.crystalMat.color.setHex(color);
        // hp drop edge → floating vitals bar on the crystal, exactly the
        // feedback a shooter expects from "I hit the target". Ally color
        // when the node fights for my team.
        if (r.hp < v.lastHp) {
          deps.lazyHealthBarSystem().showDamage(v.target, (builder ?? r.owner) === me);
        }
        v.lastHp = r.hp;
        v.target.v.health = r.hp;
        v.target.v.maxHealth = r.maxHp;
        // Crystal cracks: shrinks and goes brittle as hp drains.
        const hpF = Math.max(0, Math.min(1, r.hp / r.maxHp));
        const cs = (v.core ? 1.6 : 1) * (0.55 + 0.45 * hpF);
        v.crystal.scale.set(cs, cs * 1.9, cs);
        // Beam reads lattice state at a glance: neutral unbuilt = stub,
        // building = growing toward full, owned/core = full height — and
        // a WOUNDED node dims its pillar (opacity ∝ hp) so "it's almost
        // down" reads without a healthbar.
        const h = v.core ? CORE_BEAM_H : BEAM_H;
        const frac = r.owner === 'neutral' ? Math.max(0.08, r.build) : 1;
        v.beam.scale.y = h * frac;
        v.beam.position.y = v.baseTop + (h * frac) / 2;
        v.beamMat.opacity = r.owner === 'neutral'
          ? (r.core ? 0.42 : 0.3)
          : 0.12 + 0.38 * Math.max(0, Math.min(1, r.hp / r.maxHp));
        // Frontier double-beam: the inner 40% core only shows on nodes
        // the chain can reach, so "your next objective" reads instantly.
        v.beam2.visible = actionable.has(r.id);
        v.beam2.scale.y = h * frac;
        v.beam2.position.y = v.baseTop + (h * frac) / 2;
        v.beam2Mat.color.setHex(color);
        // Out-of-frontier enemy crystals ghost: damage-intangible reads
        // as translucent - only the gem dims, the stand stays solid.
        const ghost = r.owner !== me && r.buildBy !== me && !actionable.has(r.id);
        v.crystalMat.transparent = ghost;
        v.crystalMat.opacity = ghost ? 0.5 : 1;
      },
      reap: (v, id): void => {
        deps.lazyScene().remove(v.g);
        deps.lazyTerrain().removeFieldRing(v.ring);
        v.target.dead = true; // drops the vitals bar next frame
        v.beamMat.dispose();
        v.crystalMat.dispose();
        prevOwner.delete(id);
        prevCoreHp.delete(id);
      },
    });
    rebuildLinks(nodes);
    syncMarkers(nodes);
  };
  /** Per-frame idle motion — the crystal spin/bob. Rosters only arrive
   *  a few times a second; the affordance animates between them. */
  const tick = (dt: number, now: number): void => {
    for (const v of vis.values()) {
      v.crystal.rotation.y += dt * (v.hot ? 2.6 : 0.7);
      v.crystal.position.y = v.crystY + Math.sin(now * 0.0018 + v.g.position.x) * 0.35;
    }
  };
  return { applyRows, tick };
}

export function wireNodes(ctx: NetCtx): void {
  const layer = createNodeLayer(ctx.deps);
  ctx.networkManager.onNodeUpdate = (nodes: NodeRow[]): void => layer.applyRows(nodes);
  ctx.deps.world.nodeLayer = layer;
}
