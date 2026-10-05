import { urlParams } from '../core/params.js';
import type { NetworkManager } from './NetworkManager.js';
import type { ChildLogger } from '../core/Logger.js';
import type { LoadProfiler } from '../utils/profiling.js';

export interface ConnectCtx {
  serverUrl: string;
  /** Classic is a solo ruleset — connecting would hand ball ownership to the
   *  server sim, which enrages and spawns the full roster behind your back. */
  classicMode: boolean;
  networkManager: NetworkManager;
  logger: ChildLogger;
  fragMessages?: { show(text: string): void } | null;
  profiler: LoadProfiler;
}

/** ?p2p=quick — ask the relay for an open lobby and join the oldest. */
async function quickRoomCode(serverUrl: string): Promise<string | null> {
  const base = new URL(serverUrl.replace(/^ws/, 'http')).origin;
  try {
    const lobbies = (await (await fetch(`${base}/rtc/lobbies`)).json()) as { room: string }[];
    return lobbies[0]?.room ?? null;
  } catch { return null; }
}

/**
 * Connect to the game server (non-blocking for offline mode).
 * ?p2p=host:CODE / ?p2p=join:CODE / ?p2p=quick — the server only relays
 * the WebRTC handshake (/rtc?room=CODE), then the peers talk directly
 * over a DataChannel. The HOST also embeds the real authority modules
 * (PlayerManager/CombatHandler — see networking/p2p/host.ts), so all
 * server rules apply; the host browser is just trusted by definition.
 */
/** Peer-to-peer path: host embeds the authority, guest rides a DataChannel,
 *  'quick' resolves a room code from the relay's open-lobby list first. */
async function connectP2PMode(ctx: ConnectCtx, p2p: string): Promise<void> {
  const { serverUrl, networkManager, logger, fragMessages, profiler } = ctx;
  const colon = p2p.indexOf(':');
  let role = colon === -1 ? p2p : p2p.slice(0, colon);
  let room = colon === -1 ? 'duel' : (p2p.slice(colon + 1) || 'duel');
  if (role === 'quick') {
    const found = await quickRoomCode(serverUrl);
    if (!found) { fragMessages?.show('No open lobbies — host one and a friend can quick-join'); return; }
    room = found;
    role = 'join';
  }
  profiler.markTime('networkConnectStart');
  try {
    const { connectP2P } = await import('./p2p/signalling.js');
    const { P2PHost } = await import('./p2p/host.js');
    const { LoopbackTransport, DataChannelTransport } = await import('./p2p/transport.js');
    const sig = new URL(serverUrl);
    sig.pathname = '/rtc';
    const open = urlParams.lobby ? '&open=1' : '';
    sig.search = `?room=${encodeURIComponent(room)}${open}`;
    if (role === 'host') {
      const host = new P2PHost();
      const dc = connectP2P({ signalUrl: sig.toString() }); // resolves when guest's channel opens
      // Host plays immediately over loopback — no need to wait for a guest
      await networkManager.connect(serverUrl, (cfg) => new LoopbackTransport(host, cfg));
      dc.then((chan) => host.attachDataChannel(chan)).catch((error) => logger.warn('P2P guest handshake failed', error));
      logger.info(`P2P hosting room "${room}"${open ? ' (open lobby)' : ''} — share ?p2p=join:${room}`);
      fragMessages?.show(open
        ? `Open lobby "${room}" — anyone can quick-join`
        : `P2P room "${room}" — friend joins with ?p2p=join:${room}`);
    } else {
      const dc = await connectP2P({ signalUrl: sig.toString() });
      await networkManager.connect(serverUrl, (cfg) => new DataChannelTransport(dc, cfg));
      logger.info(`P2P joined room "${room}"`);
    }
    profiler.markTime('networkConnected');
  } catch (error) {
    logger.error('P2P connect failed', error);
    fragMessages?.show('P2P connect failed — playing offline');
  }
}

export async function connectServer(ctx: ConnectCtx): Promise<void> {
  const { serverUrl, classicMode, networkManager, logger, profiler } = ctx;
  const {p2p} = urlParams;
  if (!classicMode && p2p) {
    await connectP2PMode(ctx, p2p);
  } else if (!classicMode) {
    profiler.markTime('networkConnectStart');
    networkManager.connect(serverUrl).then(() => {
      profiler.markTime('networkConnected');
      logger.info(`Connected to server at ${serverUrl}`);
    }).catch((error) => {
      logger.error('Failed to connect to server', error);
    });
  }
}
