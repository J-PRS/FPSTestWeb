import * as THREE from 'three';

import { WeaponType, CONC_JET_DRAIN, getWeaponStats } from '../../../../shared/weapons.js';
import { TEAM_COLORS, type TeamId } from '../../../../shared/teams.js';
import * as sfx from '../../core/sfx.js';
import { PlayerDebris } from '../../effects/debris.js';
import { lifestealBurst } from '../../effects/vfx.js';
import { killTaunt, deathTaunt, comboTailFor, comboCutDelayMs, chatter, noteFrag, bulliedBy } from '../../../../shared/botTaunts.js';
import { tauntRand } from '../../../../shared/botRand.js';
import { chatSink } from '../chat.js';
import { ATLAS_BLACK } from '../../entities/PlayerModel.js';

const _gibBlack = new THREE.Color(0x11_11_11); // same convention as playerKill - colored = alive marker
import { noteKill } from '../../core/stateDebug.js';
import { GameBot } from './botBrain.js';
import type { TeamBots } from './index.js';
import { simRand } from '../../../../shared/simRand.js';
import { gunGameOnKill, gunRungOf } from '../gunGame.js';
import { igunChassis } from '../../../../shared/gunGame.js';

const _stealPos = new THREE.Vector3();
const sayTimers = new Set<ReturnType<typeof setTimeout>>();

/** Gun-game rung edge → weapon swap: the local armory band or every
 *  weapon slot on the named bot's loadout (belt pinned to the hook -
 *  the only belt item the ladder gate lets fire). */
function applyGunRung(b: TeamBots, id: string, wt: WeaponType): void {
  if (id === 'local') {b.deps.lazyPlayer().armory.setGunGameRung(gunRungOf(b.deps.world, id), wt); return;}
  const kb = b.bots.find((x): boolean => x.playerId === id);
  if (kb?.loadout) {
    kb.loadout.near = wt; kb.loadout.mid = wt; kb.loadout.far = wt; kb.loadout.side = wt;
    kb.loadout.belt = WeaponType.Hook;
    if (b.deps.world.igun === true) {kb.setBotClass(igunChassis(wt));}
  }
}

// Kill + respawn bookkeeping - the local-authority half of fragging:
// bot respawns, player→bot hit funnel, the local player's own death.
// botMatch.ts owns scores/flags; this file owns the bodies.

/** Re-seat a dead bot on the spawn ring - shared by the respawn timer
 *  and match reset (same spot-finding, hp, and gizmo re-tint). */
export function respawnBotF(b: TeamBots, bot: GameBot): void {
    // Spawn anchors come from the map spec when authored (teamSpawns >
    // spawns); spec-less modes fall back to the ring around the player.
    const sp = b.spawnSpot(bot.team);
    // Kit drift before the body comes back - the skill matrix rerolls
    // each open slot toward what this bot actually hits with. Kit-lock
    // rooms field fixed weapons; a reroll would arm contraband.
    if (!b.deps.world.instagib && !b.deps.world.gungame) {bot.adaptLoadout();}
    bot.respawn({ x: sp.x, y: sp.y, z: sp.z });
    bot.botHp = bot.botMaxHp;
    // Fresh life is unproven - the meter re-earns it each spawn.
    bot.sheep = 100;
    bot.sheepShown = 100;
    b.sheep.clear(bot.playerId);
    bot.show();
    bot.setGizmoColor(bot.team === 'ffa' ? 0xCC_66_FF : TEAM_COLORS[bot.team as TeamId]);
  }

/** A bot's line lands a beat after the frag like a typed reply - the
 *  same delay envelope the server killfeed uses over the wire. */
export function botSay(id: string, line: string | null, vgs?: string, team?: boolean): void {
    if (!line) {return;}
    const name = id.replace('bot:', '');
    const delay = 1200 + simRand() * 1800;
    // Chatter is transient like debris/audio - while hidden the timers
    // still fire but nothing queues, so alt-tab returns to a live feed,
    // not a burst of stale taunts (same rule the fx classes follow).
    const t = setTimeout((): void => { sayTimers.delete(t); if (!document.hidden) {chatSink.add?.(name, line, team, vgs);} }, delay);
    sayTimers.add(t);
    // VGS-combo intent - a rare second chord timed to hard-cut the first
    // sample mid-word ("I am the- SHAZBOT!"). Tails are global-scope
    // chords, so they land wherever the starter did.
    const tail = vgs ? comboTailFor(vgs) : undefined;
    if (tail) {
      const cut = setTimeout((): void => { sayTimers.delete(cut); if (!document.hidden) {chatSink.add?.(name, tail.text, false, tail.chord);} }, delay + comboCutDelayMs(line));
      sayTimers.add(cut);
    }
  }



