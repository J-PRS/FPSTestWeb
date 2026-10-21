/**
 * Connection-quality telemetry — ping RTT history, tick-arrival gap
 * tracking, jitter. Pulled out of NetworkManager so the wire manager
 * stays about messages; this is a pure numbers box with no transport.
 */

const PING_HISTORY_MAX = 10;
const TICK_WINDOW_MS = 5000;
const RTT_REJECT_MS = 10_000;

export class NetTelemetry {
  ping = 0;
  // Timestamped so a hidden-tab pong can't poison jitter for the next
  // 10 probes — a 12s-parked pong is one |ΔRTT| of ~12s in a 9-sample
  // mean (the soak's 2458ms readout), not a real network property.
  private pingHistory: { t: number; rtt: number }[] = [];
  private lastTickAt = 0;
  private firstTickAt = 0;
  private tickWindow: { t: number; missed: number }[] = [];
  // Seq-gap window — REAL loss: a frame whose tickSeq never arrived
  // (server shed under backpressure, or a datagram genuinely dropped).
  // Distinct from arrival gaps below: TCP can't lose a frame, so an
  // arrival gap is coalescing/jitter — "late", never "gone".
  private seqWindow: { t: number; missed: number }[] = [];

  constructor(private readonly expectedTickMs: number) {}

  onPong(sentAt: number, now: number): void {
    const rtt = now - sentAt;
    if (rtt < 0 || rtt >= RTT_REJECT_MS) {return;}
    this.ping = Math.round(rtt);
    this.pingHistory.push({ t: now, rtt });
    while (this.pingHistory.length > PING_HISTORY_MAX || (this.pingHistory.length > 0 && now - this.pingHistory[0]!.t > TICK_WINDOW_MS)) {this.pingHistory.shift();}
  }

  /** A tickSeq hole — the frame never reached us. Called from the wire
   *  decoder when an applied frame's seq jumps by >1. */
  onSeqGap(now: number, skipped: number): void {
    if (skipped <= 0) {return;}
    this.seqWindow.push({ t: now, missed: skipped });
    while (this.seqWindow.length > 0 && now - this.seqWindow[0]!.t > TICK_WINDOW_MS) {this.seqWindow.shift();}
  }

  /** A seq counted missed that arrived late anyway — unordered lanes
   *  reorder constantly; canceling keeps packetLoss honest. */
  onSeqReorder(now: number, count: number): void {
    let left = count;
    for (let i = this.seqWindow.length - 1; i >= 0 && left > 0; i -= 1) {
      const w = this.seqWindow[i]!;
      const take = Math.min(w.missed, left);
      w.missed -= take;
      left -= take;
      if (w.missed === 0) {this.seqWindow.splice(i, 1);}
    }
  }

  // "Loss" over a reliable WS transport isn't packet loss — what players
  // feel is delivery gaps. Track the tick stream: a frame arriving
  // >1 expected-interval late counts the skipped slots as missed.
  onTickArrival(now: number): void {
    if (this.lastTickAt > 0) {
      const gap = now - this.lastTickAt;
      const missed = Math.max(0, Math.round(gap / this.expectedTickMs) - 1);
      if (missed > 0) {this.tickWindow.push({ t: now, missed });}
      while (this.tickWindow.length > 0 && now - this.tickWindow[0]!.t > TICK_WINDOW_MS) {this.tickWindow.shift();}
    }
    this.lastTickAt = now;
    if (this.firstTickAt === 0) {this.firstTickAt = now;}
  }

  private windowLoss(now: number, window: { t: number; missed: number }[]): number {
    if (this.lastTickAt === 0 || window.length === 0) {return 0;}
    const missed = window.reduce((s, w): number => s + w.missed, 0);
    // Denominator is ticks since the FIRST tick ever (capped at the
    // window), not since the first miss — a single early gap otherwise
    // divides by a tiny span and pins the display at 100% for minutes.
    const spanMs = Math.max(1, now - this.firstTickAt);
    const expected = Math.max(1, Math.round(Math.min(TICK_WINDOW_MS, spanMs) / this.expectedTickMs));
    return Math.min(100, Math.round((missed / expected) * 100));
  }

  /** True loss — seq holes. ~0 on WS; nonzero on WT datagrams or when
   *  the server sheds frames under backpressure. */
  packetLoss(now: number): number {
    return this.windowLoss(now, this.seqWindow);
  }

  /** Arrival-cadence gaps — late/coalesced delivery. This is what used
   *  to masquerade as "packet loss" on TCP loopback. */
  deliveryGap(now: number): number {
    return this.windowLoss(now, this.tickWindow);
  }

  // A disconnect leaves lastTickAt stale — the reconnect gap would count
  // as missed ticks and pin the loss meter for the whole 5s window.
  reset(): void {
    this.lastTickAt = 0;
    this.firstTickAt = 0;
    this.tickWindow.length = 0;
    this.seqWindow.length = 0;
    this.pingHistory.length = 0;
    this.ping = 0;
  }

  jitter(): number {
    const rtts = this.pingHistory.map((p): number => p.rtt);
    if (rtts.length < 2) {return 0;}
    let sumDiff = 0;
    for (let i = 1; i < rtts.length; i += 1) {
      sumDiff += Math.abs(rtts[i]! - rtts[i - 1]!);
    }
    return Math.round(sumDiff / (rtts.length - 1));
  }
}
