import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { StructureSpec } from '../../../shared/mapSpec.js';
import { structureColliders } from '../../../shared/ballCollide.js';
import { TEAM_COLORS } from '../../../shared/teams.js';
import {
  mkBastion, mkBaseTower, mkWallRun, mkWallGate, mkGenDome, mkLandingPad,
  mkCommsMast, mkKataStand, mkBunker, mkFlagTower, mkPillar, mkObelisk,
  mkArch, mkShard, mkGatehouse, mkGenHouse,
} from '../structures/structures.js';
import { ramp, hullMat, trimMat, deckMat, darkMat } from '../structures/structKit.js';
import { applyTerrainBlend } from '../structures/terrainBlend.js';
import type { Terrain } from './terrain.js';
import { KIT_HULLS } from '../../../shared/structKits.js';
import { urlParams } from '../core/params.js';

// 'kit' spec pieces → their real builders (names match KIT_HULLS in
// shared/structKits — the piece collides as that table's boxes).
// Exported so the hull-parity test can build the REAL mapping — a table
// duplicated in the test would pin a copy, not the seam.
export const KIT_BUILDERS: Record<string, (glow: number) => THREE.Group> = {
  bastion:   (g): THREE.Group<THREE.Object3DEventMap> => mkBastion(g),
  tower:     (g): THREE.Group<THREE.Object3DEventMap> => mkBaseTower(9, 12, g),
  wallrun:   (g): THREE.Group<THREE.Object3DEventMap> => mkWallRun(18, 4.2, g),
  wallstub:  (g): THREE.Group<THREE.Object3DEventMap> => mkWallRun(8, 4.2, g),
  curtain:   (g): THREE.Group<THREE.Object3DEventMap> => mkWallRun(6, 4.2, g),
  lowwall:   (g): THREE.Group<THREE.Object3DEventMap> => mkWallRun(7, 2.2, g),
  wallgate:  (g): THREE.Group<THREE.Object3DEventMap> => mkWallGate(18, 4.2, 6, g),
  gendome:   (g): THREE.Group<THREE.Object3DEventMap> => mkGenDome(5, g),
  landpad:   (g): THREE.Group<THREE.Object3DEventMap> => mkLandingPad(4.5, g),
  commast:   (g): THREE.Group<THREE.Object3DEventMap> => mkCommsMast(10, g),
  katastand: (g): THREE.Group<THREE.Object3DEventMap> => mkKataStand(g),
  bunker:    (g): THREE.Group<THREE.Object3DEventMap> => mkBunker(12, 10, 4.2, g),
  genhouse:  (g): THREE.Group<THREE.Object3DEventMap> => mkGenHouse(16, 14, 7, g),
  flagtower: (g): THREE.Group<THREE.Object3DEventMap> => mkFlagTower(8, 10.5, g),
  pillar:    (g): THREE.Group<THREE.Object3DEventMap> => mkPillar(3, 9, g),
  obelisk:   (g): THREE.Group<THREE.Object3DEventMap> => mkObelisk(2.4, 12, g),
  arch:      (): THREE.Group<THREE.Object3DEventMap> => mkArch(),
  shard:     (): THREE.Group<THREE.Object3DEventMap> => mkShard(),
  gatehouse: (g): THREE.Group<THREE.Object3DEventMap> => mkGatehouse(g),
  ramp:      (): THREE.Group<THREE.Object3DEventMap> => ramp(5, 12, 2.5),
};

// Static map structures — the server's map spec arrives on gameState and
// every client builds identical geometry locally. Primitives stay dumb:
// one shared box geometry, per-kind material, merged into a handful of
// draw calls regardless of piece count. Collision is the next layer —
// for now these are cover you can stand behind, not walls that stop you.
const TINTS = {
  neutral: 0x4A_50_58,
  alpha: 0x3A_5A_80,
  bravo: 0x80_48_3A,
  root: 0x4D_3A_24,
} as const;

let built: THREE.Group | null = null;
let colliderGizmos: THREE.LineSegments | null = null;

