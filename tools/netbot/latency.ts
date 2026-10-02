// Simulated WAN link for netbot clients. Each send is scheduled on its own
// delay (ping/2 + uniform jitter), so on the wire messages arrive in
// shuffled order — the exact condition that exercises deferred claims and
// stale-seq drops that a loopback TCP test can never produce.
//
// `steady` bypasses jitter variance: used for the position channel, where a
// reordered update reads as a backwards teleport and would spam corrections
// (the real client keeps movement on the seq-gated inputMove channel for
// the same reason). Combat claims take the full jitter.

export interface LatencyOpts {
  /** Round-trip time in ms — half is applied to every send. */
  pingMs: number;
  /** Uniform extra delay range in ms — THIS is what reorders messages. */
  jitterMs: number;
  /** Random drop probability per message (0..1). */
  lossRate: number;
}

export class LatencyLink {
  sent = 0;
  dropped = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private opts: LatencyOpts, private rand: () => number = Math.random) {}

  send(socket: { send(data: string): unknown; readyState: number }, data: string, steady = false): void {
    if (this.rand() < this.opts.lossRate) { this.dropped++; return; }
    this.sent++;
    const delay = this.opts.pingMs / 2 + (steady ? 0 : this.rand() * this.opts.jitterMs);
    if (delay <= 0) { if (socket.readyState === 1) socket.send(data); return; }
    this.timers.push(setTimeout(() => {
      if (socket.readyState === 1) socket.send(data);
    }, delay));
  }

  /** Pending in-flight sends — the test waits for drain before asserting. */
  get inFlight(): number { return this.timers.length; }

  /** Deliver nothing else — pending sends are abandoned with the socket. */
  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
