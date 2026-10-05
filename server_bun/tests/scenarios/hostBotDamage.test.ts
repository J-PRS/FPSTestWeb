import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer, twoPlayers, pin, watch } from './harness.ts';
import { validateMessage } from '../../src/wire.ts';

// Host-simmed team bots ('bot:*') hurt the local player via the
// environmentDamage claim channel with an attacker tag. Server-side
// BOT-* sims don't take this path — this is the connected-session lane
// that used to write client health locally and get stomped by the
// yourHealth echo.

describe('scenario: host-bot damage claims', () => {
  it('validator passes attacker through — the tag must survive the gate', () => {
    // Regression: the validator used to return only {amount}, silently
    // dropping attacker before CombatHandler ever saw it — bot kills
    // credited 'environment' and melee was clamped to the creature cap.
    const ok = validateMessage({ type: 'environmentDamage', amount: 18, attacker: 'bot:VEKTOR-A' });
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.type === 'environmentDamage') {
      expect(ok.data.attacker).toBe('bot:VEKTOR-A');
    }
  });

  it('validator drops hostile/garbage attacker strings', () => {
    for (const attacker of ['<script>', 'a'.repeat(64), 42, { id: 'x' }, 'kill;e All']) {
      const r = validateMessage({ type: 'environmentDamage', amount: 10, attacker });
      expect(r.success).toBe(true);
      if (r.success && r.data.type === 'environmentDamage') {
        expect(r.data.attacker).toBeUndefined();
      }
    }
  });

  it('bot melee lands at 60 — the attributed cap is 80, not the creature 40', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    p.health = 100;

    room.messages.handleMessage(p.id, { type: 'environmentDamage', amount: 60, attacker: 'bot:MARA-B' });
    expect(p.health).toBe(40); // full melee, not clamped to 40's worth
  });

  it('a bot kill credits the bot id, not "environment"', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    const w = watch(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    p.health = 50;

    room.messages.handleMessage(p.id, { type: 'environmentDamage', amount: 60, attacker: 'bot:SLATE-A' });
    const kill = w.msgs.find((m) => m.type === 'playerKill');
    expect(kill).toBeDefined();
    expect((kill as { shooterId?: string }).shooterId).toBe('bot:SLATE-A');
    expect(p.isDead).toBe(true);
  });

  it('a forged attacker id too far away is stripped — no cross-map kill credit', () => {
    const room = mkRoom({ bots: 2 });
    const [victim, forged] = twoPlayers(room);
    const w = watch(room);
    pin(room, victim.id, { x: 0, y: 31, z: 0 });
    pin(room, forged.id, { x: 400, y: 31, z: 0 }); // couldn't have splashed the victim
    victim.health = 30;

    room.messages.handleMessage(victim.id, { type: 'environmentDamage', amount: 60, attacker: forged.id });
    const kill = w.msgs.find((m) => m.type === 'playerKill');
    expect(kill).toBeDefined();
    expect((kill as { shooterId?: string }).shooterId).toBe('environment');
  });

  it('a real nearby player id keeps its credit — victim-reported splash', () => {
    const room = mkRoom({ bots: 2 });
    const [victim, shooter] = twoPlayers(room);
    const w = watch(room);
    pin(room, victim.id, { x: 0, y: 31, z: 0 });
    pin(room, shooter.id, { x: 30, y: 31, z: 0 });
    victim.health = 50;

    room.messages.handleMessage(victim.id, { type: 'environmentDamage', amount: 60, attacker: shooter.id });
    const kill = w.msgs.find((m) => m.type === 'playerKill');
    expect((kill as { shooterId?: string }).shooterId).toBe(shooter.id);
  });

  it('untagged claims still clamp at 40 — no smuggling bot damage through the creature lane', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    p.health = 100;

    room.messages.handleMessage(p.id, { type: 'environmentDamage', amount: 80 });
    expect(p.health).toBe(60);
  });
});