let dome: THREE.Mesh | null = null;

/** Gate shield panes by owning spec — a downed generator switches its
 *  team's fields off (visual half; the collider list is rebuilt by
 *  structureSpecs.setTeamGridDown). */
const shieldPanes: { team?: string; mesh: THREE.Mesh }[] = [];
export function setShieldPanesOn(team: string, on: boolean): void {
  for (const p of shieldPanes) {if (p.team === team) {p.mesh.visible = on;}}
}

/** Drop the arena dome — admin hot-reload removed the boundary. */
export function clearArenaDome(scene: THREE.Scene): void {
  if (!dome) {return;}
  scene.remove(dome);
  dome.geometry.dispose();
  (dome.material as THREE.Material).dispose();
  dome = null;
}

/** Translucent dome marking the arena boundary (Quicksand-style). Non-
 * blocking — visible geometry only; enforcement is a separate layer. */
export function buildArenaDome(a: { x: number; z: number; radius: number }, groundY: number, scene: THREE.Scene): void {
  if (dome) {
    scene.remove(dome);
    dome.geometry.dispose();
    (dome.material as THREE.Material).dispose();
    dome = null;
  }
  const mat = new THREE.MeshBasicMaterial({
    color: 0x66_CC_FF, transparent: true, opacity: 0,
    // DoubleSide: BackSide is invisible from outside — and outside is
    // exactly where an offender stands when the boundary matters.
    side: THREE.DoubleSide, depthWrite: false,
  });
  dome = new THREE.Mesh(
    new THREE.SphereGeometry(a.radius, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    mat,
  );
  // Tribes-style: the barrier is invisible at range and fades in only near
  // the shell — so both inside-approach and outside-approach measure
  // distance to the shell surface, not the dome center.
  dome.onBeforeRender = (_r, _s, cam): void => {
    const dx = cam.position.x - a.x;
    const dy = cam.position.y - groundY;
    const dz = cam.position.z - a.z;
    const distToShell = Math.abs(Math.hypot(dx, dy, dz) - a.radius);
    mat.opacity = Math.max(0, Math.min(0.35, (1 - distToShell / 80) * 0.35));
    dome!.visible = mat.opacity > 0.004;
  };
  dome.position.set(a.x, groundY, a.z);
  dome.matrixAutoUpdate = false;
  dome.matrixWorldAutoUpdate = false;
  dome.updateMatrix();
  dome.updateMatrixWorld(true);
  scene.add(dome);
}

// Non-terrain collider wireframes — same ?debug / menu DEBUG gate as the
// player hitbox + AOE blast gizmos. Drawn straight from structureColliders
// output, so the overlay IS the set the sim resolves against (dif hulls,
// stands, cover) rather than a second guess at it.
const fmt = (n: number): string => n.toFixed(2);

function buildColliderGizmos(list: StructureSpec[], scene: THREE.Scene): void {
  if (colliderGizmos) {
    scene.remove(colliderGizmos);
    colliderGizmos.geometry.dispose();
    (colliderGizmos.material as THREE.Material).dispose();
    colliderGizmos = null;
  }
  const colliders = structureColliders(list);
  if (colliders.length === 0) {return;}

  if (urlParams.debug) {
    // Stand float probe — the wire spec vs the OBB it becomes. A dais
    // mesh anchors at home.y (ground); its skirt collider should start
    // at the SAME y. If collider base - spec pos.y ≠ 0, the mismatch is
    // in the collider math; if pos.y itself is high, the server snapped
    // the home onto something under it.
    let ci = 0;
    for (const s of list) {
      // Mirror structureColliders' expansion so ci lands on this spec's
      // first produced box: kits → one per KIT_HULLS row, root → 2 feet.
      let nOut = 1;
      if (s.kind === 'kit') {nOut = KIT_HULLS[s.piece ?? '']?.length ?? 0;}
      else if (s.kind === 'root') {nOut = 2;}
      if (s.kind === 'stand' && nOut > 0) {
        const c = colliders[ci];
        // oxlint-disable-next-line no-console
        console.log(`[standCollider] spec pos=(${fmt(s.pos.x)},${fmt(s.pos.y)},${fmt(s.pos.z)}) size=(${fmt(s.size.x)},${fmt(s.size.y)},${fmt(s.size.z)}) scale=${s.scale ?? 1} → box center y=${fmt(c.cy)} span=[${fmt(c.cy - c.hy)}..${fmt(c.cy + c.hy)}] baseOffset=${fmt(c.cy - c.hy - s.pos.y)}`);
      }
      ci += nOut;
    }
  }
  const unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();
  const edges: THREE.BufferGeometry[] = [];
  for (const c of colliders) {
    _p.set(c.cx, c.cy, c.cz);
    _e.set(0, Math.atan2(c.sin, c.cos), 0);
    _q.setFromEuler(_e);
    _s.set(c.hx * 2, c.hy * 2, c.hz * 2);
    _m.compose(_p, _q, _s);
    edges.push(unitEdges.clone().applyMatrix4(_m));
  }
  const merged = mergeGeometries(edges, false);
  for (const g of edges) {g.dispose();}
  unitEdges.dispose();
  if (!merged) {return;}
  colliderGizmos = new THREE.LineSegments(
    merged,
    new THREE.LineBasicMaterial({ color: 0x33_FF_88, transparent: true, opacity: 0.55, depthTest: false }),
  );
  colliderGizmos.renderOrder = 999;
  colliderGizmos.matrixAutoUpdate = false;
  colliderGizmos.matrixWorldAutoUpdate = false;
  colliderGizmos.visible = urlParams.debug;
  scene.add(colliderGizmos);
}



export function buildStructures(list: StructureSpec[], scene: THREE.Scene, terrain?: Pick<Terrain, 'heightU'>): void {
  // Sand-creep seam blend — patch the shared kit palette (idempotent)
  // and this build's spec-box mats so every wall/kit foot fades into
  // the heightfield instead of hard-intersecting it.
  if (terrain) {
    for (const m of [hullMat, trimMat, deckMat, darkMat]) {applyTerrainBlend(m, terrain.heightU);}
  }
  if (built) {
    scene.remove(built);
    // Every material in `built` comes from this file's per-build `mats`
    // (shared kit mats live in structures.ts, not here) — disposing the
    // handful per rebuild is safe; double-dispose is a no-op.
    built.traverse((o): void => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        // Kit pieces share the kit's module-level palette materials —
        // disposing them here poisons every later map/gunlab build.
        let shared = false;
        for (let p: THREE.Object3D | null = o; p; p = p.parent) {
          if (p.userData.kitPiece) {shared = true; break;}
        }
        if (!shared) {
          const m = o.material;
          if (Array.isArray(m)) {m.forEach((x) => x.dispose());}
          else {m.dispose();}
        }
      }
    });
    built = null;
  }
  shieldPanes.length = 0;
  if (list.length === 0) {return;}
  built = new THREE.Group();
  built.name = 'mapStructures';
  built.matrixAutoUpdate = false;
  built.matrixWorldAutoUpdate = false;
  const mats = {
    neutral: new THREE.MeshLambertMaterial({ color: TINTS.neutral }),
    alpha: new THREE.MeshLambertMaterial({ color: TINTS.alpha }),
    bravo: new THREE.MeshLambertMaterial({ color: TINTS.bravo }),
    root: new THREE.MeshLambertMaterial({ color: TINTS.root }),
  };
  if (terrain) {for (const m of Object.values(mats)) {applyTerrainBlend(m, terrain.heightU);}}
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  // Bake every piece into one geometry per material — a map's worth of
  // cover is ~40 static boxes, and per-mesh draws were ~40 program keys
  // per frame for pixels that never move.
  const byMat = new Map<keyof typeof mats, THREE.BufferGeometry[]>();
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();
  // 'stand'/'hull' specs are collision-only — the flag dais mesh and
  // ported interiors are their visuals; drawing the generic box would
  // double-render over them. 'kit' pieces take the real builder path.
  for (const s of list) {
    if (s.kind !== 'kit') {continue;}
    const mk = KIT_BUILDERS[s.piece ?? ''];
    if (!mk) {continue;}
    const piece = mk(s.team ? TEAM_COLORS[s.team] : 0x59_F2_FF); // unteamed = neutral cyan
    piece.userData.kitPiece = true;
    piece.position.set(s.pos.x, s.pos.y, s.pos.z);
    piece.rotation.y = s.rotY ?? 0;
    if (s.scale && s.scale !== 1) {piece.scale.setScalar(s.scale);}
    piece.updateMatrixWorld(true);
    built.add(piece);
  }
  // 'shield' panes — team-gated energy fields. Translucent so allies read
  // the gate they can pass and enemies read the wall they can't; the
  // collider carries passTeam so the server resolves who gets through.
  for (const s of list) {
    if (s.kind !== 'shield') {continue;}
    const color = s.team ? TEAM_COLORS[s.team] : 0x59_F2_FF;
    const pane = new THREE.Mesh(
      new THREE.BoxGeometry(s.size.x, s.size.y, Math.max(0.25, s.size.z)),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.22,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    pane.position.set(s.pos.x, s.pos.y + s.size.y / 2, s.pos.z);
    pane.rotation.y = s.rotY ?? 0;
    // Bright edge outline — the pane alone vanishes at glancing angles;
    // the frame keeps the portal's extent readable from any approach.
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(pane.geometry),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
    );
    pane.add(edges);
    pane.updateMatrixWorld(true);
    shieldPanes.push({ team: s.team, mesh: pane });
    built.add(pane);
  }
  for (const s of list.filter((st): boolean => st.kind !== 'stand' && st.kind !== 'hull' && st.kind !== 'kit' && st.kind !== 'shield')) {
    const key = s.kind === 'root' ? 'root' : (s.team ?? 'neutral');
    // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
    let g!: THREE.BufferGeometry;
    if (s.kind === 'root') {
      // Twisted-root arch (Quicksand): half-torus, legs at ±size.x on the
      // local X axis, apex ~size.x above base, tube radius size.y.
      // size.z tilts the ring off-axis so arches read gnarled, not ideal.
      g = new THREE.TorusGeometry(s.size.x, s.size.y, 7, 18, Math.PI);
      _p.set(s.pos.x, s.pos.y, s.pos.z);
      _e.set(0, s.rotY ?? 0, 0);
      _q.setFromEuler(_e);
      _s.set(1, 1, s.size.z);
      _m.compose(_p, _q, _s);
      g.applyMatrix4(_m);
    } else {
      _p.set(s.pos.x, s.pos.y + s.size.y / 2, s.pos.z);
      _e.set(0, s.rotY ?? 0, 0);
      if (s.kind === 'ramp') {_e.x = -Math.PI / 7;}
      _q.setFromEuler(_e);
      _s.set(s.size.x, s.size.y, s.size.z);
      _m.compose(_p, _q, _s);
      g = (s.kind === 'pillar' ? cyl : unit).clone().applyMatrix4(_m);
    }
    (byMat.get(key) ?? byMat.set(key, []).get(key)!).push(g);
  }
  for (const [key, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) {continue;}
    const mesh = new THREE.Mesh(merged, mats[key]);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.updateMatrixWorld(true);
    built.add(mesh);
    for (const g of geos) {g.dispose();}
  }
  built.updateMatrixWorld(true);
  scene.add(built);
  // Template geometries only exist to stamp clones — the merged result
  // was already added; the templates themselves aren't in the scene.
  unit.dispose();
  cyl.dispose();
  buildColliderGizmos(list, scene);
}

/** The debug toggle is live — menu flips mid-session must reach the
 *  overlay, so visibility re-reads the flag each frame. */
export function refreshColliderGizmoVisibility(): void {
  if (colliderGizmos) {colliderGizmos.visible = urlParams.debug;}
}
