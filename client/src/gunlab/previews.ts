// gunlab previews — creature, pickup, and deployable builders for the
// lab rail. Creature previews are a REAL species instance, not a mesh
// copy: the lab gets a flat-terrain stub + the actual SpeciesSwarm, so
// the preview IS the in-game instanced renderer (writeInstances pose,
// instanceColor tints, TerrainFoot skirt, blob shadow, head tracking
// the camera). The returned Group is a proxy — the body draws through
// the swarm's InstancedMeshes in the lab scene; an invisible bounds box
// gives inspect's Box3 fit something to frame.
import * as THREE from 'three';
import { initSwarms, type LabEntity } from '../entities/swarms.js';
import { AmbientBirds } from '../effects/birds.js';
import { DeployTurret } from '../entities/DeployTurret.js';
import { DeployMortar } from '../entities/DeployMortar.js';
import { DeployCg } from '../entities/DeployCg.js';
import { DeployShield } from '../entities/DeployShield.js';
import { DeployStation } from '../entities/DeployStation.js';
import { DeployBeacon } from '../entities/DeployBeacon.js';
import { DeployDrone } from '../entities/DeployDrone.js';
import { DeployTether } from '../entities/DeployTether.js';
import { DeployWatersphere } from '../entities/DeployWatersphere.js';
import { SWARM_SPECS } from '../game/species/registry.js';
import type { Terrain } from '../world/terrain.js';
import { PICKUP_ACCENT, pickupParts } from '../entities/PickupModel.js';
import { metalMat } from '../entities/procMetal.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { bakeWearOnly } from '../effects/vertexAO.js';
import { EMIT_GAIN } from '../core/config.js';
import type { PickupKind } from '../../../shared/pickups.js';
import { mkFlagPlate } from '../game/flagRun.js';
import { mkFlagMesh } from '../game/ctfFlags.js';
import { TEAM_COLORS } from '../../../shared/teams.js';
import { PlayerModel, type PlayerModelVariant } from '../entities/PlayerModel.js';
import { PlayerDebris } from '../effects/debris.js';
import { CLASS_BODY_MAT_REV, CLASS_BODY_VARIANT, type AnimationState } from '../entities/playerClips.js';
import { CLASS_MODEL_SCALE, classCapsule, type ArmorClass } from '../../../shared/botClasses.js';

// The one live-body tick — whichever preview proxy is parked owns it.
// gunlab's render loop reads it through this holder so proxy builders
// can install/clear it without reaching into the main module.
import { mkBastion, mkBaseTower, mkWallRun, mkWallGate, mkGenDome, mkLandingPad, mkCommsMast, mkKataStand, mkBunker, mkFlagTower, mkPillar, mkObelisk, mkArch, mkShard } from '../structures/structures.js';
import { ramp } from '../structures/structKit.js';
import { KIT_BUILDERS } from '../world/mapStructures.js';
import { resolveMapSpec, parseMapSpecJson } from '../../../shared/mapSpec.js';
import bastionJson from '../../../maps/bastion.json';
export const previewLive: { tick: ((dt: number) => void) | null } = { tick: null };

// Camera world position is what creature AI and deployable tracking
// aim at — installed once by initPreviews since the tables below are
// built lazily, possibly before a camera exists.
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let cam!: THREE.Camera;
export function initPreviews(camera: THREE.Camera): void { cam = camera; }

const _camW = new THREE.Vector3();
const _zero = new THREE.Vector3();
let swarmsReady = false;
// All instanced creature rendering parents under ONE layer — swarm
// InstancedMeshes, blob shadows, bolt meshes, TerrainFoot, trail dots.
// Whichever proxy currently owns the layer owns the creature, so inspect
// recentring and FPS placement carry the real body instead of leaving it
// parked at world origin inside the camera.
const creatureLayer = new THREE.Group();
const LAB_SCENE = creatureLayer as unknown as THREE.Scene;
const LAB_TERRAIN = {
  getHeight: (): number => 0,
  getHeightVisual: (): number => 0,
  getNormal: (): THREE.Vector3 => new THREE.Vector3(0, 1, 0),
  // Swarm blob shadows + terrainBlend read the SAME uniform objects a
  // real Terrain exposes — a flat 1×1 zero field keeps the stub honest.
  heightU: (() => {
    const hmap = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    hmap.needsUpdate = true;
    return {
      heightMap: { value: hmap as THREE.DataTexture | null },
      hmWorldScale: { value: 1000 },
      hScale: { value: 60 },
    };
  })(),
  // Decal APIs the deployables call when seating — a real handle object
  // so intensity tweens still land somewhere; there's just no clipmap
  // shader on the other end.
  addFieldRing: (x: number, z: number, r: number, tint: readonly number[]): { x: number; z: number; r: number; intensity: number; tint: readonly number[]; } => ({ x, z, r, intensity: 0.5, tint }),
  removeFieldRing: (): undefined => undefined,
  addScorch: (): null => null,
  addSplat: (): null => null,
} as unknown as Terrain;

