/**
 * recSink — record a harness room's live wire stream into a .rec file so
 * a sim-time run (gauntlet, soak) replays in the real client as gameplay.
 * A fake spectator socket gets the FULL tick record set every tick plus
 * every reliable JSON/binary broadcast — the same stream record.ts
 * captures off a live socket.
 *
 * Line format matches _tools/pvptest/record.ts: <ms>\t<kind>\t<payload>.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import type { Room } from '../../server_bun/src/Room.ts';
import type { WebSocketData } from '../../server_bun/src/types.ts';
import { TickFanout } from '../../server_bun/src/tickRecords.ts';

export interface RecSink {
  /** Build + fanout this tick's records — call once per step() inside the
   *  run loop (harness step() drives room.sims only; TickLoop owns the
   *  record path in production, so the sink pumps it here). */
  tick(): void;
  close(): void;
}

export function attachRec(room: Room, outPath: string, nowMs: () => number): RecSink {
  writeFileSync(outPath, '');
  const line = (kind: string, payload: string) =>
    appendFileSync(outPath, `${Math.round(nowMs())}\t${kind}\t${payload}\n`);

  // Spectator socket: anything send()ed lands as a rec line.
  const ws = {
    readyState: 1,
    data: {} as WebSocketData,
    getBufferedAmount: () => 0,
    send: (data: string | Uint8Array) => {
      if (typeof data === 'string') line('json', data);
      else line('bin', Buffer.from(data).toString('hex'));
    },
    close: () => { /* sink never closes */ },
  } as unknown as ServerWebSocket<WebSocketData>;

  const ID = 'REC';
  room.connections.register(ID, ws);
  room.spectators.add(ID);

  // Join-time truth a live client would get in gameState: the sims'
  // worldState rosters (balls, creatures) — without them the replay only
  // sees creatures that spawn after record start.
  for (const s of room.sims) {
    for (const m of s.worldState?.() ?? []) line('json', JSON.stringify(m));
  }

  const fanout = new TickFanout(
    { recordsSent: 0, recordsSuppressed: 0, recordsTierSkipped: 0, bytesSent: 0, tickFramesDropped: 0 },
    () => { /* spectators don't idle-kick in a capture */ },
  );

  return {
    tick() {
      const records = fanout.buildRecords(room, room.players.getAllPlayers(), nowMs());
      fanout.fanoutRecords(room, room.players.getAllPlayers(), records);
    },
    close() {
      room.spectators.delete(ID);
      room.connections.unregister(ID);
    },
  };
}
