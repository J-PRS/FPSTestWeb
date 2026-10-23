/**
 * Wire-layer chaos suite — ConnectionManager's journal/reclaim/drown
 * contract exercised directly. These are the pieces a CS/OW-grade
 * netcode suite must pin: replay completeness on reconnect, addressing
 * across replay, journal eviction visibility, backpressure policy, and
 * slow-client drain.
 */

import { describe, it, expect } from 'bun:test';
import { ConnectionManager } from '../../src/ConnectionManager.ts';
import { evScratch, iterBatch } from '../../../shared/wire.ts';
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

});

describe('netcode chaos: frame aliasing + journal replay', () => {
  it('queued tick frames do not alias across recipients (frameArena contract)', () => {
    // Regression: encodeTickFrame once shared ONE arena — recipient A's
    // queued view was clobbered by recipient B's encode mid-collect, so
    // every conn's batch carried the last-encoded frame. Per-conn arenas
    // must keep each queued view intact until flush.
    const cm = new ConnectionManager();
    const wsA = new FakeWs('a'), wsB = new FakeWs('b');
    cm.register('a', asWs(wsA)); cm.register('b', asWs(wsB));
    cm.beginCollect();
    const arenaA = cm.frameArenaFor('a');
    const arenaB = cm.frameArenaFor('b');
    expect(arenaA).not.toBe(arenaB);
    const frameA = new Uint8Array(arenaA.buf, 0, 8).fill(0xAA);
    const frameB = new Uint8Array(arenaB.buf, 0, 8).fill(0xBB);
    cm.sendBinaryToPlayer('a', frameA);
    cm.sendBinaryToPlayer('b', frameB);
    cm.flushOutboxes();
    const aFirst = wsA.sentRaw[0] as Uint8Array;
    const bFirst = wsB.sentRaw[0] as Uint8Array;
    expect(aFirst[0]).toBe(0xAA);
    expect(bFirst[0]).toBe(0xBB);
  });

  it('queued evScratch frames survive a ring wrap — bytes must not morph mid-window', () => {
    // The 128-slot evScratch ring recycles — a collect window queuing
    // >128 distinct event frames wraps and overwrites the queued views:
    // a queued playerHit would flush as whatever the 129th encode wrote
    // (the missing-damage class). push() must copy retained ring views.
    const cm = new ConnectionManager();
    const ws = new FakeWs('a');
    cm.register('a', asWs(ws));
    cm.beginCollect();
    // 200 distinct small frames through evScratch — wraps the ring.
    const originals: number[] = [];
    for (let i = 0; i < 200; i++) {
      const { u8 } = evScratch(8);
      u8[0] = i & 0xFF;
      cm.sendBinaryToPlayer('a', u8.subarray(0, 8));
      originals.push(i & 0xFF);
    }
    cm.flushOutboxes();
    // Every queued frame flushed in one batch — decode the subframes and
    // verify each still carries its OWN tag byte, not a wrapped sibling's.
    const sent = ws.sentRaw[0] as Uint8Array;
    const seen: number[] = [];
    for (const sub of iterBatch(sent)) {seen.push(sub[0] ?? -1);}
    expect(seen.length).toBe(200);
    expect(seen).toEqual(originals);
  });

  it('journaled binary events replay verbatim, interleaved in seq order with JSON', () => {
    // playerHit/playerKill ride broadcastBinaryReliable now — the damage
    // stream a reclaim must replay. If binary frames skipped the journal
    // or reordered against JSON, a reconnecting client silently loses
    // hits — the "missing damage" failure class.
    const cm = new ConnectionManager();
    const hit = new Uint8Array([0x13, 0xAA, 1, 2, 3]);      // WIRE_HIT kind byte
    const kill = new Uint8Array([0x19, 0xBB, 4, 5, 6]);
    for (let i = 0; i < 5; i++) {cm.broadcast({ type: 'chat', playerId: 'x', text: `j${i}` } as ServerMessage);}
    cm.broadcastBinaryReliable(hit, true);                  // journaled
    for (let i = 0; i < 5; i++) {cm.broadcast({ type: 'chat', playerId: 'x', text: `k${i}` } as ServerMessage);}
    cm.broadcastBinaryReliable(kill, 'volatile');
    cm.broadcastBinaryReliable(new Uint8Array([0x14, 0xCC])); // unjournaled — never replays

    const ws = new FakeWs('a');
    cm.register('a', asWs(ws));
    // Replay from seq 5 — should see the hit (6), k0..k4 (7-11), kill (12).
    const n = cm.replayTo('a', asWs(ws), 5);
    expect(n).toBe(7);
    expect(ws.sentRaw[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(ws.sentRaw[0] as Uint8Array)).toEqual([0x13, 0xAA, 1, 2, 3]);
    expect(ws.sentRaw[6]).toBeInstanceOf(Uint8Array);
    expect(Array.from(ws.sentRaw[6] as Uint8Array)).toEqual([0x19, 0xBB, 4, 5, 6]);
    // The JSON middle is strings, order preserved around the binary frames.
    expect(JSON.parse(ws.sentRaw[1] as string).text).toBe('k0');
  });

  it('volatile binary honors only/exclude addressing on replay', () => {
    const cm = new ConnectionManager();
    const knock = new Uint8Array([0x18, 1, 2, 3]);
    cm.sendBinToPlayerReliable('a', knock, 'volatile');     // only=a
    cm.broadcastBinaryReliable(new Uint8Array([0x17, 9]), 'volatile', 'a'); // exclude=a
    const ws = new FakeWs('a');
    cm.register('a', asWs(ws));
    const n = cm.replayTo('a', asWs(ws), 0);
    expect(n).toBe(1);
    expect(Array.from(ws.sentRaw[0] as Uint8Array)).toEqual([0x18, 1, 2, 3]);
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

  it('backlogged socket degrades to sparse keepalive — every 4th tick still rides', () => {
    // Degrade-never-cull: a congested-but-draining link must keep SOME
    // world state flowing (~5Hz) or its remotes freeze solid for the
    // whole drown window — the bigSoak stall signature. The shed count
    // stays honest: 3 of 4 still return 'backlogged'.
    const cm = new ConnectionManager();
    const ws = new FakeWs('a');
    cm.register('a', asWs(ws));
    cm.sendBinaryToPlayer('a', new Uint8Array(8)); // gate-open
    ws.buffered = 300 * 1024;
    ws.sentRaw.length = 0;
    const verdicts: string[] = [];
    for (let i = 0; i < 24; i++) {verdicts.push(cm.sendBinaryToPlayer('a', new Uint8Array(8)));}
    expect(verdicts.filter((v) => v === 'backlogged').length).toBe(18);
    expect(verdicts.filter((v) => v === 'sparse').length).toBe(6);
    expect(ws.sentRaw.length).toBe(6);
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
