// structures.ts — composed T:A-style base pieces built from structKit.
// Each builder returns a Group whose origin sits at ground level.

import * as THREE from 'three';
import {
  skirt, windowBand, capPlate, towerShaft, trimMat, deckMat, darkMat,
  topDown, pad, dome, mast, hullMat, glowStrip, endPost, compound,
  type HullBox,
} from './structKit';
import { profOct, mkLoft, mkAnnulus, mkRevolve } from '../entities/viewmodel/weaponKit';

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
  // 4 corner studs at the deck edge — the crown silhouette.
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const stud = mkLoft([
      { z: 0.8, ring: profOct(0.55, 0.55, 0.1) },
      { z: 0, ring: profOct(0.9, 0.9, 0.15) },
    ], trimMat);
    stud.rotation.x = -Math.PI / 2;
    stud.position.set(Math.cos(a) * r * 0.94, 3.05, Math.sin(a) * r * 0.94);
    g.add(stud);
  }
  // Matches flagStandSpecs (shared/mapSpec) — the same two-box stack.
  g.userData.hulls = [
    { pos: { x: 0, y: 1.1, z: 0 }, size: { x: 12, y: 2.2, z: 12 } },
    { pos: { x: 0, y: 2.625, z: 0 }, size: { x: 9, y: 0.85, z: 9 } },
  ] satisfies HullBox[];
  return g;
}

/** Base tower — T:A flag-tower shell: 2-tier shaft, window band, cap.
 *  Flag pad sits on the cap at h. For when we want elevated stands. */
export function mkBaseTower(w = 9, h = 12, teamGlow = 0x59_F2_FF): THREE.Group {
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
  g.userData.hulls = [{ pos: { x: 0, y: h / 2, z: 0 }, size: { x: w, y: h, z: w } } satisfies HullBox];
  return g;
}

// ---------------------------------------------------------------------------
// Composed base pieces — what the kit is FOR. Every builder returns a Group
// with origin at ground level; collision lives in matching 'hull' spec boxes.
// ---------------------------------------------------------------------------

/** Curtain wall run — the perimeter piece. One battered loft does all
 *  the work: wide foot, slight inward taper to the parapet, chamfered
 *  corners so the long face catches light. Pilasters/panels are texture
 *  detail — not modeled. Runs along local X. */
export function mkWallRun(len = 18, h = 4.2, teamGlow = 0x59_F2_FF, caps = true): THREE.Group {
  const g = new THREE.Group();
  const curtain = mkLoft(topDown(
    { z: h,        ring: profOct(len * 0.96, 1, 0.3) },
    { z: h - 0.7,  ring: profOct(len, 1.15, 0.32) },
    { z: 0.8,      ring: profOct(len * 1.02, 1.4, 0.36) },
    { z: 0,        ring: profOct(len * 1.08, 1.8, 0.4) },
  ), hullMat);
  curtain.rotation.x = -Math.PI / 2;
  g.add(curtain);
  // Parapet glow — the ONE accent: a thin lit strip seated on the
  // battered face just under the walk edge. The face depth at strip
  // height is the profile's interpolated ~0.51 (rings 1.15→1.0 over the
  // top 0.7m), so the strip front lands a consistent ~0.05 proud and
  // never pokes above the parapet line.
  const strip = glowStrip(len * 0.9, 0.15, 0.12, new THREE.MeshBasicMaterial({ color: teamGlow }));
  strip.position.set(0, h - 0.25, -0.52);
  g.add(strip);
  // End posts close the open loft ends — without them a run terminates
  // mid-air with the tube interior showing.
  if (caps) { for (const side of [-1, 1]) {
    const p = endPost(h);
    p.position.x = side * (len / 2);
    g.add(p);
  } }
  g.userData.hulls = [{ pos: { x: 0, y: h / 2, z: 0 }, size: { x: len + (caps ? 2.4 : 0), y: h + 0.4, z: 1.8 } } satisfies HullBox];
  return g;
}

