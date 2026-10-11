import {type Heightfield, hmHeight} from '../../shared/heightfield.ts';
import { KIT_HULLS, KIT_STAND_TOP } from '../../shared/structKits.ts';
import type { MapSpec, SpawnPoint, Vec3like } from '../../shared/mapSpec.ts';
import type { Vec3 } from './types.ts';
import type { RoomFlags } from './RoomFlags.ts';
import type { BallSim } from './BallSim.ts';

/** Where flags and seeded deploys legally stand — the room's placement
 *  domain. Homes snap to walkable surfaces (kit stand decks, structure
 *  tops, terrain), unreachable shelves walk downhill, and seeded deploys
 *  seat on the first solid top up out of buried fill. */
export class FlagPlacer {
  constructor(
    private host: {
      spec: MapSpec;
      field: Heightfield | null;
      flags: RoomFlags | null;
      ballSim: BallSim;
      mode: string;
    },
    /** Stands moved with the re-snap — collision hulls are spec entries,
     *  so the sims re-attach the merged list and (optionally) push the
     *  skinny mapUpdate. */
    private relayout: (broadcast: boolean) => void,
    /** Spawn anchors track corrected stands — a mid-match terrain attach
     *  can move them tens of meters. */
    private syncTeamBases: (snapped: { alpha: Vec3; bravo: Vec3 }) => void,
    /** Fires only on the no-authored-bases path — the Room turns the
     *  minted rings into teamSpawns so a spawnless spec doesn't drop
     *  players on the global ring mid-map. */
    private syncAutoSpawns?: (rings: { alpha: SpawnPoint[]; bravo: SpawnPoint[] }) => void,
  ) {}

  /** Rabbit's one stand: the midpoint of a two-base map (a team's own
   *  stand would hand them free territory), else the arena center, else
   *  the first spawn — always de-shelved + snapped to walkable ground. */
  rabbitFlagHome(): Vec3 {
    const {spec} = this.host;
    const src = (spec.bases?.alpha && spec.bases?.bravo)
      ? {
        x: (spec.bases.alpha.x + spec.bases.bravo.x) / 2,
        y: 0,
        z: (spec.bases.alpha.z + spec.bases.bravo.z) / 2,
      }
      : spec.bases?.alpha
        ?? (spec.arena ? { x: spec.arena.x, y: 0, z: spec.arena.z } : null)
        ?? spec.spawns?.[0]
        ?? { x: 0, y: 0, z: 0 };
    const p = this.deShelf(src);
    return { x: p.x, y: this.standTop(p.x, p.z), z: p.z };
  }

  // Spec y is advisory — flags live on the walkable surface, so touch
  // checks measure feet-to-flag, not feet-to-arbitrary-height. Both error
  // directions land the same: a flag authored under the terrain or inside
  // a stand pad pops up to the pad's deck, and a flag authored floating
  // drops onto it — max() of every surface the point could stand on IS
  // the perfect spot either way.
  standTop(x: number, z: number): number {
    let top = this.host.field ? hmHeight(this.host.field, x, z) : 0;
    for (const s of this.host.spec.structures ?? []) {
      if (s.kind === 'kit') {
        // Authored stand pieces ARE the platform — a base inside one's
        // footprint homes onto its standing surface (KIT_STAND_TOP).
        // Other kits' placeholder {1,1,1} size must never count.
        const lift = KIT_STAND_TOP[s.piece ?? ''];
        if (lift === undefined) {continue;}
        const k = s.scale ?? 1;
        let reach = 0;
        for (const h of KIT_HULLS[s.piece!] ?? []) {
          reach = Math.max(reach,
            (Math.abs(h.pos.x) + h.size.x / 2) * k,
            (Math.abs(h.pos.z) + h.size.z / 2) * k);
        }
        if (Math.abs(x - s.pos.x) <= reach && Math.abs(z - s.pos.z) <= reach) {
          top = Math.max(top, s.pos.y + lift * k);
        }
        continue;
      }
      if (Math.abs(x - s.pos.x) <= s.size.x / 2 && Math.abs(z - s.pos.z) <= s.size.z / 2) {
        top = Math.max(top, s.pos.y + s.size.y);
      }
    }
    return top;
  }

  /** Unreachable-shelf rescue: a flag snapped onto a mesa or pad that
   *  towers over every approach is a flag nobody can touch — walk it
   *  downhill toward the gentlest ring neighbor until some side is a
   *  jet-able climb (~18m over 60m) instead of a wall. */
  deShelf(v: { x: number; z: number }): { x: number; z: number } {
    let {x} = v, {z} = v;
    for (let i = 0; i < 10; i += 1) {
      const top = this.standTop(x, z);
      // Reachable when SOME side offers a jet-able approach (~18m over
      // 60m); a big flat mesa reads correctly this way — local flatness
      // doesn't fake accessibility, the far ring does.
      let bestTop = -Infinity, bx = x, bz = z;
      for (let a = 0; a < 8; a += 1) {
        const px = x + Math.cos((a / 8) * Math.PI * 2) * 60;
        const pz = z + Math.sin((a / 8) * Math.PI * 2) * 60;
        const t = this.standTop(px, pz);
        if (t > bestTop) { bestTop = t; bx = px; bz = pz; }
      }
      if (top - bestTop <= 18) {break;}
      const dx = bx - x, dz = bz - z, dd = Math.hypot(dx, dz) || 1;
      x += (dx / dd) * 15; z += (dz / dd) * 15;
    }
    return { x, z };
  }

