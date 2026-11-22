/**
 * RoomGunGame - the gun-game ladder: per-player rung state, rung-edge
 * roster weapon redeals, igun chassis sync, and the seat/reset/kill
 * edges. Room keeps thin delegates on the historical method names so
 * callers (CombatHandler, botArsenal, roomMatch, MessageHandler) stay
 * on `room.gunRungOf`-style access.
 */
import type { Room } from './Room.ts';
import { gunGameClimax, gunGameAllows, gunGameRoll } from '../../shared/gunGame.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

export class RoomGunGame {
  constructor(private room: Room) {}

  private get igun(): boolean { return this.room.mods.igun === true; }

  rungOf(playerId: string): number { return this.room.players.getPlayer(playerId)?.gunRung ?? 0; }

  /** The one weapon gate every gungame fire path consults: the rung's
   *  ladder weapon plus the Hook grapple (deals no damage - it can't
   *  farm rungs, and everyone keeps their traverse). */
  allowsFire(playerId: string, weaponType: number): boolean {
    return gunGameAllows(this.rungOf(playerId), weaponType, this.igun);
  }

  /** Bucket pick edge: a gungame fire claim names the member the player
   *  actually shouldered - roster weapon (remote viewmodel) and the igun
   *  chassis follow the real pick, not the bucket's first member. */
  held(playerId: string, weaponType: number): void {
    const p = this.room.players.getPlayer(playerId);
    if (!p || p.weapon === weaponType) {return;}
    p.weapon = weaponType;
    this.broadcastWeapon(playerId);
    this.igunClassSync(playerId);
  }

  /** Rung edge → wire + roster weapon. Only the owner needs the number:
   *  remotes read a player's gun off their own fires (p.weapon rides
   *  the roster), so the push goes to one socket. */
  setRung(playerId: string, rung: number): void {
    const r = Math.max(0, Math.min(gunGameClimax(this.igun), Math.floor(rung)));
    const p = this.room.players.getPlayer(playerId);
    if (!p || p.gunRung === r) {return;} // no edge = no redeal - a climax kill must not replay the swap
    p.gunRung = r;
    // Bucket roll: the rung deals one member - luck, not a pick. The wire
    // carries the draw so the client's locked band mirrors the same gun.
    p.weapon = gunGameRoll(r, this.igun, this.room.rng());
    this.broadcastWeapon(playerId);
    this.igunClassSync(playerId);
    this.room.sendToPlayer(playerId, { type: 'gunRung', rung: r, wt: p.weapon });
  }

  /** Roster `weapon` mid-life twin - remotes swap the hand prop to the
   *  dealt/picked gun without waiting for the first shot edge. */
  private broadcastWeapon(playerId: string): void {
    const wt = this.room.players.getPlayer(playerId)?.weapon;
    if (wt !== undefined) {this.room.broadcast({ type: 'weaponUpdate', playerId, weapon: wt } as ServerMessage);}
  }

  /** igun chassis edge: the body follows the rung weapon's tier. Humans
   *  ride applyClaimedClass (the claim arg is dead under igun anyway);
   *  bots ride the roster's applyClass so its health-delta bookkeeping
   *  and the `classes` map stay consistent. */
  private igunClassSync(playerId: string): void {
    if (!this.igun) {return;}
    const p = this.room.players.getPlayer(playerId);
    if (!p) {return;}
    if (p.isBot) {this.room.bots.syncIgunClass(playerId);}
    else {this.room.applyClaimedClass(playerId, '');}
  }

  /** Join/reclaim edge: seat the ladder rung - roster weapon + the owner
   *  push that locks the client's band. Call AFTER the handshake's
   *  gameState so the client's kit lock exists when the rung lands;
   *  reclaim re-reads the stored rung so a grace-window return keeps
   *  its climb. */
  seat(playerId: string): void {
    if (this.room.mods.gungame !== true) {return;}
    const p = this.room.players.getPlayer(playerId);
    if (!p) {return;}
    const r = p.gunRung ?? 0;
    p.weapon = gunGameRoll(r, this.igun, this.room.rng());
    this.broadcastWeapon(playerId);
    this.igunClassSync(playerId);
    this.room.sendToPlayer(playerId, { type: 'gunRung', rung: r, wt: p.weapon });
  }

  /** New match = fresh ladders: every seat back to rung 0 (roster weapon
   *  + owner push), then respawnAll lands bodies on the new spec. */
  reset(): void {
    if (this.room.mods.gungame !== true) {return;}
    for (const p of this.room.players.getAllPlayers().values()) {
      p.gunRung = 0;
      p.weapon = gunGameRoll(0, this.igun, this.room.rng());
      this.broadcastWeapon(p.id);
      this.igunClassSync(p.id);
      this.room.sendToPlayer(p.id, { type: 'gunRung', rung: 0, wt: p.weapon });
    }
  }

  /** Gun-game ladder edges off the shared kill bus: a player frag
   *  advances the shooter one rung (climax holds - frag count decides
   *  the match), the victim drops to rung 0. Environment/self kills
   *  move nobody. Every damage funnel emits 'kill', so shells, beams,
   *  melee and deployables all feed the ladder. */
  onKill(targetId: string, shooterId: string): void {
    if (this.room.mods.gungame !== true) {return;}
    if (this.room.players.getPlayer(targetId)) {this.setRung(targetId, 0);}
    if (shooterId === 'environment' || shooterId === targetId) {return;}
    if (this.room.players.getPlayer(shooterId)) {this.setRung(shooterId, this.rungOf(shooterId) + 1);}
  }
}
