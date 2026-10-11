import { ChildLogger } from '../core/Logger.js';
import type { ClientMessage } from '../../../shared/protocol.js';

const logger = new ChildLogger('InputStream');

export type MoveInput = { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number };
type MoveRotation = { yaw: number; pitch: number };

/** Change-only input stream for client-side prediction. Every transmitted
 *  input edge lands in a bounded journal so a server correction can rewind
 *  to the echoed state and replay seq > its last consumed inputSeq —
 *  CFWK-style input replay so missed packets converge instead of
 *  re-diverging. */
export class InputStream {
  private lastSentInput = '';
  private inputSeq = 0;
  // Last transmitted input payload + rotation — an inputSync resend
  // re-emits exactly this (the change-only stream's current edge).
  private lastInputState: MoveInput | null = null;
  private lastInputRotation: MoveRotation = { yaw: 0, pitch: 0 };
  private lastSentEdge: { seq: number; input: MoveInput; rotation: MoveRotation } | null = null;
  private inputJournal: { seq: number; t: number; input: MoveInput }[] = [];
  private static readonly INPUT_JOURNAL_MAX = 128;

  /** Held input state for the volatile position frame — the superseding
   *  datagram input path: every frame carries the current held state, so
   *  on unordered/lossy lanes a dropped packet costs nothing. */
  held(): MoveInput | null { return this.lastInputState; }

  /** Current input sequence — rides inside the binary position frame so
   *  the server can order input edges against position reports. */
  get seq(): number { return this.inputSeq; }

  private journal(seq: number, input: MoveInput): void {
    this.inputJournal.push({ seq, t: performance.now(), input: { ...input} });
    if (this.inputJournal.length > InputStream.INPUT_JOURNAL_MAX) {this.inputJournal.shift();}
  }

  sendMove(input: MoveInput, rotation: MoveRotation, send: (m: ClientMessage) => void): void {
    const key = `${input.forward},${input.right},${input.jump},${input.ski},${input.jet ?? 0},${input.status ?? 0}`;
    if (key === this.lastSentInput) {return;}
    this.lastSentInput = key;
    // Change-only stream → unordered transports can deliver stale events
    // after fresh ones; the seq lets the server drop them.
    const seq = ++this.inputSeq;
    // In-packet redundancy: the previous edge rides along so a single
    // lost packet heals instantly instead of via the watchdog RTT —
    // the server's seq gates make the double-apply a no-op when both land.
    const prev = this.lastSentEdge ? { seq: this.lastSentEdge.seq, input: { ...this.lastSentEdge.input}, rotation: { ...this.lastSentEdge.rotation} } : undefined;
    this.journal(seq, input);
    this.lastInputState = { ...input};
    this.lastInputRotation = { ...rotation};
    this.lastSentEdge = { seq, input: { ...input}, rotation: { ...rotation} };
    send({seq,input,rotation, ...(prev ? { prev } : {}), type: 'inputMove' as const});
  }

  /** Hard-tolerance answer: the server's consumed input watermark fell
   *  behind ours across several reports — an edge died in flight. Re-emit
   *  the current input with a fresh seq so the shadow converges. */
  resend(lastSeq: number, send: (m: ClientMessage) => void, connected: boolean): void {
    if (!this.lastInputState || !connected) {return;}
    const seq = ++this.inputSeq;
    this.journal(seq, this.lastInputState);
    logger.info(`inputSync: re-emitting input at seq ${seq} (server consumed ${lastSeq})`);
    send({ type: 'inputMove', seq, input: { ...this.lastInputState}, rotation: this.lastInputRotation });
  }

  /** Journal entries with seq > `after` — what the server hadn't consumed
   *  when it issued a correction. Also prunes consumed entries.
   *  `gapMs` (the correction's round-trip window): the journal is
   *  change-only, so the input HELD since the last edge is nowhere in
   *  it — without re-seeding it, a correction while holding steady keys
   *  finds an empty journal and hard-snaps instead of replaying. The
   *  held input is re-entered at (now - gapMs) so it governs the gap. */
  inputsAfter(after: number, gapMs = 0): { t: number; input: MoveInput }[] {
    while (this.inputJournal.length > 0 && this.inputJournal[0].seq <= after) {this.inputJournal.shift();}
    if (gapMs > 0 && this.lastInputState) {
      const gapStart = performance.now() - gapMs;
      const [first] = this.inputJournal;
      if (!first || first.t > gapStart) {
        this.inputJournal.unshift({ seq: after, t: gapStart, input: { ...this.lastInputState} });
      }
    }
    return this.inputJournal;
  }

  dropJournal(): void {
    this.inputJournal.length = 0;
  }
}
