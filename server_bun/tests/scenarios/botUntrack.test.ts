import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

interface BotsPeek {
  untrack(id: string): void;
  brains: Map<string, unknown>;
  loadouts: Map<string, unknown>;
  foeNear: Map<string, unknown>;
  lastOut: Map<string, unknown>;
  thinkPhase: Map<string, unknown>;
  gearLobT: Map<string, unknown>;
  suppressT: Map<string, unknown>;
  deadSet: Set<string>;
  quiet: Map<string, unknown>;
  skillOffAt: Map<string, unknown>;
  supportT: Map<string, unknown>;
  healBeamT: Map<string, unknown>;
  healNadeT: Map<string, unknown>;
  sense: {
    notices: { seen: Map<string, unknown> };
    routing: {
      routeHold: Map<string, unknown>;
      routeFailed: Map<string, unknown>;
      routePrefs: Map<string, unknown>;
      waitSpot: Map<string, unknown>;
    };
  };
  arsenal: {
    trigger: Map<string, unknown>;
    propelT: Map<string, unknown>;
    propelJetUntil: Map<string, unknown>;
    wasCarrying: Map<string, unknown>;
    lastShot: Map<string, unknown>;
    lastPropelAt: Map<string, unknown>;
    propels: Map<string, unknown>;
  };
  roster: {
    roleInfo: Map<string, unknown>;
    classes: Map<string, unknown>;
  };
}

// ServerBots.untrack is the single funnel every bot-keyed map drains
// through — a retired bot must leave zero per-bot state behind or the
// maps grow with cumulative churn. The funnel delegates into arsenal/
// senses/roster teardown, so those internals get seeded here too — a
// dropped delete in any of them fails this pin, not a silent leak.
describe('scenario: bot untrack purges all per-bot state', () => {
  it('untrack empties the bot\'s entries in every map', () => {
    const room = mkRoom({ bots: 2 });
    const p = firstPlayer(room);
    const bots = room.bots as unknown as BotsPeek;
    expect(bots.brains.has(p.id)).toBe(true);
    // Seed every delegated teardown surface — a live bot may not have
    // entries yet in trigger/propels/roles.
    for (const m of [bots.arsenal.trigger, bots.arsenal.propelT, bots.arsenal.propelJetUntil,
      bots.arsenal.wasCarrying, bots.arsenal.lastShot, bots.arsenal.lastPropelAt,
      bots.arsenal.propels, bots.roster.roleInfo, bots.roster.classes]) {
      m.set(p.id, {});
    }

    bots.untrack(p.id);
    for (const m of [bots.brains, bots.loadouts, bots.foeNear, bots.lastOut, bots.thinkPhase,
      bots.gearLobT, bots.suppressT, bots.quiet, bots.skillOffAt, bots.supportT,
      bots.healBeamT, bots.healNadeT,
      bots.sense.notices.seen, bots.sense.routing.routeHold, bots.sense.routing.routeFailed,
      bots.sense.routing.routePrefs, bots.sense.routing.waitSpot,
      bots.arsenal.trigger, bots.arsenal.propelT, bots.arsenal.propelJetUntil,
      bots.arsenal.wasCarrying, bots.arsenal.lastShot, bots.arsenal.lastPropelAt,
      bots.arsenal.propels, bots.roster.roleInfo, bots.roster.classes]) {
      expect(m.has(p.id)).toBe(false);
    }
    expect(bots.deadSet.has(p.id)).toBe(false);
  });
});