/** Shared local-hit funnel: trigger-time claims and real bot-shell
 *  impacts land here - damage, knockback, death feed + credit. */
export function hurtLocal(b: TeamBots, dmg: number, fromPos: THREE.Vector3, attackerId: string, opts: { src: string; melee?: boolean; weapon?: number; air?: number }): void {
    const p = b.deps.lazyPlayer();
    if (p.isDead) {return;}
    p.lastDamageSource = opts.src;
    // An explosive hit detonates this same frame - the blast pays the
    // T1 shove, which is the ONLY displacement the server grants a
    // direct-hit victim (impulseOnly). A flat knock on top double-shoves
    // offline AND online (predicted blast + this knock + the deduped
    // wire echo read as a blink). Blastless hits (bolts, melee) keep it.
    const blastPays = opts.weapon !== undefined && getWeaponStats(opts.weapon).aoeRadius > 0;
    const knock = (): void => { if (!blastPays) {p.applyKnockback(fromPos, (opts.melee ? 6 : 4) * p.mods.knockbackTaken);} };
    // Connected room: health is server truth. A local write gets stomped
    // by the next yourHealth echo - report through the self-damage channel
    // (same as creature melee) and let the wire echo apply it. Feedback
    // stays local so the hit still reads instantly.
    if (b.deps.lazyNetworkManager?.()?.isConnected()) {
      knock();
      b.deps.lazyHud().showDamage(fromPos, dmg);
      sfx.playerHurt();
      b.deps.lazyNetworkManager().sendEnvironmentDamage(dmg, attackerId);
      return;
    }
    p.health = Math.max(0, p.health - dmg);
    b.creditDamage(attackerId, 'local', dmg); // offline CTF dmg economy
    knock();
    b.deps.lazyHud().showDamage(fromPos, dmg);
    sfx.playerHurt();
    if (p.health > 0) {return;}
    b.deps.world.killCounts.set(attackerId, (b.deps.world.killCounts.get(attackerId) ?? 0) + 1);
    b.creditKill(attackerId, false, p.pos);
    gunGameOnKill(b.deps.world, 'local', attackerId, applyGunRung.bind(null, b));
    b.localDied();
    noteKill(attackerId, 'local', opts.weapon ?? (opts.melee ? WeaponType.Melee : undefined));
    b.hooks.killFeed(attackerId.replace('bot:', ''), 'YOU', false, true,
      { shooter: b.teamOf.get(attackerId), target: b.teamOf.get('local'), weapon: opts.weapon, air: opts.air });
    const kt = killTaunt(attackerId, 'YOU');
    botSay(attackerId, kt?.text ?? null, kt?.vgs);
    b.hooks.localPlayerKilled(attackerId.replace('bot:', ''));
  }

