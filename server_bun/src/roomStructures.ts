import type { Heightfield } from '../../shared/heightfield.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import { type MapSpec, type StructureSpec, flagStandSpecs } from '../../shared/mapSpec.ts';
import type { ModeSpec } from '../../shared/teams.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import { seatKits } from '../../shared/structKits.ts';
import type { FlagPlacer } from './roomFlagPlacer.ts';
import type { BallSim } from './BallSim.ts';
import type { ServerMessage } from './types.ts';

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
  messages: { setMap(spec: MapSpec): void };
  broadcast(msg: ServerMessage, exclude?: string): void;
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
    return JSON.stringify(this.eff().filter((s) => s.kind === 'stand' || s.kind === 'shield'));
  }

  /** The spec's authored structures PLUS collision hulls for the flag
   *  daises — 'stand' entries collide everywhere (move sim, shells,
   *  balls, blast LOS) and ride the wire echo, but the client never
   *  draws them as generic boxes (the dais mesh is their visual). */
  eff(): StructureSpec[] {
    const host = this.host;
    // Team shield panes vanish while their grid is dark — no collider,
    // no render, no blocker on either side.
    // deployables construct after the first moveSim/ballSim attach —
    // pre-seed the grid reads live, so a missing table means powered.
    const out = (host.spec.structures ?? []).filter(
      (s) => s.kind !== 'shield' || !s.team || (host.deployables?.teamPowered(s.team) ?? true),
    );
    if (!host.modeSpec?.flags) return out;
    if (process.env.FPS_NOSTAND) return out; // soak A/B: measure approach cost of the dais hulls
    if (host.mode === 'rabbit') {
      out.push(...flagStandSpecs(host.flagPlacer.rabbitFlagHome()));
      return out;
    }
    const bases = host.spec.bases;
    if (bases?.alpha && bases?.bravo) {
      const snapped = host.flagPlacer.snapFlagBases({ alpha: bases.alpha, bravo: bases.bravo });
      out.push(...flagStandSpecs(snapped.alpha, 'alpha'), ...flagStandSpecs(snapped.bravo, 'bravo'));
    }
    return out;
  }

  /** Re-attach the merged structure list everywhere it feeds — called
   *  at boot and whenever flag homes re-snap (terrain attach, map swap). */
  attach(): void {
    const host = this.host;
    // Kit pieces ground-seat on the live heightfield — authored y in the
    // map file can't know the terrain, and a floating/buried compound is
    // worse than an advisory height. Spec objects are shared with the
    // wire echo, so the mutation reaches clients as the real position.
    if (host.field) seatKits(host.spec.structures, (x, z) => hmHeight(host.field!, x, z));
    const list = this.eff();
    host.moveSim.attachStructures(list);
    host.projectiles?.attachStructures(list);
    if (host.ballSim) host.ballSim.colliders = structureColliders(list);
  }

  /** Re-push the merged structure list when the stand hulls moved — a
   *  skinny mapUpdate (no terrain/name keys) so clients rebuild colliders
   *  without a full map reload. */
  pushUpdate(): void {
    const host = this.host;
    const stands = this.standsJson();
    if (stands === this.emittedStands) return;
    this.emittedStands = stands;
    const spec = host.spec;
    // Refresh the join-time echo too — setMap freezes whatever snap was
    // live when applySpec ran (often the previous map's field), and
    // gameState re-serves that stale list to every reconnect until the
    // map reloads.
    host.messages.setMap({ ...spec, structures: this.eff() });
    host.broadcast({
      type: 'mapUpdate',
      silent: true,
      structures: this.eff(),
      arena: spec.arena ?? null,
      ambient: spec.ambient,
      fog: spec.fog,
      terrainTex: spec.terrainTex,
      sky: spec.sky,
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
