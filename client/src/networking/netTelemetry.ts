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
  private pingHistory: number[] = [];
  private lastTickAt = 0;
  private firstTickAt = 0;
  private tickWindow: { t: number; missed: number }[] = [];

  constructor(private readonly expectedTickMs: number) {}

  onPong(sentAt: number, now: number): void {
    const rtt = now - sentAt;
    if (rtt < 0 || rtt >= RTT_REJECT_MS) {return;}
    this.ping = Math.round(rtt);
    this.pingHistory.push(rtt);
    if (this.pingHistory.length > PING_HISTORY_MAX) {this.pingHistory.shift();}
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

  packetLoss(now: number): number {
    if (this.lastTickAt === 0 || this.tickWindow.length === 0) {return 0;}
    const missed = this.tickWindow.reduce((s, w) => s + w.missed, 0);
    // Denominator is ticks since the FIRST tick ever (capped at the
    // window), not since the first miss — a single early gap otherwise
    // divides by a tiny span and pins the display at 100% for minutes.
    const spanMs = Math.max(1, now - this.firstTickAt);
    const expected = Math.max(1, Math.round(Math.min(TICK_WINDOW_MS, spanMs) / this.expectedTickMs));
    return Math.min(100, Math.round((missed / expected) * 100));
  }

  // A disconnect leaves lastTickAt stale — the reconnect gap would count
  // as missed ticks and pin the loss meter for the whole 5s window.
  reset(): void {
    this.lastTickAt = 0;
    this.firstTickAt = 0;
    this.tickWindow.length = 0;
    this.pingHistory.length = 0;
    this.ping = 0;
  }

  jitter(): number {
    if (this.pingHistory.length < 2) {return 0;}
    let sumDiff = 0;
    for (let i = 1; i < this.pingHistory.length; i++) {
      sumDiff += Math.abs(this.pingHistory[i] - this.pingHistory[i - 1]);
    }
    return Math.round(sumDiff / (this.pingHistory.length - 1));
  }
}
