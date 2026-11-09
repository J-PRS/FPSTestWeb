import {type Heightfield, hmHeight} from '../../shared/heightfield.ts';
import { type MapSpec, type StructureSpec } from '../../shared/mapSpec.ts';
import type { ModeSpec } from '../../shared/teams.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import { seatKits } from '../../shared/structKits.ts';
import type { FlagPlacer } from './roomFlagPlacer.ts';
import type { BallSim } from './BallSim.ts';
import type { ServerMessage } from './types.ts';
import { existsSync, readFileSync } from 'node:fs';

/** World-space AABBs baked per interior (tools/hullbox) — T2 maps ship
 *  interiors not structures, so without these the hulls were ghosts:
 *  bots pathed through them, projectiles flew through, bots bled charge
 *  grinding a wall they couldn't see (raindance_nef 2731 pts). */
const HULLBOX_CACHE = new Map<string, StructureSpec[] | null>();
export function hullBoxes(mapSrc: string): StructureSpec[] {
  if (!HULLBOX_CACHE.has(mapSrc)) {
    let boxes: StructureSpec[] | null = null;
    try {
      const p = `${import.meta.dir}/../../maps/t2/${mapSrc}/hullboxes.json`;
      if (existsSync(p)) {
        boxes = (JSON.parse(readFileSync(p, 'utf8')) as { min: number[]; max: number[]; yaw?: number }[]).map((b) => ({
          kind: 'hull' as const,
          pos: { x: ((b.min[0] ?? 0) + (b.max[0] ?? 0)) / 2, y: b.min[1] ?? 0, z: ((b.min[2] ?? 0) + (b.max[2] ?? 0)) / 2 },
          size: { x: (b.max[0] ?? 0) - (b.min[0] ?? 0), y: (b.max[1] ?? 0) - (b.min[1] ?? 0), z: (b.max[2] ?? 0) - (b.min[2] ?? 0) },
          // yaw entries (q3conv ports): min/max are the LOCAL-frame bounds,
          // pos=(min+max)/2 is the box center, yaw→rotY spins it about Y.
          rotY: typeof b.yaw === 'number' ? b.yaw : undefined,
        }));
      }
    } catch { boxes = null; }
    HULLBOX_CACHE.set(mapSrc, boxes);
  }
  return HULLBOX_CACHE.get(mapSrc) ?? [];
}

/** The room-side surface RoomStructures needs — the room satisfies it
 *  structurally; every member reads live so late assigns (terrain,
 *  spec swap, deployables boot) are visible. */
export interface RoomStructHost {
  spec: MapSpec;
  field: Heightfield | null;
  modeSpec: ModeSpec | null;
  mode: string;
  flagPlacer: FlagPlacer;
  moveSim: { attachStructures(list: StructureSpec[]): void };
  projectiles: { attachStructures(list: StructureSpec[]): void } | null;
  ballSim: BallSim;
  deployables: { teamPowered(team: string): boolean } | null | undefined;
  /** Pluggable mode's module — its structures() feeds eff() so node
   *  bases and future mode solids ride the one collider/wire pipeline. */
  modeModule: { structures?(): StructureSpec[] } | null;
  messages: { setMap(spec: MapSpec): void };
  broadcast(msg: ServerMessage, exclude?: string): void;
  mapSrc: string;
}

/** The effective structure set — spec's authored structures plus the
 *  flag-dais hulls — and everywhere it feeds: colliders on every sim,
 *  the join-time setMap echo, and the skinny mapUpdate diff. One owner
 *  so "which stand hulls exist" can't desync across the three sinks. */
export class RoomStructures {
  constructor(private host: RoomStructHost) {}

  /** The stand hulls as emitted — the baseline "every client holds"
   *  approximation: gameState echoes and pushes both serialize eff(),
   *  so the last push's snapshot is what a stayer has. */
  private emittedStands: string | null = null;
  private standsJson(): string {
    // Shields ride the diff too — a generator flip changes which panes emit.
    return JSON.stringify(this.eff().filter((s): boolean => s.kind === 'stand' || s.kind === 'shield'));
  }

  /** The spec's authored structures — the flag socket is visual-only
   *  (mkFlagStand), so nothing is injected here; a map that wants a real
   *  platform authors a 'stand' box or a katastand/flagtower kit piece. */
  eff(): StructureSpec[] {
    const {host} = this;
    // Team shield panes vanish while their grid is dark — no collider,
    // no render, no blocker on either side.
    // deployables construct after the first moveSim/ballSim attach —
    // pre-seed the grid reads live, so a missing table means powered.
    const authored = (host.spec.structures ?? []).filter(
      (s): boolean => s.kind !== 'shield' || !s.team || (host.deployables?.teamPowered(s.team) ?? true),
    );
    // 'hull' is the collider-only kind — the client mesh builder skips it
    // (GLB interiors already render), while every sim AND the wire echo
    // see the same boxes, so prediction collides identically both sides.
    const all = host.spec.interiors?.length ? authored.concat(hullBoxes(host.mapSrc)) : authored;
    // Module-owned solids last — colliders, ball/projectile sims AND the
    // wire echo all see conquest bases / future mode geometry as one list.
    const mode = host.modeModule?.structures?.() ?? [];
    return mode.length > 0 ? all.concat(mode) : all;
  }

  /** Re-attach the merged structure list everywhere it feeds — called
   *  at boot and whenever flag homes re-snap (terrain attach, map swap). */
  attach(): void {
    const {host} = this;
    // Kit pieces ground-seat on the live heightfield — authored y in the
    // map file can't know the terrain, and a floating/buried compound is
    // worse than an advisory height. Spec objects are shared with the
    // wire echo, so the mutation reaches clients as the real position.
    // Sky maps (killY) author decks in the air over a far-below plain — seating them would drop the deck into the kill zone.
    if (host.field && host.spec.killY === undefined) {seatKits(host.spec.structures, (x, z): number => hmHeight(host.field!, x, z));}
    const list = this.eff();
    host.moveSim.attachStructures(list);
    host.projectiles?.attachStructures(list);
    if (host.ballSim) {host.ballSim.colliders = structureColliders(list);}
  }

  /** Re-push the merged structure list when the stand hulls moved — a
   *  skinny mapUpdate (no terrain/name keys) so clients rebuild colliders
   *  without a full map reload. */
  pushUpdate(): void {
    const {host} = this;
    const stands = this.standsJson();
    if (stands === this.emittedStands) {return;}
    this.emittedStands = stands;
    const {spec} = host;
    // Refresh the join-time echo too — setMap freezes whatever snap was
    // live when applySpec ran (often the previous map's field), and
    // gameState re-serves that stale list to every reconnect until the
    // map reloads.
    host.messages.setMap(Object.assign({}, spec, {structures: this.eff()}));
    host.broadcast({
      type: 'mapUpdate',
      silent: true,
      structures: this.eff(),
      arena: spec.arena ?? null,
      ambient: spec.ambient,
      fog: spec.fog,
      water: spec.water,
      terrainTex: spec.terrainTex,
      terrainPreset: spec.terrainPreset,
      sky: spec.sky,
      weather: spec.weather,
      atmosphere: spec.atmosphere,
      interiors: spec.interiors,
    });
  }

  /** Generator state flips which shield panes exist — colliders and the
   *  wire echo share this list, so one call re-syncs every client. */
  refreshPower(): void {
    this.attach();
    this.pushUpdate();
  }

  /** Boot-time baseline — the stands the gameState echo already served,
   *  so a first no-op refresh doesn't spam mapUpdate. */
  baseline(): void {
    this.emittedStands = this.standsJson();
  }
}