/** Wall gate — a run split around an opening: two stubs, posts on the
 *  INNER faces, and a lintel beam across the top so the mouth reads as
 *  a portal frame, not a broken fence line. Pass lintel=false for a
 *  bare vehicle mouth. */
export function mkWallGate(len = 18, h = 4.2, gap = 6, teamGlow = 0x59_F2_FF, lintel = true): THREE.Group {
  const stub = (len - gap) / 2;
  const g = compound([
    [mkWallRun(stub, h, teamGlow, false), -(gap / 2 + stub / 2), 0],
    [mkWallRun(stub, h, teamGlow, false),  (gap / 2 + stub / 2), 0],
    [endPost(h), -gap / 2, 0],
    [endPost(h),  gap / 2, 0],
  ]);
  if (lintel) {
    const beam = mkLoft(topDown(
      { z: 0.8, ring: profOct(gap + 2.4, 1, 0.3) },
      { z: 0,   ring: profOct(gap + 2.4, 1.3, 0.35) },
    ), hullMat);
    beam.rotation.x = -Math.PI / 2;
    beam.position.y = h - 0.9;
    g.add(beam);
  }
  return g;
}

/** Kata-style flag stand — the low square pedestal: one battered block,
 *  a stepped-in deck slab the flag sockets onto, and a single glow slot
 *  on the front face. Deliberately plain — the panel lines in the
 *  reference are texture work, not geometry. ~6.5m wide, ~3.2m tall. */
export function mkKataStand(teamGlow = 0x59_F2_FF): THREE.Group {
  const g = new THREE.Group();
  // Pedestal — one clean battered slab, foot to shoulder. Flat faces
  // and a single taper read as poured concrete armour, not rock.
  const body = mkLoft(topDown(
    { z: 2.6, ring: profOct(5.4, 5.4, 0.7) },
    { z: 0,   ring: profOct(6.4, 6.4, 0.9) },
  ), hullMat);
  body.rotation.x = -Math.PI / 2;
  g.add(body);
  // Deck slab — the inset step the flag pole seats on.
  const deck = mkLoft(topDown(
    { z: 0.55, ring: profOct(4.4, 4.4, 0.5) },
    { z: 0,    ring: profOct(4.6, 4.6, 0.5) },
  ), deckMat);
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = 2.6;
  g.add(deck);
  // Corner pillars — four stub posts on the deck edge; they break the
  // top silhouette (the kata stand's tell), so they're geometry.
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const pil = mkLoft(topDown(
      { z: 0.9, ring: profOct(0.6, 0.6, 0.12) },
      { z: 0,   ring: profOct(0.8, 0.8, 0.15) },
    ), trimMat);
    pil.rotation.x = -Math.PI / 2;
    pil.position.set(Math.cos(a) * 1.85, 3.15, Math.sin(a) * 1.85);
    g.add(pil);
  }
  // Glow band around the pedestal lip — the team line where the body
  // necks into the deck, read from every approach angle.
  const band = mkAnnulus(
    profOct(5.5, 5.5, 0.7),
    profOct(5.38, 5.38, 0.7),
    2.3, 2.55, new THREE.MeshBasicMaterial({ color: teamGlow }),
  );
  band.rotation.x = -Math.PI / 2;
  g.add(band);
  g.userData.hulls = [{ pos: { x: 0, y: 1.6, z: 0 }, size: { x: 6.4, y: 3.2, z: 6.4 } } satisfies HullBox];
  return g;
}

/** Enterable bunker — the first interior piece. Perimeter is wall runs
 *  (their battered face reads pillbox-right from inside too), end posts
 *  frame a +Z door, a single roof slab spans the top. Collision stays
 *  per-wall boxes — the interior is genuinely hollow, not a solid hull. */
