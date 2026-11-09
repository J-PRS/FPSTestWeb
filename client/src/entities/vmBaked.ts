import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mkGltfLoader, loadGlbOrMain } from '../gltfLoad';
import { WeaponType } from '../../../shared/weapons.js';
import { urlParams } from '../core/params.js';
import { bakeVertexAO, bakeWearOnly } from '../effects/vertexAO.js';
import { Logger } from '../core/Logger.js';

// Baked-weapon swap - the GLB+AO adoption pipeline for the viewmodel.
// When tools/vmdump has shipped w{id}_baked.glb/w{id}_ao.png, the baked
// mesh replaces the procedural one part-by-part (glow parts stay
// procedural). Kept off ViewModel so the load path isn't tangled with
// the per-frame envelope/kick code.

/** Flat host surface — everything the swap reads or writes. */
export interface BakedHost {
  readonly weapons: Map<number, THREE.Group>;
  /** The chaingun spin group — re-pointed when the bake's barrels node
   *  gets reseated under a bore-centered pivot. */
  chainBarrels: THREE.Group | null;
  /** Bore axis in the spin node's local space — recomputed on adoption
   *  (a Blender export node carries foreign axes; rotating .z cartwheels). */
  spinAxis: THREE.Vector3;
  /** Live ghost materials — a bake landing mid-cloak must join the set. */
  readonly ghostMats: readonly unknown[];
  ghostify(m: THREE.Material): void;
  ghostifyMesh(mesh: THREE.Mesh): void;
}

// Concave-grime rollout: per-weapon opt-in while the signed-curvature
// pass gets tuned. Weapons not in the set bake no `grime` attribute —
// the shader reads 0 for them, so nothing changes pixel-wise.
const GRIME_WEAPONS = new Set<number>([WeaponType.Chaingun]);
// Per-weapon wear-line emphasis — 0 keeps the shared look; >0 pushes
// the white edge wear toward full brightness on this weapon only.
const WEAR_BOOST = new Map<number, number>([[WeaponType.Chaingun, 0.7]]);
// Weapons whose baked GLB is the DEFAULT look — no ?bake flag needed.
// The procedural builder stays as the fallback when the file is missing
// and under ?export (the dump pipeline must serialize procedural geo).
// w0's slab bake is parked (w0_baked.glb.old) — the procedural crossbow
// is the shipping look; re-add the id here if a new bake ships.
const ALWAYS_BAKE = new Set<number>([]);

const yieldFrame = (): Promise<void> => new Promise<void>((r): NodeJS.Timeout => setTimeout(r, 0));

export class VmBaked {
  constructor(private h: BakedHost) {}

  /** Probes every weapon for a bake and swaps what lands. Missing bakes
   *  are the normal case — those weapons bake their vertex AO now
   *  (deferred from the ctor: swapped weapons would discard it). */
  async load(): Promise<void> {
    // Export mode must serialize the PROCEDURAL meshes — if the baked swap
    // lands mid-export the GLB round-trips the stale bake and the pipeline
    // can never pick up new geometry. Still bake AO: the dump pipeline
    // round-trips the procedural vertex colors into the GLB.
    if (urlParams.has('export')) {
      for (const [wt, g] of this.h.weapons) {bakeVertexAO(g, { grime: GRIME_WEAPONS.has(wt), wearBoost: WEAR_BOOST.get(wt) });}
      return;
    }
    // Procedural is the default look — baked GLBs only load behind ?bake
    // (gunlab A/B + pipeline verification) or for ALWAYS_BAKE weapons
    // whose GLB IS the shipping model. The nobake flag still reads as
    // off for anyone with it bookmarked.
    const bakeAll = urlParams.has('bake') && !urlParams.has('nobake');
    const loader = mkGltfLoader();
    const texLoader = new THREE.TextureLoader();
    const done = new Set<THREE.Group>();
    for (const [wt, g] of this.h.weapons) {
      await this.loadWeaponBake(wt, g, loader, texLoader, bakeAll, done);
    }
  }

