/**
 * Wire-layer chaos suite — ConnectionManager's journal/reclaim/drown
 * contract exercised directly. These are the pieces a CS/OW-grade
 * netcode suite must pin: replay completeness on reconnect, addressing
 * across replay, journal eviction visibility, backpressure policy, and
 * slow-client drain.
 */

import { describe, it, expect } from 'bun:test';
import { ConnectionManager } from '../../src/ConnectionManager.ts';
import { FakeWs } from './chaos.ts';
import type { ServerWebSocket } from 'bun';
import type { WebSocketData, ServerMessage } from '../../src/types.ts';

const asWs = (w: FakeWs) => w as unknown as ServerWebSocket<WebSocketData>;

const evOf = (data: string | Uint8Array): number =>
  (JSON.parse(data as string) as { ev: number }).ev;
const typeOf = (data: string | Uint8Array): string =>
  (JSON.parse(data as string) as { type: string }).type;

describe('netcode chaos: wire layer', () => {
  it('reclaim replays exactly the missed seqs, in order', () => {
    const cm = new ConnectionManager();
    // Frames fly while nobody's connected — a dead socket's whole world.
    for (let i = 0; i < 20; i++) {cm.broadcast({ type: 'chat', playerId: 'x', text: `m${i}` } as ServerMessage);}
    const ws = new FakeWs('a');
    cm.register('a', asWs(ws));
    const replayed = cm.replayTo('a', asWs(ws), 10);
    expect(replayed).toBe(10);
    const seqs = ws.sentRaw.map(evOf);
    for (let i = 0; i < seqs.length; i++) {expect(seqs[i]).toBe(11 + i);}
    expect(cm.reclaimGap).toBe(0);
  });

  it('addressed frames replay only to their audience', () => {
    const cm = new ConnectionManager();
    cm.sendToPlayer('a', { type: 'chat', playerId: 'x', text: 'for-a' } as ServerMessage);
    cm.sendToPlayer('b', { type: 'chat', playerId: 'x', text: 'for-b' } as ServerMessage);
    cm.broadcast({ type: 'chat', playerId: 'x', text: 'for-all' } as ServerMessage);
    cm.broadcast({ type: 'chat', playerId: 'x', text: 'not-for-a' } as ServerMessage, 'a');

    const wsA = new FakeWs('a'), wsB = new FakeWs('b');
    cm.register('a', asWs(wsA)); cm.register('b', asWs(wsB));
    cm.replayTo('a', asWs(wsA), 0);
    cm.replayTo('b', asWs(wsB), 0);

    const aTypes = wsA.sentRaw.map(d => (JSON.parse(d as string) as { text: string }).text);
    const bTypes = wsB.sentRaw.map(d => (JSON.parse(d as string) as { text: string }).text);
    expect(aTypes).toEqual(['for-a', 'for-all']);          // exclude honored, other's only hidden
    expect(bTypes).toEqual(['for-b', 'for-all', 'not-for-a']);
  });

  it('volatile cues replay while fresh — durable facts always replay', () => {
    const cm = new ConnectionManager();
    cm.broadcast({ type: 'playerShot', id: 'shot-1' } as ServerMessage); // volatile
    cm.broadcast({ type: 'chat', playerId: 'x', text: 'fact' } as ServerMessage); // durable
    const ws = new FakeWs('a');
    cm.register('a', asWs(ws));
    cm.replayTo('a', asWs(ws), 0);
    const types = ws.sentRaw.map(typeOf);
    expect(types).toContain('playerShot');
    expect(types).toContain('chat');
  });

  it('journal eviction is counted and reclaimed gaps are visible', () => {
    const cm = new ConnectionManager();
    let wrapped = 0;
    cm.onJournalWrap = (d) => { wrapped += d; };
    const ws = new FakeWs('a');
    cm.register('a', asWs(ws));
    // Eviction fires in JOURNAL_EVICT_CHUNK-sized drops once the journal
    // overshoots MAX+CHUNK — the first wrap sheds CHUNK+1, not a 1-by-1
    // drip. The counts below ride the constants so a re-tune re-derives
    // them instead of breaking.
    const MAX = ConnectionManager.JOURNAL_MAX, CHUNK = ConnectionManager.JOURNAL_EVICT_CHUNK;
    const dropped = CHUNK + 1;
    for (let i = 0; i < MAX + CHUNK + 1; i++) {cm.broadcast({ type: 'chat', playerId: 'x', text: `${i}` } as ServerMessage);}
    expect(wrapped).toBe(dropped);
    expect(cm.journalDropped).toBe(dropped);

    // A reclaim asking for seq 0 missed frames that no longer exist —
    // the gap must be COUNTED, not silently skipped.
    let gap = -1;
    cm.onReclaimGap = (_pid, missed) => { gap = missed; };
    ws.sentRaw.length = 0;
    cm.replayTo('a', asWs(ws), 0);
    expect(gap).toBe(dropped);
    // ...but every surviving frame still replays.
    expect(ws.sentRaw.length).toBe(MAX);
  });

  it('tick frames shed at backlog while reliable lane still queues', () => {
    const cm = new ConnectionManager();
    const ws = new FakeWs('a');
    cm.register('a', asWs(ws));
    // Open the intro gate first — a fresh join holds ticks, not sheds.
    cm.sendBinaryToPlayer('a', new Uint8Array(8));
    ws.buffered = 300 * 1024; // past MAX_TICK_BACKLOG
    expect(cm.sendBinaryToPlayer('a', new Uint8Array(8))).toBe('backlogged');
    expect(ws.sentRaw.length).toBe(1); // the gate-open frame only
    // Reliable JSON still flows — it counts toward the drown drain.
    // (sentRaw=2: the gate-open tick frame + this chat frame.)
    cm.sendToPlayer('a', { type: 'chat', playerId: 'x', text: 'hi' } as ServerMessage);
    expect(ws.sentRaw.length).toBe(2);
  });

  it('drowned socket gets marked, skipped, then closed after the window', () => {
    const cm = new ConnectionManager();
    let drowned = '';
    cm.onDrowned = (pid) => { drowned = pid; };
    const ws = new FakeWs('a');
    ws.buffered = 5 * 1024 * 1024; // past DROWN_BYTES
    cm.register('a', asWs(ws));

    // First sighting just starts the clock — the send still goes.
    cm.sendToPlayer('a', { type: 'chat', playerId: 'x', text: '1' } as ServerMessage);
    expect(ws.sentRaw.length).toBe(1);
    expect(ws.data.slowSince).toBeTypeOf('number');

    // Still inside SLOW_FOR_MS — sends are skipped but no close yet.
    cm.sendToPlayer('a', { type: 'chat', playerId: 'x', text: '2' } as ServerMessage);
    expect(ws.sentRaw.length).toBe(1);

    // Age the mark past the window — next send closes it as drowned.
    ws.data.slowSince = Date.now() - 6000;
    cm.sendToPlayer('a', { type: 'chat', playerId: 'x', text: '3' } as ServerMessage);
    expect(drowned).toBe('a');
    expect(ws.closed?.code).toBe(1011);
  });

  it('binary lanes feed the drown clock — a stalled binary-only reader closes', () => {
    const cm = new ConnectionManager();
    let drowned = '';
    cm.onDrowned = (pid) => { drowned = pid; };
    const ws = new FakeWs('a');
    ws.buffered = 5 * 1024 * 1024; // past DROWN_BYTES
    cm.register('a', asWs(ws));

    // Reliable binary (ball segments) previously sent blind — no clock, no
    // skip. First sighting starts the clock and lets the frame through.
    cm.broadcastBinaryReliable(new Uint8Array(8));
    expect(ws.sentRaw.length).toBe(1);
    expect(ws.data.slowSince).toBeTypeOf('number');

    // Tick frames shed above the cap AND feed the same clock. The gate
    // is still armed (outbox never drained) — held is honest too, so
    // accept either non-sent verdict as "shed at backlog".
    expect(cm.sendBinaryToPlayer('a', new Uint8Array(8))).not.toBe('sent');
    expect(ws.sentRaw.length).toBe(1);

    // Aged mark — the next binary send closes the socket as drowned.
    ws.data.slowSince = Date.now() - 6000;
    cm.broadcastBinaryReliable(new Uint8Array(8));
    expect(drowned).toBe('a');
    expect(ws.closed?.code).toBe(1011);
    expect(ws.sentRaw.length).toBe(1);
  });

  it('a draining socket clears its mark — transient spike is not a drown', () => {
    const cm = new ConnectionManager();
    let drowned = '';
    cm.onDrowned = (pid) => { drowned = pid; };
    const ws = new FakeWs('a');
    ws.buffered = 5 * 1024 * 1024;
    cm.register('a', asWs(ws));
    cm.sendToPlayer('a', { type: 'chat', playerId: 'x', text: '1' } as ServerMessage);
    expect(ws.data.slowSince).toBeTypeOf('number');
    // Socket drains before the window closes — mark clears, no drown.
    ws.buffered = 1024;
    ws.data.slowSince = Date.now() - 6000; // even an aged mark clears on drain
    cm.sendToPlayer('a', { type: 'chat', playerId: 'x', text: '2' } as ServerMessage);
    expect(ws.data.slowSince).toBeUndefined();
    expect(drowned).toBe('');
    expect(ws.closed).toBeNull();
  });
});
