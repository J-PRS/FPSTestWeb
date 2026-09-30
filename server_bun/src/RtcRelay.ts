import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';

/**
 * WebRTC signalling relay — the server's only role in P2P mode. Two peers
 * share a room code (?room=X on the /ws upgrade); whatever either sends is
 * forwarded verbatim to the other (SDP offer/answer + ICE candidates).
 * Max 2 members per room: a third join gets a polite close.
 *
 * The relay ships opaque JSON envelopes — it never parses `data`, so the
 * signalling vocabulary can evolve client-side without a server bump.
 */
export class RtcRelay {
  private rooms = new Map<string, Set<ServerWebSocket<WebSocketData>>>();
  /** Rooms the host opened to strangers — listed until a second member
   *  lands or the host leaves. */
  private openRooms = new Map<string, number>(); // room → openedAt ms

  /** Public lobby list for quick-join: open rooms still waiting on a guest. */
  lobbies(): { room: string; since: number }[] {
    const out: { room: string; since: number }[] = [];
    for (const [room, since] of this.openRooms) {
      if ((this.rooms.get(room)?.size ?? 0) === 1) out.push({ room, since });
    }
    return out.sort((a, b) => a.since - b.since);
  }

  onOpen(ws: ServerWebSocket<WebSocketData>): void {
    const room = ws.data.room ?? '';
    let members = this.rooms.get(room);
    if (!members) { members = new Set(); this.rooms.set(room, members); }
    if (members.size >= 2) {
      ws.close(1008, 'room full');
      return;
    }
    members.add(ws);
    if (members.size === 1 && ws.data.open) this.openRooms.set(room, Date.now());
    // First member hosts; the second's arrival kicks off the offer.
    ws.send(JSON.stringify({ t: 'role', host: members.size === 1 }));
    if (members.size === 2) {
      for (const m of members) if (m !== ws) m.send(JSON.stringify({ t: 'peer' }));
    }
    logger.info('RTC room join', { room, members: members.size });
  }

  onMessage(ws: ServerWebSocket<WebSocketData>, message: string | ArrayBuffer): void {
    const members = this.rooms.get(ws.data.room ?? '');
    if (!members) return;
    for (const m of members) {
      if (m !== ws && m.readyState === 1) m.send(message);
    }
  }

  onClose(ws: ServerWebSocket<WebSocketData>): void {
    const room = ws.data.room ?? '';
    const members = this.rooms.get(room);
    if (!members) return;
    members.delete(ws);
    for (const m of members) {
      if (m.readyState === 1) m.send(JSON.stringify({ t: 'peer-left' }));
    }
    if (members.size === 0) {
      this.rooms.delete(room);
      this.openRooms.delete(room);
    } else if (![...members].some((m) => m.data.open)) {
      // The OPEN member left — a lone guest isn't a joinable lobby.
      this.openRooms.delete(room);
    }
  }
}
