// Replay a real captured wire stream through the real handler pipeline.
// Fixture: _tools/pvptest/record.ts output — a live duel room with 3 fleet
// bots + 3 server bots. Feeds json through handleMessage and binary frames
// through handleBinaryMessage in capture order, then asserts the world state
// a browser client would have ended up with. This is the regression net for
// the "decoder works but the handler dropped it" failure class.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import recText from './fixtures/duel.rec?raw';

vi.mock('../core/sfx.js', () => ({ at: () => {}, shotAt: () => {}, init: () => {}, hitMarker: () => {}, playerHurt: () => {}, shieldHit: () => {}, killConfirm: () => {}, flagCue: () => {} }));
vi.mock('../entities/PlayerModel.js', () => ({
  // RemotePlayer's GLTF model can't load headless — permissive proxy so any
  // visual method is a no-op while lifecycle code (RemoteSet) runs for real.
  PlayerModel: function () {
    return new Proxy({ load: () => Promise.resolve() }, {
      get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : () => {}),
    });
  },
}));
globalThis.fetch = () => new Promise<Response>(() => {});

import { makeDeps, feed, feedBin } from './netHarness.js';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function loadRec(text: string) {
  return text.split('\n').filter(Boolean).map((l) => {
    const [ms, kind, payload] = l.split('\t');
    return { ms: Number(ms), kind, payload };
  });
}

describe('netReplay — captured wire stream through real handlers', () => {
  let h: ReturnType<typeof makeDeps>;
  beforeEach(() => { h = makeDeps(); });

  it('replays the duel capture without throwing', () => {
    for (const ev of loadRec(recText)) {
      if (ev.kind === 'json') feed(h.nm, JSON.parse(ev.payload));
      else feedBin(h.nm, hexToBytes(ev.payload));
    }
    // populated remote roster from tickUpdate frames (bots joined before us)
    expect(h.nm.getPlayers().size).toBeGreaterThan(0);
    // ball events routed to entities — roster reconciles first, so the
    // subsequent ballSpawn dupes are absorbed; assert the roster landed.
    expect(h.calls.entities).toContain('ballRoster');
    // kills/hits reached the HUD surface (22 playerHit + 2 playerKill in capture)
    expect(h.calls.hud.length).toBeGreaterThan(0);
  });
});