  /** Highest walkable surface under a seeded deploy that isn't a climb
   *  away from its authored height — genhouse decks ride ~1m over the
   *  seated base, walls/roofs sit higher and must not win. Returns the
   *  authored y when nothing taller is under it, so tower-top assets
   *  are never dragged down and terrain never hoists anything. */
  deployFloor(x: number, z: number, authoredY: number): number {
    // No structure under it → authored y stands. Grounding to terrain
    // lives in applySpec/seatKits, not here.
    //
    // The floor is the LOWEST solid top above the authored point, not
    // the highest: a genhouse seats its foundation on max terrain, so
    // the authored y often lands INSIDE the buried slab — taking the
    // highest top in reach would plant the generator on the roof.
    // The first surface up out of the fill is the deck.
    let floor = Infinity;
    for (const c of this.host.ballSim?.colliders ?? []) {
      const dx = x - c.cx, dz = z - c.cz;
      const lx = dx * c.cos + dz * c.sin;
      const lz = -dx * c.sin + dz * c.cos;
      if (Math.abs(lx) > c.hx || Math.abs(lz) > c.hz) {continue;}
      const t = c.cy + c.hy;
      if (t > authoredY && t < floor && t <= authoredY + 12) {floor = t;}
    }
    return floor === Infinity ? authoredY : floor;
  }

  /** Local-peak finder for the no-bases path: from a seed, step to the
   *  highest walkable top within 100m until it stops rising. Hilltops
   *  are the classic readable stand — visible and defensible — and
   *  deShelf still rescues the rare pure-cliff summit it lands on. */
  private hilltop(x0: number, z0: number): { x: number; z: number } {
    let x = x0, z = z0, top = this.standTop(x, z);
    for (let i = 0; i < 8; i += 1) {
      let bt = top, bx = x, bz = z;
      for (let r = 25; r <= 100; r += 25) {
        for (let a = 0; a < 8; a += 1) {
          const px = x + Math.cos((a / 8) * Math.PI * 2) * r;
          const pz = z + Math.sin((a / 8) * Math.PI * 2) * r;
          const t = this.standTop(px, pz);
          if (t > bt + 0.5) { bt = t; bx = px; bz = pz; }
        }
      }
      if (bx === x && bz === z) {break;}
      x = bx; z = bz; top = bt;
    }
    return { x, z };
  }

  /** Spawn rings minted around auto-derived stands — a spawnless spec
   *  otherwise drops bravo players next to alpha's flag on the global
   *  config ring. Three anchors 35m out, snapped to standTop. */
  private autoSpawnRings(bases: { alpha: Vec3; bravo: Vec3 }): { alpha: SpawnPoint[]; bravo: SpawnPoint[] } {
    const ring = (b: Vec3): SpawnPoint[] => [0, 1, 2].map(i => {
      const a = (i / 3) * Math.PI * 2;
      const x = b.x + Math.cos(a) * 35, z = b.z + Math.sin(a) * 35;
      return { x, y: this.standTop(x, z), z, r: 10 };
    });
    return { alpha: ring(bases.alpha), bravo: ring(bases.bravo) };
  }

  /** CTF on a map with no authored bases: seed a symmetric pair 300m
   *  apart on the map diagonal (through the arena center / anchor
   *  centroid), hill-climb each seed onto its local peak, and keep the
   *  pair when the climbed distance stays a sane flag run. The PCA
   *  anchor-cloud axis, arena split, and ±50m remain the fallbacks when
   *  the peaks collide or flee. */
  autoFlagBases(): { alpha: Vec3; bravo: Vec3 } {
    const pair = this.diagonalHilltops();
    if (pair) {return this.seatAuto(pair);}
    return this.seatAuto(this.pcaAxisSeats());
  }

  private seatAuto(raw: { alpha: Vec3like; bravo: Vec3like }): { alpha: Vec3; bravo: Vec3 } {
    const snapped = this.snapFlagBases(raw);
    this.syncAutoSpawns?.(this.autoSpawnRings(snapped));
    return snapped;
  }

