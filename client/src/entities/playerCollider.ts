import * as THREE from 'three';

import { PLAYER_RADIUS, CAPSULE_CYLINDER_HEIGHT, CAPSULE_CENTER_Y } from '../core/config.js';
import { urlParams } from '../core/params.js';
import { debugOverlaysOn } from '../ui/hud/indicators.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('PlayerModel');

/** Debug hitbox wireframe — the wireframe capsule child of the model that
 *  traces the sim collision capsule. Everything about it (geometry, hex,
 *  debug/force visibility, the class-capsule restash) lives here; the
 *  model supplies scale + feet offset per call since those change
 *  without the gizmo knowing. */
export class PlayerCollider {
  private gizmo: THREE.Mesh | null = null;
  private mat: THREE.MeshBasicMaterial | null = null;
  private hex = 0x00_FF_00;
  private shown = true;
  /** `force` bypasses the ?debug gate — lab/inspect surfaces drive the
   *  gizmo directly, without flipping the global debug flag. Sticky so
   *  a gizmo created later (async load) still honors the lab toggle. */
  private force = false;
  /** Requested capsule — stashed because the gizmo only exists after the
   *  async load(); applied at creation and on re-request. */
  cap: { height: number; half: number; radius: number } | null = null;

  // Same constants as collision detection — single source of truth in
  // config.ts. CapsuleGeometry(radius, cylinderHeight, ...) —
  // cylinderHeight excludes hemispheres. `vs` is the FULL visual scale
  // (rig fit × class bump): the gizmo is a model child, so setScale()
  // would otherwise inflate the wire past the real sim capsule.
  attach(model: THREE.Group, vs: number, feetOffsetY: number): void {
    const {cap} = this;
    const geo = new THREE.CapsuleGeometry(
      (cap ? cap.radius : PLAYER_RADIUS) / vs,
      (cap ? 2 * cap.half : CAPSULE_CYLINDER_HEIGHT) / vs,
      4, 16);
    this.mat = new THREE.MeshBasicMaterial({
      color: this.hex,
      wireframe: true,
      transparent: true,
      opacity: 0.3,
      depthTest: false // Always render on top
    });
    this.gizmo = new THREE.Mesh(geo, this.mat);
    // Capsule center is at feet + CAPSULE_CENTER_Y (half PLAYER_HEIGHT).
    // feetOffsetY lifts the whole group for rigs not authored feet-at-origin
    // — the gizmo counteracts it locally so it stays on the logical feet.
    this.gizmo.position.y = (cap ? cap.height / 2 : CAPSULE_CENTER_Y) / vs - feetOffsetY;
    this.gizmo.renderOrder = 999; // Render last (on top)
    // Hitbox visualization is a debug overlay — same flag as the
    // AOE blast wireframes (menu DEBUG toggle / ?debug).
    this.gizmo.visible = this.shown && (urlParams.debug || this.force || debugOverlaysOn());
    model.add(this.gizmo); // Add as child of model so it moves with it
    logger.debug('COLLIDER GIZMO ADDED to model', { children: model.parent?.children.length });
  }

  /** Re-size the debug gizmo to the class hit capsule — it was built
   *  from the generic constants and never matched light/heavy sim
   *  capsules. */
  setCapsule(cap: { height: number; half: number; radius: number }, vs: number, feetOffsetY: number): void {
    this.cap = cap;
    if (!this.gizmo) {return;}
    this.gizmo.geometry.dispose();
    this.gizmo.geometry = new THREE.CapsuleGeometry(cap.radius / vs, (2 * cap.half) / vs, 4, 16);
    this.gizmo.position.y = (cap.height / 2) / vs - feetOffsetY;
  }

  /** Friend-or-foe tint on the debug hitbox — remotes recolor on team
   *  assign; untouched models stay the default friendly green. The hex is
   *  cached so a call landing before the GLB load still tints the capsule
   *  when it's built. */
  setColor(hex: number): void {
    this.hex = hex;
    this.mat?.color.setHex(hex);
    // This runs every frame per remote — piggyback the debug-visibility
    // refresh so the menu DEBUG toggle applies without a reload.
    if (this.gizmo) {this.gizmo.visible = this.shown && (urlParams.debug || this.force || debugOverlaysOn());}
  }

  setVisible(visible: boolean, force = false): void {
    this.shown = visible;
    this.force = force;
    if (this.gizmo) {
      this.gizmo.visible = visible && (force || urlParams.debug || debugOverlaysOn());
    }
  }

  get attached(): boolean { return this.gizmo !== null; }

  /** Re-add after remove() — the gunlab's gun-swap inspect path pulls
   *  the gizmo off so it doesn't trace the weapon swap. */
  reattach(model: THREE.Group): void {
    if (this.gizmo && !model.children.includes(this.gizmo)) {
      model.add(this.gizmo);
      this.gizmo.visible = this.shown && (urlParams.debug || this.force || debugOverlaysOn());
      logger.debug('COLLIDER GIZMO RE-ADDED to model');
    }
  }

  remove(model: THREE.Group | null): void {
    if (this.gizmo && model) {
      this.gizmo.visible = false;
      model.remove(this.gizmo);
      logger.debug('COLLIDER GIZMO REMOVED from model');
    }
  }

  dispose(): void {
    if (this.gizmo) {
      this.gizmo.geometry.dispose();
      this.gizmo = null;
    }
    this.mat?.dispose();
    this.mat = null;
  }
}
