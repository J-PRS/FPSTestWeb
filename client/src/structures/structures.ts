// structures.ts — composed T:A-style base pieces built from structKit.
// Each builder returns a Group whose origin sits at ground level.

import * as THREE from 'three';
import {
  skirt, windowBand, capPlate, towerShaft, trimMat, deckMat, darkMat,
} from './structKit';
import { profOct, mkLoft, mkAnnulus } from '../entities/viewmodel/weaponKit';

/** Deck-top height of the flag dais — the flag's pole seats ON the
 *  platform, so 'home' seating adds this to the stand's ground pos. */
export const FLAG_STAND_TOP = 3.13;

/** Flag stand platform — the T:A read: a RAISED octagonal platform the
 *  flag sockets into. Scale is the detail: ~9m across, ~3m tall — you
 *  ski INTO it, not over it. Collision is a two-box spec stack the
 *  server injects at flag homes (shared/mapSpec flagStandSpecs) — keep
 *  these dims in step with it: skirt 12 wide × 2.2, deck 9 × 0.85. */
export function mkFlagStand(teamGlow: number, r = 4.5): THREE.Group {
  const g = new THREE.Group();
  const glow = new THREE.MeshBasicMaterial({ color: teamGlow });
  glow.side = THREE.DoubleSide; // thin trim reads from any face
  // Truncated pyramid talus — wide foot BURIED ~4.5m so the mass reads
  // grown out of the terrain (T:A stands are plinths, not platforms on
  // stilts). The buried run necks down to a root plug, so even on a
  // slope that undercuts the bury depth the exposed end reads as a
  // foundation piling, not a floating slab. ~12m foot under a ~9m deck.
  g.add(skirt(profOct(r * 2.15, r * 2.15, r * 0.3), 2.2, 1.25, undefined, 4.5));
  // Deck tier — its own slight taper so the silhouette keeps stepping
  // inward like a pyramid rather than reading as a floating slab.
  const deck = mkLoft([
    { z: 0.85, ring: profOct(r * 2, r * 2, r * 0.2) },
    { z: 0, ring: profOct(r * 2.12, r * 2.12, r * 0.2) },
  ], deckMat);
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = 2.2;
  g.add(deck);
  // Team glow — a band wrapped around the deck's SIDE face (annulus
  // spanning most of the slab's thickness, a hair proud — lit trim,
  // not a floating outline).
  const band = mkAnnulus(
    profOct(r * 2.02, r * 2.02, r * 0.2),
    profOct(r * 1.96, r * 1.96, r * 0.2),
    0.15, 0.55, glow,
  );
  band.rotation.x = -Math.PI / 2;
  band.position.y = 2.2;
  g.add(band);
  // Socket well — dark recessed disc at deck centre; the pole seats here.
  const well = mkLoft([
    { z: 0.08, ring: profOct(1.7, 1.7, 0.2) },
    { z: 0, ring: profOct(1.6, 1.6, 0.2) },
  ], darkMat);
  well.rotation.x = -Math.PI / 2;
  well.position.y = 3.05;
  g.add(well);
  // 4 corner studs at the deck edge — the crown silhouette.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const stud = mkLoft([
      { z: 0.8, ring: profOct(0.55, 0.55, 0.1) },
      { z: 0, ring: profOct(0.9, 0.9, 0.15) },
    ], trimMat);
    stud.rotation.x = -Math.PI / 2;
    stud.position.set(Math.cos(a) * r * 0.94, 3.05, Math.sin(a) * r * 0.94);
    g.add(stud);
  }
  return g;
}

/** Base tower — T:A flag-tower shell: 2-tier shaft, window band, cap.
 *  Flag pad sits on the cap at h. For when we want elevated stands. */
export function mkBaseTower(w = 9, h = 12, teamGlow = 0x59F2FF): THREE.Group {
  const g = new THREE.Group();
  g.add(skirt(profOct(w * 1.06, w * 1.06, w * 0.15), 2.2, 1.3));
  const shaft = towerShaft(w, h - 2.2);
  shaft.position.y = 2.2;
  g.add(shaft);
  const band = windowBand(w * 0.9, 0.7, new THREE.MeshBasicMaterial({ color: teamGlow }));
  band.position.y = h - 1.6;
  g.add(band);
  const cap = capPlate(w * 0.9);
  cap.position.y = h;
  g.add(cap);
  return g;
}