function ensureSwarms(): void {
  if (swarmsReady) {return;}
  // The full live registry, shrunk to single-specimen buffers — a new
  // species shows up in the lab the moment it's registered, no lab edit.
  const labSpecs = Object.fromEntries(
    Object.entries(SWARM_SPECS).map(([k, s]) => [k, Object.assign({}, s, {capacity: 8})]),
  );
  initSwarms(LAB_SCENE, LAB_TERRAIN, labSpecs);
  swarmsReady = true;
}

function creatureProxy(spawn: () => LabEntity): THREE.Group {
  ensureSwarms();
  const c = spawn();
  const proxy = new THREE.Group();
  // Invisible bounds sized off the entity's gameplay radius — gives
  // inspect's Box3 fit something sane to frame for overlord or gnat alike.
  const r = Math.max(c.radius, 0.4);
  const bounds = new THREE.Mesh(new THREE.BoxGeometry(r * 2.6, r * 2.2, r * 2.6), new THREE.MeshBasicMaterial());
  bounds.visible = false;
  bounds.position.y = r * 0.9;
  proxy.add(bounds, creatureLayer);
  // Live-body anchor — the swarm's instances sit wherever the creature
  // crawled, so the invisible bounds box can't be trusted to frame it.
  proxy.userData.liveFocus = (): THREE.Vector3 => c.pos;
  // Explicit dispose, NOT a 'removed' listener — inspect re-parents this
  // proxy (vm.group → scene) and 'removed' fires on every reparent,
  // which would slaughter the creature on each mode toggle.
  proxy.userData.disposeCreature = (): void => { c.dispose(); previewLive.tick = null; };
  // Feed playerPos in PROXY space, not world space: inspect mode
  // recentres/rotates the proxy, so a world-space camera pos would leave
  // the AI aiming at a phantom — the barrel misses you by exactly the
  // recentre offset. Local space keeps aim honest under any placement.
  previewLive.tick = (dt): void => {
    proxy.updateMatrixWorld();
    c.update(dt, LAB_TERRAIN, proxy.worldToLocal(cam.getWorldPosition(_camW)));
  };
  return proxy;
}

// Every species that can spawn under the shared ctor is a lab button —
// plus the ambient buzzard kettle, a whole boid system rather than one
// species instance (shrunk to lab scale or it orbits past the horizon).
export const CREATURES: [label: string, build: () => THREE.Group][] = [
  ...Object.entries(SWARM_SPECS)
    .filter(([, s]): ((scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) => LabEntity) | undefined => s.spawn)
    .map(([name, s]): [string, () => THREE.Group] =>
      [name, (): THREE.Group<THREE.Object3DEventMap> => creatureProxy((): LabEntity => s.spawn!(LAB_SCENE, LAB_TERRAIN, new THREE.Vector3()))]),
  ['buzzard', (): THREE.Group<THREE.Object3DEventMap> => creatureProxy(() => {
    const kettle = new AmbientBirds(LAB_SCENE, 0.08);
    return {
      pos: kettle.birds[0]!.group.position, radius: 2.5,
      update: (dt, _t, p): void => kettle.update(dt, p, LAB_TERRAIN),
      dispose: (): void => kettle.dispose(),
    };
  })],
];

