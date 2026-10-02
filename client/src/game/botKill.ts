import * as THREE from 'three';

import { EYE } from './botBrain.js';
import { WeaponType } from '../../../shared/weapons.js';
import { TEAM_COLORS, type TeamId } from '../../../shared/teams.js';
import * as sfx from '../core/sfx.js';
import { PlayerDebris } from '../effects/debris.js';
import { killTaunt, deathTaunt } from '../../../shared/botTaunts.js';
import { chatSink } from './chat.js';
import { noteKill } from '../core/stateDebug.js';
import { GameBot } from './botBrain.js';
import type { TeamBots } from './bots.js';

// Kill + respawn bookkeeping — the local-authority half of fragging:
// bot respawns, player→bot hit funnel, the local player's own death.
// botMatch.ts owns scores/flags; this file owns the bodies.

/** Re-seat a dead bot on the spawn ring — shared by the respawn timer
 *  and match reset (same spot-finding, hp, and gizmo re-tint). */
export function respawnBotF(b: TeamBots, bot: GameBot): void {
    const player = b.deps.lazyPlayer();
    const terrain = b.deps.lazyTerrain();
    const a = Math.random() * Math.PI * 2;
    const sp = new THREE.Vector3(player.pos.x + Math.cos(a) * 50, 0, player.pos.z + Math.sin(a) * 50);
    sp.y = terrain.getHeight(sp.x, sp.z) + EYE;
    bot.respawn({ x: sp.x, y: sp.y, z: sp.z });
    bot.botHp = bot.botMaxHp;
    // Fresh life is unproven — the meter re-earns it each spawn.
    bot.sheep = 100;
    bot.sheepShown = 100;
    b.sheep.clear(bot.playerId);
    bot.show();
    bot.setGizmoColor(bot.team === 'ffa' ? 0xcc66ff : TEAM_COLORS[bot.team as TeamId]);
  }

/** Shared local-hit funnel: trigger-time claims and real bot-shell
 *  impacts land here — damage, knockback, death feed + credit. */
export function hurtLocal(b: TeamBots, dmg: number, fromPos: THREE.Vector3, attackerId: string, opts: { src: string; melee?: boolean; weapon?: number }): void {
    const p = b.deps.lazyPlayer();
    if (p.isDead) return;
    p.lastDamageSource = opts.src;
    // Connected room: health is server truth. A local write gets stomped
    // by the next yourHealth echo — report through the self-damage channel
    // (same as creature melee) and let the wire echo apply it. Feedback
    // stays local so the hit still reads instantly.
    if (b.deps.lazyNetworkManager?.()?.isConnected()) {
      p.applyKnockback(fromPos, (opts.melee ? 6 : 4) * p.mods.knockbackTaken);
      b.deps.lazyHud().showDamage(fromPos, dmg);
      sfx.playerHurt();
      b.deps.lazyNetworkManager().sendEnvironmentDamage(dmg, attackerId);
      return;
    }
    p.health = Math.max(0, p.health - dmg);
    p.applyKnockback(fromPos, (opts.melee ? 6 : 4) * p.mods.knockbackTaken);
    b.deps.lazyHud().showDamage(fromPos, dmg);
    sfx.playerHurt();
    if (p.health > 0) return;
    b.deps.world.killCounts.set(attackerId, (b.deps.world.killCounts.get(attackerId) ?? 0) + 1);
    b.creditKill(attackerId, false);
    b.localDied();
    noteKill(attackerId, 'local', opts.weapon ?? (opts.melee ? WeaponType.Melee : undefined));
    b.hooks.killFeed(attackerId.replace('bot:', ''), 'YOU', false, true);
    botSay(attackerId, killTaunt(attackerId, 'YOU'));
    b.hooks.localPlayerKilled(attackerId.replace('bot:', ''));
  }

