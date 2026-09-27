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

export function connectP2P(opts: { signalUrl: string; timeoutMs?: number }): Promise<RTCDataChannel> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('P2P signalling timed out')), opts.timeoutMs ?? 15000);
    const fail = (e: Error) => { clearTimeout(timeout); ws.close(); reject(e); };

    const ws = new WebSocket(opts.signalUrl);
    let pc: RTCPeerConnection | null = null;
    let isHost = false;

    const send = (m: SignalMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

    const newPc = (): RTCPeerConnection => {
      const p = new RTCPeerConnection(RTC_CONFIG);
      p.onicecandidate = (e) => { if (e.candidate) send({ t: 'ice', ice: e.candidate.toJSON() }); };
      p.onconnectionstatechange = () => {
        if (p.connectionState === 'failed') fail(new Error('ICE failed — NAT unroutable'));
      };
      return p;
    };

    const armChannel = (dc: RTCDataChannel) => {
      dc.onopen = () => { clearTimeout(timeout); ws.close(); resolve(dc); };
    };

    ws.onerror = () => fail(new Error('signalling socket failed'));
    ws.onclose = (e) => { if (e.code === 1008) fail(new Error(`room rejected: ${e.reason}`)); };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data as string) as SignalMsg;
      try {
        switch (msg.t) {
          case 'role':
            isHost = !!msg.host;
            break;
          case 'peer': {
            // Second member arrived — host makes the offer
            pc = newPc();
            const dc = pc.createDataChannel('game', { ordered: true });
            armChannel(dc);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            send({ t: 'offer', sdp: offer.sdp });
            break;
          }
          case 'offer': {
            pc = newPc();
            pc.ondatachannel = (e) => armChannel(e.channel);
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp! });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            send({ t: 'answer', sdp: answer.sdp });
            break;
          }
          case 'answer':
            await pc?.setRemoteDescription({ type: 'answer', sdp: msg.sdp! });
            break;
          case 'ice':
            await pc?.addIceCandidate(msg.ice);
            break;
          case 'peer-left':
            fail(new Error('peer left during handshake'));
            break;
        }
      } catch (e) {
        logger.error('signalling error', e);
        fail(e as Error);
      }
    };

    ws.onopen = () => logger.info(`signalling connected (host=${isHost})`);
  });
}