// Pickup previews — every kind is the same tumbling gem body (mesh +
// additive halo sprite) sold by its PICKUP_ACCENT tint, so the table
// builds straight off that map: new kinds appear here automatically.
const NUGGET_R = 0.3; // Nugget.ts NUGGET_RADIUS — keep in step
function buildNugget(kind: PickupKind): () => THREE.Group {
  return (): THREE.Group<THREE.Object3DEventMap> => {
    const g = new THREE.Group();
    const base = new THREE.Color(PICKUP_ACCENT[kind]);
    const emit = base.clone().lerp(new THREE.Color(0xFF_FF_FF), 0.33).multiplyScalar(EMIT_GAIN);
    // Diegetic kinds get the real pickupParts body+accent — the same
    // shapes/materials Nugget builds in-game. Null parts keep the plain
    // gem (gem kind itself).
    const parts = pickupParts(kind);
    // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
    let gem!: THREE.Mesh;
    if (parts) {
      gem = new THREE.Mesh(parts.body, metalMat(parts.bodyColor));
      gem.add(new THREE.Mesh(parts.accent, new THREE.MeshBasicMaterial({ color: emit })));
    } else {
      gem = new THREE.Mesh(
        new THREE.IcosahedronGeometry(NUGGET_R, 0),
        new THREE.MeshBasicMaterial({ color: emit }),
      );
    }
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(32),
      color: base.clone().multiplyScalar(EMIT_GAIN),
      transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.setScalar(1.1);
    g.add(gem, halo);
    // Glow-behind trick: the billboard is coplanar with the model's
    // center, so wherever the surface falls behind that plane the sprite
    // crops the silhouette. Each frame park it just past the body on the
    // far side of the camera (proxy-local space — inspect recentres and
    // rotates the proxy, so a world-space offset would drift).
    previewLive.tick = (): void => {
      g.updateMatrixWorld();
      const local = g.worldToLocal(cam.getWorldPosition(_camW));
      halo.position.copy(local.normalize().multiplyScalar(-0.25));
    };
    g.userData.disposeCreature = (): void => { previewLive.tick = null; };
    return g;
  };
}
export const PICKUPS: [label: string, build: () => THREE.Group][] =
  (Object.keys(PICKUP_ACCENT) as PickupKind[]).map((k): [PickupKind, () => THREE.Group] => [k, buildNugget(k)]);

