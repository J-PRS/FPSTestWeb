/**
 * NetChannel — netcode v2 seam. One logical connection with two lanes:
 *
 *   reliable   — ordered + guaranteed. Claims, events, joins, chat.
 *   unreliable — unordered, droppable. Position frames, ball states.
 *
 * Every tier (WebTransport / WebRTC datachannel / WebSocket) produces the
 * same NetChannel, so game code never sees which lane the bytes rode. On
 * WebSocket both lanes share the socket — same wire, semantics degrade
 * gracefully (unreliable becomes reliable-ordered TCP, which is today's
 * behavior anyway).
 *
 * Unreliable consumers MUST drop stale seqs — callers stamp `seq` in the
 * payload and receivers keep `lastSeq` (see design doc).
 */
export interface NetChannel {
  /** Guaranteed ordered delivery. */
  sendReliable(data: string | Uint8Array): boolean;
  /** Fire-and-forget; may arrive out of order, late, duplicated, or never. */
  sendUnreliable(data: string | Uint8Array): boolean;
  connected(): boolean;
  disconnect(): void;
  /** Which tier this channel is running on — HUD/debug display only. */
  readonly tier: 'webtransport' | 'webrtc' | 'websocket';
}