export function mkBunker(w = 12, d = 10, h = 4.2, teamGlow = 0x59_F2_FF, door = 4.5): THREE.Group {
  const stub = (w - door) / 2;
  const g = compound([
    // Back wall, then the two side walls (rotated 90° — runs are local-X).
    [mkWallRun(w, h, teamGlow),       0, -d / 2],
    [mkWallRun(d, h, teamGlow), -w / 2, 0, Math.PI / 2],
    [mkWallRun(d, h, teamGlow),  w / 2, 0, Math.PI / 2],
    // Front face: two stubs flanking the door gap. Slim posts half-buried
    // in the stub ends — they frame the mouth without eating it.
    [mkWallRun(stub, h, teamGlow, false), -(door / 2 + stub / 2), d / 2],
    [mkWallRun(stub, h, teamGlow, false),  (door / 2 + stub / 2), d / 2],
    [endPost(h, 2), -(door / 2 + 0.5), d / 2],
    [endPost(h, 2),  (door / 2 + 0.5), d / 2],
  ]);
  // Roof — a real rectangular slab spanning wall to wall, cornice
  // overhang + chamfered crown edge. capPlate is square-only.
  const roof = mkLoft(topDown(
    { z: 0.9, ring: profOct(w + 0.4, d + 0.4, 0.5) },
    { z: 0.3, ring: profOct(w + 0.9, d + 0.9, 0.55) },
    { z: 0,   ring: profOct(w + 0.9, d + 0.9, 0.55) },
  ), hullMat);
  roof.rotation.x = -Math.PI / 2;
  roof.position.y = h;
  g.add(roof);
  // Interior light line — the one accent, along the back wall face.
  const strip = glowStrip(w * 0.8, 0.3, 0.1, new THREE.MeshBasicMaterial({ color: teamGlow }));
  strip.position.set(0, h - 0.6, -d / 2 + 0.55); // inner face ≈0.52 off wall centerline
  g.add(strip);
  // Roof hull on top of the folded wall hulls.
  (g.userData.hulls as HullBox[]).push(
    { pos: { x: 0, y: h + 0.4, z: 0 }, size: { x: w, y: 0.8, z: d } },
  );
  return g;
}

/** Flag tower — the classic Raindance/T2 form: a small enterable room
 *  at ground level, a wrap-around LEDGE platform at mid-height where
 *  the flag sits exposed on all four sides, and a tapered shaft rising
 *  through the deck to a cap. ~8m footprint, ~11m tall. */
