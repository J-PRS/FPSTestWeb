import { it, expect } from 'bun:test';
import { mkRoom, step, pin } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { BotLoadout } from '../../../shared/botLoadouts.ts';

it('melee probe: who punches from far?', () => {
  const room = mkRoom({ mode: 'dm', bots: 6, botSkill: 'impossible', arena: { x: 0, z: 0, radius: 300 } }, 'dm', 201, false);
  const combat = room.messages.combat as unknown as {
    botAttack(s: string, t: string, w: number, air?: number, sid?: string): void;
  };
  const orig = combat.botAttack.bind(combat);
  const far = new Map<string, number>();
  let calls = 0, applied = 0;
  const { hitLedger } = (room.messages.combat as unknown as { hitLedger: { applyHit(c: unknown, s: string, t: string, d: number, r: { killed: boolean }, o: { weapon?: number; label?: string }): unknown } });
  const origHit = hitLedger.applyHit.bind(hitLedger);
  hitLedger.applyHit = (c, s, t, dmg, r, o) => {
    if (o.weapon === WeaponType.Melee) {
      const sp = room.players.getPlayer(s), tp = room.players.getPlayer(t);
      if (sp && tp) {
        const d = Math.hypot(tp.position.x - sp.position.x, tp.position.y - sp.position.y, tp.position.z - sp.position.z);
        if (d > 6) {far.set(t, (far.get(t) ?? 0) + 1); console.log(`MELEE-FAR-APPLIED ${s}->${t} d=${d.toFixed(1)}m`);}
        applied++;
      }
    }
    return origHit(c, s, t, dmg, r, o);
  };
  combat.botAttack = (s, t, w, air, sid) => { if (w === WeaponType.Melee) {calls++;} return orig(s, t, w, air, sid); };
  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  // Mixed loadouts incl. knife-hungry brawlers
  for (let i = 0; i < bots.length; i++) {
    const a = (i / bots.length) * Math.PI * 2;
    pin(room, bots[i]!.id, { x: Math.cos(a) * 60, y: 32, z: Math.sin(a) * 60 });
  }
  const deadSince = new Map<string, number>();
  for (let i = 0; i < 12000; i++) {
    step(room, 1);
    for (const p of bots) {
      if (p.isDead) {
        const n = (deadSince.get(p.id) ?? 0) + 0.05;
        if (n >= 3) {deadSince.delete(p.id); room.players.respawnPlayer(p.id); pin(room, p.id, { x: (Math.random() - 0.5) * 200, y: 32, z: (Math.random() - 0.5) * 200 });}
        else {deadSince.set(p.id, n);}
      } else {deadSince.delete(p.id);}
    }
  }
  console.log(`melee calls=${calls} applied=${applied} far-applied=${[...far.values()].reduce((a, b) => a + b, 0)}`);
  expect([...far.values()].reduce((a, b) => a + b, 0)).toBe(0);
});
