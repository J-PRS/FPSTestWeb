import { describe, it, expect } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';

interface Peek {
  sessions: {
    // Private: joins claim an id→token binding so a name can't be stolen.
    // The map evicts its stalest half at 10k — a script minting fresh
    // playerIds must not grow it forever.
    claimedIdentities: Map<string, string>;
    claimIdentity(playerId: string, token: string | undefined, idToken: string): boolean;
  };
  tickLoop: { stop(): void };
}

describe('claimed-identities cap', () => {
  it('evicts the stalest half at MAX_IDENTITIES — newest survive', () => {
    const gs = new GameServer();
    const peek = gs as unknown as Peek;
    try {
      const claim = (id: string) =>
        peek.sessions.claimIdentity(id, undefined, `tok-${id}`);
      for (let i = 0; i < 10_000; i++) claim(`p${i}`);
      expect(peek.sessions.claimedIdentities.size).toBe(10_000);

      claim('p-new');
      // 5000 oldest evicted, then the new claim inserted.
      expect(peek.sessions.claimedIdentities.size).toBe(5001);
      expect(peek.sessions.claimedIdentities.has('p0')).toBe(false);
      expect(peek.sessions.claimedIdentities.has('p4999')).toBe(false);
      expect(peek.sessions.claimedIdentities.has('p5000')).toBe(true);
      expect(peek.sessions.claimedIdentities.has('p-new')).toBe(true);
    } finally {
      peek.tickLoop.stop();
    }
  });
});
