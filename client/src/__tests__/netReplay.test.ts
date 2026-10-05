// Replay a real captured wire stream through the real handler pipeline.
// Fixture: _tools/pvptest/record.ts output — a live duel room with 3 fleet
// bots + 3 server bots. Feeds json through handleMessage and binary frames
// through handleBinaryMessage in capture order, then asserts the world state
// a browser client would have ended up with. This is the regression net for
// the "decoder works but the handler dropped it" failure class.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import recText from './fixtures/duel.rec?raw';
import crossfireRec from './fixtures/crossfire.rec?raw';

vi.mock('../core/sfx.js', () => ({ at: () => {}, shotAt: () => {}, init: () => {}, hitMarker: () => {}, playerHurt: () => {}, shieldHit: () => {}, killConfirm: () => {}, flagCue: () => {}, matchHorn: () => {} }));
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
import { PROTOCOL_VERSION, type ServerMessage } from '../../../shared/protocol.js';

// Captures are stamped with whatever protocol the recorder saw —
// re-versioning gameState keeps the replay testing handlers, not the
// version-negotiation gate (which has its own job: reload real browsers).
function feedJson(nm: Parameters<typeof feed>[0], payload: string): void {
  const m = JSON.parse(payload) as ServerMessage;
  if (m.type === 'gameState') {m.protocolVersion = PROTOCOL_VERSION;}
  feed(nm, m);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);}
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
      if (ev.kind === 'json') {feedJson(h.nm, ev.payload);}
      else {feedBin(h.nm, hexToBytes(ev.payload));}
    }
    // populated remote roster from tickUpdate frames (bots joined before us)
    expect(h.nm.getPlayers().size).toBeGreaterThan(0);
    // ball events routed to entities — roster reconciles first, so the
    // subsequent ballSpawn dupes are absorbed; assert the roster landed.
    expect(h.calls.entities).toContain('ballRoster');
    // kills/hits reached the HUD surface (22 playerHit + 2 playerKill in capture)
    expect(h.calls.hud.length).toBeGreaterThan(0);
  });

  it('replays the crossfire capture — ticks populate remotes, deploySpawns route', () => {
    for (const ev of loadRec(crossfireRec)) {
      if (ev.kind === 'json') {feedJson(h.nm, ev.payload);}
      else {feedBin(h.nm, hexToBytes(ev.payload));}
    }
    // 3 fleet bots + 4 server bots joined before the recorder did
    expect(h.nm.getPlayers().size).toBeGreaterThan(0);
    // 17 deploySpawn broadcasts in the window — replicas spawned
    expect(h.calls.deployables.filter((c) => c.startsWith('spawn:')).length).toBeGreaterThan(0);
  });
});
