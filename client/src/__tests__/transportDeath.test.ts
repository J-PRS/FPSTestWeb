import { describe, it, expect, vi } from 'vitest';
import type { ConnectionConfig } from '../networking/WebSocketConnection.js';
import { WebTransportGameTransport } from '../networking/tiersWebTransport.js';

// Transport death contract — the 64KB-carry silent-death bug: a lane must
// NEVER go dead without first firing onDisconnect. If it does, the tier
// manager never reprobes and sends black-hole forever.
//
// Fake WebTransport: controllable streams + closed promise so each death
// mode can be driven deterministically.

function makeStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
  const writable = new WritableStream<Uint8Array>({ write: () => Promise.resolve() });
  return { readable, writable, ctrl };
}

function fakeWt() {
  let closeResolve!: () => void;
  let closeReject!: (e: unknown) => void;
  const closed = new Promise<void>((res, rej) => { closeResolve = res; closeReject = rej; });
  const stream = makeStream();
  const dgrams = makeStream();
  const wt = {
    ready: Promise.resolve(),
    closed,
    createBidirectionalStream: async () => ({ writable: stream.writable, readable: stream.readable }),
    datagrams: { readable: dgrams.readable },
    close: vi.fn(() => { closeResolve(); }),
  };
  return { wt: wt as unknown as WebTransport, stream, dgrams, closeResolve, closeReject };
}

function makeConfig() {
  const cfg: ConnectionConfig = {
    url: 'ws://x/ws',
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onMessage: vi.fn(),
    onBinaryMessage: vi.fn(),
    onError: vi.fn(),
  };
  return cfg;
}

async function connectWt() {
  const { wt, stream, dgrams, closeResolve, closeReject } = fakeWt();
  const config = makeConfig();
  const t = new WebTransportGameTransport(config, wt);
  t.connect();
  await vi.waitFor(() => expect(config.onConnect).toHaveBeenCalled());
  return { t, config, stream, dgrams, closeResolve, closeReject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('WebTransport lane-death contract', () => {
  it('reliable stream ending mid-session declares dead', async () => {
    const { t, config, stream } = await connectWt();
    stream.ctrl.close(); // server ended the bidi stream without closing the session
    await flush();
    expect(config.onDisconnect).toHaveBeenCalledWith(1006, 'wt reliable stream ended');
    expect(t.connected()).toBe(false);
  });

  it('a legit oversized frame no longer silently disconnects — it declares dead', async () => {
    const { config, stream } = await connectWt();
    // The bug: a >64KB gameState line silently disconnected. Now: guard is
    // 4MB AND the overflow declares dead so the tier reprobes.
    stream.ctrl.enqueue(new TextEncoder().encode('x'.repeat(70 * 1024)));
    await flush();
    expect(config.onDisconnect).not.toHaveBeenCalled(); // 70K is fine now
    stream.ctrl.enqueue(new TextEncoder().encode('x'.repeat(5 * 1024 * 1024)));
    await flush();
    expect(config.onDisconnect).toHaveBeenCalledWith(1006, 'wt line overflow');
  });

  it('reliable stream reset declares dead', async () => {
    const { config, stream } = await connectWt();
    stream.ctrl.error(new Error('boom'));
    await flush();
    expect(config.onDisconnect).toHaveBeenCalledWith(1006, 'wt reliable stream reset');
  });

  it('wt.closed resolving declares dead', async () => {
    const { config, closeResolve } = await connectWt();
    closeResolve();
    await flush();
    expect(config.onDisconnect).toHaveBeenCalledWith(1006, 'webtransport closed');
  });

  it('wt.closed REJECTING declares dead (abnormal close)', async () => {
    const { config, closeReject } = await connectWt();
    closeReject(new Error('quic reset'));
    await flush();
    expect(config.onDisconnect).toHaveBeenCalledWith(1006, 'webtransport closed');
  });

  it('datagram lane ending declares dead', async () => {
    const { config, dgrams } = await connectWt();
    dgrams.ctrl.close();
    await flush();
    expect(config.onDisconnect).toHaveBeenCalledWith(1006, 'wt datagrams ended');
  });

  it('multiple detectors firing still yields ONE onDisconnect', async () => {
    const { config, stream, dgrams } = await connectWt();
    stream.ctrl.close();
    dgrams.ctrl.close();
    await flush();
    expect(config.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('deliberate disconnect() stays silent — teardown must not impersonate a drop', async () => {
    const { t, config } = await connectWt();
    t.disconnect();
    await flush();
    expect(config.onDisconnect).not.toHaveBeenCalled();
    expect(t.connected()).toBe(false);
  });

  it('a well-formed line still parses and dispatches (no regression)', async () => {
    const { config, stream } = await connectWt();
    stream.ctrl.enqueue(new TextEncoder().encode('{"type":"matchNotice","text":"hi"}\n'));
    await flush();
    expect(config.onMessage).toHaveBeenCalledWith({ type: 'matchNotice', text: 'hi' });
    expect(config.onDisconnect).not.toHaveBeenCalled();
  });

  it('a big legit frame (>64KB, under 4MB) is delivered, not killed', async () => {
    const { config, stream } = await connectWt();
    const big = JSON.stringify({ type: 'serverWarn', text: 'x'.repeat(100 * 1024) });
    stream.ctrl.enqueue(new TextEncoder().encode(`${big  }\n`));
    await flush();
    expect(config.onMessage).toHaveBeenCalled();
    expect(config.onDisconnect).not.toHaveBeenCalled();
  });
});
