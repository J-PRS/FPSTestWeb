import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import { decomposeTokens, tokenTier } from '../../../shared/pickups.js';
import { BEAM_ALPHA } from './Nugget.js';
import { metalMat } from './procMetal.js';
import { getGlowTexture } from '../effects/glowTexture.js';

// HeldCrown — a headhunt carrier's hoard worn overhead: the same token
// octahedra the field drops, shrunk and orbiting the skull, one mesh per
// decomposed denomination (greedy base-3 keeps 100 held = 6 meshes). A
// short team-tinted beam rides the group so friend/foe still reads at
// distance — the digit badge keeps the exact count, this sells the pile.
const RING_R = 0.55;       // orbit radius around the neck column
const SPIN = 0.9;          // rad/s — lazy carousel, not a turbine
const BOB_AMP = 0.08;
const COIN_BEAM_H = 3.2;   // short shaft per coin — the field drops get 16
const MAX_MESHES = 8;      // pathological hoards degrade to biggest coins

// Per-coin beacon: each denomination octa carries its own short shaft —
// the beams ride the ring with their coin, so two purples read as two
// purple beacons, not one shaft floating off nothing.
const _coinBeamGeo = new THREE.CylinderGeometry(0.05, 0.09, COIN_BEAM_H, 6, 1, true);
// Same shell+core silhouette the field token uses (PickupModel 'token'
// parts), shrunk — a single flat octa read unlit and unlike the drops.
const _shellGeo = new THREE.OctahedronGeometry(0.2, 0);
const _coreGeo = new THREE.OctahedronGeometry(0.11, 0);
const _shellMat = metalMat();
const _glowTex = getGlowTexture(32, 0.12, 0.5);

export class HeldCrown {
  readonly group = new THREE.Group();
  private octas: THREE.Group[] = [];
  private beams: THREE.Mesh[] = [];
  private shownHeld = -1;
  private spin = Math.random() * Math.PI * 2;

  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    // Scene-rooted, position driven per frame: parented to the model the
    // crown would inherit body roll and pitch the beams off-vertical.
    scene.add(this.group);
  }

  /** Feet-space follow — world position under the ring; topY = the
   *  model's capsule height so the crown rides class height. */
  follow(feet: THREE.Vector3, topY: number): void {
    this.group.position.set(feet.x, feet.y + topY + 0.45, feet.z);
  }

  /** Rebuild the ring when the held value changes. Every coin gets its
   *  own beam in its tier's color — a 54-held shows two purple shafts
   *  orbiting, while the indicator dot keeps the friend/foe read. */
  set(held: number): void {
    this.group.visible = held > 0;
    if (held === this.shownHeld) {return;}
    this.shownHeld = held;
    for (const o of this.octas) {this.disposeCoin(o); this.group.remove(o);}
    this.octas.length = 0;
    for (const b of this.beams) {(b.material as THREE.Material).dispose(); this.group.remove(b);}
    this.beams.length = 0;
    if (held <= 0) {return;}
    const vals = decomposeTokens(held).slice(0, MAX_MESHES);
    for (let i = 0; i < vals.length; i++) {
      const tier = tokenTier(vals[i]!);
      // Field-token recipe: emitColor is lerp-only (the ×EMIT_GAIN push
      // lives on the bloom-writing core, not the shaft — a 3× additive
      // beam reads as a lightsaber, not a beacon).
      const shaft = new THREE.Color(tier.color).lerp(new THREE.Color(0xFF_FF_FF), 0.33);
      const emit = shaft.clone().multiplyScalar(EMIT_GAIN);
      const coin = new THREE.Group();
      // Same recipe as the field drop: dark lit shell, hot colored core,
      // additive halo — a flat unlit octa read wrong against the ground tokens.
      const shell = new THREE.Mesh(_shellGeo, _shellMat);
      const core = new THREE.Mesh(_coreGeo, new THREE.MeshBasicMaterial({ color: emit, fog: false }));
      core.layers.enable(BLOOM_LAYER);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: _glowTex, color: emit, transparent: true, opacity: 0.85,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      glow.scale.setScalar(0.9);
      glow.layers.enable(BLOOM_LAYER);
      coin.add(shell, core, glow);
      coin.scale.setScalar(tier.scale);
      const a = (i / vals.length) * Math.PI * 2;
      coin.userData.ringA = a;
      coin.userData.ringY = (i % 2) * 0.16; // two stacked lanes keep coins readable
      this.group.add(coin);
      this.octas.push(coin);
      // The coin's own beacon — lives in the upright crown group (not the
      // tumbling coin) so the shaft stays vertical while tracking its coin.
      const beam = new THREE.Mesh(_coinBeamGeo, new THREE.MeshBasicMaterial({
        color: shaft, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false, alphaMap: BEAM_ALPHA,
      }));
      beam.scale.y = tier.scale; // taller shaft = fatter coin — the bounty reads at range
      beam.userData.h = COIN_BEAM_H * tier.scale;
      beam.layers.enable(BLOOM_LAYER);
      this.group.add(beam);
      this.beams.push(beam);
    }
  }

  private disposeCoin(coin: THREE.Group): void {
    for (const c of coin.children) {
      if (c instanceof THREE.Sprite || c instanceof THREE.Mesh) {
        const m = c.material as THREE.Material;
        if (m !== _shellMat) {m.dispose();} // shell material is shared
      }
    }
  }

  update(dt: number): void {
    if (!this.group.visible) {return;}
    this.spin += dt * SPIN;
    const t = performance.now() / 1000;
    for (let i = 0; i < this.octas.length; i++) {
      const o = this.octas[i]!;
      const a = this.spin + o.userData.ringA;
      const y = o.userData.ringY + Math.sin(t * 2 + o.userData.ringA * 3) * BOB_AMP;
      o.position.set(Math.cos(a) * RING_R, y, Math.sin(a) * RING_R);
      o.rotation.y = a * 2;
      o.rotation.x = a; // tumble like the dropped coins
      this.beams[i]!.position.set(o.position.x, y + this.beams[i]!.userData.h / 2 + 0.15, o.position.z);
    }
  }

  dispose(): void {
    for (const o of this.octas) {this.disposeCoin(o);}
    for (const b of this.beams) {(b.material as THREE.Material).dispose();}
    this.group.parent?.remove(this.group);
  }
}