// Base structures — the structKit compositions, real builders straight
// out of structures.ts. Big pieces: liveFocus parks the camera framing
// on the compound center rather than the group origin.
export const STRUCTURES: [label: string, build: () => THREE.Group][] = [
  // The deployed map verbatim — same bastion.json + resolveMapSpec +
  // KIT_BUILDERS path the game renders, so the lab can never show a
  // stale layout. Flat terrain here (no seatKits): authored y stands.
  ['[MAP] bastion', (): THREE.Group<THREE.Object3DEventMap> => {
    const spec = resolveMapSpec(parseMapSpecJson(JSON.stringify(bastionJson)));
    const g = new THREE.Group();
    for (const s of spec.structures ?? []) {
      if (s.kind === 'kit') {
        const mk = KIT_BUILDERS[s.piece ?? ''];
        if (!mk) {continue;}
        const piece = mk(s.team ? TEAM_COLORS[s.team] : 0x59_F2_FF);
        piece.position.set(s.pos.x, s.pos.y, s.pos.z);
        piece.rotation.y = s.rotY ?? 0;
        if (s.scale && s.scale !== 1) {piece.scale.setScalar(s.scale);}
        g.add(piece);
      } else if (s.kind === 'shield' && s.size.y > 0) {
        const color = s.team ? TEAM_COLORS[s.team] : 0x59_F2_FF;
        const pane = new THREE.Mesh(
          new THREE.BoxGeometry(s.size.x, s.size.y, Math.max(0.25, s.size.z)),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
        pane.position.set(s.pos.x, s.pos.y + s.size.y / 2, s.pos.z);
        pane.rotation.y = s.rotY ?? 0;
        g.add(pane);
      }
    }
    // Frame alpha's compound — the authored cluster center.
    g.userData.liveFocus = (): THREE.Vector3 => new THREE.Vector3(-500, 40, 60);
    return g;
  }],
  ['bastion', (): THREE.Group<THREE.Object3DEventMap> => {
    const g = mkBastion();
    g.userData.liveFocus = (): THREE.Vector3 => new THREE.Vector3(0, 4, -4);
    return g;
  }],
  ['katastand', (): THREE.Group<THREE.Object3DEventMap> => mkKataStand()],
  ['bunker',   (): THREE.Group<THREE.Object3DEventMap> => mkBunker(12, 10, 4.2)],
  ['flagtower', (): THREE.Group<THREE.Object3DEventMap> => mkFlagTower()],
  ['tower',    (): THREE.Group<THREE.Object3DEventMap> => mkBaseTower(9, 12)],
  ['wallrun',  (): THREE.Group<THREE.Object3DEventMap> => mkWallRun(18, 4.2)],
  ['wallgate', (): THREE.Group<THREE.Object3DEventMap> => mkWallGate(18, 4.2, 6)],
  ['ramp',     (): THREE.Group<THREE.Object3DEventMap> => ramp(5, 12, 2.5)],
  ['gendome',  (): THREE.Group<THREE.Object3DEventMap> => mkGenDome(5)],
  ['landpad',  (): THREE.Group<THREE.Object3DEventMap> => mkLandingPad(4.5)],
  ['commast',  (): THREE.Group<THREE.Object3DEventMap> => mkCommsMast(10)],
  ['pillar',   (): THREE.Group<THREE.Object3DEventMap> => mkPillar()],
  ['obelisk',  (): THREE.Group<THREE.Object3DEventMap> => mkObelisk()],
  ['arch',     (): THREE.Group<THREE.Object3DEventMap> => mkArch()],
  ['shard',    (): THREE.Group<THREE.Object3DEventMap> => mkShard()],
];

// Deployable previews — real entity instances (real .group, real update
// loop) parked on the lab terrain stub. The group's own bounds feed
// inspect's Box3 fit, so no invisible proxy mesh is needed.
interface LabItem {
  group: THREE.Group;
  update?: (dt: number, p: THREE.Vector3) => void;
  dispose: (scene: THREE.Scene) => void;
}
function itemProxy(spawn: () => LabItem): THREE.Group {
  const it = spawn();
  const proxy = new THREE.Group();
  proxy.add(it.group);
  bakeWearOnly(proxy, { grime: true });
  proxy.userData.liveFocus = (): THREE.Vector3 => it.group.getWorldPosition(new THREE.Vector3());
  proxy.userData.disposeCreature = (): void => { it.dispose(LAB_SCENE); previewLive.tick = null; };
  if (it.update) {
    previewLive.tick = (dt): void => {
      proxy.updateMatrixWorld();
      it.update!(dt, proxy.worldToLocal(cam.getWorldPosition(_camW)));
    };
  }
  return proxy;
}
export const ITEMS: [label: string, build: () => THREE.Group][] = [
  // Flag on its floor plate — the flagrun pad + the shared flag mesh,
  // the in-game pair previewed as one piece — plus each half alone.
  ['flag', (): THREE.Group<THREE.Object3DEventMap> => {
    const g = new THREE.Group();
    g.add(mkFlagPlate(TEAM_COLORS.alpha));
    const flag = mkFlagMesh('alpha');
    flag.position.y = 0.46; // pole inserts into the socket mouth
    g.add(flag);
    return g;
  }],
  ['flag alone', (): THREE.Group<THREE.Object3DEventMap> => mkFlagMesh('alpha')],
  ['stand',     (): THREE.Group<THREE.Object3DEventMap> => mkFlagPlate(TEAM_COLORS.alpha)],
  ['sentry',  (): THREE.Group<THREE.Object3DEventMap> => { ensureSwarms(); const d = new DeployTurret(LAB_SCENE, LAB_TERRAIN, _zero); const proxy = new THREE.Group(); proxy.add(d.group, creatureLayer); proxy.userData.liveFocus = (): THREE.Vector3 => d.group.getWorldPosition(new THREE.Vector3()); proxy.userData.disposeCreature = (): void => { d.dispose(LAB_SCENE); previewLive.tick = null; }; previewLive.tick = (dt): void => { proxy.updateMatrixWorld(); d.update(dt, []); }; bakeWearOnly(proxy, { grime: true }); return proxy; }],
  ['mortar',  (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployMortar(LAB_SCENE, LAB_TERRAIN, _zero);
      d.unfoldDone(); return { group: d.group, update: (dt) => { d.update(dt, []); }, dispose: (s): void => d.dispose(s) }; })],
  ['minigun', (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployCg(LAB_SCENE, LAB_TERRAIN, _zero);
      d.unfoldDone(); return { group: d.group, update: (dt) => { d.update(dt, []); }, dispose: (s): void => d.dispose(s) }; })],
  ['shield',  (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployShield(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt): void => d.update(dt), dispose: (s): void => d.dispose(s) }; })],
  ['station', (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployStation(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt, p): void => { d.update(dt, p); }, dispose: (s): void => d.dispose(s) }; })],
  ['beacon',  (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployBeacon(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt): void => d.update(dt), dispose: (s): void => d.dispose(s) }; })],
  ['drone',   (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployDrone(LAB_SCENE, LAB_TERRAIN, _zero);
      return { group: d.group, update: (dt, p) => d.update(dt, p, 0, []), dispose: (s): void => d.dispose(s) }; })],
  ['tether',  (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployTether(LAB_SCENE, LAB_TERRAIN, _zero);
      d.unfoldDone(); return { group: d.group, update: (dt): void => d.update(dt), dispose: (s): void => d.dispose(s) }; })],
  ['watersphere', (): THREE.Group<THREE.Object3DEventMap> => itemProxy(() => { const d = new DeployWatersphere(LAB_SCENE, LAB_TERRAIN, _zero);
      d.unfoldDone(); return { group: d.group, update: (dt): void => d.update(dt), dispose: (s): void => d.dispose(s) }; })],
];

