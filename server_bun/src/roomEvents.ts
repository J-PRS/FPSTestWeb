/**
 * RoomEvents - the room's domain-event channel. Notifications that used
 * to live as five separate optional hooks on RoomInfo/CombatDeps
 * (onKill/onHit/onFire/onBotSpoke/onChat) are one typed stream now:
 * producers emit, the Room fans out to subscribers. New consumers
 * (influence writes, match journal, spectate feeds) subscribe without
 * another bespoke hook on the grab-bag interface.
 *
 * Events are notifications only - commands and queries (move claims,
 * claim verdicts, snapshot suppliers) stay direct calls; an event
 * never carries a verdict back to its producer.
 */
import type { Vec3 } from './types.ts';

export type RoomEvent =
  | { type: 'kill'; targetId: string; shooterId: string; weapon?: number }
  | { type: 'hit'; targetId: string; shooterId: string; damage: number }
  | { type: 'fire'; playerId: string }
  // Bot trigger pulls - the human path emits 'fire' per shot; bots go
  // through the arsenal and emit nothing, which left per-bot accuracy
  // (hits/shots) unmeasurable. Sweeps subscribe to attribute shots.
  | { type: 'botShot'; id: string; weapon: number }
  | { type: 'botSpoke'; id: string; vgs?: string }
  | { type: 'chat'; id: string; text: string; vgs?: string }
  // Blast aftermath notifications - what a resolved explosion did to the
  // non-player world. Producers emit once per blast; the Room fans out to
  // whichever subsystems care (deployables eat splash, dropped flags punt,
  // loose pickups punt, wildlife takes splash, armor-nades plate sims).
  | { type: 'blast'; pos: Vec3; damage: number; radius: number; shooterId: string; scales?: readonly number[]; weapon?: number; splash?: number }
  | { type: 'knock'; pos: Vec3; radius: number; force: number; kind: 'flag' | 'pickup' | 'prey'; pull?: boolean }
  | { type: 'preySplash'; ownerId: string; pos: Vec3; radius: number; maxDamage: number }
  // Melee intent aftermath: the swing is server-derived (rewound pos +
  // aim dir), so the creature cone pays here - the client predicts the
  // contact and never claims it.
  | { type: 'meleeSweep'; playerId: string; pos: Vec3; dir: Vec3 }
  | { type: 'armor'; pos: Vec3; amount: number; radius: number }
  // Player-world notifications without a verdict - the shadow sim gets
  // the same impulse the blast applied; a conc'd carrier drops the flag.
  | { type: 'impulse'; playerId: string; dv: Vec3; fallBoost?: number }
  | { type: 'flagDrop'; playerId: string };

export type RoomEventSink = (e: RoomEvent) => void;

/** Minimal fan-out - subscribers run in subscribe order; a throwing
 *  subscriber doesn't take the rest of the room down. */
export class EventBus {
  private subs = new Set<RoomEventSink>();
  on(cb: RoomEventSink): () => void {
    this.subs.add(cb);
    return (): boolean => this.subs.delete(cb);
  }
  readonly emit: RoomEventSink = (e): void => {
    for (const cb of this.subs) {
      // oxlint-disable-next-line no-console
      try { cb(e); } catch (error) { console.error('[EventBus] subscriber threw', error); }
    }
  };
}
