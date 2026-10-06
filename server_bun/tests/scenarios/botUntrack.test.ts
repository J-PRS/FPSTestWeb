import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

interface BotsPeek {
  untrack(id: string): void;
  brains: Map<string, unknown>;
  loadouts: Map<string, unknown>;
  foeNear: Map<string, unknown>;
  lastOut: Map<string, unknown>;
  thinkPhase: Map<string, unknown>;
}

// ServerBots.untrack is the single funnel every bot-keyed map drains
// through — a retired bot must leave zero per-bot state behind or the
// maps grow with cumulative churn.
describe('scenario: bot untrack purges all per-bot state', () => {
  it('untrack empties the bot\'s entries in every map', () => {
    const room = mkRoom({ bots: 2 });
    const p = firstPlayer(room);
    const bots = room.bots as unknown as BotsPeek;
    expect(bots.brains.has(p.id)).toBe(true);

    bots.untrack(p.id);
    for (const m of [bots.brains, bots.loadouts, bots.foeNear, bots.lastOut, bots.thinkPhase]) {
      expect(m.has(p.id)).toBe(false);
    }
  });
});