export function mkFlagTower(w = 8, h = 10.5, teamGlow = 0x59_F2_FF, door = 3): THREE.Group {
  const roomH = 4.4;
  const stub = (w - door) / 2;
  const g = compound([
    [mkWallRun(w, roomH, teamGlow),       0, -w / 2],
    [mkWallRun(w, roomH, teamGlow), -w / 2, 0, Math.PI / 2],
    [mkWallRun(w, roomH, teamGlow),  w / 2, 0, Math.PI / 2],
    [mkWallRun(stub, roomH, teamGlow, false), -(door / 2 + stub / 2), w / 2],
    [mkWallRun(stub, roomH, teamGlow, false),  (door / 2 + stub / 2), w / 2],
    [endPost(roomH, 2), -(door / 2 + 0.4), w / 2],
    [endPost(roomH, 2),  (door / 2 + 0.4), w / 2],
  ]);
  // Ledge — the walk-around deck the flag sits on: chamfered slab
  // ~3m wider than the room, low parapet lip all round.
  const ledge = mkLoft(topDown(
    { z: 0.7, ring: profOct(w + 2.4, w + 2.4, 0.6) },
    { z: 0,   ring: profOct(w + 2.9, w + 2.9, 0.65) },
  ), deckMat);
  ledge.rotation.x = -Math.PI / 2;
  ledge.position.y = roomH;
  g.add(ledge);
  const lip = mkAnnulus(
    profOct(w + 2.55, w + 2.55, 0.6),
    profOct(w + 2.3, w + 2.3, 0.55),
    roomH + 0.7, roomH + 1.15, hullMat,
  );
  lip.rotation.x = -Math.PI / 2;
  g.add(lip);
  // Flag socket on the ledge — dark disc + glow bead, dead center front.
  const sock = mkLoft(topDown(
    { z: 0.3, ring: profOct(1.5, 1.5, 0.3) },
    { z: 0,   ring: profOct(1.8, 1.8, 0.35) },
  ), darkMat);
  sock.rotation.x = -Math.PI / 2;
  sock.position.set(0, roomH + 0.7, w / 2 + 0.6);
  g.add(sock);
  // Upper shaft — solid, centered, rising to the cap.
  const shaft = towerShaft(w * 0.72, h - roomH - 1);
  shaft.position.y = roomH + 0.7;
  g.add(shaft);
  const band = windowBand(w * 0.72, 0.5, new THREE.MeshBasicMaterial({ color: teamGlow }));
  band.position.y = h - 1.2;
  g.add(band);
  const cap = capPlate(w * 0.72);
  cap.position.y = h;
  g.add(cap);
  (g.userData.hulls as HullBox[]).push(
    { pos: { x: 0, y: roomH + 0.35, z: 0 }, size: { x: w + 2.9, y: 0.7, z: w + 2.9 } },
    { pos: { x: 0, y: (roomH + h) / 2, z: 0 }, size: { x: w * 0.72, y: h - roomH, z: w * 0.72 } },
  );
  return g;
}

/** Generator dome — low faceted dome on a skirted plinth with a single
 *  dark recessed door lintel. Reads "power plant" by silhouette alone. */
export function mkGenDome(r = 5, teamGlow = 0x59_F2_FF): THREE.Group {
  const g = new THREE.Group();
  g.add(skirt(profOct(r * 2.1, r * 2.1, r * 0.25), 1.8, 1.22, hullMat, 3));
  const cap = dome(r, hullMat);
  cap.position.y = 1.8;
  g.add(cap);
  // Glow collar where dome meets plinth — the T:A window line.
  const band = windowBand(r * 1.98, 0.45, new THREE.MeshBasicMaterial({ color: teamGlow }));
  band.position.y = 2.1;
  g.add(band);
  g.userData.hulls = [{ pos: { x: 0, y: (1.8 + r) / 2, z: 0 }, size: { x: r * 2, y: 1.8 + r, z: r * 2 } } satisfies HullBox];
  return g;
}

/** Landing pad — the kit pad surfaced: skirted plinth + glow-rim deck. */
export function mkLandingPad(r = 4.5, teamGlow = 0x59_F2_FF): THREE.Group {
  const g = new THREE.Group();
  g.add(skirt(profOct(r * 2.05, r * 2.05, r * 0.3), 1.2, 1.15, hullMat, 2));
  const p = pad(r, 0.6, new THREE.MeshBasicMaterial({ color: teamGlow }));
  p.position.y = 1.2;
  g.add(p);
  g.userData.hulls = [{ pos: { x: 0, y: 0.9, z: 0 }, size: { x: r * 2.1, y: 1.8, z: r * 2.1 } } satisfies HullBox];
  return g;
}

/** Sensor/comms mast — thin tower + dish horn; the "eyes" silhouette.
 *  Sits on its own skirt so it reads planted, not speared. */