export function botKilledF(b: TeamBots, killerId: string, bot: GameBot, weapon?: number, air?: number): void {
    // Full-gib for every kill for now - the model hides as its baked
    // chunk geos fly; respawn restores on the next life.
    const t = bot.team;
    // Kill-zone memory - the brain remembers where this life ended so
    // the next one routes around it (server feeds the same mark).
    bot.markDeath(bot.position, performance.now());
    bot.hide();
    // Past ~120m real body parts read as generic shards anyway - take
    // the instanced path (mesh-path gibs are ~20 materials + matrix
    // writes each, the pdebris spike under throttle).
    const cam = b.deps.lazyCamera().position;
    const gdx = bot.position.x - cam.x, gdy = bot.position.y + 1 - cam.y, gdz = bot.position.z - cam.z;
    let parts: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] | undefined = undefined;
    if (gdx * gdx + gdy * gdy + gdz * gdz < 120 * 120) {
      try { parts = bot.model.deathParts() ?? undefined; }
      catch { /* fall through to generic shards */ }
    }
    b.deps.world.playerDebrisList.push(new PlayerDebris(
      b.deps.lazyScene(), b.deps.lazyTerrain(),
      { x: bot.position.x, y: bot.position.y + 1, z: bot.position.z },
      ATLAS_BLACK ? _gibBlack : new THREE.Color(t === 'alpha' || t === 'bravo' ? TEAM_COLORS[t] : 0xCC_66_FF),
      { inheritVel: bot.vel, parts },
    ));
    // Kills drop loot - headhunt scatters the carrier's held tokens
    // (+1 corpse bounty) in denomination coins; other team modes drop 3
    // nuggets so a death feeds the economy, not just pain.
    if (b.mode === 'headhunt') {b.scatterTokens(bot.playerId, bot.position, bot.vel, 1);}
    else if (!b.spec.ffa) {b.hooks.dropNuggets(bot.position, 3, bot.vel);}
    b.deps.world.killCounts.set(killerId, (b.deps.world.killCounts.get(killerId) ?? 0) + 1);
    b.deps.world.deathCounts.set(bot.playerId, (b.deps.world.deathCounts.get(bot.playerId) ?? 0) + 1);
    b.creditKill(killerId, false, bot.position);
    gunGameOnKill(b.deps.world, bot.playerId, killerId, applyGunRung.bind(null, b));
    // Lifesteal - the server's creditKill rule mirrored for local
    // authority: a melee frag refills the killer's pool, a lance frag half.
    const stealFrac = weapon === WeaponType.Melee ? 1 : weapon === WeaponType.Shocklance ? 0.5 : 0;
    if (stealFrac > 0) {
      if (killerId === 'local') {
        const p = b.deps.lazyPlayer();
        if (p.mods.meleeHeal > 0) {
          p.health = Math.min(p.maxHealth, p.health + p.maxHealth * p.mods.meleeHeal * stealFrac);
          _stealPos.copy(p.pos); _stealPos.y -= 0.4; lifestealBurst(_stealPos);
        }
      } else {
        const kb = b.bots.find((x): boolean => x.playerId === killerId);
        const mh = kb?.perkMods.meleeHeal ?? 0;
        if (kb && mh > 0) {
          kb.heal(kb.botMaxHp * mh * stealFrac);
          _stealPos.copy(kb.position); _stealPos.y -= 0.4; lifestealBurst(_stealPos);
        }
      }
    }
    b.ctf?.dropCarried(bot.playerId, bot.position);
    // Rabbit: every corpse is a flag event - first kill spawns it, a
    // rabbit's death drops it loose. Local deaths ride localDied().
    b.rabbit?.onDeath(bot.playerId, bot.position);
    killChatter(b, killerId, bot, weapon, air);
  }



/** Conc payload - the server's splashOne drops the carrier on ANY conc
 *  blast that lands damage AND saps the victim's jets; local authority
 *  runs the same rule. Returns whether the payload landed (caller applies
 *  the tank drain - player and bot energy fields differ in shape).
 *  The dead already drop theirs via botKilledF/localDied. */
function concStrip(b: TeamBots, playerId: string, dmg: number, weapon: number | undefined, at: THREE.Vector3): boolean {
    if (weapon !== WeaponType.Concussion || dmg < 1) {return false;}
    b.ctf?.dropCarried(playerId, at);
    return true;
}



/** Player/explosion damage routed here when the victim is a bot -
 *  combat consults `hit` before predictDamage. A bot shell can also
 *  hit 'local' (sweepLocal) - that resolves through the same funnel. */
export function hitF(b: TeamBots, playerId: string, dmg: number, fromPos: THREE.Vector3, attackerId = 'local', meta?: { weapon?: number; air?: number }): boolean {
    const { weapon, air } = meta ?? {};
    // Local authority has to enforce the same friendly gate the server's
    // CombatHandler does - without it P2P-host/offline kills teammates.
    const aTeam = b.teamOf.get(attackerId), vTeam = b.teamOf.get(playerId);
    if (attackerId !== playerId && aTeam && aTeam === vTeam) {return true;} // claim swallowed, like a server reject
    // Rabbit: while a carrier exists, only pairs involving the rabbit
    // (or a bottom feeder) resolve - same gate the server applies.
    if (b.rabbit?.blocks(attackerId, playerId, b.bottomFeeders())) {return true;}
    if (playerId === 'local') {
      hurtLocal(b, dmg, fromPos, attackerId, { src: attackerId.replace('bot:', ''), weapon, air });
      if (concStrip(b, playerId, dmg, weapon, b.deps.lazyPlayer().pos)) {
        const p = b.deps.lazyPlayer();
        p.energy = Math.max(0, p.energy - CONC_JET_DRAIN); // the escape tax - jets sputter
      }
      return true;
    }
    const rp = b.deps.world.remotePlayers.get(playerId);
    if (!(rp instanceof GameBot)) {return false;}
    b.creditDamage(attackerId, playerId, dmg); // bot victim - attacker banks chip
    const died = rp.takeDamageLocal(dmg, fromPos, attackerId);
    b.deps.lazyHealthBarSystem().spawn(playerId, dmg, died ? 0 : rp.botHp);
    if (!died && concStrip(b, playerId, dmg, weapon, rp.position)) {
      rp.energy = Math.max(0, rp.energy - CONC_JET_DRAIN);
    }
    if (died) {botKilledF(b, attackerId, rp, weapon, air);}
    return true;
}