  // bakeVertexAO is ~100ms of raycasts per weapon — an async fn's body
  // still runs synchronously until a real await, so the old loop froze
  // boot for ~2.3s before this function's first fetch ever fired.
  // Yield per weapon: the bake streams in over the first seconds of
  // menu/play instead of blocking TTI.
  private async loadWeaponBake(wt: number, g: THREE.Group, loader: GLTFLoader, texLoader: THREE.TextureLoader, bakeAll: boolean, done: Set<THREE.Group>): Promise<void> {
    await yieldFrame();
    if (!bakeAll && !ALWAYS_BAKE.has(wt)) {
      bakeVertexAO(g, { grime: GRIME_WEAPONS.has(wt), wearBoost: WEAR_BOOST.get(wt) });
      return;
    }
    // Forced bakes: hide the procedural placeholder NOW so the async
    // GLB fetch doesn't flash the old model for a frame. Restored on
    // failure below.
    const forced = !bakeAll;
    if (forced) {g.traverse((o): void => { if ((o as THREE.Mesh).isMesh) {o.visible = false;} });}
    if (done.has(g)) {return;}
    done.add(g);
    try {
      // HEAD-probe first: a missing GLB makes the dev server serve the
      // 404 HTML page, which then fails PARSING — the miss arrives as a
      // real Error, indistinguishable from a corrupt bake. Probing keeps
      // expected misses from ever becoming fetch/parse noise.
      const probe = await fetch(`/weapons/w${wt}_baked.glb`, { method: 'HEAD' });
      // Vite's SPA fallback can 200 a HEAD for a missing file — only a
      // non-HTML body is a real bake.
      const ct = probe.headers.get('content-type') ?? '';
      if (!probe.ok || ct.includes('html')) {
        if (forced) {g.traverse((o): void => { if ((o as THREE.Mesh).isMesh) {o.visible = true;} });}
        bakeVertexAO(g, { grime: GRIME_WEAPONS.has(wt), wearBoost: WEAR_BOOST.get(wt) });
        return;
      }
      await this.swapBaked(wt, g, loader, texLoader);
    } catch (error) {
      if (forced) {g.traverse((o): void => { if ((o as THREE.Mesh).isMesh) {o.visible = true;} });}
      bakeVertexAO(g, { grime: GRIME_WEAPONS.has(wt), wearBoost: WEAR_BOOST.get(wt) });
      // A missing bake is the normal case — 404s surface as
      // Event/ProgressEvent (ImageLoader) or "Not Found"/404 Errors —
      // neither is worth a log line. Only a real parse/decode failure is.
      const is404 = !(error instanceof Error) ||
        /404|not found|fetch/i.test(error.message);
      if (!is404) {Logger.warn(`[vm] w${wt} bake load failed`, error);}
    }
  }

