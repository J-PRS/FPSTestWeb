import * as THREE from 'three';
import * as sfx from '../core/sfx.js';
import { GameBot } from './botBrain.js';
import type { BotFire } from './botFire.js';
import { WeaponType } from '../../../shared/weapons.js';

type BoltHost = BotFire;
const _shotMuzzle = new THREE.Vector3();
const BOLT_MAT = new THREE.LineBasicMaterial({ color: 0xFFE08A, transparent: true, opacity: 0.9 });

// Bot tracer + claim-resolution family: resolveShot decides hit or miss,
// then these resolve the claim against the right target kind (local
// player, creature, or remote wire target) and draw the tracer.

export function claimShot(b: BoltHost, bot: GameBot, targetId: string, claim: { aim: THREE.Vector3; melee: boolean; dmg: number; weapon?: number }): void {
  const { aim, melee, dmg, weapon } = claim;
    // Arm the shooter's model: recoil kick + muzzle flash, and the
    // firing spine-lock that stops the stride roll waving the gun —
    // the claim path used to skip this, so local bots ran with a
    // permanently swaying torso even mid-firefight.
    bot.fire?.(weapon ?? (melee ? WeaponType.Melee : WeaponType.Disc));
    if (!melee) {
      spawnBolt(b, bot.position, aim);
      // The claim path never made sound before — beam/bolt shots at a
      // remote wire target were visually a tracer and audibly nothing.
      sfx.shotAt(_shotMuzzle.set(bot.position.x, bot.position.y + 1.4, bot.position.z), weapon ?? 0, bot.vel);
    }
    const src = `${bot.playerId.replace('bot:', '')} ${melee ? 'fist' : 'bolt'}`;
    if (targetId === 'local') { claimLocal(b, bot, aim, melee, dmg, src); return; }
    if (targetId.startsWith('creature:')) { claimCreature(b, bot, targetId, aim, dmg); return; }
    const rp = b.host.world().remotePlayers.get(targetId);
    if (rp instanceof GameBot && aim.distanceTo(rp.pos) < 1.6) {
      if (rp.takeDamageLocal(dmg, bot.position)) {b.host.botKilled(bot.playerId, rp, weapon);}
    }
  }

function claimLocal(b: BoltHost, bot: GameBot, aim: THREE.Vector3, melee: boolean, dmg: number, src: string): void {
    const p = b.host.player();
    if (!p.isDead && aim.distanceTo(p.pos) < 1.6) {
      b.host.hurtLocal(dmg, bot.position, src, melee, bot.playerId);
    }
  }

function claimCreature(b: BoltHost, bot: GameBot, targetId: string, aim: THREE.Vector3, dmg: number): void {
    const id = Number(targetId.slice(9));
    const t = b.host.targets.find(x => x.id === id);
    if (t && !t.dead && aim.distanceTo(t.pos) < t.radius + 1) {
      if (b.host.damageCreature(t.id, dmg, bot.playerId)) {b.host.creditKill(bot.playerId, true);}
    }
  }

function spawnBolt(b: BoltHost, from: THREE.Vector3, to: THREE.Vector3): void {
    let line = b.boltPool.pop();
    if (!line) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      line = new THREE.Line(g, BOLT_MAT);
    }
    const a = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    a.setXYZ(0, from.x, from.y, from.z);
    a.setXYZ(1, to.x, to.y, to.z);
    a.needsUpdate = true;
    b.host.scene().add(line);
    b.bolts.push({ line, t: 0.12 });
  }

export function tickBolts(h: BoltHost, dt: number): void {
    for (let i = h.bolts.length - 1; i >= 0; i--) {
      const tr = h.bolts[i];
      tr.t -= dt;
      if (tr.t <= 0) {
        h.host.scene().remove(tr.line);
        h.boltPool.push(tr.line);
        h.bolts[i] = h.bolts[h.bolts.length - 1];
        h.bolts.pop();
      }
    }
  }

export function disposeBolts(h: BoltHost): void {
    for (const tr of h.bolts) {h.host.scene().remove(tr.line);}
    h.bolts.length = 0;
    for (const l of h.boltPool) {l.geometry.dispose();}
    h.boltPool.length = 0;
  }

