import { describe, it, expect } from 'bun:test';
import { RtcRelay } from '../src/RtcRelay.ts';
import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from '../src/types.ts';

/** Fake socket — records sent frames, readyState=1 (OPEN). */
function fakeWs(room: string, open = false) {
  const sent: (string | ArrayBuffer)[] = [];
  const ws = {
    data: { room, rtc: true, open, playerId: '', connectedAt: Date.now() },
    readyState: 1,
    sent,
    closed: null as { code: number; reason: string } | null,
    send(d: string | ArrayBuffer) { sent.push(d); },
    close(code: number, reason: string) { this.closed = { code, reason }; },
  };
  return ws as unknown as ServerWebSocket<WebSocketData> & { sent: typeof sent; closed: { code: number; reason: string } | null };
}

describe('RtcRelay', () => {
  it('first member hosts, second triggers peer notification', () => {
    const relay = new RtcRelay();
    const a = fakeWs('r1');
    const b = fakeWs('r1');
    relay.onOpen(a);
    expect(JSON.parse(a.sent[0] as string)).toEqual({ t: 'role', host: true });
    relay.onOpen(b);
    expect(JSON.parse(b.sent[0] as string)).toEqual({ t: 'role', host: false });
    expect(JSON.parse(a.sent[1] as string)).toEqual({ t: 'peer' });
  });

  it('forwards messages verbatim to the other member only', () => {
    const relay = new RtcRelay();
    const a = fakeWs('r1'); const b = fakeWs('r1');
    relay.onOpen(a); relay.onOpen(b);
    relay.onMessage(a, '{"t":"offer","sdp":"X"}');
    expect(b.sent[b.sent.length - 1]).toBe('{"t":"offer","sdp":"X"}');
    expect(a.sent.length).toBe(2); // role + peer, nothing echoed back
    // rooms don't bleed
    const c = fakeWs('r2');
    relay.onOpen(c);
    relay.onMessage(a, 'again');
    expect(c.sent.length).toBe(1); // only its own role message
  });

  it('rejects a third member politely', () => {
    const relay = new RtcRelay();
    relay.onOpen(fakeWs('r1'));
    relay.onOpen(fakeWs('r1'));
    const c = fakeWs('r1');
    relay.onOpen(c);
    expect(c.closed).toEqual({ code: 1008, reason: 'room full' });
  });

  it('peer-left on close, room freed for a new pair', () => {
    const relay = new RtcRelay();
    const a = fakeWs('r1'); const b = fakeWs('r1');
    relay.onOpen(a); relay.onOpen(b);
    relay.onClose(b);
    expect(JSON.parse(a.sent[a.sent.length - 1] as string)).toEqual({ t: 'peer-left' });
    // a stays in the room, so a fresh joiner is member 2 (guest), and a
    // gets a new 'peer' kick to re-offer
    const c = fakeWs('r1');
    relay.onOpen(c);
    expect(JSON.parse(c.sent[0] as string)).toEqual({ t: 'role', host: false });
    expect(JSON.parse(a.sent[a.sent.length - 1] as string)).toEqual({ t: 'peer' });
    // both leave → room deleted → next joiner hosts again
    relay.onClose(a); relay.onClose(c);
    const d = fakeWs('r1');
    relay.onOpen(d);
    expect(JSON.parse(d.sent[0] as string)).toEqual({ t: 'role', host: true });
  });

  it('lobbies(): open hosts listed while waiting, paired rooms hidden', () => {
    const relay = new RtcRelay();
    const a = fakeWs('open1', true);   // host opted into the lobby list
    const b = fakeWs('closed1');       // private duel
    relay.onOpen(a); relay.onOpen(b);
    expect(relay.lobbies().map((l) => l.room)).toEqual(['open1']);
    // a guest arrives — the room fills and drops off the list
    const g = fakeWs('open1');
    relay.onOpen(g);
    expect(relay.lobbies()).toEqual([]);
    // guest drops again — the open host is waiting once more
    relay.onClose(g);
    expect(relay.lobbies().map((l) => l.room)).toEqual(['open1']);
  });

  it('lobbies(): host leaving unlists the room even with a guest left', () => {
    const relay = new RtcRelay();
    const host = fakeWs('r', true);
    const guest = fakeWs('r');
    relay.onOpen(host); relay.onOpen(guest);
    relay.onClose(guest);            // back to waiting — listed
    expect(relay.lobbies().length).toBe(1);
    relay.onClose(host);             // host gone → lone guest isn't a lobby
    expect(relay.lobbies()).toEqual([]);
    relay.onClose(guest);            // room fully gone
    expect(relay.lobbies()).toEqual([]);
  });

  it('lobbies(): longest-waiting first', async () => {
    const relay = new RtcRelay();
    relay.onOpen(fakeWs('older', true));
    await new Promise((r) => setTimeout(r, 5)); // distinct openedAt
    relay.onOpen(fakeWs('newer', true));
    expect(relay.lobbies().map((l) => l.room)).toEqual(['older', 'newer']);
  });
});