/** In-flight taunt timers - tracked so match teardown can drain them:
 *  the feed outlives the match, and a dead match's bots must not taunt
 *  into the next room's chat (killFeed does the same on the server). */

/** Match teardown - a queued taunt from a disposed roster is a dead id
 *  speaking; drop it rather than let it read as live room traffic. */
export function botSayDrain(): void {
    for (const t of sayTimers) {clearTimeout(t);}
    sayTimers.clear();
}

/** Feed row + taunts + the local-player frag banner - all the "tell the
 *  humans a kill happened" work of botKilledF. */
function killChatter(b: TeamBots, killerId: string, bot: GameBot, weapon?: number, air?: number): void {
    // kn = killer's display name (the {t} of death/props lines),
    // vn = victim's (the {v} of kill lines) - passing kn to killTaunt
    // once made a bot name himself as the fragged one.
    const kn = killerId === 'local' ? 'YOU' : killerId.replace('bot:', '');
    const vn = bot.playerId.replace('bot:', '');
    noteKill(killerId === 'local' ? 'local' : killerId, bot.playerId, weapon);
    noteFrag(killerId, bot.playerId); // the one-sided ledger - bully check reads it below
    b.hooks.killFeed(kn, vn, killerId === 'local', false,
      { shooter: b.teamOf.get(killerId), target: bot.team, weapon, air });
    // A long-airtime explosive shell = the brag kill (server killFeed's
    // skillKill, mirrored) - the killer may hype it, the victim may
    // give props, and a quiet killer can close the beat with thanks.
    const skill = (air ?? 0) >= 0.5 && weapon != null && (getWeaponStats(weapon)?.aoeRadius ?? 0) > 0;
    if (killerId !== 'local') {
      if (skill) {
        const c = chatter('air', killerId, vn);
        botSay(killerId, c?.text ?? null, c?.vgs);
      } else {
        const kt = killTaunt(killerId, vn);
        botSay(killerId, kt?.text ?? null, kt?.vgs);
      }
    }
    const dStreak = (b.deathStreak.get(bot.playerId) ?? 0) + 1;
    b.deathStreak.set(bot.playerId, dStreak);
    if (bulliedBy(bot.playerId, killerId)) {
      const c = chatter('bully', bot.playerId, kn);
      botSay(bot.playerId, c?.text ?? null, c?.vgs, c?.team);
    } else if (dStreak >= 3) {
      const c = chatter('tilt', bot.playerId, kn); // three unanswered deaths - server's victimLine order
      botSay(bot.playerId, c?.text ?? null, c?.vgs, c?.team);
    } else {
      // Same qualification roll as the server's hardShot: air-lobs earn
      // props more often, routine deaths mostly stay quiet.
      const qual = skill || Math.abs(bot.vel.y) > 10;
      const c = qual && tauntRand() < (skill ? 0.7 : 0.45)
        ? chatter('props', bot.playerId, kn) : null;
      if (c) {
        botSay(bot.playerId, c.text, c.vgs, c.team);
        if (killerId !== 'local' && tauntRand() < 0.5) {
          setTimeout((): void => { // the thanks beat - only lands if the killer didn't gloat
            const t = chatter('thanks', killerId, vn);
            botSay(killerId, t?.text ?? null, t?.vgs, t?.team);
          }, 2500 + tauntRand() * 2000);
        }
      } else {
        const dt = deathTaunt(bot.playerId, kn);
        botSay(bot.playerId, dt?.text ?? null, dt?.vgs);
      }
    }
    if (killerId === 'local') {
      // Same center headline the wire path (onPlayerKill) gives connected
      // frags - offline kills were feed-row-only and read as no credit.
      b.hooks.fragBanner?.(`FRAGGED ${bot.playerId.replace('bot:', '')}!`);
      sfx.killConfirm();
    }
  }



