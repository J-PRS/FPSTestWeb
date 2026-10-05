/**
 * Chaos transport for the netcode suite — a deterministic packet pipe that
 * injects latency, jitter, loss, duplication, and reordering, plus a
 * ServerWebSocket-shaped test double that routes its sends through it.
 *
 * Everything is driven by an injected clock, never wall time: a test can
 * simulate minutes of adverse link in milliseconds of CPU, and a seeded
 * run is bit-reproducible (the WHOLE POINT — nondeterministic chaos tests
 * just move the flake into the harness).
 */

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ChaosSpec = {
  /** One-way delay in sim-ms (HALF the RTT — apply per direction). */
  latencyMs?: number;
  /** Uniform +- jitter added to each frame's delay. */
  jitterMs?: number;
  /** Drop probability at enqueue. */
  lossP?: number;
  /** Probability a frame is enqueued twice. */
  dupP?: number;
  /** Probability a frame borrows a random extra 0..50ms delay — enough to
   *  land out of order against a same-window frame. */
  reorderP?: number;
};

type Queued = { due: number; data: string | Uint8Array };

/** One direction of a link. Frames sit until their due time; deliver()
 *  pops everything whose due <= now (delivery order = due order). */
export class ChaosLink {
  private q: Queued[] = [];
  private rng: () => number;
  sent = 0; dropped = 0; duped = 0;

  constructor(private spec: ChaosSpec, seed: number) {
    this.rng = mulberry(seed);
  }

  get queued(): number { return this.q.length; }

  send(data: string | Uint8Array, now: number): void {
    this.sent++;
    if (this.spec.lossP && this.rng() < this.spec.lossP) { this.dropped++; return; }
    let delay = (this.spec.latencyMs ?? 0) + (this.spec.jitterMs ? (this.rng() * 2 - 1) * this.spec.jitterMs : 0);
    if (this.spec.reorderP && this.rng() < this.spec.reorderP) delay += this.rng() * 50;
    const frame = { due: now + Math.max(0, delay), data };
    this.q.push(frame);
    if (this.spec.dupP && this.rng() < this.spec.dupP) {
      this.duped++;
      this.q.push({ due: frame.due + this.rng() * 5, data: frame.data });
    }
  }

  /** Everything due by `now`, in due order. Reordering is a byproduct of
   *  jitter/reorder delays competing, not a shuffle — same as a real link. */
  deliver(now: number): (string | Uint8Array)[] {
    this.q.sort((a, b) => a.due - b.due);
    const out: Queued[] = [];
    while (this.q.length && this.q[0]!.due <= now) out.push(this.q.shift()!);
    return out.map(f => f.data);
  }
}

/** Minimal ServerWebSocket stand-in: ConnectionManager touches send(),
 *  close(), readyState, data, and getBufferedAmount(). */
export class FakeWs {
  readyState = 1;
  data: Record<string, unknown>;
  buffered = 0;
  closed: { code: number; reason: string } | null = null;
  sentRaw: (string | Uint8Array)[] = []; // raw capture when no link attached

  constructor(public playerId: string, private link?: ChaosLink, private nowFn: () => number = () => 0) {
    this.data = { playerId };
  }

  send(d: string | Uint8Array): void {
    this.sentRaw.push(d);
    this.link?.send(d, this.nowFn());
  }
  close(code = 1000, reason = ''): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  getBufferedAmount(): number { return this.buffered; }
}