export function mkCommsMast(h = 10, teamGlow = 0x59_F2_FF): THREE.Group {
  const g = new THREE.Group();
  g.add(skirt(profOct(3.4, 3.4, 0.5), 1.4, 1.3, hullMat, 2));
  const m = mast(h, 0.3, trimMat, new THREE.MeshBasicMaterial({ color: teamGlow }));
  m.position.y = 1.4;
  g.add(m);
  // Dish — a shallow lathe cone aimed out over the field.
  const dish = mkRevolve([[0.05, -0.35], [1.1, 0], [0.05, 0.05]], trimMat, 10, true);
  dish.position.set(0, 1.4 + h * 0.78, 0);
  dish.rotation.set(-0.5, 0.5, 0);
  g.add(dish);
  // Skirt + shaft as one slim box — the dish is collision-exempt dress.
  g.userData.hulls = [{ pos: { x: 0, y: (1.4 + h) / 2, z: 0 }, size: { x: 2.2, y: 1.4 + h, z: 2.2 } } satisfies HullBox];
  return g;
}

// ---------------------------------------------------------------------------
// Midfield scatter — landmarks and ski-cover, not base parts. Each is one
// strong silhouette on a buried skirt; all take a `hue` accent or none.
// ---------------------------------------------------------------------------

/** Waypoint pillar — the generic midfield marker: battered octagonal
 *  column, cornice cap, one glow collar at the crown. Good for slalom
 *  lines and mid-map orientation reads. */
export function mkPillar(w = 3, h = 9, teamGlow = 0x59_F2_FF): THREE.Group {
  const g = new THREE.Group();
  g.add(skirt(profOct(w * 1.4, w * 1.4, w * 0.3), 1.6, 1.2, hullMat, 2.5));
  const shaft = mkLoft(topDown(
    { z: h,       ring: profOct(w * 0.85, w * 0.85, w * 0.15) },
    { z: h * 0.5, ring: profOct(w,        w,        w * 0.18) },
    { z: 0,       ring: profOct(w * 1.1,  w * 1.1,  w * 0.2)  },
  ), hullMat);
  shaft.rotation.x = -Math.PI / 2;
  shaft.position.y = 1.6;
  g.add(shaft);
  const collar = mkAnnulus(
    profOct(w * 0.92, w * 0.92, w * 0.16),
    profOct(w * 0.8,  w * 0.8,  w * 0.15),
    1.6 + h - 0.6, 1.6 + h - 0.25, new THREE.MeshBasicMaterial({ color: teamGlow }),
  );
  collar.rotation.x = -Math.PI / 2;
  g.add(collar);
  const cap = capPlate(w * 0.95, 0.15, 0.5);
  cap.position.y = 1.6 + h;
  g.add(cap);
  g.userData.hulls = [{ pos: { x: 0, y: (1.6 + h) / 2, z: 0 }, size: { x: w, y: 1.6 + h, z: w } } satisfies HullBox];
  return g;
}

/** Obelisk — the landmark needle: four-sided taper on a stepped plinth,
 *  glowing tip. Taller than it is wide by ~4× so it reads across the
 *  whole map. */
export function mkObelisk(w = 2.4, h = 12, teamGlow = 0x59_F2_FF): THREE.Group {
  const g = new THREE.Group();
  g.add(skirt(profOct(w * 2.6, w * 2.6, w * 0.4), 1.4, 1.25, hullMat, 2));
  const step = mkLoft(topDown(
    { z: 0.8, ring: profOct(w * 1.9, w * 1.9, w * 0.3) },
    { z: 0,   ring: profOct(w * 2.2, w * 2.2, w * 0.35) },
  ), deckMat);
  step.rotation.x = -Math.PI / 2;
  step.position.y = 1.4;
  g.add(step);
  // Needle — a hard 4-sided taper (chamfer ~0 reads as a square; r=0
  // collapses profOct's corner pairs and trips the degenerate-point lint),
  // rotated 45° so a flat face greets each approach.
  const needle = mkLoft(topDown(
    { z: h,       ring: profOct(w * 0.35, w * 0.35, w * 0.02) },
    { z: 0,       ring: profOct(w,        w,        w * 0.02) },
  ), hullMat);
  needle.rotation.x = -Math.PI / 2;
  needle.rotation.y = Math.PI / 4;
  needle.position.y = 2.2;
  g.add(needle);
  const tip = new THREE.Mesh(
    new THREE.OctahedronGeometry(w * 0.3),
    new THREE.MeshBasicMaterial({ color: teamGlow }),
  );
  tip.position.y = 2.2 + h + w * 0.25;
  g.add(tip);
  g.userData.hulls = [{ pos: { x: 0, y: (2.2 + h) / 2, z: 0 }, size: { x: w * 1.4, y: 2.2 + h, z: w * 1.4 } } satisfies HullBox];
  return g;
}