/** Player/explosion damage routed here when the victim is a bot —
 *  combat consults `hit` before predictDamage. A bot shell can also
 *  hit 'local' (sweepLocal) — that resolves through the same funnel. */
export function hitF(b: TeamBots, playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId = 'local', weapon?: number): boolean {
    // Local authority has to enforce the same friendly gate the server's
    // CombatHandler does — without it P2P-host/offline kills teammates.
    const aTeam = b.teamOf.get(attackerId), vTeam = b.teamOf.get(playerId);
    if (attackerId !== playerId && aTeam && aTeam === vTeam) return true; // claim swallowed, like a server reject
    if (playerId === 'local') {
      hurtLocal(b, dmg, fromPos, attackerId, { src: attackerId.replace('bot:', ''), weapon });
      return true;
    }
    const rp = b.deps.world.remotePlayers.get(playerId);
    if (!(rp instanceof GameBot)) return false;
    const died = rp.takeDamageLocal(dmg, fromPos);
    b.deps.lazyHealthBarSystem().spawn(playerId, dmg, died ? 0 : rp.botHp);
    if (died) botKilledF(b, attackerId, rp, weapon);
    return true;
  }

/** A bot's line lands a beat after the frag like a typed reply — the
 *  same delay envelope the server killfeed uses over the wire. */
export function botSay(id: string, line: string | null, vgs?: string, team?: boolean): void {
    if (!line) return;
    const name = id.replace('bot:', '');
    setTimeout(() => chatSink.add?.(name, line, team, vgs), 1200 + Math.random() * 1800);
  }

export function botKilledF(b: TeamBots, killerId: string, bot: GameBot, weapon?: number): void {
    // Same shatter as wire remotes — the corpse pops into team-colored
    // shards instead of just shrinking away.
    const t = bot.team;
    // Past ~120m real body parts read as generic shards anyway — take
    // the instanced path (mesh-path gibs are ~20 materials + matrix
    // writes each, the pdebris spike under throttle).
    const cam = b.deps.lazyCamera().position;
    const gdx = bot.position.x - cam.x, gdy = bot.position.y + 1.0 - cam.y, gdz = bot.position.z - cam.z;
    let parts: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] | undefined;
    if (gdx * gdx + gdy * gdy + gdz * gdz < 120 * 120) {
      try { parts = bot.model.deathParts() ?? undefined; }
      catch { /* fall through to generic shards */ }
    }
    b.deps.world.playerDebrisList.push(new PlayerDebris(
      b.deps.lazyScene(), b.deps.lazyTerrain(),
      { x: bot.position.x, y: bot.position.y + 1.0, z: bot.position.z },
      new THREE.Color(t === 'alpha' || t === 'bravo' ? TEAM_COLORS[t] : 0xcc66ff),
      { inheritVel: bot.vel, parts },
    ));
    // Kills drop nuggets — bots feed the economy like everything else.
    if (!b.spec.ffa) b.hooks.dropNuggets(bot.position, 3, bot.vel);
    b.deps.world.killCounts.set(killerId, (b.deps.world.killCounts.get(killerId) ?? 0) + 1);
    b.creditKill(killerId, false);
    b.ctf?.dropCarried(bot.playerId, bot.position);
    const kn = killerId === 'local' ? 'YOU' : killerId.replace('bot:', '');
    noteKill(killerId === 'local' ? 'local' : killerId, bot.playerId, weapon);
    b.hooks.killFeed(kn, bot.playerId.replace('bot:', ''), killerId === 'local', false);
    if (killerId !== 'local') botSay(killerId, killTaunt(killerId, kn));
    botSay(bot.playerId, deathTaunt(bot.playerId, kn));
    if (killerId === 'local') {
      // Same center headline the wire path (onPlayerKill) gives connected
      // frags — offline kills were feed-row-only and read as no credit.
      b.hooks.fragBanner?.(`FRAGGED ${bot.playerId.replace('bot:', '')}!`);
      sfx.killConfirm();
    }
  }