// Class lineup — all three armor classes at once (only three exist, a
// picker would be ceremony). REAL PlayerModel instances on the class
// bodies (scifisoldier/cybersoldier/polyart GLBs) so the silhouette,
// fit scale and idle animation are the shipping ones — same trick the
// old classlineup page did by hand, but through the real pipeline.
const CLASS_LINEUP: [cls: ArmorClass, x: number, labelY: number][] = [
  ['light',  -1.9, 2.1],
  ['medium',  0, 2.5],
  ['heavy',   2.4, 3.2],
];
function mkTextSprite(text: string, y: number): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.font = '600 30px monospace';
  ctx.fillStyle = '#9cf';
  ctx.textAlign = 'center';
  ctx.fillText(text.toUpperCase(), 128, 42);
  const tex = new THREE.CanvasTexture(cv);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.6, 0.4, 1);
  s.position.y = y;
  return s;
}
/** One lineup entry: body variant, world x, floating label text+height,
 *  capsule tier (collider wire) and scale tier. */
type LineupEntry = [variant: PlayerModelVariant, x: number, label: string, labelY: number, capsule: ArmorClass, matRev: boolean, scale?: number, yaw?: number];
function mkLineup(entries: LineupEntry[], boundsX = 0, boundsW = 0, focusX = 0): () => THREE.Group {
  return (): THREE.Group<THREE.Object3DEventMap> => {
    const proxy = new THREE.Group();
    const models: PlayerModel[] = [];
    // Gib preview — the real PlayerDebris pulverize (posed body parts +
    // impulse burst) then the body respawns ~1.6s later.
    const debris: { d: PlayerDebris; t: number; s: number }[] = [];
    const flashes: { m: THREE.Mesh; l: THREE.PointLight; t: number; s: number }[] = [];
    const downAt = new Map<PlayerModel, { t: number; s: number }>();
    let elapsed = 0;
    // Last picked team tint/outline — reapplied per body as GLBs resolve
    // (setOutline's hull clone needs the skinned meshes loaded first).
    let teamSel = 'neutral';
    let markSel = 'none';
    let sideSel = 'enemy';
    const TEAM_HEX: Record<string, number> = { red: 0xC0_30_30, blue: 0x30_60_C0 };
    // Mark palette — enemy: Overwatch scarlet (TF2 brick 0xB8_38_3B if
    // too loud). ally: squad green (OW's light-blue ally ~0x66_A3_FF is
    // the other classic). neutral: plain white mark.
    const SIDE_HEX: Record<string, number> = { enemy: 0xF0_4A_4A, ally: 0x44_CC_55, neutral: 0xDD_DD_DD };
    const applyTeam = (m: PlayerModel): void => {
      m.setTeamTint(TEAM_HEX[teamSel] ?? null);
      const mark = markSel === 'outline' || markSel === 'out+rim' ? SIDE_HEX[sideSel]! : null;
      const rim = markSel === 'rim' || markSel === 'out+rim' ? SIDE_HEX[sideSel]! : null;
      m.setOutline(mark);
      m.setRim(rim);
    };
    for (const [variant, x, label, ly, capsule, matRev, scale, yaw] of entries) {
      const pm = new PlayerModel(LAB_SCENE, variant, matRev);
      // The gizmo defaults to the generic capsule — without the class
      // sizes the collider wireframe would lie about light/heavy.
      pm.setColliderCapsule(classCapsule(capsule));
      pm.load().then((): void => {
        if ((pm as unknown as { _disposed?: boolean })._disposed) {return;}
        if (scale) {pm.setScale(scale);} // real tier silhouette, not raw rig height
        pm.setPosition(x, 0, 0);
        // 0 = the rig's authored forward; legacy GLBs face -Z while the
        // inspect camera sits at +Z, so those entries pass yaw:Math.PI.
        pm.setRotation(yaw ?? 0, 0);
        // Barrel-direction arrow (posedump's ?gunArrow=1, always on in the
        // lineup) — mounted guns have drifted 180° before without it.
        const g = (pm as unknown as { gunCtl: { group?: THREE.Group } }).gunCtl.group;
        if (g) {
          const am = new THREE.MeshBasicMaterial({ color: 0xFF_22_22 });
          g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9).rotateX(Math.PI / 2).translate(0, 0, 0.95), am));
          g.add(new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28).rotateX(Math.PI / 2).translate(0, 0, 1.55), am));
        }
        applyTeam(pm);
      return; }).catch((): void => undefined);
      models.push(pm);
      const sprite = mkTextSprite(label, ly);
      sprite.position.x = x;
      proxy.add(sprite);
    }
    proxy.add(creatureLayer); // PlayerModel.scene = LAB_SCENE = creatureLayer
    // Invisible bounds for inspect's Box3 fit — the GLB resolves async,
    // so without a synchronous volume the fit lands on the label sprite
    // and parks the camera inside the body. Wide box for lineups, a
    // body-sized column for solos.
    const spanH = Math.max(...entries.map((e): number => e[3])) + 0.6;
    const bounds = new THREE.Mesh(
      new THREE.BoxGeometry(boundsW > 0 ? boundsW : 2.6, spanH, boundsW > 0 ? 1.4 : 2.6),
      new THREE.MeshBasicMaterial());
    bounds.visible = false;
    bounds.position.set(boundsW > 0 ? boundsX : 0, spanH / 2, 0);
    proxy.add(bounds);
    proxy.userData.liveFocus = (): THREE.Vector3 => new THREE.Vector3(focusX, 1.4, 0);
    // Anim rail hook — gunlab's right panel drives all bodies in
    // lockstep so a state flaw (ski tuck, strafe stride) shows at once.
    proxy.userData.anims = {
      set: (s: AnimationState): void => { for (const m of models) {m.forceAnimationState(s);} },
      dir: (f: number, side: number): void => { for (const m of models) {m.setLocomotionVector(f, side);} },
      cur: (): AnimationState => models[0]?.animationState,
      // Authored rest pose — the T-pose the builder/skeleton bind to.
      bind: (): void => { for (const m of models) {m.setBindPose();} },
      // Weapon picker — swaps each body's hand prop to the real weapon
      // silhouette so scale reads against the lineup.
      weapon: (wt: number): void => { for (const m of models) {m.setWeapon(wt);} },
      // Team paint preview — neutral restores; red/blue tint the bodies.
      team: (t: string): void => { teamSel = t; for (const m of models) {applyTeam(m);} },
      // Enemy-mark overlay — outline hull / fresnel rim / both, combined
      // with whatever tint is picked.
      mark: (t: string): void => { markSel = t; for (const m of models) {applyTeam(m);} },
      // Mark color side — enemy/ally/neutral.
      side: (t: string): void => { sideSel = t; for (const m of models) {applyTeam(m);} },
      // The real kill effect — posed body parts + debris burst + impulse,
      // same path gibVictim takes on the wire.
      gib: (speed = 1): void => {
        for (const m of models) {
          let parts: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] | undefined;
          try { parts = m.deathParts() ?? undefined; } catch { /* generic chunks */ }
          // Shards parent under creatureLayer (re-parented into the
          // active proxy for inspect) while part.pos bakes are world —
          // convert BOTH into layer space or the layer's transform
          // double-applies and the burst lands offset from the body.
          const w = (m as unknown as { model?: THREE.Group }).model
            ?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
          const c = LAB_SCENE.worldToLocal(w.clone());
          const cx = c.x, cy = c.y + 1, cz = c.z;
          if (parts) {
            for (const p of parts) {LAB_SCENE.worldToLocal(p.pos);}
          }
          // Blast from below + ahead like a disc landing at the feet —
          // the upward geyser is what reads "pulverized", a flat push
          // just scatters gravel. Team-vivid color sells "that was a
          // body", neutral grey reads as concrete rubble.
          debris.push({ d: new PlayerDebris(LAB_SCENE, LAB_TERRAIN,
            { x: cx, y: cy, z: cz }, new THREE.Color(0x55_AA_FF),
            { parts, impulseDir: new THREE.Vector3(0, 1, -0.3).normalize().multiplyScalar(0.15) }), t: elapsed, s: speed });
          // Cheap stand-in for the game's explosion flash — expanding
          // additive shell + light, dies in ~0.35s.
          const flash = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.4, 1),
            new THREE.MeshBasicMaterial({ color: 0xFF_CC_66, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
          flash.position.set(cx, cy, cz);
          const light = new THREE.PointLight(0xFF_AA_44, 60, 12);
          light.position.set(cx, cy + 0.5, cz);
          LAB_SCENE.add(flash, light);
          flashes.push({ m: flash, l: light, t: elapsed, s: speed });
          m.setVisible(false);
          downAt.set(m, { t: elapsed, s: speed });
        }
      },
    };
    // Wire toggle rides along: gunlab calls this on every ▧ wire flip so
    // the class hit capsules show exactly while the tri overlay does.
    proxy.userData.colliderWire = (on: boolean): void => {
      for (const m of models) {m.setColliderVisible(on, true);}
    };
    proxy.userData.disposeCreature = (): void => { for (const d of debris) {d.d.dispose();} for (const f of flashes) {f.m.geometry.dispose(); (f.m.material as THREE.Material).dispose();} for (const m of models) {m.dispose();} previewLive.tick = null; };
    previewLive.tick = (dt): void => {
      elapsed += dt;
      for (const m of models) {m.update(dt);}
      for (let i = debris.length - 1; i >= 0; i -= 1) {
        const e = debris[i]!;
        e.d.update(dt * e.s);
        if (elapsed - e.t > 8 / e.s) {e.d.dispose(); debris.splice(i, 1);}
      }
      for (let i = flashes.length - 1; i >= 0; i -= 1) {
        const f = flashes[i]!;
        const k = (elapsed - f.t) / (0.35 / f.s);
        if (k >= 1) {
          LAB_SCENE.remove(f.m, f.l);
          f.m.geometry.dispose(); (f.m.material as THREE.Material).dispose();
          flashes.splice(i, 1);
        } else {
          f.m.scale.setScalar(1 + k * 5);
          (f.m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
          f.l.intensity = 60 * (1 - k);
        }
      }
      for (const [m, d] of downAt) {
        if (elapsed - d.t > 1.6 / d.s) {m.setVisible(true); m.forceAnimationState('idle'); downAt.delete(m);}
      }
    };
    return proxy;
  };
}
const SOLO_X = 0;
const BRUTE_ENTRY: LineupEntry = ['brute' as PlayerModelVariant, 4.4, 'brute', 3, 'heavy', false];
const BRAWLER_ENTRY: LineupEntry = ['brawler' as PlayerModelVariant, 6.4, 'brawler', 2.4, 'medium', false];
const SCOUT_ENTRY: LineupEntry = ['scout' as PlayerModelVariant, 8.2, 'scout', 2, 'light', false];
export const CLASSES: [label: string, build: () => THREE.Group][] = [
  ['classes', mkLineup(CLASS_LINEUP.map(([cls, x, ly]): LineupEntry => [CLASS_BODY_VARIANT[cls] as PlayerModelVariant, x, cls, ly, cls, CLASS_BODY_MAT_REV.has(cls), CLASS_MODEL_SCALE[cls]]), 1.25, 9.6, 1.25)],
  ['light',  mkLineup([[CLASS_BODY_VARIANT.light as PlayerModelVariant, SOLO_X, 'light', 2.1, 'light', CLASS_BODY_MAT_REV.has('light'), CLASS_MODEL_SCALE.light]])],
  ['medium', mkLineup([[CLASS_BODY_VARIANT.medium as PlayerModelVariant, SOLO_X, 'medium', 2.5, 'medium', CLASS_BODY_MAT_REV.has('medium'), CLASS_MODEL_SCALE.medium]])],
  ['heavy',  mkLineup([[CLASS_BODY_VARIANT.heavy as PlayerModelVariant, SOLO_X, 'heavy', 3.2, 'heavy', CLASS_BODY_MAT_REV.has('heavy'), CLASS_MODEL_SCALE.heavy]])],
  ['brute',  mkLineup([[BRUTE_ENTRY[0], SOLO_X, 'brute', 3, 'heavy', false]])],
  ['juggernaut', mkLineup([['juggernaut' as PlayerModelVariant, SOLO_X, 'juggernaut', 3, 'heavy', false]])],
  ['jugg og', mkLineup([['juggernaut_og' as PlayerModelVariant, SOLO_X, 'jugg og', 3, 'heavy', false]])],
  ['Heavy Lineup', mkLineup([
    // bld + scp are benched — the Blender sculpts aren't lineup quality.
    ['juggernaut' as PlayerModelVariant, -5.5, 'jugg', 3, 'heavy', false],
    ['juggernaut_og' as PlayerModelVariant, -3.3, 'og', 3, 'heavy', false],
    ['juggernaut_brick' as PlayerModelVariant, -1.1, 'brick', 3, 'heavy', false],
    ['juggernaut_wedge' as PlayerModelVariant, 1.1, 'wedge', 3, 'heavy', false],
    ['juggernaut_kit' as PlayerModelVariant, 3.3, 'kit', 3, 'heavy', false],
    ['juggernaut_shell' as PlayerModelVariant, 5.5, 'shell', 3, 'heavy', false],
  ], 0, 14, 0)],
  ['Light Lineup', mkLineup([
    ['scout' as PlayerModelVariant, -3.3, 'scout', 2, 'light', false],
    ['light_plate' as PlayerModelVariant, -1.1, 'plate', 2, 'light', false],
    ['light_shell' as PlayerModelVariant, 1.1, 'shell', 2, 'light', false],
  ], -1.1, 6.5, 0)],
  ['dreadnought', mkLineup([['dreadnought' as PlayerModelVariant, SOLO_X, 'dreadnought', 3, 'heavy', false]])],
  ['brawler', mkLineup([[BRAWLER_ENTRY[0], SOLO_X, 'brawler', 2.4, 'medium', false]])],
  ['scout',  mkLineup([[SCOUT_ENTRY[0], SOLO_X, 'scout', 2, 'light', false]])],
  // Legacy class bodies — pre-swap rigs kept for side-by-side compare.
  // The old GLBs face -Z, the M2M rigs +Z — the π yaw keeps fronts to camera.
  ['legacy', mkLineup([
    ['mannequin' as PlayerModelVariant, -1.9, 'light(mann)', 2.1, 'light', true, undefined, Math.PI],
    ['mannequin' as PlayerModelVariant, 0, 'medium(mann)', 2.5, 'medium', false, undefined, Math.PI],
    ['polyart' as PlayerModelVariant, 2.4, 'heavy(poly)', 3.2, 'heavy', false, undefined, Math.PI],
  ], 0.3, 9.6, 0.3)],
  ['mann',  mkLineup([['mannequin' as PlayerModelVariant, SOLO_X, 'mannequin', 2.5, 'medium', false, undefined, Math.PI]])],
  ['polyart', mkLineup([['polyart' as PlayerModelVariant, SOLO_X, 'polyart', 3.2, 'heavy', false, undefined, Math.PI]])],
];