/** Arch — two posts and a lintel: the midfield gate you ski UNDER.
 *  Pure silhouette, no accent — a doorway to nowhere reads as terrain
 *  furniture, not tech. */
export function mkArch(span = 9, h = 7, w = 2.6): THREE.Group {
  const g = compound([
    [endPost(h, w), -span / 2, 0],
    [endPost(h, w),  span / 2, 0],
  ]);
  const beam = mkLoft(topDown(
    { z: 1.1, ring: profOct(span + w, 1.0, 0.25) },
    { z: 0,   ring: profOct(span + w, 1.4, 0.3) },
  ), hullMat);
  beam.rotation.x = -Math.PI / 2;
  beam.position.y = h + 0.3;
  g.add(beam);
  (g.userData.hulls as HullBox[]).push(
    { pos: { x: 0, y: h + 0.85, z: 0 }, size: { x: span + w, y: 1.1, z: 1.4 } },
  );
  return g;
}

/** Shard — a broken monolith chunk: irregular slab loft with a slight
 *  lean baked into the silhouette (sections drift +x going up). The
 *  "ancient ruin" scatter piece. */
export function mkShard(w = 3.4, h = 8, lean = 0.25): THREE.Group {
  const g = new THREE.Group();
  g.add(skirt(profOct(w * 1.5, w * 1.5, w * 0.3), 1.2, 1.2, hullMat, 2));
  const slab = mkLoft(topDown(
    { z: h,       ring: profOct(w * 0.7, w * 1.05, w * 0.2), dx: lean * h },
    { z: h * 0.6, ring: profOct(w * 0.85, w * 1.1, w * 0.22), dx: lean * h * 0.6 },
    { z: 0,       ring: profOct(w, w * 1.2, w * 0.25) },
  ), hullMat);
  slab.rotation.x = -Math.PI / 2;
  slab.position.y = 1.2;
  g.add(slab);
  g.userData.hulls = [{ pos: { x: lean * h * 0.5, y: (1.2 + h) / 2, z: 0 }, size: { x: w * 1.2, y: 1.2 + h, z: w * 1.2 } } satisfies HullBox];
  return g;
}

/** The bastion — a complete CTF base compound from the kit, ~46×34m.
 *  Composition rules (the parts that made hand-placed walls look wrong):
 *  every mass is axially aligned to the compound, heights step
 *  tower→wall→pad, one material story (gunmetal hull + dark trim + team
 *  glow), and every piece sits ON its own buried skirt so nothing floats
 *  or cross-clips. The courtyard stays open toward +Z. */
export function mkBastion(teamGlow = 0x59_F2_FF): THREE.Group {
  // Command tower — the tall anchor, rear-center. Flag can stand beside.
  // Perimeter: two angled curtains form the courtyard gate mouth; the
  // rear run closes the compound. compound() folds every child's hulls
  // into bastion space — collision stays in step with layout for free.
  return compound([
    [mkBaseTower(10, 14, teamGlow),   0, -9],
    [mkGenDome(4.6, teamGlow),       -13, 1],
    [mkLandingPad(4.2, teamGlow),     11, 8],
    [mkCommsMast(10, teamGlow),       15, -11],
    [mkWallRun(15, 4.2, teamGlow),   -13, 13, -0.26],
    [mkWallRun(15, 4.2, teamGlow),    13, 13, 0.26],
    [mkWallRun(30, 4.2, teamGlow),     0, -18],
  ]);
}