  /** Seeds 150m either side of the map center on each diagonal; a pair
   *  counts when the peaks end 150–500m apart — closer is one hill
   *  claiming both seeds, farther means the climbs ran off the map. */
  private diagonalHilltops(): { alpha: Vec3like; bravo: Vec3like } | null {
    const {spec} = this.host;
    const pts: Vec3like[] = [
      ...(spec.spawns ?? []),
      ...(spec.structures ?? []).map(s => ({ x: s.pos.x, y: 0, z: s.pos.z })),
    ];
    let cx = spec.arena?.x ?? 0, cz = spec.arena?.z ?? 0;
    if (!spec.arena && pts.length > 0) {
      for (const p of pts) { cx += p.x; cz += p.z; }
      cx /= pts.length; cz /= pts.length;
    }
    for (const [ux, uz] of [[Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2]] as const) {
      const a = this.hilltop(cx - ux * 150, cz - uz * 150);
      const b = this.hilltop(cx + ux * 150, cz + uz * 150);
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d >= 150 && d <= 500) {return { alpha: { x: a.x, y: 0, z: a.z }, bravo: { x: b.x, y: 0, z: b.z } };}
    }
    return null;
  }

  /** The old auto path, kept as the fallback: dominant axis of the
   *  anchor cloud (spawns + structures), stands at its 25%/75% marks;
   *  symmetric clouds take the 45° diagonal, bare specs the arena split
   *  or ±50m. */
  private pcaAxisSeats(): { alpha: Vec3like; bravo: Vec3like } {
    const {spec} = this.host;
    const pts: Vec3like[] = [
      ...(spec.spawns ?? []),
      ...(spec.structures ?? []).map(s => ({ x: s.pos.x, y: 0, z: s.pos.z })),
    ];
    let a: Vec3like, b: Vec3like;
    if (pts.length >= 2) {
      let cx = 0, cz = 0;
      for (const p of pts) { cx += p.x; cz += p.z; }
      cx /= pts.length; cz /= pts.length;
      let sxx = 0, sxz = 0, szz = 0;
      for (const p of pts) { const dx = p.x - cx, dz = p.z - cz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
      const tr = (sxx + szz) / 2;
      const disc = Math.hypot((sxx - szz) / 2, sxz);
      const lam1 = tr + disc, lam2 = tr - disc;
      let ux: number, uz: number;
      if (disc < 1e-6 || lam1 / lam2 < 1.25) {
        // Symmetric cloud — the axis is ambiguous, take the diagonal.
        ux = Math.SQRT1_2; uz = Math.SQRT1_2;
      } else {
        let vx = sxz, vz = lam1 - sxx;
        if (Math.hypot(vx, vz) < 1e-9) { vx = lam1 - szz; vz = sxz; }
        const n = Math.hypot(vx, vz) || 1;
        ux = vx / n; uz = vz / n;
        if (ux < 0 || (ux === 0 && uz < 0)) { ux = -ux; uz = -uz; }
      }
      let tMin = Infinity, tMax = -Infinity;
      for (const p of pts) {
        const t = (p.x - cx) * ux + (p.z - cz) * uz;
        if (t < tMin) {tMin = t;}
        if (t > tMax) {tMax = t;}
      }
      const span = tMax - tMin;
      const seat = (t: number): Vec3like => ({ x: cx + ux * t, y: 0, z: cz + uz * t });
      if (span < 20) {
        // Coincident anchors — nothing to split along.
        a = { x: -50, y: 0, z: 0 }; b = { x: 50, y: 0, z: 0 };
      } else {
        a = seat(tMin + span * 0.25); b = seat(tMax - span * 0.25);
      }
    } else if (spec.arena) {
      const r = spec.arena.radius * 0.6;
      a = { x: spec.arena.x - r, y: 0, z: spec.arena.z };
      b = { x: spec.arena.x + r, y: 0, z: spec.arena.z };
    } else {
      a = { x: -50, y: 0, z: 0 }; b = { x: 50, y: 0, z: 0 };
    }
    return { alpha: a, bravo: b };
  }

  snapFlagBases(bases: { alpha: Vec3like; bravo: Vec3like }): { alpha: Vec3; bravo: Vec3 } {
    const snapBase = (v: Vec3like): Vec3 => {
      const p = this.deShelf(v);
      return { ...v, x: p.x,z: p.z,y: this.standTop(p.x, p.z)};
    };
    return { alpha: snapBase(bases.alpha), bravo: snapBase(bases.bravo) };
  }

  /** Re-snaps flag homes against the LIVE heightfield. The ctor runs this
   *  with whatever field the host had at boot (often null), and the real
   *  per-map terrain lands later via the async attachTerrain promise —
   *  without this refresh the homes stay snapped to the wrong ground.
   *  Called again on every terrain attach and applySpec (bases can move
   *  with the map). */
  refreshHomes(broadcastUpdate = true): void {
    const {host} = this;
    if (!host.flags) {return;}
    if (host.mode === 'rabbit') {
      host.flags.retargetHomes({ alpha: this.rabbitFlagHome() });
      this.relayout(broadcastUpdate);
      return;
    }
    const {bases} = host.spec;
    if (!host.flags.flags.has('bravo')) {return;}
    // Auto-placed homes (bare spec) re-derive the same way — terrain
    // lands after the ctor, so the first snap was against null ground.
    const snapped = bases?.alpha && bases?.bravo
      ? this.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo })
      : this.autoFlagBases();
    host.flags.retargetHomes(snapped);
    this.syncTeamBases(snapped);
    this.relayout(broadcastUpdate);
  }
}
