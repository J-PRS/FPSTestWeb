/**
 * WebRTC handshake over the server's /rtc relay. The relay shuttles opaque
 * envelopes between the two members of a room; the first member hosts.
 * Returns an open RTCDataChannel ('game') — after this, the server is out
 * of the loop entirely.
 */

import { ChildLogger } from '../../core/Logger.js';

const logger = new ChildLogger('P2P');

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

interface SignalMsg { t: string; sdp?: string; ice?: RTCIceCandidateInit; host?: boolean }

/** The two lanes, same split the dedicated-RTC path uses (tiers.ts):
 *  'game' unordered/bounded-retransmit carries volatile seq'd binary
 *  (position frames, tick frames — a retransmitted stale tick is worse
 *  than a dropped one); 'ctrl' reliable+ordered carries JSON. A single
 *  ordered channel head-of-line blocks every position update behind a
 *  lost packet's retransmit. */
export interface P2PChannels { game: RTCDataChannel; ctrl: RTCDataChannel; pc: RTCPeerConnection | null }

export function connectP2P(opts: { signalUrl: string; timeoutMs?: number }): Promise<P2PChannels> {
  return new Promise((resolve, reject): void => {
    const timeout = setTimeout((): void => reject(new Error('P2P signalling timed out')), opts.timeoutMs ?? 15_000);
    const fail = (e: Error): void => { clearTimeout(timeout); ws.close(); reject(e); };

    const ws = new WebSocket(opts.signalUrl);
    let pc: RTCPeerConnection | null = null;
    let isHost = false;

    const send = (m: SignalMsg): void => { if (ws.readyState === WebSocket.OPEN) {ws.send(JSON.stringify(m));} };

    const newPc = (): RTCPeerConnection => {
      const p = new RTCPeerConnection(RTC_CONFIG);
      p.addEventListener('icecandidate', (e): void => { if (e.candidate) {send({ t: 'ice', ice: e.candidate.toJSON() });} });
      p.addEventListener('connectionstatechange', (): void => {
        if (p.connectionState === 'failed') {fail(new Error('ICE failed — NAT unroutable'));}
      });
      return p;
    };

    const chans: Partial<P2PChannels> = {};
    const armChannel = (dc: RTCDataChannel): void => {
      dc.addEventListener('open', (): void => {
        if (dc.label === 'ctrl') {chans.ctrl = dc;}
        else {chans.game = dc;} // 'game' or unlabeled → fast lane
        if (chans.game && chans.ctrl) {clearTimeout(timeout); ws.close(); resolve({ game: chans.game, ctrl: chans.ctrl, pc });}
      });
    };

    ws.addEventListener('error', (): void => fail(new Error('signalling socket failed')));
    ws.addEventListener('close', (e): void => { if (e.code === 1008) {fail(new Error(`room rejected: ${e.reason}`));} });

    ws.addEventListener('message', async (ev): Promise<void> => {
      // A malformed signal frame must not kill the handshake — an exception
      // inside this async listener surfaces as an unhandled rejection and
      // silently aborts ICE relay.
      // oxlint-disable-next-line init-declarations -- assigned later
      let msg!: SignalMsg | null;
      try { msg = JSON.parse(ev.data as string) as SignalMsg; } catch { return; }
      if (msg === null || typeof msg !== 'object') {return;}
      try {
        switch (msg.t) {
          case 'role': {
            isHost = Boolean(msg.host);
            // The host must outwait the guest — a 15s handshake timeout here
            // killed the room's signalling socket for anyone arriving late.
            // Guests keep the deadline: their join either works fast or not.
            if (isHost) {clearTimeout(timeout);}
            break;
          }
          case 'peer': {
            // Second member arrived — host makes the offer
            pc = newPc();
            armChannel(pc.createDataChannel('game', { ordered: false, maxRetransmits: 2 }));
            armChannel(pc.createDataChannel('ctrl')); // reliable+ordered
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            send({ t: 'offer', sdp: offer.sdp });
            break;
          }
          case 'offer': {
            pc = newPc();
            pc.addEventListener('datachannel', (e): void => armChannel(e.channel));
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp! });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            send({ t: 'answer', sdp: answer.sdp });
            break;
          }
          case 'answer': {
            await pc?.setRemoteDescription({ type: 'answer', sdp: msg.sdp! });
            break;
          }
          case 'ice': {
            await pc?.addIceCandidate(msg.ice);
            break;
          }
          case 'peer-left': {
            // Host waits for the next guest — the first join attempt may be
            // the friend retrying after a failed hole punch.
            if (isHost) { try { pc?.close(); } catch { /* gone */ } pc = null; break; }
            fail(new Error('peer left during handshake'));
            break;
          }
                  default: { break; }
}
      } catch (error) {
        logger.error('signalling error', error);
        fail(error as Error);
      }
    });

    ws.addEventListener('open', (): void => logger.info(`signalling connected (host=${isHost})`));
  });
}
