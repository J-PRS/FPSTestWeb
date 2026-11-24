/**
 * RoomUnbury - the ground-law rescue sweep. Half-second cadence check
 * that no sim-owned body sits under its terrain surface, plus the
 * one-shot unburySeats() pass when the real field lands and unseats
 * every spawn picked against a stale/empty heightmap.
 */
import type { Room } from './Room.ts';
import { hmHeight, hmChord } from '../../shared/heightfield.ts';
import { classCapsule, type ArmorClass } from '../../shared/botClasses.ts';
import { inv } from '../../shared/invariants.ts';
import { WORLD_MODEL, eventPayload } from '../../shared/worldModel.ts';
import { logger } from './logger.ts';
import type { PlayerState } from './types.ts';

export class RoomUnbury {
  constructor(private room: Room) {}

  private acc = 0;
  private logN = 0;

  tick(dt: number): void {
    if (!this.room.field) {return;}
    this.acc += dt;
    if (this.acc < 0.5) {return;}
    this.acc = 0;
    this.sweep();
  }

  /** The room's real field landed (attachTerrain) - seats picked before
   *  it resolved kept authored anchor y (groundAt read 0/stale), leaving
   *  bodies meters under the surface the client will draw. One sweep,
   *  including seats that never reported: a server-picked spawn under
   *  the real terrain is our bug to lift, not a claim to honor. */
  seats(): void {
    if (!this.room.field) {return;}
    this.sweep(true);
  }

  private sweep(includeUnreported = false): void {
    if (!this.room.field) {return;}
    for (const p of this.room.players.getAllPlayers().values()) {
      this.check(p, includeUnreported);
    }
  }

  /** One body's ground-law check. Measure with the shadow's own eye when
   *  one exists - the class capsule and the sim body disagree whenever a
   *  refit left the sim at the default eye, and the record's view was the
   *  stale one. Judge each body on the floor it sims on: bot shadows ride
   *  the chord-augmented surface (what remotes draw), human shadows the
   *  plain field - a field-grounded human in a gully is legitimately
   *  under the drawn chord, and popping their claim is a phantom
   *  correction. Remote-side render lift owns the visual clearance.
   *  pos.y IS the eye point - "feet" would double-subtract the eye and
   *  phantom-bury every banded contact (a grounded heavy legally rides
   *  its eye ~0.5 under the floor in the snap window). Buried means the
   *  EYE itself is below the surface. */
  private check(p: PlayerState, includeUnreported: boolean): void {
    const { room } = this;
    const { field } = room;
    if (!field) {return;}
    if (p.isDead || (!p.isBot && !p.hasReceivedPosition && !includeUnreported)) {return;}
    const eye = room.moveSim.eyeOf(p.id) ?? classCapsule(p.armorClass as ArmorClass).eye;
    const terrain = p.isBot
      ? Math.max(hmHeight(field, p.position.x, p.position.z), hmChord(field, p.position.x, p.position.z))
      : hmHeight(field, p.position.x, p.position.z);
    // The ground law as an invariant - scoped to sim-owned bodies.
    // A bot's record mirrors its shadow every tick (botDrive), so a
    // buried bot record IS a violation. Human records are claims -
    // a lagged claim under the surface is lag, not a bug.
    if (p.isBot) {inv('bot-below-ground', !Number.isFinite(terrain) || p.position.y >= terrain - 0.5,
      { id: p.id, xz: `${p.position.x.toFixed(1)},${p.position.z.toFixed(1)}`, y: Number(p.position.y.toFixed(1)), eye, terrain: Number.isFinite(terrain) ? Number(terrain.toFixed(1)) : 'n/a', dbg: room.moveSim.unburyDebug(p.id) });}
    if (!Number.isFinite(terrain) || p.position.y >= terrain - 0.5) {return;}
    // First rescues carry the autopsy at debug level - the 'unbury'
    // health counter and the bot-scoped inv above are the loud signal;
    // a warn per rescue reads as jank in soak asserts while routine
    // claim wobble is legitimately rescued.
    if (((this.logN += 1) - 1) < 30) {
      logger.debug(`unbury ${p.id}: pos.y=${p.position.y.toFixed(1)} feet=${(p.position.y - eye).toFixed(1)} terrain=${terrain.toFixed(1)} bot=${p.isBot} ${room.moveSim.unburyDebug(p.id)}`);
    }
    const lift = terrain + eye - p.position.y;
    p.position.y = terrain + eye;
    p.velocity.y = Math.max(0, p.velocity.y);
    room.moveSim.resync(p.id, p.position, p.rotation.yaw);
    room.healthBump('unbury');
    // A big rescue is an instant server-side repositioning - undeclared,
    // the client interp reads it as an impossible wire jump (the 10-14m
    // dbgwire-jump population on heavy/medium bots that can't blink).
    // Declare past 6m; smaller lifts interp smoothly and never flag.
    // Bot-scoped: bot records are sim-owned truth, so a rescue IS a
    // server teleport. Human records are claims - the owner's next
    // report re-asserts truth, and a server-declared teleport of a
    // human body would fight the claim stream.
    if (lift > 6 && p.isBot) {
      console.log('[unburyprobe] lift=' + lift.toFixed(1) + ' id=' + p.id); console.log();
      room.broadcast(eventPayload(WORLD_MODEL.player!, 'teleport', 'playerId', p.id, { position: { x: p.position.x, y: p.position.y, z: p.position.z }, velocity: { x: p.velocity.x, y: p.velocity.y, z: p.velocity.z } }) as never);
    }
  }
}