  /** One weapon's bake swap: fetch glb+AO, replace non-glow procedural
   *  meshes with the bake, seat the chaingun spin pivot, ghost it if a
   *  cloak is active. Throws on missing bakes — the caller treats 404 as
   *  "procedural stays", silently. */
  private async swapBaked(wt: number, g: THREE.Group, loader: GLTFLoader, texLoader: THREE.TextureLoader): Promise<void> {
    // AO map is optional — a GLB whose bake predates its current mesh
    // wears the wrong unwrap, and a missing file shouldn't kill the swap.
    const ao = await this.probeTex(`/weapons/w${wt}_ao`);
    const [gltf, tex] = await Promise.all([
      loadGlbOrMain(loader, `/weapons/w${wt}_baked.glb`),
      ao ? texLoader.loadAsync(`${ao}?v=${Date.now()}`) : Promise.resolve(null),
    ]);
    const bakedMat = this.bakedMaterial(tex);
    // Chaingun special case: the barrel triad is ANIMATED (spinVel), not
    // static geometry — a merged bake folds it into the body and the gun
    // stops spinning forever. null = merged bake, procedural barrels keep
    // spinning and this weapon's swap is skipped.
    const spin = wt === WeaponType.Chaingun
      ? await this.adoptChainSpin(gltf.scene, wt, texLoader) : null;
    if (wt === WeaponType.Chaingun && !spin) {return;}
    const swap = new Set<THREE.Object3D>();
    // ALWAYS_BAKE bakes carry their own bore/glow geometry — the usual
    // "keep Basic parts procedural" rule would leave the old mkBore disc
    // floating at its authored spot.
    const dropAll = ALWAYS_BAKE.has(wt);
    g.traverse((o): void => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (dropAll || (m.material as THREE.Material).type !== 'MeshBasicMaterial')) {swap.add(o);}
    });
    for (const o of swap) { o.parent?.remove(o); }
    gltf.scene.traverse((o: THREE.Object3D): void => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) {return;}
      const inBarrels = spin && (o === spin.node || spin.node.children.includes(o) || o.parent === spin.node);
      m.material = inBarrels && spin.barrelMat ? spin.barrelMat : bakedMat;
    });
    g.add(gltf.scene);
    // The blend bakes a real edge-wear mask on this same unwrap — prefer
    // it over the runtime atlas. Missing file = atlas fallback, silent.
    const edgeTex = await this.loadEdgeTex(wt, texLoader);
    const grimeTex = await this.loadWeaponTex(wt, 'grime', texLoader);
    if (edgeTex || grimeTex) {
      gltf.scene.traverse((o: THREE.Object3D): void => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) {return;}
        m.geometry.userData.__keepUv = true;
        if (edgeTex) {m.geometry.userData.__wearTex = edgeTex;}
        if (grimeTex) {m.geometry.userData.__grimeTex = grimeTex;}
      });
    }
    // With an ao.png the AO lives in the texture — bake only curvature
    // for the wear shader. Without one (new GLBs before their bake
    // passes), run the FULL vertex bake so the mesh shades exactly like
    // the procedural weapons — same AO, same shader base.
    if (tex) {bakeWearOnly(gltf.scene as THREE.Group, { grime: GRIME_WEAPONS.has(wt), wearBoost: WEAR_BOOST.get(wt) });}
    else {bakeVertexAO(gltf.scene as THREE.Group, { grime: GRIME_WEAPONS.has(wt), wearBoost: WEAR_BOOST.get(wt) });}
    if (spin) {this.seatChainPivot(spin.node, g);}
    // A bake landing mid-cloak must join the ghost set — otherwise the
    // weapon pops back opaque while you're invisible.
    if (this.h.ghostMats.length > 0) {this.ghostBake(gltf.scene);}
    Logger.debug(`[vm] w${wt} baked swap: removed ${swap.size} procedural meshes`);
  }

  /** Baked-surface material: AO map when the bake has one (kept linear —
   *  Cycles EMIT bakes are stored linear; tagging sRGB would decode twice
   *  and render ~2 stops dark), gunmetal fallback until a bake exists,
   *  magenta under ?bakedbg. */
  private bakedMaterial(tex: THREE.Texture | null): THREE.MeshLambertMaterial {
    if (tex) {
      tex.flipY = false;
      tex.colorSpace = THREE.LinearSRGBColorSpace;
    }
    const bakedMat = new THREE.MeshLambertMaterial();
    if (tex) {bakedMat.map = tex;}
    else {bakedMat.color.set(0x3A_36_32);} // gunmetal fallback until an ao bake exists
    if (urlParams.has('bakedbg')) { bakedMat.map = null; bakedMat.color.set(0xFF_00_FF); }
    return bakedMat;
  }

  private ghostBake(root: THREE.Object3D): void {
    const seen = new Set<THREE.Material>();
    const toShell: THREE.Mesh[] = [];
    root.traverse((o: THREE.Object3D): void => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) {return;}
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let shelled = false;
      for (const m of mats) {
        if (!m || seen.has(m)) {continue;}
        seen.add(m);
        if (!m.transparent && !shelled) { toShell.push(mesh); shelled = true; }
        this.h.ghostify(m);
      }
    });
    for (const mesh of toShell) {this.h.ghostifyMesh(mesh);}
  }

  /** Optional per-weapon edge bake (exported from the weapon's .blend on
   *  the same unwrap as _ao.png). null when absent — caller falls back
   *  to the runtime atlas. */
  private async loadEdgeTex(wt: number, texLoader: THREE.TextureLoader): Promise<THREE.Texture | null> {
    return this.loadWeaponTex(wt, 'edge', texLoader);
  }

  /** Optional per-weapon mask bake (edge wear, broad grime) exported on
   *  the same unwrap as _ao.png. null when absent — caller falls back. */
  private async loadWeaponTex(wt: number, suffix: string, texLoader: THREE.TextureLoader): Promise<THREE.Texture | null> {
    const url = await this.probeTex(`/weapons/w${wt}_${suffix}`);
    if (!url) {return null;}
    try {
      const t = await texLoader.loadAsync(`${url}?v=${Date.now()}`);
      t.flipY = false;
      t.colorSpace = THREE.LinearSRGBColorSpace;
      return t;
    } catch { return null; }
  }

  /** HEAD-probes the base path across shipped extensions — webp first
   *  (pipeline output), png/jpg as pre-webp legacy. Returns the URL that
   *  exists or null. */
  private async probeTex(base: string): Promise<string | null> {
    for (const ext of ['webp', 'png', 'jpg']) {
      const probe = await fetch(`${base}.${ext}`, { method: 'HEAD' });
      if (probe.ok && !(probe.headers.get('content-type') ?? '').includes('html')) {return `${base}.${ext}`;}
    }
    return null;
  }

  /** Finds the bake's "barrels" node (Blender dedups to 'barrels.001'
   *  when the group empty lingers) and fetches its own small
   *  w{id}b_ao.png bake. Returns null on a merged bake — the swap is
   *  then skipped entirely. */
  private async adoptChainSpin(scene: THREE.Object3D, wt: number, texLoader: THREE.TextureLoader):
    Promise<{ node: THREE.Object3D; barrelMat: THREE.MeshLambertMaterial | null } | null> {
    let node: THREE.Object3D | undefined = undefined;
    scene.traverse((o): void => { if (!node && o.name.startsWith('barrels')) {node = o;} });
    if (!node) {return null;}
    this.h.chainBarrels = node as THREE.Group;
    let barrelMat: THREE.MeshLambertMaterial | null = null;
    const burl = await this.probeTex(`/weapons/w${wt}b_ao`);
    if (burl) {
      try {
        const btex = await texLoader.loadAsync(`${burl}?v=${Date.now()}`);
        btex.flipY = false;
        btex.colorSpace = THREE.LinearSRGBColorSpace;
        barrelMat = new THREE.MeshLambertMaterial({ map: btex });
      } catch { barrelMat = null; }
    }
    return { node, barrelMat };
  }

  /** The bake node's origin isn't the cluster center — spinning it
   *  directly orbits the triad around one barrel. Wraps it in a pivot
   *  seated on the bore line (weapon-space x=0,y=0 at barrel z) and spins
   *  THAT. Matrix math runs after the reparent so matrixWorld already
   *  includes g's transform. */
  private seatChainPivot(spinNode: THREE.Object3D, g: THREE.Group): void {
    if (!spinNode.parent) {return;}
    const boreCenter = new THREE.Vector3(0, 0, -0.28); // cluster z in weapon space
    const {parent} = spinNode;
    parent.updateWorldMatrix(true, false);
    g.updateWorldMatrix(true, false);
    const parentInv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    const pivot = new THREE.Group();
    pivot.position.copy(boreCenter.applyMatrix4(
      new THREE.Matrix4().copy(parentInv).multiply(g.matrixWorld)));
    parent.add(pivot);
    pivot.attach(spinNode);
    // Bore dir (-Z in weapon space) into the pivot's local axes —
    // the pivot is unrotated, so this is just parent-space.
    this.h.spinAxis.set(0, 0, -1)
      .transformDirection(new THREE.Matrix4().copy(parentInv).multiply(g.matrixWorld));
    this.h.chainBarrels = pivot;
  }
}
